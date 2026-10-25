import { strFromU8, unzipSync } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { UserError } from '../util/errors.js';

/**
 * A small, read-only .xlsx reader. It pulls cell text straight out of the file's XML and
 * ignores drawings, charts, images and styles, which is why it opens files that general
 * spreadsheet libraries choke on. It never writes anything.
 */

export interface RawGrid {
  /** Cell text by address, e.g. "H5". Empty cells are absent. */
  cells: Map<string, string>;
  maxRow: number;
  maxCol: number;
  /** Only for a PDF page that holds tables: their columns and rows, each row with the line (row of this grid) it was read as. */
  pdfTables?: GridTable[];
}

export interface GridTable {
  /** The header cells, one per column. */
  headers: string[];
  /** The x start of each column on the page. */
  x: number[];
  rows: Array<{ cells: string[]; merged: boolean; line: number }>;
}

const ARRAYS = new Set(['row', 'c', 'si', 'r', 'sheet', 'Relationship', 'xf', 'numFmt']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  isArray: (name) => ARRAYS.has(name),
});

type Node = Record<string, unknown>;

function textOf(node: unknown): string {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf((node as Node)['#text']);
}

/** Shared-string and inline-string items: plain <t>, or rich text made of <r><t> runs. */
function richText(item: unknown): string {
  if (!item || typeof item !== 'object') return textOf(item);
  const node = item as Node;
  if (node.r) return (node.r as Node[]).map((run) => textOf(run.t)).join('');
  return textOf(node.t);
}

function columnNumber(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function isDateFormat(code: string): boolean {
  const stripped = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[ymdhs]/i.test(stripped);
}

function serialToText(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000);
  const iso = new Date(ms).toISOString();
  return Number.isInteger(serial) ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
}

function parseXml(files: Record<string, Uint8Array>, name: string): Node | undefined {
  const file = files[name];
  return file ? (parser.parse(strFromU8(file)) as Node) : undefined;
}

function dateStyles(files: Record<string, Uint8Array>): Set<number> {
  const styles = parseXml(files, 'xl/styles.xml')?.styleSheet as Node | undefined;
  if (!styles) return new Set();
  const custom = new Map<number, string>();
  const numFmts = (styles.numFmts as Node | undefined)?.numFmt as Node[] | undefined;
  for (const fmt of numFmts ?? []) custom.set(Number(fmt['@_numFmtId']), String(fmt['@_formatCode'] ?? ''));
  const xfs = ((styles.cellXfs as Node | undefined)?.xf as Node[] | undefined) ?? [];
  const dates = new Set<number>();
  xfs.forEach((xf, index) => {
    const id = Number(xf['@_numFmtId'] ?? 0);
    if (BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDateFormat(custom.get(id)!))) dates.add(index);
  });
  return dates;
}

function cellValue(cell: Node, shared: string[], dates: Set<number>): string {
  const type = cell['@_t'] as string | undefined;
  const raw = textOf(cell.v);
  if (type === 's') return shared[Number(raw)] ?? '';
  if (type === 'inlineStr') return richText(cell.is);
  if (type === 'b') return raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : '';
  if (type === 'str' || type === 'e') return raw;
  if (raw === '') {
    // A formula nobody has calculated: show the formula so it can still be read.
    const formula = textOf((cell.f as unknown[] | Node | undefined) ?? '');
    return formula ? `=${formula}` : '';
  }
  const style = Number(cell['@_s'] ?? -1);
  if (dates.has(style) && Number.isFinite(Number(raw))) return serialToText(Number(raw));
  return raw;
}

export function readXlsx(bytes: Uint8Array): Map<string, RawGrid> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new UserError('The file is not a valid .xlsx workbook (it could not be unzipped).');
  }
  const workbook = parseXml(files, 'xl/workbook.xml')?.workbook as Node | undefined;
  if (!workbook) throw new UserError('The file is not a valid .xlsx workbook (xl/workbook.xml is missing).');

  const targets = new Map<string, string>();
  const rels = (parseXml(files, 'xl/_rels/workbook.xml.rels')?.Relationships as Node | undefined)?.Relationship as Node[] | undefined;
  for (const rel of rels ?? []) targets.set(String(rel['@_Id']), String(rel['@_Target']));

  const sharedItems = (parseXml(files, 'xl/sharedStrings.xml')?.sst as Node | undefined)?.si as unknown[] | undefined;
  const shared = (sharedItems ?? []).map(richText);
  const dates = dateStyles(files);

  const result = new Map<string, RawGrid>();
  const sheets = ((workbook.sheets as Node | undefined)?.sheet as Node[] | undefined) ?? [];
  for (const sheet of sheets) {
    const name = String(sheet['@_name']);
    const target = targets.get(String(sheet['@_r:id'] ?? sheet['@_id']));
    if (!target) continue;
    const file = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    const worksheet = parseXml(files, file)?.worksheet as Node | undefined;
    const grid: RawGrid = { cells: new Map(), maxRow: 0, maxCol: 0 };
    const rows = ((worksheet?.sheetData as Node | undefined)?.row as Node[] | undefined) ?? [];
    for (const row of rows) {
      for (const cell of (row.c as Node[] | undefined) ?? []) {
        const match = /^([A-Z]+)(\d+)$/.exec(String(cell['@_r'] ?? ''));
        if (!match) continue;
        const text = cellValue(cell, shared, dates);
        if (text === '') continue;
        grid.cells.set(`${match[1]}${match[2]}`, text);
        grid.maxRow = Math.max(grid.maxRow, Number(match[2]));
        grid.maxCol = Math.max(grid.maxCol, columnNumber(match[1]!));
      }
    }
    result.set(name, grid);
  }
  return result;
}
