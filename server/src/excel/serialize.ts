import type { SheetSpec } from '@ddd/shared';
import { UserError } from '../util/errors.js';
import { truncate } from '../util/text.js';
import { columnLetters, type WorkbookModel } from './workbook.js';

const MAX_CELL_CHARS = 400;

/**
 * Turns a sheet into text a model can cite from. Every non-empty cell is written with
 * its address (`H5="..."`), so a rater can point at the exact cell it relied on.
 * With `columns`, only those columns (and only the rows from the header down) are sent.
 */
export function serializeSheet(wb: WorkbookModel, spec: SheetSpec | string): string {
  const { name, headerRow, columns, rows } = typeof spec === 'string' ? { name: spec, headerRow: 1, columns: undefined, rows: undefined } : spec;
  const rowSet = rows ? new Set(rows) : null;
  const real = wb.resolveSheet(name);
  if (!real) return `## Sheet: ${name}\n(sheet not found)\n`;
  const size = wb.dimensions(real)!;

  let keep: Set<number> | null = null;
  let firstRow = headerRow;
  if (columns) {
    let table = wb.table(real, headerRow);
    let wanted = columns.map((title) => table.headers.find((h) => h.title === title));
    if (wanted.some((h) => !h)) {
      // The titles may come from another reading of the sheet than the header row given (a reused conversion pinned row 6; the file now has its titles on row 5).
      // If one nearby row holds every title, that row is the header; only when none does is the scorecard's column list wrong.
      const holder = headerRowHolding(wb, real, columns, size.rows);
      if (holder !== undefined) {
        firstRow = holder;
        table = wb.table(real, holder);
        wanted = columns.map((title) => table.headers.find((h) => h.title === title));
      }
    }
    const missing = columns.filter((_, i) => !wanted[i]);
    if (missing.length > 0) {
      throw new UserError(
        `Column "${missing[0]}" named by the scorecard was not found in sheet "${real}". Columns: ${table.headers.map((h) => h.title).join(', ')}`,
      );
    }
    keep = new Set(wanted.map((h) => h!.column.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0)));
  }

  const shown = keep ? `${keep.size} columns` : `columns A-${columnLetters(Math.max(size.cols, 1))}`;
  const lines = [`## Sheet: ${real} (${size.rows} rows, ${rowSet ? `${rowSet.size} supporting rows` : shown})`];

  let currentRow = -1;
  let parts: string[] = [];
  const flush = () => {
    if (parts.length > 0) lines.push(`r${currentRow}: ${parts.join(' ')}`);
    parts = [];
  };

  for (const [row, col, text] of wb.cells(real)) {
    if (rowSet && row !== headerRow && !rowSet.has(row)) continue;
    if (keep && (row < firstRow || !keep.has(col))) continue;
    if (row !== currentRow) {
      flush();
      currentRow = row;
    }
    parts.push(`${columnLetters(col)}${row}=${JSON.stringify(truncate(text, MAX_CELL_CHARS))}`);
  }
  flush();
  return lines.join('\n');
}

/** The first of the top rows whose cells include every one of these titles, if any. */
function headerRowHolding(wb: WorkbookModel, sheet: string, titles: string[], rows: number): number | undefined {
  for (let r = 1; r <= Math.min(rows, 30); r++) {
    const have = new Set(wb.table(sheet, r).headers.map((h) => h.title));
    if (titles.every((title) => have.has(title))) return r;
  }
  return undefined;
}

export function serializeSheets(wb: WorkbookModel, sheets: Array<SheetSpec | string>): string {
  return sheets.map((sheet) => serializeSheet(wb, sheet)).join('\n\n');
}
