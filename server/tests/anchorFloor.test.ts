import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DimensionResult, DimensionSpec } from '@ddd/shared';
import { WorkbookModel } from '../src/excel/workbook.js';
import { expandCriteria } from '../src/agent/aggregate.js';
import { applyAnchorFloors, lowestRung, parseScaleText } from '../src/agent/anchorFloor.js';
import { ScorecardResolver } from '../src/scorecard/resolve.js';
import { makeWorkbook } from './helpers.js';

const REAL_SCALE = '5 a machine-readable schema (JSON Schema/YAML) matches the prose; 3 structured tables generated from one source but no machine format; 1 prose only.';
const CONVERTED_ANCHORS: Record<number, string> = {
  0: 'Prose only',
  1: 'Prose only',
  2: 'Structured tables generated from one source but no machine format',
  3: 'Structured tables generated from one source but no machine format',
  4: 'Machine-readable schema exists with minor gap',
  5: 'A machine-readable schema (JSON Schema/YAML) matches the prose',
};

const spec = (extra: Partial<DimensionSpec> = {}): DimensionSpec =>
  ({ id: 'G07-C05', name: 'Machine-readable specification', weight: 1, critical: true, measuredBy: 'raters', measure: 'A machine-readable schema (JSON Schema/YAML) matches the prose.', anchors: CONVERTED_ANCHORS, ...extra }) as DimensionSpec;

const result = (score: number | null, extra: Partial<DimensionResult> = {}): DimensionResult => ({
  id: 'G07-C05', name: 'Machine-readable specification', weight: 1, critical: true, measuredBy: 'raters', status: score === null ? 'unscored' : 'scored',
  raterScores: { A: 0, B: 0, C: 2 }, consolidated: score, spread: 2, resolution: 'agreement', flagged: false, rationale: 'No machine-readable schema.',
  evidence: [{ sheet: 'Validation_Rules', cell: 'A4', quote: 'Rule' }], ...extra,
});

const workbook = async () =>
  WorkbookModel.load(await makeWorkbook({ Validation_Rules: [['x'], ['y'], ['z'], ['Rule', 'What it checks'], ['VR-01', 'Prose describing the rule.']], Other: [['a']] }));

describe('the scale a scorecard describes', () => {
  it('reads the rungs of a scale written in the measure', () => {
    expect(parseScaleText(REAL_SCALE)).toEqual([
      { score: 1, text: 'prose only' },
      { score: 3, text: 'structured tables generated from one source but no machine format' },
      { score: 5, text: 'a machine-readable schema (JSON Schema/YAML) matches the prose' },
    ]);
  });
  it('finds the bottom rung in the real wording (1 = prose only), written out or spread over 0 and 1 by the converter', () => {
    expect(lowestRung({ measure: REAL_SCALE })).toEqual({ score: 1, text: 'prose only' });
    expect(lowestRung({ anchors: CONVERTED_ANCHORS })).toEqual({ score: 1, text: 'Prose only' });
  });
  it('finds no floor when 0 is a rung of its own, when the bottom rung says absent, or when the scale starts above 1', () => {
    expect(lowestRung({ anchors: { 0: 'Absent or contradicted', 1: 'Mentioned only', 2: 'A major element missing', 5: 'Complete' } })).toBeNull();
    expect(lowestRung({ anchors: { 0: 'Nothing stated', 1: 'Nothing stated', 3: 'Some', 5: 'All' } })).toBeNull();
    expect(lowestRung({ measure: '5 none confirmed; 4 one minor; 3 one that could change an outcome; 2 several.' })).toBeNull();
    expect(lowestRung({ anchors: { 0: 'None of what the question asks for is in the file.', 1: 'A few items meet it; most do not.', 2: 'About half' } })).toBeNull();
  });
  it('does not read a sentence with a number in it as a scale', () => {
    expect(parseScaleText('Rules tagged with a DQ dimension (426 field rules + 41 VR)')).toEqual([]);
    expect(parseScaleText('On AZ-01..AZ-10; 10/10 = 5, 9 = 4, 7-8 = 3, 5-6 = 2, 1-4 = 1.')).toEqual([]);
  });
});

describe('the anchor floor', () => {
  it('pulls the G07-C05 case (scored 0, scale starts at 1 = prose only, the cited cell is there) back to 1 and says so', async () => {
    const out = applyAnchorFloors([result(0)], [spec()], await workbook());
    expect(out.results[0]!.consolidated).toBe(1);
    expect(out.results[0]!.rationale).toContain('Raised to 1');
    expect(out.notes).toEqual([expect.stringContaining('G07-C05 was raised from 0 to 1')]);
    expect(out.notes[0]).toContain('Validation_Rules!A4');
  });
  it('works from the scale written in the measure too', async () => {
    const out = applyAnchorFloors([result(0)], [spec({ anchors: undefined, measure: REAL_SCALE })], await workbook());
    expect(out.results[0]!.consolidated).toBe(1);
  });
  it('leaves a score at or above the rung alone', async () => {
    for (const s of [1, 2, 4]) expect(applyAnchorFloors([result(s)], [spec()], await workbook()).results[0]!.consolidated).toBe(s);
  });
  it('does nothing when the cited cell does not exist, is empty, or does not hold the quote', async () => {
    const wb = await workbook();
    for (const evidence of [
      [{ sheet: 'Validation_Rules', cell: 'Z99', quote: 'Rule' }],
      [{ sheet: 'Missing_Sheet', cell: 'A4' }],
      [{ sheet: 'Validation_Rules', cell: 'C4' }],
      [{ sheet: 'Validation_Rules', cell: 'A4', quote: 'Something the cell does not say' }],
      [],
    ]) {
      const out = applyAnchorFloors([result(0, { evidence })], [spec()], wb);
      expect(out.results[0]!.consolidated).toBe(0);
      expect(out.notes).toEqual([]);
    }
  });
  it('keeps one good citation among bad ones', async () => {
    const out = applyAnchorFloors([result(0, { evidence: [{ sheet: 'Nope', cell: 'A1' }, { sheet: 'Validation_Rules', cell: 'B4', quote: 'what it checks' }] })], [spec()], await workbook());
    expect(out.results[0]!.consolidated).toBe(1);
  });
  it('does not touch an unscored question, a question outside the file, a code question, or a scale with a real 0', async () => {
    const wb = await workbook();
    expect(applyAnchorFloors([result(null)], [spec()], wb).results[0]!.consolidated).toBeNull();
    expect(applyAnchorFloors([result(0)], [spec()], wb, new Set(['G07-C05'])).results[0]!.consolidated).toBe(0);
    expect(applyAnchorFloors([result(0, { measuredBy: 'code' })], [spec()], wb).results[0]!.consolidated).toBe(0);
    expect(applyAnchorFloors([result(0)], [spec({ anchors: { 0: 'Absent or contradicted', 1: 'Mentioned only', 5: 'Complete' }, measure: 'x' })], wb).results[0]!.consolidated).toBe(0);
  });
});

const CACHE = path.resolve(__dirname, '../../data/scorecards');
const INPUT = path.resolve(__dirname, '../../data/inputs/step2-v32');
const SCORECARD = 'Talentra_Step2_Master_Scorecard_v3.2_Reconciled.xlsx';
const SCHEMA = 'Talentra_Step2_Master_Schema_v3.2_Reconciled.xlsx';

describe.skipIf(!existsSync(path.join(INPUT, SCHEMA)) || !existsSync(CACHE))('the real step2-v32 scorecard (data/inputs, cached conversion)', () => {
  it('has G07-C05 scored 0 by the examiners raised to 1 with the cells they actually cited', async () => {
    const read = async (name: string) => ({ name, bytes: await readFile(path.join(INPUT, name)) });
    const resolver = new ScorecardResolver({ cacheDir: CACHE, candidates: () => [] as never });
    const resolved = await resolver.lookup(await read(SCORECARD), await read(SCHEMA));
    if (!resolved) return; // not converted on this machine
    const q = expandCriteria(resolved.scorecard).dimensions.find((d) => d.id === 'G07-C05')!;
    expect(lowestRung(q)).toMatchObject({ score: 1 });
    const wb = await WorkbookModel.load(path.join(INPUT, SCHEMA));
    const cited = [{ sheet: 'L2_Parameters', cell: 'O4', quote: 'Validation rule' }, { sheet: 'Validation_Rules', cell: 'A4', quote: 'Rule' }];
    const out = applyAnchorFloors([result(0, { evidence: cited })], [q], wb);
    expect(out.results[0]!.consolidated).toBe(1);
    expect(out.notes[0]).toContain('G07-C05 was raised from 0 to 1');
    expect(out.notes[0]).toContain('exist and hold text');
    // A criterion whose scale has its own 0 ("Absent or contradicted") is never raised.
    const g07c03 = expandCriteria(resolved.scorecard).dimensions.find((d) => d.id === 'G07-C03')!;
    expect(lowestRung(g07c03)).toBeNull();
  });
});
