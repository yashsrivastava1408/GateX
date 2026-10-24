import { UserError } from '../util/errors.js';
import type { RawGrid } from './xlsxReader.js';

/**
 * Reads a .csv into the same grid an .xlsx becomes: one sheet, named "Sheet1", so a rater can cite `Sheet1!E5` exactly as
 * it would cite a cell in a workbook. Quoted fields, doubled quotes, line breaks inside quotes and a leading byte-order
 * mark are handled; the delimiter (comma, semicolon or tab) is picked from the first lines. Nothing is ever written back.
 */

export const CSV_SHEET = 'Sheet1';

const DELIMITERS = [',', ';', '\t'] as const;

function letters(index: number): string {
  let out = '';
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
}

/** The delimiter that splits the first non-empty lines into the most (and a steady number of) columns. */
export function pickDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).filter((line) => line.trim() !== '').slice(0, 8);
  let best = ',';
  let bestScore = 0;
  for (const delimiter of DELIMITERS) {
    const counts = sample.map((line) => line.split(delimiter).length - 1);
    const score = counts.length === 0 ? 0 : Math.min(...counts) * 10 + Math.max(...counts);
    if (score > bestScore) {
      best = delimiter;
      bestScore = score;
    }
  }
  return best;
}

export function parseCsvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** True for bytes that look like delimited text and not like a zip or a PDF. */
export function looksLikeCsv(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return false;
  const head = bytes.subarray(0, 4096);
  for (const byte of head) if (byte === 0) return false;
  // Plain words with no delimiter at all are not a table, so they keep the "not a valid .xlsx" message.
  return /[,;\t]/.test(Buffer.from(head).toString('utf8'));
}

export function readCsv(bytes: Uint8Array): Map<string, RawGrid> {
  const text = Buffer.from(bytes).toString('utf8').replace(/^﻿/, '');
  if (text.trim() === '') throw new UserError('That .csv file is empty.');
  const rows = parseCsvRows(text, pickDelimiter(text));
  const cells = new Map<string, string>();
  let maxRow = 0;
  let maxCol = 0;
  rows.forEach((values, r) => {
    values.forEach((value, c) => {
      const cleaned = value.replace(/\s+$/, '');
      if (cleaned.trim() === '') return;
      cells.set(`${letters(c + 1)}${r + 1}`, cleaned);
      maxRow = Math.max(maxRow, r + 1);
      maxCol = Math.max(maxCol, c + 1);
    });
  });
  return new Map([[CSV_SHEET, { cells, maxRow, maxCol }]]);
}
