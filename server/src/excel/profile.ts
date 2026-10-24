import { estimateTokens } from '../agent/rater.js';
import { columnLetters, type WorkbookModel } from './workbook.js';
import { serializeSheet } from './serialize.js';

/**
 * A profile of a workbook, built once by code: for every sheet its real header row, its id column and its size, and for
 * every column what it holds and how full it is. It is the one source of facts the rest of the app uses to adapt to a
 * workbook in any layout: which columns a question should read, whether a finding is contradicted by the file, how
 * big a prompt will be, and which column a count runs on. Built from the file alone, so the same file always gives
 * the same profile; no model is involved.
 */

export type ColumnKind = 'id' | 'number' | 'code' | 'text' | 'formula' | 'empty';

export interface ColumnProfile {
  /** Excel letter, e.g. "M". */
  letter: string;
  /** 1-based column number. */
  index: number;
  /** The header title as written (whitespace collapsed); "" when the column has no title. */
  title: string;
  /** Data rows (below the header) with a value in this column. */
  filled: number;
  /** Data rows in the sheet. */
  total: number;
  /** filled / total, 0 when the sheet has no data rows. */
  fillRate: number;
  kind: ColumnKind;
  /** Distinct non-empty values. */
  distinct: number;
  /** Up to three short example values, first seen first. */
  samples: string[];
  /** Mean length of the non-empty values, in characters. */
  avgLength: number;
}

export interface SheetProfile {
  name: string;
  headerRow: number;
  /** Last row with any value. */
  rows: number;
  /** Rows below the header that have at least one value. */
  dataRows: number;
  /** The title of the column that identifies rows (unique, filled, short), or null. */
  idColumn: string | null;
  columns: ColumnProfile[];
  /** Estimated tokens to send the whole sheet to a model. */
  tokens: number;
}

export interface WorkbookProfile {
  sheets: SheetProfile[];
}

const SAMPLE_CHARS = 40;
/** Header detection looks this far down; title blocks above a table are rarely longer. */
const HEADER_SCAN_ROWS = 10;

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * The header row of a sheet: the row in the top ten with the most cells of real words, the earliest on a tie. Titles and notes
 * above it have few, and a row of numbers or path ids such as "4.1.1" is not a row of column names.
 */
export function detectHeaderRow(wb: WorkbookModel, sheet: string): number {
  const filled = new Map<number, number>();
  for (const [row, , text] of wb.cells(sheet)) {
    if (row <= HEADER_SCAN_ROWS && /[A-Za-z]/.test(text)) filled.set(row, (filled.get(row) ?? 0) + 1);
  }
  let best = 1;
  let most = 0;
  for (const [row, count] of [...filled].sort((a, b) => a[0] - b[0])) {
    if (count > most) {
      best = row;
      most = count;
    }
  }
  return most >= 2 ? best : 1;
}

function kindOf(values: string[], distinct: number): ColumnKind {
  if (values.length === 0) return 'empty';
  const share = (test: (v: string) => boolean) => values.filter(test).length / values.length;
  if (share((v) => v.startsWith('=')) >= 0.5) return 'formula';
  if (share((v) => /^-?\d+(\.\d+)?%?$/.test(v)) >= 0.9) return 'number';
  const short = share((v) => v.length <= 40 && !/\s{1}\S+\s\S+\s/.test(v));
  // An id: short, almost all different, and shaped like an identifier (letters and digits with separators).
  if (distinct >= values.length * 0.95 && short >= 0.95 && share((v) => /^[A-Za-z0-9][\w.\-/:]*\d[\w.\-/:]*$/.test(v)) >= 0.8) return 'id';
  // A code: short values from a small set (a status, a type, a yes/no).
  if (short >= 0.95 && distinct <= Math.max(12, values.length * 0.2)) return 'code';
  return 'text';
}

export function profileSheet(wb: WorkbookModel, name: string): SheetProfile {
  const headerRow = detectHeaderRow(wb, name);
  const titles = new Map<number, string>();
  const values = new Map<number, string[]>();
  const dataRowSet = new Set<number>();
  let rows = 0;
  let maxCol = 0;
  for (const [row, col, text] of wb.cells(name)) {
    rows = Math.max(rows, row);
    maxCol = Math.max(maxCol, col);
    if (row === headerRow) titles.set(col, squash(text));
    else if (row > headerRow && text.trim() !== '') {
      dataRowSet.add(row);
      if (!values.has(col)) values.set(col, []);
      values.get(col)!.push(squash(text));
    }
  }
  const total = dataRowSet.size;
  const columns: ColumnProfile[] = [];
  for (let col = 1; col <= maxCol; col++) {
    const vals = values.get(col) ?? [];
    const title = titles.get(col) ?? '';
    if (!title && vals.length === 0) continue;
    const distinct = new Set(vals).size;
    columns.push({
      letter: columnLetters(col),
      index: col,
      title,
      filled: vals.length,
      total,
      fillRate: total > 0 ? vals.length / total : 0,
      kind: kindOf(vals, distinct),
      distinct,
      samples: [...new Set(vals)].slice(0, 3).map((v) => (v.length > SAMPLE_CHARS ? `${v.slice(0, SAMPLE_CHARS - 1)}…` : v)),
      avgLength: vals.length > 0 ? Math.round(vals.reduce((sum, v) => sum + v.length, 0) / vals.length) : 0,
    });
  }
  // The id column: the leftmost id-shaped column that is nearly always filled.
  const id = columns.find((c) => c.title && c.kind === 'id' && c.fillRate >= 0.9) ?? null;
  return {
    name,
    headerRow,
    rows,
    dataRows: total,
    idColumn: id?.title ?? null,
    columns,
    tokens: estimateTokens(serializeSheet(wb, { name, headerRow: 1 })),
  };
}

const cache = new WeakMap<WorkbookModel, WorkbookProfile>();

/** The profile of a workbook. Computed once per loaded workbook and kept with it. */
export function profileWorkbook(wb: WorkbookModel): WorkbookProfile {
  const known = cache.get(wb);
  if (known) return known;
  const profile = { sheets: wb.sheetNames().map((name) => profileSheet(wb, name)) };
  cache.set(wb, profile);
  return profile;
}

export function sheetProfile(profile: WorkbookProfile, name: string): SheetProfile | undefined {
  const wanted = name.trim().toLowerCase();
  return profile.sheets.find((s) => s.name.toLowerCase() === wanted);
}

const key = (text: string) => squash(text).toLowerCase();

/** A column by its title, ignoring case and spacing. */
export function columnProfile(profile: WorkbookProfile, sheet: string, title: string): ColumnProfile | undefined {
  return sheetProfile(profile, sheet)?.columns.find((c) => key(c.title) === key(title));
}

const STOP_WORDS = new Set([
  'with', 'that', 'this', 'from', 'each', 'every', 'have', 'into', 'only', 'what', 'which', 'score', 'file', 'their', 'there',
  'where', 'when', 'judge', 'check', 'records', 'about', 'does', 'item', 'items', 'stated', 'state', 'whether', 'list',
]);

/** The words of a text, cut to a five-letter stem so "validation" also matches "Validation rule" and "validated". */
export function stems(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP_WORDS.has(w)).map((w) => w.slice(0, 5)));
}

export interface RankedColumn {
  column: ColumnProfile;
  /** Higher is more relevant. 0 means nothing in common with the question. */
  score: number;
}

/**
 * The columns of a sheet that matter most for a question: words shared with the title count most, words shared with the
 * values count a little, and an empty column counts for nothing. Deterministic, so a question always reads the same columns.
 */
export function rankColumns(sheet: SheetProfile, question: string): RankedColumn[] {
  const words = stems(question);
  return sheet.columns
    .filter((c) => c.title && c.kind !== 'empty' && c.kind !== 'formula')
    .map((column) => {
      const inTitle = [...stems(column.title)].filter((w) => words.has(w)).length;
      const inValues = [...stems(column.samples.join(' '))].filter((w) => words.has(w)).length;
      const score = (inTitle * 3 + inValues) * (0.5 + column.fillRate / 2);
      return { column, score };
    })
    .sort((a, b) => b.score - a.score || a.column.index - b.column.index);
}

/**
 * Which columns a question should read from a sheet: the id column, then the most relevant columns, at most `max` in all,
 * in sheet order. When nothing matches the question, the fullest text columns are used, so the examiners still see content.
 */
export function pickColumns(sheet: SheetProfile, question: string, max = 8): string[] {
  const ranked = rankColumns(sheet, question);
  const relevant = ranked.filter((r) => r.score > 0).map((r) => r.column);
  const fallback = ranked
    .map((r) => r.column)
    .filter((c) => c.kind === 'text' || c.kind === 'code')
    .sort((a, b) => b.fillRate * b.avgLength - a.fillRate * a.avgLength);
  const chosen: ColumnProfile[] = [];
  const id = sheet.columns.find((c) => c.title === sheet.idColumn);
  if (id) chosen.push(id);
  for (const c of [...relevant, ...(relevant.length > 0 ? [] : fallback)]) {
    if (chosen.length >= max) break;
    if (!chosen.includes(c)) chosen.push(c);
  }
  if (chosen.length === 0 && sheet.columns[0]?.title) chosen.push(sheet.columns[0]);
  return chosen.sort((a, b) => a.index - b.index).map((c) => c.title);
}

/** A compact description of the workbook for a model: per sheet, the header row, size and id, and per column what it holds. */
export function describeProfile(profile: WorkbookProfile, maxColumns = 60): string {
  return profile.sheets
    .map((s) => {
      const cols = s.columns
        .filter((c) => c.title)
        .slice(0, maxColumns)
        .map((c) => `  ${c.letter} "${c.title}": ${c.kind}, ${Math.round(c.fillRate * 100)}% filled${c.samples.length ? `, e.g. ${c.samples.map((v) => JSON.stringify(v)).join(', ')}` : ''}`);
      return [`${s.name} (header row ${s.headerRow}, ${s.dataRows} data rows, about ${s.tokens.toLocaleString('en')} tokens${s.idColumn ? `, id column "${s.idColumn}"` : ''}):`, ...cols].join('\n');
    })
    .join('\n');
}
