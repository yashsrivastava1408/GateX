import { describe, expect, it } from 'vitest';
import PDFDocument from 'pdfkit';
import { WorkbookModel } from '../src/excel/workbook.js';
import type { RawGrid } from '../src/excel/xlsxReader.js';
import { exactCeilingsFor, exactCoverage } from '../src/agent/exactScore.js';
import { pdfOwnChecks, pdfTableSet, sweepPdfDeep, sweepPdfTables } from '../src/agent/pdfSweep.js';
import { emptyStats, sweepAll } from '../src/agent/sweep.js';
import type { DimensionSpec } from '@ddd/shared';

/**
 * A PDF with a table the way real ones are made: each cell is text wrapped inside its column, a row is as tall as its tallest cell, the
 * header repeats on every page. Rows are [id, field, why, type, source].
 */
const HEAD = ['ID', 'Field', 'What it is for', 'Type', 'Source'];
const X = [40, 100, 190, 380, 450];
const W = [55, 85, 185, 65, 90];
interface Options {
  /** Cells drawn so that this row's cell [col] spans over the next column (a merged cell). */
  spanning?: Array<{ row: number; col: number }>;
  /** Rows (by index) drawn without a header on top: the table continues on a page that has none. */
  noHeaderOnPage?: number[];
  rowsPerPage?: number;
  /** A banner line drawn before this row index. */
  bannerBefore?: Record<number, string>;
}

function makePdf(rows: string[][], options: Options = {}): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const perPage = options.rowsPerPage ?? 12;
  doc.fontSize(8);
  let y = 60;
  const header = () => {
    HEAD.forEach((h, c) => doc.text(h, X[c]!, y, { width: W[c]!, lineBreak: false }));
    y += 20;
  };
  const page = (n: number) => {
    if (n > 0) doc.addPage();
    y = 60;
    doc.text(`Page heading ${n + 1}`, 40, y - 30, { lineBreak: false });
    if (!options.noHeaderOnPage?.includes(n)) header();
  };
  page(0);
  rows.forEach((row, i) => {
    if (i > 0 && i % perPage === 0) page(i / perPage);
    const banner = options.bannerBefore?.[i];
    if (banner) {
      doc.text(banner, X[0]!, y, { lineBreak: false });
      y += 18;
    }
    const span = options.spanning?.find((s) => s.row === i);
    let tall = 0;
    row.forEach((cell, c) => {
      if (cell === '') return;
      const width = span?.col === c ? W[c]! + W[c + 1]! : W[c]!;
      tall = Math.max(tall, doc.heightOfString(cell, { width }));
      doc.text(cell, X[c]!, y, { width });
    });
    y += Math.max(tall, 10) + 9;
  });
  doc.end();
  return done;
}

const LONG = 'This describes in some detail what the field is for, so a reader can tell why it exists and who relies on it downstream';
const field = (i: number, over: Partial<Record<number, string>> = {}): string[] => {
  const base = [`F-S01-${String(i).padStart(2, '0')}`, `field_${i}`, i % 3 === 0 ? LONG : `Short reason ${i}`, i % 2 ? 'Text(100)' : 'Enum', i % 4 ? 'ANALYST' : 'SYSTEM'];
  return base.map((v, c) => over[c] ?? v);
};
const register = (n = 30, over: Record<number, Partial<Record<number, string>>> = {}) => Array.from({ length: n }, (_, i) => field(i + 1, over[i] ?? {}));
const load = async (rows: string[][], options?: Options) => WorkbookModel.load(await makePdf(rows, options));

describe('the row sweep over the tables of a PDF', () => {
  it('rebuilds a table of wrapped cells that runs over three pages as ONE table with one row per entry', async () => {
    const wb = await load(register());
    const set = pdfTableSet(wb)!;
    expect(set).not.toBeNull();
    expect(set.profile.sheets).toHaveLength(1);
    expect(set.profile.sheets[0]!.dataRows).toBe(30);
    expect(set.profile.sheets[0]!.columns.map((c) => c.title)).toEqual(HEAD);
    // The row with the long wrapped reason is one cell, in the right column.
    const name = set.profile.sheets[0]!.name;
    expect(set.wb.cellText(name, 'C4')).toContain('who relies on it downstream');
    expect(set.wb.cellText(name, 'D4')).toBe('Text(100)');
  });

  it('finds nothing in a clean table, however much of it wraps', async () => {
    const wb = await load(register());
    const stats = emptyStats();
    expect(sweepAll(wb, { all: true, stats })).toEqual([]);
    expect(sweepPdfDeep(wb, { all: true, stats })).toEqual([]);
    expect(stats.rows).toBe(30);
    expect(stats.ids).toBe(30);
  });

  it('finds an empty cell in a full column, on the page and line where the row sits', async () => {
    const wb = await load(register(30, { 17: { 2: '' } }));
    const found = sweepPdfTables(wb, { all: true });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'empty_cell' });
    expect(found[0]!.location.sheet).toMatch(/^Page [23]$/);
    expect(found[0]!.detail).toContain('F-S01-18');
    expect(found[0]!.detail).toMatch(/Page \d+, line \d+/);
    // The finding points at a line that really holds that row.
    const at = wb.cellText(found[0]!.location.sheet, found[0]!.location.cell)!;
    expect(at).toContain('F-S01-18');
  });

  it('does not read a cell that wraps over several lines as empty', async () => {
    const rows = register(30, { 5: { 2: `${LONG} ${LONG} ${LONG}` }, 20: { 4: 'A VERY LONG SOURCE NAME THAT WRAPS' } });
    expect(sweepPdfTables(await load(rows), { all: true })).toEqual([]);
  });

  it('finds a repeated id across two pages', async () => {
    const wb = await load(register(40, { 25: { 0: 'F-S01-04' } }));
    const found = sweepPdfTables(wb, { all: true }).filter((f) => f.kind === 'duplicate_id');
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toContain('F-S01-04');
  });

  it('leaves out a row whose cell spans two columns (merged), so the empty neighbour is not read as a gap', async () => {
    const rows = register(30);
    rows[9]![2] = 'One note that is meant to cover both the reason and the type of this entry across two columns of the table';
    rows[9]![3] = '';
    const wb = await load(rows, { spanning: [{ row: 9, col: 2 }] });
    expect(sweepPdfTables(wb, { all: true })).toEqual([]);
  });

  it('skips a heading band between groups of rows', async () => {
    const wb = await load(register(30), { bannerBefore: { 5: 'B S02 · 2 · Another group of fields', 20: 'B S03 · 3 · And a third group' } });
    expect(pdfTableSet(wb)!.profile.sheets[0]!.dataRows).toBe(30);
    expect(sweepPdfTables(wb, { all: true })).toEqual([]);
  });

  it('is silent for a table on one page (its header does not repeat)', async () => {
    const wb = await load(register(14, { 6: { 2: '' } }), { rowsPerPage: 40 });
    expect(pdfTableSet(wb)).toBeNull();
    expect(sweepPdfTables(wb, { all: true })).toEqual([]);
  });

  it('does not take the first row of a page without a header for a header', async () => {
    const wb = await load(register(36, { 30: { 2: '' } }), { noHeaderOnPage: [2] });
    // Page 3 has no header: its rows are not read (nothing is guessed), and nothing false is reported.
    expect(sweepPdfTables(wb, { all: true })).toEqual([]);
  });

  it('is silent when the rows could not be read right (many fragments)', () => {
    const cells = (n: number) => (i: number) => (i % 3 === 0 ? [`F-${n}`, 'name', '', '', 'ANALYST'] : [`F-${i}`, 'name', 'why', 'Text', 'ANALYST']);
    const grid = (page: number): RawGrid => ({
      cells: new Map([['A1', 'x']]), maxRow: 1, maxCol: 1,
      pdfTables: [{ headers: HEAD, x: X, rows: Array.from({ length: 20 }, (_, i) => ({ cells: cells(page)(i + page * 20), merged: false, line: i + 2 })) }],
    });
    const wb = WorkbookModel.fromGrids(new Map([['Page 1', grid(0)], ['Page 2', grid(1)]]));
    expect(pdfTableSet(wb)).toBeNull();
  });

  it('joins a row that breaks across a page (its first column is empty on the second page)', () => {
    const row = (id: string, why: string): { cells: string[]; merged: boolean; line: number } => ({ cells: [id, `f_${id}`, why, 'Text', 'ANALYST'], merged: false, line: 0 });
    const page1 = Array.from({ length: 14 }, (_, i) => ({ ...row(`F-${i + 1}`, `why ${i}`), line: i + 2 }));
    const page2 = [{ cells: ['', '', 'rest of the reason', '', ''], merged: false, line: 2 }, ...Array.from({ length: 14 }, (_, i) => ({ ...row(`F-${i + 20}`, `why ${i}`), line: i + 3 }))];
    // The last row of page 1 has an empty Source because that cell is on the next page, with the rest of the reason.
    page1[13]!.cells[4] = '';
    page2[0]!.cells[4] = 'ANALYST';
    const grid = (rows: typeof page1): RawGrid => ({ cells: new Map([['A1', 'x']]), maxRow: 1, maxCol: 1, pdfTables: [{ headers: HEAD, x: X, rows }] });
    const wb = WorkbookModel.fromGrids(new Map([['Page 1', grid(page1)], ['Page 2', grid(page2)]]));
    const set = pdfTableSet(wb)!;
    expect(set.profile.sheets[0]!.dataRows).toBe(28);
    expect(set.wb.cellText(set.profile.sheets[0]!.name, 'C15')).toBe('why 13 rest of the reason');
    expect(sweepPdfTables(wb, { all: true })).toEqual([]);
  });
});

describe('exact scores over the tables of a PDF', () => {
  const crit = (id: string, name: string): DimensionSpec => ({ id, name, weight: 1, critical: false, measuredBy: 'raters' }) as DimensionSpec;
  const qs = [crit('FILL', 'Cell fill: no blank cells'), crit('UNIQ', 'Every id is unique'), crit('PAT', 'Ids follow the id pattern')];

  it('counts a PDF the same way as a sheet: nothing wrong, no ceiling; a blank cell lowers the cell-fill question', async () => {
    const clean = await load(register());
    expect(exactCeilingsFor(qs, clean).size).toBe(0);
    expect(exactCoverage(qs, clean).get('FILL')).toEqual([{ family: 'empty', looked: 30 }]);
    // Without the tables of the PDF nothing is counted at all.
    expect(exactCoverage(qs, clean, { pdf: false }).size).toBe(0);
    const planted = await load(register(30, { 10: { 2: '' }, 22: { 3: '' } }));
    const c = exactCeilingsFor(qs, planted).get('FILL')!;
    expect(c).toMatchObject({ family: 'empty', mistakes: 2, looked: 30 });
    expect(c.ceiling).toBe(1);
  });

  it('counts a repeated id and an id that breaks the pattern, but not a second family of ids', async () => {
    const rows = register(40);
    rows[30]![0] = 'F-S01-5';
    const wb = await load(rows);
    const own = pdfOwnChecks(wb, 'idformat', 'ids follow the id pattern', { all: true })!;
    expect(own.found).toHaveLength(1);
    expect(own.found[0]!.detail).toContain('F-S01-5');
    // Three ids of another family (F-RB-01..03) are a family, not slips.
    const fam = register(40);
    fam[10]![0] = 'F-RB-01';
    fam[11]![0] = 'F-RB-02';
    fam[12]![0] = 'F-RB-03';
    expect(pdfOwnChecks(await load(fam), 'idformat', 'ids follow the id pattern', { all: true })!.found).toEqual([]);
  });
});
