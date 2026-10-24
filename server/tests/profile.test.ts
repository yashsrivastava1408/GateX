import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkbookModel } from '../src/excel/workbook.js';
import { columnProfile, describeProfile, detectHeaderRow, pickColumns, profileWorkbook, rankColumns, sheetProfile, stems } from '../src/excel/profile.js';
import { makeWorkbook } from './helpers.js';

const load = async (sheets: Record<string, Array<Array<string | number | null>>>) => WorkbookModel.load(await makeWorkbook(sheets));

/** Three layouts that look nothing alike: a title block above the table, a plain table, and a register with codes. */
const register = [
  ['Field register v2'],
  ['Every field the platform stores.'],
  [],
  ['Field ID', 'Name', 'Definition', 'Data type', 'Status', 'Owner', 'Notes'],
  ...Array.from({ length: 40 }, (_, i) => [`FLD-${String(i + 1).padStart(3, '0')}`, `Field ${i + 1}`, `What field ${i + 1} records for the account.`, i % 2 ? 'text' : 'date', i % 3 ? 'ACTIVE' : 'DRAFT', 'Data team', i < 4 ? 'check later' : null]),
];

describe('profiling a workbook in any layout', () => {
  it('finds the real header row below a title block, and the id column', async () => {
    const wb = await load({ Register: register });
    const sheet = sheetProfile(profileWorkbook(wb), 'register')!;
    expect(sheet.headerRow).toBe(4);
    expect(detectHeaderRow(wb, 'Register')).toBe(4);
    expect(sheet.dataRows).toBe(40);
    expect(sheet.idColumn).toBe('Field ID');
    expect(sheet.tokens).toBeGreaterThan(0);
  });

  it('says what each column holds and how full it is', async () => {
    const profile = profileWorkbook(await load({ Register: register }));
    const col = (title: string) => columnProfile(profile, 'Register', title)!;
    expect(col('Field ID')).toMatchObject({ letter: 'A', kind: 'id', fillRate: 1, distinct: 40 });
    expect(col('definition')).toMatchObject({ letter: 'C', kind: 'text', fillRate: 1 });
    expect(col('Status')).toMatchObject({ kind: 'code', distinct: 2 });
    expect(col('Data  type').kind).toBe('code');
    expect(col('Notes')).toMatchObject({ filled: 4, total: 40, fillRate: 0.1 });
    expect(col('Status').samples).toEqual(['DRAFT', 'ACTIVE']);
    expect(columnProfile(profile, 'Register', 'Nope')).toBeUndefined();
  });

  it('recognises numbers and formulas, and a sheet with its headers in row 1', async () => {
    const profile = profileWorkbook(await load({ Counts: [['Level', 'Count', 'Total'], ['L1', 6, '=SUM(B2:B2)'], ['L2', 34, '=SUM(B3:B3)'], ['L3', 36, '=SUM(B4:B4)']] }));
    const sheet = sheetProfile(profile, 'Counts')!;
    expect(sheet.headerRow).toBe(1);
    expect(columnProfile(profile, 'Counts', 'Count')!.kind).toBe('number');
    expect(columnProfile(profile, 'Counts', 'Total')!.kind).toBe('formula');
  });

  it('is built once per loaded workbook', async () => {
    const wb = await load({ Register: register });
    expect(profileWorkbook(wb)).toBe(profileWorkbook(wb));
  });
});

describe('choosing the columns a question reads', () => {
  it('ranks columns by the words they share with the question, keeping the id column first', async () => {
    const sheet = sheetProfile(profileWorkbook(await load({ Register: register })), 'Register')!;
    expect(rankColumns(sheet, 'Is every field defined, with a clear definition?')[0]!.column.title).toBe('Definition');
    expect(pickColumns(sheet, 'Is every field defined, with a clear definition?', 3)).toEqual(expect.arrayContaining(['Field ID', 'Definition']));
    expect(rankColumns(sheet, 'Is an owner recorded for every row?')[0]!.column.title).toBe('Owner');
  });

  it('falls back to the fullest text columns, not the first ones, when nothing matches', async () => {
    const sheet = sheetProfile(profileWorkbook(await load({ Register: register })), 'Register')!;
    const picked = pickColumns(sheet, 'zzz qqq', 3);
    expect(picked[0]).toBe('Field ID');
    expect(picked).toContain('Definition');
    expect(picked).not.toContain('Notes');
  });

  it('never picks more than asked, and ignores empty and formula columns', async () => {
    const sheet = sheetProfile(profileWorkbook(await load({ T: [['ID', 'A total', 'Empty', 'Text'], ['X-1', '=1+1', null, 'total words'], ['X-2', '=2+2', null, 'more total words']] })), 'T')!;
    const picked = pickColumns(sheet, 'total', 2);
    expect(picked.length).toBeLessThanOrEqual(2);
    expect(picked).not.toContain('A total');
    expect(picked).not.toContain('Empty');
  });

  it('cuts words to stems so different forms of a word match', () => {
    expect([...stems('Validation rules are validated')]).toEqual(['valid', 'rules']);
  });
});

describe('describing a workbook to a model', () => {
  it('lists each sheet with its header row and id, and each column with its kind, fill and examples', async () => {
    const text = describeProfile(profileWorkbook(await load({ Register: register })));
    expect(text).toMatch(/^Register \(header row 4, 40 data rows, about [\d,]+ tokens, id column "Field ID"\):/);
    expect(text).toMatch(/ {2}A "Field ID": id, 100% filled, e\.g\. "FLD-001"/);
    expect(text).toMatch(/ {2}G "Notes": code, 10% filled/);
  });
});

const REAL = path.join(os.homedir(), 'Desktop', 'Talentra_Step2_Master_Schema.xlsx');
describe.skipIf(!existsSync(REAL))('on the real Talentra master schema (skipped when the file is not on this machine)', () => {
  it('profiles all 20 sheets quickly and finds the parameter table under its title block', async () => {
    const started = Date.now();
    const wb = await WorkbookModel.load(readFileSync(REAL));
    const profile = profileWorkbook(wb);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(profile.sheets).toHaveLength(20);
    const l2 = sheetProfile(profile, 'Schema_L2_Parameters')!;
    expect(l2).toMatchObject({ headerRow: 4, idColumn: 'L2 ID' });
    // The two columns a false finding said do not exist are there and full.
    expect(columnProfile(profile, 'Schema_L2_Parameters', 'Type and format')!.fillRate).toBeGreaterThan(0.9);
    expect(columnProfile(profile, 'Value_Sets', 'Owner')!.fillRate).toBeGreaterThan(0.9);
    expect(pickColumns(l2, 'validation rules, DQ dimension tagging, passing and failing examples')).toEqual(expect.arrayContaining(['L2 ID', 'Validation rule', 'DQ dimensions', 'Passing example', 'Failing example']));
  });
});
