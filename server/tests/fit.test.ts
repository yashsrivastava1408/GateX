import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DimensionSpec } from '@ddd/shared';
import { WorkbookModel } from '../src/excel/workbook.js';
import { checkScorecardFit, fitNote, mentionsOfBuiltParts } from '../src/agent/fit.js';
import { expandCriteria, retypeOutsideCriteria } from '../src/agent/aggregate.js';
import { ScorecardResolver } from '../src/scorecard/resolve.js';
import { evaluate } from '../src/agent/index.js';
import { createProviderFactory } from '../src/llm/registry.js';
import { parseScorecard } from '../src/scorecard/parse.js';
import { makeWorkbook, mockModels, writeTemp } from './helpers.js';

const q = (id: string, name: string, extra: Partial<DimensionSpec> = {}): DimensionSpec => ({ id, name, weight: 1, critical: false, measuredBy: 'raters', ...extra }) as DimensionSpec;

describe('does the scorecard fit the file?', () => {
  it('flags questions about tables, indexes and SQL put to a file that has none, and counts what the file says', async () => {
    const wb = await WorkbookModel.load(await makeWorkbook({ Features: [['Feature', 'Competitor'], ['Search', 'Naukri'], ['Alerts', 'LinkedIn']] }));
    expect(mentionsOfBuiltParts(wb)).toBe(0);
    const fit = checkScorecardFit([q('Q1', 'Search features have supporting data and indexes'), q('Q2', 'Saved searches have tables'), q('Q3', 'Competitors are named')], wb)!;
    expect(fit.builtParts.map((x) => x.id)).toEqual(['Q1', 'Q2']);
    expect(fit.checked).toBe(3);
    expect(fitNote(fit)).toMatch(/Scorecard fit: 2 of the 3 questions ask about the tables, indexes or SQL of a built database \(Q1 \(Search features have supporting data and indexes\); Q2 \(Saved searches have tables\)\), and this file mentions such things nowhere/);
    expect(fitNote(fit)).toMatch(/check that this is the right scorecard/);
  });

  it('is silent when the file does describe tables, or when no question asks about them', async () => {
    const tables = await WorkbookModel.load(await makeWorkbook({ Design: [['Table', 'Index', 'Foreign key'], ['candidate', 'idx_candidate_email', 'user_id'], ['job', 'idx_job_title', 'company_id']] }));
    expect(checkScorecardFit([q('Q1', 'Every table has an index')], tables)).toBeNull();
    const plain = await WorkbookModel.load(await makeWorkbook({ Features: [['Feature'], ['Search']] }));
    expect(checkScorecardFit([q('Q3', 'Competitors are named'), q('Q4', 'Counts are correct')], plain)).toBeNull();
  });

  it('leaves out code-scored questions and ones that need evidence from outside the file', async () => {
    const wb = await WorkbookModel.load(await makeWorkbook({ Features: [['Feature'], ['Search']] }));
    const out = q('Q1', 'Run EXPLAIN on the slowest query', { criterionOf: { id: 'D', name: 'D', outside: true } });
    expect(checkScorecardFit([out, q('Q2', 'Tables exist', { measuredBy: 'code' })], wb)).toBeNull();
  });

  const dir = (name: string) => path.resolve(import.meta.dirname, '../../data/inputs', name);
  const cache = path.resolve(import.meta.dirname, '../../data/scorecards');
  const questionsOf = async (name: string, card: string, book: string) => {
    const read = async (f: string) => ({ name: f, bytes: await readFile(path.join(dir(name), f)) });
    const resolved = await new ScorecardResolver({ cacheDir: cache, candidates: () => [] as never }).lookup(await read(card), await read(book));
    return resolved ? expandCriteria(retypeOutsideCriteria(resolved.scorecard).scorecard).dimensions : null;
  };
  const book = 'Feature_Discovery_Schema_3A.xlsx';

  it.skipIf(!existsSync(path.join(dir('step3'), book)))('the old Step 3 pairing is flagged, and the same file with its own scorecard is not', async () => {
    const wb = await WorkbookModel.load(path.join(dir('step3'), book));
    const old = await questionsOf('step3', '03_feature_discovery.xlsx', book);
    if (old) {
      const fit = checkScorecardFit(old, wb)!;
      expect(fit.builtParts.map((x) => x.id)).toEqual(['S03-03-C02', 'S03-03-C09', 'S03-04-C03', 'S03-07-C01']);
      expect(fit.checked).toBe(25);
    }
    if (existsSync(path.join(dir('step3-correct'), '03_Step3_Scorecard.xlsx'))) {
      const right = await questionsOf('step3-correct', '03_Step3_Scorecard.xlsx', book);
      if (right) expect(checkScorecardFit(right, wb)).toBeNull();
    }
  });

  it.skipIf(!existsSync(path.join(dir('step2-v32'), 'Talentra_Step2_Master_Schema_v3.2_Reconciled.xlsx')))('is silent on the real Step 2, Step 4 and docket pairs', async () => {
    for (const [name, card, file] of [
      ['step2-v32', 'Talentra_Step2_Master_Scorecard_v3.2_Reconciled.xlsx', 'Talentra_Step2_Master_Schema_v3.2_Reconciled.xlsx'],
      ['step4', 'scorecard.csv', 'schema.csv'],
      ['docket', 'scorecard.xlsx', 'schema.pdf'],
    ] as const) {
      const questions = await questionsOf(name, card, file);
      if (questions) expect(checkScorecardFit(questions, await WorkbookModel.load(path.join(dir(name), file)))).toBeNull();
    }
  });

  it('puts a note in the run, and changes no score', async () => {
    const yaml = `scorecard:
  id: FIT
  name: Fit test
  version: "1"
  judges: D1 schema
  frozen: true
  thresholds: { accept: 75, refine: 60 }
  artifact:
    sheets:
      - name: Features
        header_row: 1
  dimensions:
    - id: Q1
      name: Search features have supporting data and indexes
      weight: 50
      critical: false
      measure: indexes exist for every search
      anchors: { 5: ok, 4: ok, 3: ok, 2: ok, 1: ok, 0: none }
    - id: Q2
      name: Competitors are named
      weight: 50
      critical: false
      measure: competitors named
      anchors: { 5: ok, 4: ok, 3: ok, 2: ok, 1: ok, 0: none }
`;
    const parsed = parseScorecard(yaml, 'fit.yaml');
    const file = await writeTemp('fit.xlsx', await makeWorkbook({ Features: [['Feature', 'Competitor'], ['Search', 'Naukri']] }));
    const models = mockModels(['mock-mid', 'mock-mid', 'mock-mid']);
    const out = await evaluate({ runId: 'r', projectName: 'p', iteration: 1, workbookPath: file, artifactName: 'fit.xlsx', scorecard: parsed.scorecard, scorecardHash: parsed.hash, sources: '', models, providers: createProviderFactory(models, { mockDelayMs: 0 }), env: {} });
    expect(out.core.notes.some((n) => /^Scorecard fit: 1 of the 2 questions ask about the tables, indexes or SQL/.test(n))).toBe(true);
    expect(out.core.dimensions.every((d) => d.status === 'scored')).toBe(true);
  });
});
