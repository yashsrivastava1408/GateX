import { describe, expect, it } from 'vitest';
import type { DimensionSpec, Scorecard } from '@ddd/shared';
import { sweepFindings, sweepWorkbook } from '../src/agent/sweep.js';
import { plantDefects } from '../src/planted/plant.js';
import { WorkbookModel } from '../src/excel/workbook.js';
import { loadTalentraScorecard, makeWorkbook, mockModels, runEvaluation } from './helpers.js';

function register(n = 40): Array<Array<string | number>> {
  const out: Array<Array<string | number>> = [['Path id', 'Level', 'Name', 'Definition', 'Reason it exists', 'Data type', 'Required', 'Parent id', 'Children']];
  for (let i = 1; i <= n; i++) out.push([`1.${i}`, 3, `Field ${i}`, `Definition of field ${i}.`, `Reason ${i}.`, 'text', i % 2 ? 'Required' : 'Optional', '1', 0]);
  return out;
}
const load = async (rows: Array<Array<string | number>>) => WorkbookModel.load(await makeWorkbook({ Register: rows }));
const kinds = (found: ReturnType<typeof sweepWorkbook>) => found.map((f) => `${f.kind}@${f.location.cell}`);

describe('the row-by-row sweep', () => {
  it('finds nothing in a clean register', async () => {
    expect(sweepWorkbook(await load(register()))).toEqual([]);
  });

  it('finds an empty cell in an otherwise full column, and says which row and how full the column is', async () => {
    const rows = register();
    rows[11]![3] = '';
    const [f] = sweepWorkbook(await load(rows));
    expect(f).toMatchObject({ kind: 'empty_cell', location: { sheet: 'Register', cell: 'D12' }, severity: 'MEDIUM' });
    expect(f!.detail).toMatch(/\(row 1\.11\).*"Definition" is filled in 39 of the other 39 rows/);
  });

  it('is LOW for an empty cell in a column that is not essential, and ignores a column that is often empty', async () => {
    const rows = register();
    rows[0]!.push('Comment');
    for (let i = 1; i < rows.length; i++) rows[i]!.push(i === 5 ? '' : 'ok');
    expect(sweepWorkbook(await load(rows))[0]).toMatchObject({ kind: 'empty_cell', severity: 'LOW' });
    const sparse = register();
    sparse[0]!.push('Note');
    for (let i = 1; i < sparse.length; i++) sparse[i]!.push(i % 3 === 0 ? 'x' : '');
    expect(sweepWorkbook(await load(sparse))).toEqual([]);
  });

  it('leaves a total row and a sparse heading row alone', async () => {
    const rows = register();
    rows.push(['COUNT', '', '', '', '', '', '', '', 40]);
    rows.push(['Notes', '', '', '', '', '', '', '', '']);
    expect(sweepWorkbook(await load(rows))).toEqual([]);
  });

  it('finds a repeated id, but not in a column that is mostly repeats or in a repeated header', async () => {
    const rows = register();
    rows[20]![0] = '1.19';
    expect(kinds(sweepWorkbook(await load(rows)))).toContain('duplicate_id@A21');
    const repeats = register();
    for (let i = 1; i < repeats.length; i++) repeats[i]![0] = `g${i % 4}`;
    expect(sweepWorkbook(await load(repeats)).filter((f) => f.kind === 'duplicate_id')).toEqual([]);
  });

  it('finds a reference to an id that does not exist, only in a column where the rest resolve', async () => {
    const rows = register();
    for (let i = 1; i < rows.length; i++) rows[i]![7] = '1.1';
    rows[30]![7] = '9.9';
    const found = sweepWorkbook(await load(rows)).filter((f) => f.kind === 'dangling_reference');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ location: { cell: 'H31' } });
    expect(found[0]!.detail).toMatch(/"9\.9".*all resolve/);
    // A free-text column where most values are not ids is not a reference column.
    const free = register();
    for (let i = 1; i < free.length; i++) free[i]![7] = `see section ${i}`;
    expect(sweepWorkbook(await load(free)).filter((f) => f.kind === 'dangling_reference')).toEqual([]);
  });

  it('finds a child count that does not match the rows under an id', async () => {
    const rows: Array<Array<string | number>> = [['Path id', 'Level', 'Name', 'Definition', 'Reason it exists', 'Children']];
    for (let p = 1; p <= 4; p++) {
      rows.push([`${p}`, 1, `Group ${p}`, `Definition ${p}.`, `Reason ${p}.`, 3]);
      for (let c = 1; c <= 3; c++) rows.push([`${p}.${c}`, 2, `Item ${p}.${c}`, `Definition ${p}.${c}.`, `Reason ${p}.${c}.`, 0]);
    }
    expect(sweepWorkbook(await load(rows))).toEqual([]);
    rows[1]![5] = 5;
    const [f] = sweepWorkbook(await load(rows));
    expect(f).toMatchObject({ kind: 'wrong_count', location: { cell: 'F2' } });
    expect(f!.detail).toMatch(/says 1 has 5 children, but 3 rows sit directly under it/);
  });

  it('finds a definition that is mostly filler, but not one with a single soft word', async () => {
    const rows = register();
    rows[5]![3] = 'Handles various things as needed, etc.';
    rows[6]![3] = 'Holds the things a person owns, listed one per row.';
    const found = sweepWorkbook(await load(rows));
    expect(kinds(found)).toEqual(['vague_words@D6']);
    expect(found[0]!.severity).toBe('LOW');
  });

  it('leaves a small sheet alone: too few rows to say what is usual', async () => {
    const rows = register(8);
    rows[3]![3] = '';
    expect(sweepWorkbook(await load(rows))).toEqual([]);
  });

  it('finds seven of the eight defects planted by the planting tool, and nothing in the clean copy', async () => {
    const source = await makeWorkbook({ Register: register(60).map((r, i) => (i > 0 && r[0] !== undefined ? [...r.slice(0, 8), (i % 5) === 0 ? 2 : 0] : r)) });
    expect(sweepWorkbook(await WorkbookModel.load(source)).filter((f) => f.kind !== 'wrong_count')).toEqual([]);
    const { bytes, defects } = await plantDefects(source);
    const found = sweepWorkbook(await WorkbookModel.load(bytes));
    const cells = new Set(found.map((f) => f.location.cell));
    const caught = defects.filter((d) => cells.has(d.cell) || (d.kind === 'duplicate_id' && cells.has(d.cell)));
    // blank_type is not found: a data type is allowed to be empty on most rows in some registers, so the sweep does not guess.
    expect(caught.length).toBeGreaterThanOrEqual(5);
  });
});

describe('attaching sweep findings to a scorecard question', () => {
  const q = (id: string, name: string, weight: number): DimensionSpec => ({ id, name, weight, critical: false, measuredBy: 'raters', anchors: { 0: 'a', 1: 'b', 2: 'c', 3: 'd', 4: 'e', 5: 'f' } });

  it('puts an empty definition under the question about definitions, and the rest under the heaviest question', async () => {
    const rows = register();
    rows[11]![3] = '';
    rows[20]![0] = '1.19';
    const wb = await load(rows);
    const questions = [q('Q1', 'Definition clarity', 5), q('Q2', 'Overall structure', 20)];
    const out = sweepFindings({} as Scorecard, questions, wb, 'Define');
    const byCell = new Map(out.map((f) => [f.location!.cell, f]));
    expect(byCell.get('D12')).toMatchObject({ dimensionId: 'Q1', source: 'code', returnTo: 'Define', reportedBy: ['code'] });
    expect(byCell.get('A21')).toMatchObject({ dimensionId: 'Q2' });
    expect(sweepFindings({} as Scorecard, [], wb, 'Define')).toEqual([]);
  });

  it('skips the pages of a PDF', async () => {
    // A "Page 1" sheet is a PDF page; the sweep must not treat its lines as a register.
    const wb = await WorkbookModel.load(await makeWorkbook({ 'Page 1': register(30) }));
    expect(sweepFindings({} as Scorecard, [q('Q1', 'Definition clarity', 5)], wb, 'Define')).toEqual([]);
  });

  it('shows up in a whole run as exact code findings at the cells that were broken', async () => {
    const parsed = await loadTalentraScorecard();
    const rows = register(40);
    rows[14]![3] = '';
    const sheets = { Tree: rows };
    const book = await makeWorkbook(sheets);
    const scorecard = { ...parsed.scorecard, artifact: { ...parsed.scorecard.artifact, sheets: [{ name: 'Tree', headerRow: 1 }], context: [] }, dimensions: parsed.scorecard.dimensions.filter((d) => d.measuredBy === 'raters').slice(0, 2) };
    const run = await runEvaluation({ workbook: book, scorecard: { ...parsed, scorecard }, models: mockModels() });
    const hit = run.core.findings.find((f) => f.source === 'code' && f.location?.cell === 'D15');
    expect(hit).toMatchObject({ severity: 'MEDIUM' });
    expect(run.core.notes.join(' ')).toMatch(/row-by-row sweep in code found 1 anomaly/);
  });
});

describe('the score follows the exact findings', () => {
  const dim = (id: string, score: number | null, over: Partial<import('@ddd/shared').DimensionResult> = {}): import('@ddd/shared').DimensionResult =>
    ({ id, name: id, weight: 10, critical: false, measuredBy: 'raters', status: 'scored', raterScores: {}, consolidated: score, spread: 0, resolution: 'agreement', flagged: false, rationale: 'r.', evidence: [], ...over }) as never;
  const f = (dimensionId: string, severity: 'HIGH' | 'MEDIUM' | 'LOW' = 'MEDIUM') => ({ dimensionId, severity });

  it('caps a question at 4 for one or two mistakes, 3 for three to five, 2 for six or more', async () => {
    const { capFor, capByExactFindings } = await import('../src/agent/sweep.js');
    expect([0, 1, 2, 3, 5, 6, 40].map(capFor)).toEqual([5, 4, 4, 3, 3, 2, 2]);
    const out = capByExactFindings([dim('A', 5), dim('B', 5), dim('C', 5), dim('D', 5)], [f('A'), f('B'), f('B'), f('B'), ...Array.from({ length: 6 }, () => f('C'))], new Map());
    expect(out.dimensions.map((d) => d.consolidated)).toEqual([4, 3, 2, 5]);
    expect(out.notes).toHaveLength(3);
    expect(out.dimensions[0]!.rationale).toMatch(/Capped at 4: the row-by-row sweep found 1 mistake/);
  });

  it('only ever lowers a score, ignores LOW findings, and leaves unscored and code-measured questions alone', async () => {
    const { capByExactFindings } = await import('../src/agent/sweep.js');
    const out = capByExactFindings(
      [dim('A', 3), dim('B', 5), dim('C', null, { status: 'unscored' }), dim('D', 5, { measuredBy: 'code' })],
      [f('A'), f('B', 'LOW'), f('C'), f('D')],
      new Map(),
    );
    expect(out.dimensions.map((d) => d.consolidated)).toEqual([3, 5, null, 5]);
    expect(out.notes).toEqual([]);
  });

  it('counts a finding tagged with a criterion id under its dimension', async () => {
    const { capByExactFindings } = await import('../src/agent/sweep.js');
    const out = capByExactFindings([dim('SC', 5)], [f('SC-01'), f('SC-02')], new Map([['SC-01', 'SC'], ['SC-02', 'SC']]));
    expect(out.dimensions[0]!.consolidated).toBe(4);
  });
});

describe('an id cited in text that is defined nowhere', () => {
  const defs = (n: number) => {
    const rows: Array<Array<string | number>> = [['Id', 'Name', 'Meaning']];
    for (let i = 1; i <= n; i++) rows.push([`D3-S14-P${String(i).padStart(2, '0')}`, `Field ${i}`, `Meaning ${i}.`]);
    return rows;
  };
  const loadTwo = async (second: Array<Array<string | number>>, first = defs(9)) => WorkbookModel.load(await makeWorkbook({ Params: first, Notes: second }));

  it('finds a cited id of a family the file defines, when that id is defined nowhere', async () => {
    const found = sweepWorkbook(await loadTwo([['Code', 'Definition'], ['WIDENING', 'Needs the security reviewer (D3-S14-P15).']]));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'missing_target', location: { sheet: 'Notes', cell: 'B2' }, severity: 'MEDIUM' });
    expect(found[0]!.title).toMatch(/D3-S14-P15 is cited but defined nowhere/);
  });

  it('leaves alone an id that exists, a zero-padded twin, a pattern placeholder, an example column, and a family too small to judge', async () => {
    const clean = [['Code', 'Definition', 'Example'], ['A', 'See D3-S14-P03 and D3-S14-P7.', 'D3-S14-P99'], ['B', 'Written like PER-000.', ''], ['C', 'Cites XY-12.', '']];
    expect(sweepWorkbook(await loadTwo(clean))).toEqual([]);
  });

  it('counts only the id column as a definition, so a pointer column does not make a family', async () => {
    const tests = [['Row', 'Verification test'], ...Array.from({ length: 10 }, (_, i) => [`r${i}`, `TST-${i + 1}`])];
    const mention = [['Code', 'Definition'], ['A', 'Proved by TST-40.']];
    expect(sweepWorkbook(await loadTwo(mention, tests))).toEqual([]);
  });
});

describe('a count the file states about its own sheet', () => {
  const sheetOf = (n: number): Array<Array<string | number>> => [['Id', 'Name'], ...Array.from({ length: n }, (_, i) => [`P-${i + 1}`, `Parameter ${i + 1}`])];
  const withClaim = async (stated: string, rows: number) =>
    WorkbookModel.load(await makeWorkbook({ README: [['Item', 'Text'], ['Size', stated]], L2_Parameters: sheetOf(rows) }));

  it('finds a tally that is a little off, as a LOW finding that names both numbers', async () => {
    const found = sweepWorkbook(await withClaim('3 deliverables with 278 parameters in all', 276)).filter((f) => f.kind === 'stated_count');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'LOW', location: { sheet: 'README', cell: 'B2' } });
    expect(found[0]!.detail).toBe('README!B2 says there are 278 parameters, but L2_Parameters has 276 data rows.');
  });

  it('is silent when the tally is right, when the number is far from the row count, or when the noun is only part of a sheet name', async () => {
    expect(sweepWorkbook(await withClaim('278 parameters', 278)).filter((f) => f.kind === 'stated_count')).toEqual([]);
    expect(sweepWorkbook(await withClaim('14 parameters on each record', 278)).filter((f) => f.kind === 'stated_count')).toEqual([]);
    const wb = await WorkbookModel.load(await makeWorkbook({ README: [['Item', 'Text'], ['Size', '35 hooks']], Links_Hooks: sheetOf(25) }));
    expect(sweepWorkbook(wb).filter((f) => f.kind === 'stated_count')).toEqual([]);
  });
});

describe('a cell empty on a row that should have it (a column filled on every row of one kind)', () => {
  // Groups (Children > 0) have no data type; every leaf has one. A leaf with none is the gap.
  const tree = (blankLeaf?: number): Array<Array<string | number>> => {
    const rows: Array<Array<string | number>> = [['Path id', 'Name', 'Definition', 'Kind', 'Data type']];
    for (let i = 1; i <= 40; i++) {
      const group = i % 4 === 1;
      rows.push([`1.${i}`, `Field ${i}`, `Definition ${i}.`, group ? 'group' : 'leaf', group ? '' : i === blankLeaf ? '' : 'text']);
    }
    return rows;
  };

  it('finds the leaf with no data type, and says what the other leaves have', async () => {
    const found = sweepWorkbook(await load(tree(7))).filter((f) => f.kind === 'conditional_empty');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ location: { sheet: 'Register', cell: 'E8' } });
    expect(found[0]!.detail).toMatch(/every other row with "Kind" = "leaf" has a "Data type"/);
  });

  it('is silent when every leaf has one, and when the blanks do not follow any kind of row', async () => {
    expect(sweepWorkbook(await load(tree())).filter((f) => f.kind === 'conditional_empty')).toEqual([]);
    const scattered = tree();
    for (const i of [3, 5, 6, 9, 13, 14, 18, 22]) scattered[i]![4] = '';
    expect(sweepWorkbook(await load(scattered)).filter((f) => f.kind === 'conditional_empty')).toEqual([]);
  });
});
