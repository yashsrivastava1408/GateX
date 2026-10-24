import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DimensionResult, DimensionSpec, Scorecard } from '@ddd/shared';
import { WorkbookModel } from '../src/excel/workbook.js';
import { collapseCriteria, expandCriteria } from '../src/agent/aggregate.js';
import { applyExactCeilings, exactCeilings, exactCeilingsFor, FAMILIES, scoreForShare, scoreForTallies } from '../src/agent/exactScore.js';
import { emptyStats, sweepAll } from '../src/agent/sweep.js';
import { recountTallies } from '../src/agent/tallies.js';
import { plantDefects } from '../src/planted/plant.js';
import { makeWorkbook } from './helpers.js';

const csvOf = (r: Array<Array<string | number>>) => Buffer.from(r.map((row) => row.join(',')).join('\n') + '\n', 'utf8');

/** A register of 80 rows: id, definition, reason, data type (empty on composites by design), required, parent, children. */
function register(): Array<Array<string | number>> {
  const out: Array<Array<string | number>> = [['Register'], [''], [''], ['Path id', 'Level', 'Name', 'Definition', 'Reason it exists', 'Data type', 'Required', 'Parent id', 'Children', 'Kind']];
  for (let i = 1; i <= 80; i++) {
    const composite = i % 4 === 0;
    out.push([`${i}`, 3, `Field ${i}`, `Definition of field ${i}.`, `Reason ${i}.`, composite ? '' : 'text', i % 2 ? 'Required' : 'Optional', i === 1 ? '' : '1', 0, composite ? 'composite' : 'atomic']);
  }
  return out;
}

const crit = (id: string, name: string, extra: Partial<DimensionSpec> = {}): DimensionSpec => ({ id, name, weight: 1, critical: false, measuredBy: 'raters', ...extra }) as DimensionSpec;

/** The criteria of the real NFR scorecard that are counts, plus judgement ones that must stay judgement. */
const QUESTIONS: DimensionSpec[] = [
  crit('SC-02', 'List fields hold only allowed values (or a sentinel)'),
  crit('SC-03', 'NFR ids follow NFR-nnn and are unique'),
  crit('CP-01', 'No blank cells: every field has a value or a sentinel'),
  crit('DC-01', 'Every field has a definition, a type and a reason'),
  crit('DC-02', 'Every allowed value has a plain meaning'),
  crit('SD-02', 'No section or parameter has more than 10 children'),
  crit('FN-02', 'NFRs ready for test design: no open gap'),
];

describe('the fixed scale', () => {
  it('maps the share of clean rows to 0-5, and any mistake caps it at 4', () => {
    expect([1, 0.995, 0.99, 0.98, 0.975, 0.96, 0.95, 0.93, 0.9, 0.85].map((s) => scoreForShare(s, 0))).toEqual([5, 4, 4, 3, 3, 2, 2, 1, 1, 0]);
    expect(scoreForShare(1, 1)).toBe(4);
    expect(scoreForShare(0.9999, 1)).toBe(4);
  });
  it('scores tallies as five minus the number that are wrong', () => {
    expect([0, 1, 2, 4, 5, 9].map(scoreForTallies)).toEqual([5, 4, 3, 1, 0, 0]);
  });
});

describe('which criteria are counts', () => {
  const asks = (id: string, text: string) => FAMILIES.find((f) => f.id === id)!.asks(text);
  it('recognises the wording of a count', () => {
    expect(asks('duplicate', 'NFR ids follow NFR-nnn and are unique')).toBe(true);
    expect(asks('empty', 'No blank cells: every field has a value or a sentinel')).toBe(true);
    expect(asks('empty', 'Every field has a definition, a type and a reason')).toBe(true);
    expect(asks('reference', 'Every reference resolves to an existing id')).toBe(true);
    expect(asks('allowed', 'List fields hold only allowed values')).toBe(true);
    expect(asks('children', 'The children counts match the rows under each id')).toBe(true);
    expect(asks('tally', 'Input counts reconciled')).toBe(true);
  });
  it('leaves judgement criteria alone', () => {
    expect(asks('allowed', 'Every allowed value has a plain meaning')).toBe(false);
    expect(asks('children', 'No section or parameter has more than 10 children')).toBe(false);
    expect(asks('empty', 'NFRs ready for test design: no open gap')).toBe(false);
    expect(asks('duplicate', 'The register is clear and well organised')).toBe(false);
    expect(asks('tally', 'Counts visible at every level')).toBe(false);
  });
});

describe('exact ceilings on a planted register', () => {
  it('finds no ceiling in the clean register', async () => {
    const wb = await WorkbookModel.load(csvOf(register()));
    expect(exactCeilingsFor(QUESTIONS, wb).size).toBe(0);
  });

  it('puts a ceiling on exactly the counted criteria the planted mistakes touch', async () => {
    const { bytes } = await plantDefects(csvOf(register()));
    const wb = await WorkbookModel.load(bytes);
    const c = exactCeilingsFor(QUESTIONS, wb);
    expect([...c.keys()].sort()).toEqual(['CP-01', 'DC-01', 'SC-02', 'SC-03']);
    expect(c.get('SC-03')).toMatchObject({ family: 'duplicate', mistakes: 1, ceiling: 3 });
    expect(c.get('SC-02')).toMatchObject({ family: 'allowed', mistakes: 1 });
    // Three blank cells in three rows of 80: 96.3% clean.
    expect(c.get('CP-01')).toMatchObject({ family: 'empty', mistakes: 3, ceiling: 2 });
    // "Every field has a definition, a type and a reason" counts those three columns only, the same three cells.
    expect(c.get('DC-01')).toMatchObject({ mistakes: 3 });
    // Judgement criteria and a max-children limit get no ceiling.
    for (const id of ['DC-02', 'SD-02', 'FN-02']) expect(c.has(id)).toBe(false);
  });

  it('counts only the columns a question names', async () => {
    const rows = register();
    rows[5]![3] = ''; // a blank definition
    const wb = await WorkbookModel.load(csvOf(rows));
    const c = exactCeilings([crit('Q1', 'Every field has a reason'), crit('Q2', 'Every field has a definition')], sweepAll(wb, { all: true, stats: emptyStats() }), (() => { const s = emptyStats(); sweepAll(wb, { all: true, stats: s }); return s; })());
    expect(c.has('Q1')).toBe(false);
    expect(c.get('Q2')).toMatchObject({ mistakes: 1, ceiling: 3 });
  });

  it('matches a column by whole words: "a defined kind of check" is not about "Definition"', async () => {
    const rows = register();
    rows[5]![3] = '';
    const wb = await WorkbookModel.load(csvOf(rows));
    const stats = emptyStats();
    const found = sweepAll(wb, { all: true, stats });
    const c = exactCeilings([crit('Q', 'Every NFR has a test method, a kind of check and a pass rule', { measure: 'N = NFRs with a stated test method, a defined kind of check and a pass rule.' })], found, stats);
    expect(c.size).toBe(0);
  });

  it('counts every mistake, not just the few that are listed in the report', async () => {
    const rows = register();
    for (const r of [6, 9, 12, 15, 18, 21, 24, 27]) rows[r]![3] = '';
    const wb = await WorkbookModel.load(csvOf(rows));
    // Eight blank definitions in 80 rows is more than 3% of the column, so the column is no longer "always filled": nothing is claimed.
    expect(sweepAll(wb).length).toBe(0);
    const some = register();
    for (const r of [6, 9]) some[r]![3] = '';
    const stats = emptyStats();
    const found = sweepAll(await WorkbookModel.load(csvOf(some)), { all: true, stats });
    expect(found.filter((f) => f.kind === 'empty_cell')).toHaveLength(2);
    expect(stats.rows).toBe(80);
  });
});

describe('applying the ceilings', () => {
  const dim = (id: string, score: number | null, over: Partial<DimensionResult> = {}): DimensionResult =>
    ({ id, name: id, weight: 1, critical: false, measuredBy: 'raters', status: 'scored', raterScores: {}, consolidated: score, spread: 0, resolution: 'agreement', flagged: false, rationale: 'r.', evidence: [], ...over }) as DimensionResult;
  const ceilings = new Map([
    ['A', { family: 'empty' as const, ceiling: 2, mistakes: 3, looked: 80, summary: '3 of 80 (3.8%) empty cells' }],
    ['B', { family: 'empty' as const, ceiling: 2, mistakes: 3, looked: 80, summary: '3 of 80 (3.8%) empty cells' }],
    ['C', { family: 'empty' as const, ceiling: 2, mistakes: 3, looked: 80, summary: 'x' }],
    ['D', { family: 'empty' as const, ceiling: 2, mistakes: 3, looked: 80, summary: 'x' }],
  ]);

  it('only lowers a score: an examiner who gave less keeps it', () => {
    const out = applyExactCeilings([dim('A', 5), dim('B', 1), dim('E', 5)], ceilings);
    expect(out.results.map((d) => d.consolidated)).toEqual([2, 1, 5]);
    expect(out.notes).toHaveLength(1);
    expect(out.results[0]!.rationale).toMatch(/Set to 2 by an exact count \(the examiners gave 5\): 3 of 80/);
  });

  it('leaves unscored and code-measured questions as they are', () => {
    const out = applyExactCeilings([dim('C', null, { status: 'unscored' }), dim('D', 5, { measuredBy: 'code' })], ceilings);
    expect(out.results.map((d) => d.consolidated)).toEqual([null, 5]);
  });
});

describe('the planted register scores lower than the clean one', () => {
  // The shape of the real NFR scorecard: counted criteria inside dimensions whose weights differ; every examiner gives a clean 5 everywhere.
  const scorecard = (): Scorecard =>
    ({
      id: 'T', name: 'T', version: '1', gate: 'D1', step: 4, passBar: 75,
      dimensions: [
        { id: 'SC', name: 'Structure', weight: 12, critical: true, measuredBy: 'raters', criteria: [{ id: 'SC-01', name: 'Columns exist', kind: 'judged' }, { id: 'SC-02', name: 'List fields hold only allowed values', kind: 'judged' }, { id: 'SC-03', name: 'Ids follow the pattern and are unique', kind: 'judged' }] },
        { id: 'CP', name: 'Completeness', weight: 12, critical: false, measuredBy: 'raters', criteria: [{ id: 'CP-01', name: 'No blank cells: every field has a value', kind: 'judged' }, { id: 'CP-02', name: 'Areas covered', kind: 'judged' }] },
        { id: 'DC', name: 'Definition clarity', weight: 8, critical: false, measuredBy: 'raters', criteria: [{ id: 'DC-01', name: 'Every field has a definition, a type and a reason', kind: 'judged' }, { id: 'DC-02', name: 'Every allowed value has a plain meaning', kind: 'judged' }] },
        { id: 'AT', name: 'Accuracy', weight: 20, critical: false, measuredBy: 'raters', criteria: [{ id: 'AT-01', name: 'Traces to a source', kind: 'judged' }] },
      ],
    }) as unknown as Scorecard;

  const score = async (bytes: Buffer): Promise<number> => {
    const sc = scorecard();
    const working = expandCriteria(sc);
    const wb = await WorkbookModel.load(bytes);
    const rated = working.dimensions.map((q): DimensionResult => ({ id: q.id, name: q.name, weight: q.weight, critical: q.critical, measuredBy: 'raters', status: 'scored', raterScores: { A: 5, B: 5, C: 5 }, consolidated: 5, spread: 0, resolution: 'agreement', flagged: false, rationale: 'r.', evidence: [] }));
    const exact = applyExactCeilings(rated, exactCeilingsFor(working.dimensions, wb));
    const dims = collapseCriteria(sc, exact.results);
    return (dims.reduce((s, d) => s + (d.weight * (d.consolidated ?? 0)) / 5, 0) / dims.reduce((s, d) => s + d.weight, 0)) * 100;
  };

  it('even when every examiner gives a clean 5 to both', async () => {
    const clean = await score(csvOf(register()));
    const { bytes } = await plantDefects(csvOf(register()));
    const planted = await score(bytes);
    expect(clean).toBe(100);
    expect(clean - planted).toBeGreaterThanOrEqual(10);
  });

  const root = path.resolve(import.meta.dirname, '../../data');
  const plantedFile = path.join(root, 'planted/final-production-with-sweep/planted.csv');
  const cleanFile = path.join(root, 'inputs/step4/schema.csv');
  it.skipIf(!existsSync(plantedFile) || !existsSync(cleanFile))('on the saved planted fixture and its clean original (data/)', async () => {
    const questions = [crit('SC-02', 'List fields hold only allowed values'), crit('SC-03', 'ids are unique'), crit('CP-01', 'No blank cells: every field has a value'), crit('DC-01', 'Every field has a definition, a type and a reason')];
    const planted = exactCeilingsFor(questions, await WorkbookModel.load(await readFile(plantedFile)));
    expect([...planted.entries()].map(([id, c]) => `${id}:${c.ceiling}`).sort()).toEqual(['CP-01:2', 'DC-01:2', 'SC-02:3', 'SC-03:3']);
    expect(exactCeilingsFor(questions, await WorkbookModel.load(await readFile(cleanFile))).size).toBe(0);
  });
});

describe('tallies the file states about itself', () => {
  it('flags a percentage that is not the share, and accepts a correct one', async () => {
    const wb = await WorkbookModel.load(await makeWorkbook({ README: [['Summary'], ['283 of 426 fields (66%) were already correct'], ['Only 16 of 426 fields (3.8%) are covered'], ['71/71 100%'], ['30 of 40 fields (90%) are filled']] }));
    const found = recountTallies(wb);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'tally_mismatch', severity: 'MEDIUM', location: { sheet: 'README', cell: 'A5' } });
    expect(found[0]!.detail).toMatch(/30 of 40 is 75%/);
  });

  // A small field dictionary in the shape of a PDF: overview tiles, then rows (name | definition | type | allowed | M/C | source) under S headings.
  const pdfLike = (tile: { s1: number; s2: number; s3: number }, total: string, mc: string) => {
    const fields = (n: number, tag: string, flag: (i: number) => string) => Array.from({ length: n }, (_, i) => `${tag}_${i + 1} | Meaning of ${tag} ${i + 1}  Reason | string | text | ${flag(i)} | CtO`);
    return {
      'Page 1': ['Overview', `${total}`, 'S1 · Control control | S2 · Workflow register workflow[] | S3 · Steps step[]', `${tile.s1} fields · 1 closed lists | ${tile.s2} fields · 2 closed lists | ${tile.s3} fields · 0 closed lists`],
      'Page 2': ['Field dictionary', 'S1 · Control control | · 1..1  Identity', ...fields(5, 'ctl', () => 'M'), 'S2 · Workflow register | workflow[] · 1..n  One row per workflow', ...fields(6, 'wf', (i) => (i < 4 ? 'M' : 'C')), 'S3 · Steps | step[] · 1..n  The happy path', ...fields(4, 'st', () => 'M'), `Mandatory · conditional fields | ${mc}`],
    };
  };
  const loadPdfLike = async (parts: Record<string, string[]>) => {
    // Page sheets of a PDF hold one line per row in column A.
    return WorkbookModel.load(await makeWorkbook(Object.fromEntries(Object.entries(parts).map(([name, lines]) => [name, lines.map((l) => [l])]))));
  };

  it('accepts a dictionary whose tiles and totals are right', async () => {
    const wb = await loadPdfLike(pdfLike({ s1: 5, s2: 6, s3: 4 }, '3 sections · 15 fields · 7 values', '13 · 2'));
    expect(recountTallies(wb)).toEqual([]);
    const stats = emptyStats();
    recountTallies(wb, undefined, { stats });
    expect(stats.tallies).toBeGreaterThanOrEqual(5);
  });

  it('flags a section tile, a total and a mandatory count that its own rows contradict', async () => {
    const wb = await loadPdfLike(pdfLike({ s1: 5, s2: 6, s3: 7 }, '3 sections · 17 fields · 7 values', '14 · 2'));
    const found = recountTallies(wb);
    expect(found.map((f) => f.title).join(' | ')).toMatch(/S3 has 7 fields/);
    expect(found.map((f) => f.title).join(' | ')).toMatch(/17 fields/);
    expect(found.map((f) => f.title).join(' | ')).toMatch(/14 mandatory and 2 conditional/);
    expect(found.every((f) => f.kind === 'tally_mismatch' && f.severity === 'MEDIUM')).toBe(true);
  });

  it('claims nothing when its own count disagrees with most of the document (it is probably reading the layout wrong)', async () => {
    const wb = await loadPdfLike(pdfLike({ s1: 9, s2: 9, s3: 9 }, '3 sections · 12 fields · 7 values', '10 · 2'));
    expect(recountTallies(wb)).toEqual([]);
  });

  it('caps the question that asks for correct counts', async () => {
    const wb = await loadPdfLike(pdfLike({ s1: 5, s2: 6, s3: 7 }, '3 sections · 17 fields · 7 values', '14 · 2'));
    const c = exactCeilingsFor([crit('Q', 'Input counts reconciled'), crit('R', 'Hierarchy is sensible')], wb);
    expect(c.get('Q')).toMatchObject({ family: 'tally', mistakes: 3, ceiling: 2 });
    expect(c.has('R')).toBe(false);
  });
});

describe('tallies of a document with section tables ("L1·2 ... L4=50", "COUNT | ... 50 L4 leaves")', () => {
  const table = (k: number, title: string, prefix: string, n: number, claim: number) => [
    `L1·${k} — ${title} L2=1 · L3=1 · L4=${claim}`,
    'L1 | L2 | L3 | L4 (IDED LEAF)',
    ...Array.from({ length: n }, (_, i) => `${i === 0 ? `${k}. ${title} | ${k}.1 Group | ${k}.1.1 Cluster | ` : ''}${prefix}-${String(i + 1).padStart(2, '0')} Item ${i + 1}`),
    `COUNT | 1 L2 · 1 L3 · ${claim} L4 leaves`,
  ];
  const load = async (claims: [number, number, number], total: number) =>
    WorkbookModel.load(await makeWorkbook({
      'Page 1': [['Numbers'], [`The ${total} leaves in all`]],
      'Page 2': [...table(1, 'Workflows', 'WF', 5, claims[0]), ...table(2, 'Steps', 'STEP', 8, claims[1]), ...table(3, 'Exceptions', 'EXC', 4, claims[2])].map((l) => [l]),
    }));

  it('accepts tables whose counts and total are right', async () => {
    expect(recountTallies(await load([5, 8, 4], 17))).toEqual([]);
  });
  it('flags a table whose count row is wrong, and a total that is not their sum', async () => {
    const found = recountTallies(await load([5, 9, 4], 18));
    expect(found.map((f) => f.title)).toEqual(expect.arrayContaining([expect.stringMatching(/Steps.*9 L4 leaves, the table has 8/)]));
    expect(found.some((f) => /"18 leaves" matches no table/.test(f.title))).toBe(true);
  });
  it('claims nothing when the tables do not hold ids it can count', async () => {
    const wb = await WorkbookModel.load(await makeWorkbook({ 'Page 1': [['x']], 'Page 2': [['L1·1 — A L2=1 · L3=1 · L4=9'], ['text only'], ['COUNT | 1 L2 · 1 L3 · 9 L4 leaves']] }));
    expect(recountTallies(wb)).toEqual([]);
  });
});

describe('the recount on the saved Step 5 documents (data/)', () => {
  const root = path.resolve(import.meta.dirname, '../../data/inputs');
  for (const file of ['step5/Step5_D1_Schema_Definition.pdf', 'raw-step5/schema.pdf']) {
    it.skipIf(!existsSync(path.join(root, file)))(`${file}: every tally the document states is true`, async () => {
      const wb = await WorkbookModel.load(await readFile(path.join(root, file)));
      const stats = emptyStats();
      expect(sweepAll(wb, { all: true, stats })).toEqual([]);
      expect(stats.tallies).toBeGreaterThanOrEqual(10);
    });
  }
});
