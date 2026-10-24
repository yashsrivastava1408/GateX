import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { WorkbookModel, columnIndex, columnLetters, parseAddress } from '../src/excel/workbook.js';
import { serializeSheet } from '../src/excel/serialize.js';
import { sha256 } from '../src/util/hash.js';
import { TALENTRA_XLSX, makeWorkbook } from './helpers.js';

describe('workbook reader', () => {
  it('opens the real Talentra workbook, which general spreadsheet libraries fail on', async () => {
    const wb = await WorkbookModel.load(TALENTRA_XLSX);
    expect(wb.sheetNames()).toEqual([
      'Summary', 'Stage 1 steps', 'Playbook map', 'Tree', 'Schema register', 'Allowed values', 'Feature discovery',
      'Coverage matrix', 'Competitors', 'NFR register', 'Requirements', 'Scope lines', 'Scorecard', 'Measures', 'Discover log',
    ]);
    const tree = wb.table('Tree');
    expect(tree.rows).toHaveLength(169);
    expect(tree.headers.map((h) => h.title)).toContain('Definition');
    expect(wb.table('Schema register').rows).toHaveLength(117);
    expect(wb.table('Requirements', 3).rows).toHaveLength(108);
    expect(wb.table('NFR register', 3).rows).toHaveLength(26);
  });

  it('reads text, numbers, booleans, rich text and cells with entities', async () => {
    const wb = await WorkbookModel.load(
      await makeWorkbook({ Data: [['name', 'qty', 'note'], ['Alpha & <Beta>', 42, 'two\nlines'], ['  padded  ', 0.5, null]] }),
    );
    const table = wb.table('Data');
    expect(table.rows[0]!.values.get('name')).toBe('Alpha & <Beta>');
    expect(table.rows[0]!.values.get('qty')).toBe('42');
    expect(table.rows[0]!.values.get('note')).toBe('two\nlines');
    expect(table.rows[1]!.values.get('qty')).toBe('0.5');
    expect(table.rows[1]!.values.get('note')).toBe('');
  });

  it('shows the formula for cells nobody has calculated, so they can still be read', async () => {
    const wb = await WorkbookModel.load(await makeWorkbook({ Data: [['a'], [1]] }));
    expect(wb.cellText('Data', 'A2')).toBe('1');
    const real = await WorkbookModel.load(TALENTRA_XLSX);
    expect(real.cellText('Summary', 'B5')).toMatch(/^=COUNTIF\(Tree!/);
  });

  it('turns date-formatted cells into dates', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('D');
    sheet.addRow(['when']);
    sheet.addRow([new Date(Date.UTC(2026, 9, 15))]);
    const wb = await WorkbookModel.load(Buffer.from(await book.xlsx.writeBuffer()));
    expect(wb.cellText('D', 'A2')).toBe('2026-10-15');
  });

  it('numbers duplicate headers instead of losing a column', async () => {
    const wb = await WorkbookModel.load(await makeWorkbook({ S: [['x', 'x', 'y'], ['1', '2', '3']] }));
    expect(wb.table('S').headers.map((h) => h.title)).toEqual(['x', 'x #2', 'y']);
  });

  it('gives a clear error for a missing sheet, a bad file and a non-xlsx upload', async () => {
    const wb = await WorkbookModel.load(await makeWorkbook({ One: [['a']] }));
    expect(() => wb.table('Two')).toThrow(/Sheet "Two" was not found.*One/);
    await expect(WorkbookModel.load(Buffer.from('not a zip at all'))).rejects.toThrow(/not a valid \.xlsx/);
  });

  it('never changes the file it reads', async () => {
    const before = sha256(await readFile(TALENTRA_XLSX));
    const wb = await WorkbookModel.load(TALENTRA_XLSX);
    serializeSheet(wb, 'Tree');
    expect(sha256(await readFile(TALENTRA_XLSX))).toBe(before);
  });

  it('serialises every cell with its address so a rater can cite it', async () => {
    const wb = await WorkbookModel.load(await makeWorkbook({ T: [['id', 'def'], ['1', 'First "quoted" thing']] }));
    const text = serializeSheet(wb, 'T');
    expect(text).toContain('## Sheet: T (2 rows, columns A-B)');
    expect(text).toContain('B2="First \\"quoted\\" thing"');
  });

  it('converts addresses both ways', () => {
    expect(columnLetters(1)).toBe('A');
    expect(columnLetters(27)).toBe('AA');
    expect(columnIndex('AB')).toBe(28);
    expect(parseAddress('$h$12')).toEqual({ col: 8, row: 12, letters: 'H' });
    expect(parseAddress('12H')).toBeNull();
  });
});

describe('serializing named columns when the header row given is not where the titles are', () => {
  const rows = [
    ['Title line'],
    ['Note'],
    ['Id', 'Name', 'Meaning'],
    ['A1', 'one', 'first'],
    ['A2', 'two', 'second'],
  ];

  it('finds the row that holds every title instead of failing (a reused conversion pinned another header row)', async () => {
    const wb = await WorkbookModel.load(await makeWorkbook({ Sheet1: rows }));
    const text = serializeSheet(wb, { name: 'Sheet1', headerRow: 5, columns: ['Id', 'Meaning'] });
    expect(text).toContain('A4="A1"');
    expect(text).toContain('C5="second"');
    expect(text).not.toContain('B4=');
  });

  it('still says so when no row holds the named columns', async () => {
    const wb = await WorkbookModel.load(await makeWorkbook({ Sheet1: rows }));
    expect(() => serializeSheet(wb, { name: 'Sheet1', headerRow: 3, columns: ['Nope'] })).toThrow(/Column "Nope" named by the scorecard was not found/);
  });
});
