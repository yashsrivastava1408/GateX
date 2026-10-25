import { readFile } from 'node:fs/promises';
import { UserError } from '../util/errors.js';
import { isPdf, readPdf } from './pdfReader.js';
import { readXlsx, type GridTable, type RawGrid } from './xlsxReader.js';
import { looksLikeCsv, readCsv } from './csvReader.js';

export interface Header {
  title: string;
  column: string;
}

export interface TableRow {
  row: number;
  /** Cell text by header title; '' when empty. */
  values: Map<string, string>;
}

export interface Table {
  sheet: string;
  headerRow: number;
  headers: Header[];
  rows: TableRow[];
  /** Address of a cell in this table by header title and row number, or undefined if no such header. */
  address(title: string, row: number): string | undefined;
}

export function columnLetters(index: number): string {
  let n = index;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export function parseAddress(address: string): { col: number; row: number; letters: string } | null {
  const match = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(address.trim());
  if (!match) return null;
  const letters = match[1]!.toUpperCase();
  return { col: columnIndex(letters), row: Number(match[2]), letters };
}

/** A read-only, in-memory copy of a workbook. Nothing here ever writes to the file. */
export class WorkbookModel {
  private readonly tables = new Map<string, Table>();

  private constructor(private readonly grids: Map<string, RawGrid>) {}

  static async load(source: string | Buffer): Promise<WorkbookModel> {
    const bytes = typeof source === 'string' ? await readFile(source) : source;
    if (isPdf(bytes)) return new WorkbookModel(await readPdf(bytes));
    return new WorkbookModel(looksLikeCsv(bytes) ? readCsv(bytes) : readXlsx(bytes));
  }

  /** A workbook made of ready grids (the tables of a PDF rebuilt as sheets). */
  static fromGrids(grids: Map<string, RawGrid>): WorkbookModel {
    return new WorkbookModel(grids);
  }

  /** The tables of a PDF's pages, in page order (none for any other kind of file). */
  pdfTables(): Array<{ sheet: string; table: GridTable }> {
    return [...this.grids].flatMap(([sheet, g]) => (g.pdfTables ?? []).map((table) => ({ sheet, table })));
  }

  sheetNames(): string[] {
    return [...this.grids.keys()];
  }

  /** Resolves a sheet name ignoring case; returns the real name or undefined. */
  resolveSheet(name: string): string | undefined {
    if (this.grids.has(name)) return name;
    const lower = name.trim().toLowerCase();
    return this.sheetNames().find((candidate) => candidate.toLowerCase() === lower);
  }

  /** Text of a cell: '' when empty, undefined when the sheet or the address is invalid. */
  cellText(sheet: string, address: string): string | undefined {
    const real = this.resolveSheet(sheet);
    const parsed = parseAddress(address);
    if (!real || !parsed) return undefined;
    return this.grids.get(real)!.cells.get(`${parsed.letters}${parsed.row}`) ?? '';
  }

  inBounds(sheet: string, address: string): boolean {
    const real = this.resolveSheet(sheet);
    const parsed = parseAddress(address);
    if (!real || !parsed) return false;
    const grid = this.grids.get(real)!;
    return parsed.row <= Math.max(grid.maxRow, 1) && parsed.col <= Math.max(grid.maxCol, 1);
  }

  dimensions(sheet: string): { rows: number; cols: number } | undefined {
    const real = this.resolveSheet(sheet);
    if (!real) return undefined;
    const grid = this.grids.get(real)!;
    return { rows: grid.maxRow, cols: grid.maxCol };
  }

  /** Non-empty cells of one sheet in reading order: [row, column index, text]. */
  cells(sheet: string): Array<[number, number, string]> {
    const real = this.resolveSheet(sheet);
    if (!real) return [];
    const out: Array<[number, number, string]> = [];
    for (const [address, text] of this.grids.get(real)!.cells) {
      const parsed = parseAddress(address)!;
      out.push([parsed.row, parsed.col, text]);
    }
    return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }

  table(sheet: string, headerRow = 1): Table {
    const real = this.resolveSheet(sheet);
    if (!real) {
      throw new UserError(`Sheet "${sheet}" was not found. Sheets in this file: ${this.sheetNames().join(', ')}`);
    }
    const key = `${real}#${headerRow}`;
    const cached = this.tables.get(key);
    if (cached) return cached;

    const grid = this.grids.get(real)!;
    const headers: Header[] = [];
    const seen = new Map<string, number>();
    for (let col = 1; col <= grid.maxCol; col++) {
      const letters = columnLetters(col);
      const raw = grid.cells.get(`${letters}${headerRow}`)?.trim();
      if (!raw) continue;
      const count = (seen.get(raw) ?? 0) + 1;
      seen.set(raw, count);
      headers.push({ title: count === 1 ? raw : `${raw} #${count}`, column: letters });
    }

    const rows: TableRow[] = [];
    for (let row = headerRow + 1; row <= grid.maxRow; row++) {
      const values = new Map<string, string>();
      let any = false;
      for (const header of headers) {
        const text = grid.cells.get(`${header.column}${row}`) ?? '';
        if (text !== '') any = true;
        values.set(header.title, text);
      }
      if (any) rows.push({ row, values });
    }

    const columnOf = new Map(headers.map((h) => [h.title, h.column]));
    const table: Table = {
      sheet: real,
      headerRow,
      headers,
      rows,
      address: (title, row) => {
        const column = columnOf.get(title);
        return column ? `${column}${row}` : undefined;
      },
    };
    this.tables.set(key, table);
    return table;
  }
}
