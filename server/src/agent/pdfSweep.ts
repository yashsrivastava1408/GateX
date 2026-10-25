import { columnLetters, WorkbookModel } from '../excel/workbook.js';
import type { GridTable, RawGrid } from '../excel/xlsxReader.js';
import { profileWorkbook, type WorkbookProfile } from '../excel/profile.js';
import { MIN_ROWS, sweepSheet, type SweepFinding, type SweepOptions } from './sweep.js';
import { statedChildLimit, statedIdPattern, sweepCrossReferences, sweepIdFormats, sweepNearMissValues, sweepOrphanRows, sweepRestatedReasons, sweepWidth } from './sweepDeep.js';

/**
 * The row sweep over the tables of a PDF. A PDF page is one column of text lines, so the sweep (which reads columns) skipped it. Here the table
 * rows that `excel/pdfTables.ts` rebuilt from the page are put back together as ordinary sheets, and the same row checks run on them:
 *
 *   - Tables that share a header (the docket repeats "ID | Field | What to write | ..." on every page of a section) are ONE table, and a row
 *     that breaks across a page (its first column empty) is joined to the row it continues.
 *   - A wrapped cell is already one cell (the reader joins its lines). A row is left out of the sweep when any of its cells runs under an empty
 *     neighbour (a cell spanning two columns) or when it is a heading band (one or two cells filled in a table of five or more columns): a
 *     merged cell is never read as an empty one.
 *   - A table needs MIN_ROWS rows to be swept, and every rule keeps its own "the column plainly follows the pattern" test, so a table whose
 *     columns could not be read cleanly stays silent.
 *
 * Results point at the line of the page where the row sits ("Page 41!A12"), like any other finding on a PDF.
 */

/** Columns of a header must be at least this many for the table to be a table. */
const MIN_HEADER_CELLS = 3;
/** A table must span this many pages (its header repeats on each) to be swept. */
const MIN_PAGES = 2;
/** A row is whole when at least this share of its cells are filled; a table is read right when nearly all its rows are whole. */
const WHOLE_ROW = 0.7;
const MIN_WHOLE_ROWS = 0.9;
/** A first column filled in at least this share of the rows can tell a row from the continuation of the row above. */
const KEY_FILLED = 0.9;
const MAX_HEADER_CELL = 40;
const MAX_HEADER_WORDS = 5;
/** Column starts of two pages' tables agree when none differs by more than this many points. */
const SAME_X = 4;

interface Origin {
  page: string;
  line: number;
}
interface Group {
  headers: string[];
  x: number[];
  rows: Array<{ cells: string[]; merged: boolean; origin: Origin }>;
  pages: number[];
}

/** The rows of the PDF's tables as sheets, and where each row sits in the PDF. */
export interface PdfTableSet {
  wb: WorkbookModel;
  profile: WorkbookProfile;
  /** Per virtual sheet: origin of each row, by the sheet's row number. */
  origins: Map<string, Map<number, Origin>>;
  /** Per virtual sheet: how many columns it has. */
  widths: Map<string, number>;
}

const squash = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '');
const pageNumber = (sheet: string) => Number(/\d+/.exec(sheet)?.[0] ?? 0);

/**
 * A header names its columns: several short, different cells of plain words. A data row read as a header (a page that has no header of its
 * own) has cells cut mid-word ("D3-", "enum-"), the same cell twice, or digits; those are not headers.
 */
function headerLike(cells: string[]): boolean {
  const filled = cells.filter((c) => c !== '');
  const distinct = new Set(filled.map(squash));
  return (
    filled.length >= MIN_HEADER_CELLS &&
    distinct.size === filled.length &&
    filled.every((c) => c.length <= MAX_HEADER_CELL && c.split(/\s+/).length <= MAX_HEADER_WORDS && (c.match(/[A-Za-z]/g) ?? []).length >= 2 && !/\d/.test(c) && !/[-\u2010-\u2013(/]$/.test(c) && !/^[a-z]/.test(c[0] === undefined ? '' : c))
  );
}

/** The cells of a page table reduced to its titled columns: an untitled column belongs to the titled one on its left. */
function titledCells(table: GridTable, cells: string[]): string[] {
  const out: string[] = [];
  cells.forEach((c, i) => {
    if (table.headers[i] !== '' || out.length === 0) out.push(c);
    else if (c !== '') out[out.length - 1] = `${out[out.length - 1]} ${c}`.trim();
  });
  return out;
}

const titledHeaders = (table: GridTable): string[] => table.headers.filter((h, i) => h !== '' || i === 0);

function groupTables(wb: WorkbookModel): Group[] {
  const groups = new Map<string, Group>();
  for (const { sheet, table } of wb.pdfTables()) {
    const headers = titledHeaders(table);
    const toRow = (r: GridTable['rows'][number]) => ({ cells: titledCells(table, r.cells), merged: r.merged, origin: { page: sheet, line: r.line } });
    let group: Group | null = null;
    const rows = table.rows.map(toRow);
    if (headerLike(headers)) {
      const sig = headers.map(squash).join('|');
      group = groups.get(sig) ?? { headers, x: table.x, rows: [], pages: [] };
      groups.set(sig, group);
    }
    if (!group) continue;
    group.pages.push(pageNumber(sheet));
    group.rows.push(...rows.filter((r) => r.cells.length === group!.headers.length));
  }
  return [...groups.values()];
}

/** The rows of a group that are entries: repeated headers, heading bands and merged-cell rows left out, broken rows joined. */
function entryRows(group: Group): Group['rows'] {
  const sig = group.headers.map(squash).join('|');
  const columns = group.headers.length;
  const rows = group.rows.filter((r) => r.cells.map(squash).join('|') !== sig && squash(r.cells.filter(Boolean).join('|')) !== squash(group.headers.join('|')));
  // A row whose first column is empty continues the row above it, when the first column is otherwise always filled (the id of a row never wraps to nothing).
  const keyFilled = rows.filter((r) => r.cells[0] !== '').length / Math.max(rows.length, 1);
  const joined: Group['rows'] = [];
  for (const r of rows) {
    const prev = joined[joined.length - 1];
    if (prev && keyFilled >= KEY_FILLED && r.cells[0] === '') {
      prev.cells = prev.cells.map((c, i) => `${c} ${r.cells[i] ?? ''}`.trim());
      prev.merged = prev.merged || r.merged;
    } else joined.push({ ...r, cells: [...r.cells] });
  }
  const bandMax = columns >= 5 ? 2 : 0;
  return joined.filter((r) => !r.merged && r.cells.filter((c) => c !== '').length > bandMax);
}

/**
 * Rows read right are mostly whole. Text centred in tall cells, or rows cut where the text does not allow it, leave fragments (an id and
 * nothing else, a type and nothing else): when more than one row in ten is such a fragment, the table was not read right and says nothing.
 */
function coherent(rows: Group['rows'], columns: number): boolean {
  const whole = rows.filter((r) => r.cells.filter((c) => c !== '').length >= Math.ceil(columns * WHOLE_ROW)).length;
  return whole / rows.length >= MIN_WHOLE_ROWS;
}

const built = new WeakMap<WorkbookModel, PdfTableSet | null>();

/** Rebuilds the tables of a PDF as sheets; null when the file is not a PDF or has no table large enough to sweep. Built once per file. */
export function pdfTableSet(wb: WorkbookModel): PdfTableSet | null {
  if (!built.has(wb)) built.set(wb, buildTableSet(wb));
  return built.get(wb) ?? null;
}

function buildTableSet(wb: WorkbookModel): PdfTableSet | null {
  if (wb.pdfTables().length === 0) return null;
  const grids = new Map<string, RawGrid>();
  const origins = new Map<string, Map<number, Origin>>();
  const widths = new Map<string, number>();
  for (const group of groupTables(wb)) {
    // A table that runs over two pages or more has its header repeated, which a data row misread as a header never does.
    if (new Set(group.pages).size < MIN_PAGES) continue;
    const rows = entryRows(group);
    if (rows.length < MIN_ROWS || !coherent(rows, group.headers.length)) continue;
    const pages = group.pages.filter(Boolean);
    const span = pages.length === 0 ? '' : ` (pages ${Math.min(...pages)}-${Math.max(...pages)})`;
    let name = `PDF table ${group.headers.slice(0, 3).join('/')}${span}`;
    for (let n = 2; grids.has(name); n++) name = `PDF table ${group.headers.slice(0, 3).join('/')}${span} #${n}`;
    const grid: RawGrid = { cells: new Map(), maxRow: rows.length + 1, maxCol: group.headers.length };
    group.headers.forEach((h, c) => grid.cells.set(`${columnLetters(c + 1)}1`, h));
    const from = new Map<number, Origin>();
    rows.forEach((r, i) => {
      r.cells.forEach((text, c) => text !== '' && grid.cells.set(`${columnLetters(c + 1)}${i + 2}`, text));
      from.set(i + 2, r.origin);
    });
    grids.set(name, grid);
    origins.set(name, from);
    widths.set(name, group.headers.length);
  }
  if (grids.size === 0) return null;
  const set = WorkbookModel.fromGrids(grids);
  return { wb: set, profile: profileWorkbook(set), origins, widths };
}

/** Findings point at the PDF: the page and the line of the row, with the virtual cell address in the text turned into the same words. */
function toPage(set: PdfTableSet, f: SweepFinding): SweepFinding {
  const origin = set.origins.get(f.location.sheet)?.get(Number(/\d+/.exec(f.location.cell)?.[0]));
  if (!origin) return f;
  const cols = set.widths.get(f.location.sheet) ?? 0;
  const rowMap = set.origins.get(f.location.sheet)!;
  const say = (text: string): string =>
    text
      .replace(new RegExp(`${f.location.sheet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}!([A-Z]{1,2})(\\d+)`, 'g'), (m, _l, r) => {
        const o = rowMap.get(Number(r));
        return o ? `${o.page}, line ${o.line}` : m;
      })
      .replace(/\brows? (\d+)\b/g, (m, r) => {
        const o = rowMap.get(Number(r));
        return o ? `the row at ${o.page}, line ${o.line}` : m;
      })
      .replace(/\b(at|Fill|Change|in) ([A-Z]{1,2})(\d+)\b/g, (m, w, l, r) => {
        const o = rowMap.get(Number(r));
        return o && l.charCodeAt(0) - 64 <= cols ? `${w} ${o.page}, line ${o.line}` : m;
      });
  return { ...f, location: { sheet: origin.page, cell: `A${origin.line}` }, title: say(f.title), detail: say(f.detail), fix: say(f.fix) };
}

/** The listed row checks over the PDF's tables (empty cells, repeated ids, dangling references, child counts, filler, odd Required values). */
export function sweepPdfTables(wb: WorkbookModel, options: SweepOptions = {}): SweepFinding[] {
  const set = pdfTableSet(wb);
  if (!set) return [];
  return set.profile.sheets.flatMap((sheet) => sweepSheet(set.wb, sheet, options)).map((f) => toPage(set, f));
}

/** The deep checks (counted into exact scores only) over the PDF's tables. */
export function sweepPdfDeep(wb: WorkbookModel, options: SweepOptions = {}): SweepFinding[] {
  const set = pdfTableSet(wb);
  if (!set) return [];
  const found = [...sweepCrossReferences(set.wb, set.profile, options), ...sweepOrphanRows(set.wb, set.profile, options), ...sweepNearMissValues(set.wb, set.profile, options), ...sweepRestatedReasons(set.wb, set.profile, options)];
  return found.map((f) => toPage(set, f));
}

/** The id-pattern and parent-width counts over the PDF's tables, for the criteria whose own words state the pattern or the limit. */
export function pdfOwnChecks(wb: WorkbookModel, family: 'idformat' | 'width', text: string, options: SweepOptions = {}): { found: SweepFinding[]; looked: number } | null {
  const set = pdfTableSet(wb);
  if (!set) return null;
  const r = family === 'idformat' ? sweepIdFormats(set.wb, set.profile, statedIdPattern(text), { ...options, isolatedOnly: true }) : sweepWidth(set.wb, set.profile, statedChildLimit(text), options);
  return { found: r.found.map((f) => toPage(set, f)), looked: r.looked };
}
