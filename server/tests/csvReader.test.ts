import { describe, expect, it } from 'vitest';
import { WorkbookModel } from '../src/excel/workbook.js';
import { profileWorkbook } from '../src/excel/profile.js';

const load = (text: string) => WorkbookModel.load(Buffer.from(text, 'utf8'));

describe('reading a .csv as a one-sheet workbook', () => {
  it('puts the cells at the addresses a spreadsheet would use', async () => {
    const wb = await load('Id,Name\n1,Alpha\n2,Beta\n');
    expect(wb.sheetNames()).toEqual(['Sheet1']);
    expect(wb.cellText('Sheet1', 'A1')).toBe('Id');
    expect(wb.cellText('Sheet1', 'B3')).toBe('Beta');
  });

  it('handles quotes, doubled quotes, commas and line breaks inside a field, and a byte-order mark', async () => {
    const wb = await load('﻿Id,Definition\n1,"He said ""hi"", twice"\n2,"line one\nline two"\n');
    expect(wb.cellText('Sheet1', 'A1')).toBe('Id');
    expect(wb.cellText('Sheet1', 'B2')).toBe('He said "hi", twice');
    expect(wb.cellText('Sheet1', 'B3')).toBe('line one\nline two');
  });

  it('picks a semicolon or tab delimiter, and leaves empty cells out', async () => {
    const semi = await load('Id;Name;Note\n1;Alpha;\n');
    expect(semi.cellText('Sheet1', 'B2')).toBe('Alpha');
    expect(semi.cellText('Sheet1', 'C2')).toBe('');
    const tab = await load('Id\tName\n1\tAlpha\n');
    expect(tab.cellText('Sheet1', 'B2')).toBe('Alpha');
  });

  it('finds the real header row below a title block, like the profile does for a workbook', async () => {
    const wb = await load('My schema,,,\n"One row per node.",,,\n,,,\nPath id,Level,Name,Definition\n1,1,Alpha,First\n2,2,Beta,Second\n');
    const sheet = profileWorkbook(wb).sheets[0]!;
    expect(sheet.headerRow).toBe(4);
    expect(sheet.dataRows).toBe(2);
  });

  it('does not treat words with no delimiter as a table', async () => {
    await expect(load('   \n')).rejects.toThrow(/not a valid .xlsx/);
  });
});
