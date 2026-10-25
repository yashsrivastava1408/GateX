import { getDocumentProxy } from 'unpdf';
import { UserError } from '../util/errors.js';
import { tablePage, type PageLine, type PageTable } from './pdfTables.js';
import type { RawGrid } from './xlsxReader.js';

/**
 * Reads the text of a PDF into the same grid an .xlsx becomes: one sheet per page ("Page 3"),
 * one line per row, all in column A. A rater can then cite `Page 3!A12` exactly as it would
 * cite a cell, and the rest of the pipeline does not know the difference. Scanned pages have
 * no text, so they come out empty. Nothing is ever written back.
 */

const LINE_TOLERANCE = 3;
const COLUMN_GAP = 14;
const BOILERPLATE_MAX_CHARS = 80;

interface Piece {
  text: string;
  x: number;
  y: number;
  width: number;
}

export const isPdf = (bytes: Uint8Array) =>
  bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;

function toLines(pieces: Piece[]): string[] {
  const rows: Array<{ y: number; pieces: Piece[] }> = [];
  for (const piece of pieces) {
    const row = rows.find((r) => Math.abs(r.y - piece.y) <= LINE_TOLERANCE);
    if (row) row.pieces.push(piece);
    else rows.push({ y: piece.y, pieces: [piece] });
  }
  return rows
    .sort((a, b) => b.y - a.y)
    .map((row) => {
      const ordered = row.pieces.sort((a, b) => a.x - b.x);
      let line = '';
      let end = 0;
      ordered.forEach((p, i) => {
        if (i > 0) line += p.x - end > COLUMN_GAP ? ' | ' : p.x > end + 0.5 ? ' ' : '';
        line += p.text;
        end = p.x + p.width;
      });
      return line.replace(/\s+/g, ' ').trim();
    })
    .filter((line) => line !== '');
}

export async function readPdf(bytes: Uint8Array): Promise<Map<string, RawGrid>> {
  let pages: PageLine[][];
  let tables: PageTable[][];
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    pages = [];
    tables = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const content = await (await pdf.getPage(n)).getTextContent();
      const pieces: Piece[] = [];
      for (const item of content.items) {
        if (!('str' in item) || item.str.trim() === '') continue;
        pieces.push({ text: item.str, x: item.transform[4]!, y: item.transform[5]!, width: item.width });
      }
      // A page with a table gets its rows rebuilt (wrapped cells joined); any other page reads line by line as before.
      const page = tablePage(pieces);
      pages.push(page?.lines ?? toLines(pieces).map((text) => ({ text })));
      tables.push(page?.tables ?? []);
    }
  } catch (error) {
    throw new UserError(`The PDF could not be read (${error instanceof Error ? error.message : 'unknown error'}).`);
  }

  // Running headers, footers and bare page numbers repeat on most pages and only cost tokens.
  const seen = new Map<string, number>();
  for (const lines of pages) for (const line of new Set(lines.map((l) => l.text))) seen.set(line, (seen.get(line) ?? 0) + 1);
  const repeated = (line: string) => pages.length >= 4 && line.length <= BOILERPLATE_MAX_CHARS && (seen.get(line) ?? 0) > pages.length / 2;
  const pageNumber = (line: string) => /^(page\s+)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i.test(line);

  const result = new Map<string, RawGrid>();
  pages.forEach((lines, index) => {
    const kept = lines.filter((line) => !repeated(line.text) && !pageNumber(line.text));
    const grid: RawGrid = { cells: new Map(), maxRow: kept.length, maxCol: kept.length > 0 ? 1 : 0 };
    kept.forEach((line, i) => grid.cells.set(`A${i + 1}`, line.text));
    // The table's rows keep the line they were read as; a row dropped as a repeated header or a page number has none and is left out.
    const lineOf = new Map<number, number>();
    kept.forEach((line, i) => { if (line.row !== undefined) lineOf.set(line.row, i + 1); });
    const found = tables[index]!.flatMap((t) => {
      const rows = t.rows.flatMap((r, k) => (lineOf.has(t.indexes[k]!) ? [{ ...r, line: lineOf.get(t.indexes[k]!)! }] : []));
      return rows.length > 0 ? [{ headers: t.headers, x: t.x, rows }] : [];
    });
    if (found.length > 0) grid.pdfTables = found;
    result.set(`Page ${index + 1}`, grid);
  });
  if ([...result.values()].every((g) => g.cells.size === 0)) {
    throw new UserError('This PDF has no readable text. It may be scanned images, which this tool cannot read.');
  }
  return result;
}
