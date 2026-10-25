import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DimensionSpec } from '@ddd/shared';
import { WorkbookModel } from '../src/excel/workbook.js';
import { checkNamedItems, namedItemsOf, scoreForItems } from '../src/agent/namedItems.js';
import { applyExactCeilings, exactCeilingsFor } from '../src/agent/exactScore.js';
import { expandCriteria, retypeOutsideCriteria } from '../src/agent/aggregate.js';
import { ScorecardResolver } from '../src/scorecard/resolve.js';
import { makeWorkbook } from './helpers.js';

const q = (measure: string, reads: string[], extra: Partial<DimensionSpec> = {}): DimensionSpec =>
  ({ id: 'Q-01', name: 'Set governance metadata', weight: 1, critical: false, measuredBy: 'raters', measure, reads, ...extra }) as DimensionSpec;

describe('items a question names that the file has no column for', () => {
  it('reads the list after "present:", with or without a trailing count and sentence', () => {
    expect(namedItemsOf('Governance items present: status, migration, extensibility, owner × 116 sets')).toEqual(['status', 'migration', 'extensibility', 'owner']);
    expect(namedItemsOf('Governance items present: status, migration, extensibility, owner × 116 sets Estimate the share of items that meet it.')).toEqual(['status', 'migration', 'extensibility', 'owner']);
    expect(namedItemsOf('Fields present: name and owner.')).toEqual(['name', 'owner']);
  });
  it('says nothing about wording that is not a short list', () => {
    expect(namedItemsOf('Every set has a status, a migration rule and an owner')).toBeNull();
    expect(namedItemsOf('Items present: one')).toBeNull();
    expect(namedItemsOf('Items present: 4 of 5 fields filled in every row, as the scorecard says')).toBeNull();
    expect(namedItemsOf('Items present: a, b, c, d, e, f, g, h, i')).toBeNull();
  });
  it('scales the share of named items present', () => {
    expect([4, 3, 2, 1, 0].map((n) => scoreForItems(n, 4))).toEqual([5, 3, 2, 1, 0]);
  });

  it('finds the items with no column in the sheets the question reads, and not a column worded a little differently', async () => {
    const wb = await WorkbookModel.load(await makeWorkbook({ Sets: [['Set', 'Extensibility', 'Owner (team)', 'Lifecycle status'], ['A', 'closed', 'x', 'live']] }));
    const found = checkNamedItems(q('Governance items present: status, migration, extensibility, owner', ['Sets[Set|Owner]']), wb)!;
    expect(found.present).toEqual(['status', 'extensibility', 'owner']);
    expect(found.missing).toEqual(['migration']);
  });
  it('is silent when the question names no sheet, or a sheet the file lacks', async () => {
    const wb = await WorkbookModel.load(await makeWorkbook({ Sets: [['Set', 'Owner'], ['A', 'x']] }));
    expect(checkNamedItems(q('Items present: status, owner', []), wb)).toBeNull();
    expect(checkNamedItems(q('Items present: status, owner', ['Nowhere']), wb)).toBeNull();
  });

  it('caps the mark the examiners gave, and never raises one', async () => {
    const wb = await WorkbookModel.load(await makeWorkbook({ Sets: [['Set', 'Extensibility', 'Owner'], ['A', 'closed', 'x']] }));
    const questions = [q('Governance items present: status, migration, extensibility, owner × 1 sets', ['Sets'])];
    const ceilings = exactCeilingsFor(questions, wb);
    expect(ceilings.get('Q-01')).toMatchObject({ family: 'items', ceiling: 2, mistakes: 2, looked: 4 });
    expect(ceilings.get('Q-01')!.summary).toMatch(/2 of the 4 items it names have no column in Sets \(status, migration\)/);
    const mark = (n: number) => ({ id: 'Q-01', name: 'x', weight: 1, critical: false, measuredBy: 'raters' as const, status: 'scored' as const, raterScores: {}, consolidated: n, spread: 0, resolution: 'agreement' as const, flagged: false, rationale: 'r.', evidence: [] });
    expect(applyExactCeilings([mark(5)], ceilings).results[0]!.consolidated).toBe(2);
    expect(applyExactCeilings([mark(1)], ceilings).results[0]!.consolidated).toBe(1);
  });

  // The one real case: the human assessment of the Step 2 workbook scored this question 2 (232 of 464 items) and every live run scored it 5.
  const dir = path.resolve(import.meta.dirname, '../../data/inputs/step2-v32');
  const card = 'Talentra_Step2_Master_Scorecard_v3.2_Reconciled.xlsx';
  const book = 'Talentra_Step2_Master_Schema_v3.2_Reconciled.xlsx';
  it.skipIf(!existsSync(path.join(dir, book)))('on the real Step 2 pair it caps G06-C04 at 2, the human mark, and no other question', async () => {
    const read = async (f: string) => ({ name: f, bytes: await readFile(path.join(dir, f)) });
    const resolved = await new ScorecardResolver({ cacheDir: path.resolve(import.meta.dirname, '../../data/scorecards'), candidates: () => [] as never }).lookup(await read(card), await read(book));
    if (!resolved) return;
    const questions = expandCriteria(retypeOutsideCriteria(resolved.scorecard).scorecard).dimensions;
    const ceilings = exactCeilingsFor(questions, await WorkbookModel.load(path.join(dir, book)));
    const items = [...ceilings].filter(([, c]) => c.family === 'items');
    expect(items.map(([id, c]) => `${id}:${c.ceiling}`)).toEqual(['G06-C04:2']);
  });
});
