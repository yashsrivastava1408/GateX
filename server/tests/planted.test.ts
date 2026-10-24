import { describe, expect, it } from 'vitest';
import { WorkbookModel } from '../src/excel/workbook.js';
import { sweepWorkbook } from '../src/agent/sweep.js';
import { DEFECT_KINDS, plantDefects } from '../src/planted/plant.js';
import { scorePlanted, type ScoredFinding } from '../src/planted/score.js';
import { makeWorkbook } from './helpers.js';

/** A small register: id, level, name, definition, reason, data type, required, parent, children. */
function rows(n = 40): Array<Array<string | number>> {
  const out: Array<Array<string | number>> = [['Planted test register'], [''], [''], ['Path id', 'Level', 'Name', 'Definition', 'Reason it exists', 'Data type', 'Required', 'Parent id', 'Children']];
  for (let i = 1; i <= n; i++) out.push([`1.${i}`, 3, `Field ${i}`, `Definition of field ${i}.`, `Reason ${i}.`, 'text', i % 2 ? 'Required' : 'Optional', '1', i % 5]);
  return out;
}
const csvOf = (r: Array<Array<string | number>>) => Buffer.from(r.map((row) => row.join(',')).join('\n') + '\n', 'utf8');

describe('planting defects in a register', () => {
  it('plants one defect of each kind in a csv, in different rows, and records the change', async () => {
    const source = csvOf(rows());
    const { bytes, defects, skipped } = await plantDefects(source);
    expect(skipped).toEqual([]);
    expect(defects.map((d) => d.kind)).toEqual(DEFECT_KINDS);
    expect(new Set(defects.map((d) => d.row)).size).toBe(defects.length);
    const wb = await WorkbookModel.load(bytes);
    for (const d of defects) {
      expect(wb.cellText('Sheet1', d.cell)).toBe(d.after);
      expect(d.before).not.toBe(d.after);
    }
    const blank = defects.find((d) => d.kind === 'blank_definition')!;
    expect(blank.before).toMatch(/^Definition of field/);
    expect(defects.find((d) => d.kind === 'wrong_count')!.after).toBe(String(Number(defects.find((d) => d.kind === 'wrong_count')!.before) + 7));
    // The duplicate takes the id of the row above it.
    const dup = defects.find((d) => d.kind === 'duplicate_id')!;
    expect(wb.cellText('Sheet1', `A${dup.row - 1}`)).toBe(dup.recordId);
  });

  it('is deterministic, and a different seed plants in different rows', async () => {
    const source = csvOf(rows());
    const a = await plantDefects(source, { seed: 1 });
    expect(await plantDefects(source, { seed: 1 })).toEqual(a);
    expect((await plantDefects(source, { seed: 2 })).defects.map((d) => d.row)).not.toEqual(a.defects.map((d) => d.row));
  });

  it('plants in an .xlsx too, and leaves every other cell as it was', async () => {
    const source = await makeWorkbook({ Register: rows() });
    const { bytes, defects } = await plantDefects(source);
    const before = await WorkbookModel.load(source);
    const after = await WorkbookModel.load(bytes);
    const changed = new Set(defects.map((d) => d.cell));
    for (const [r, c, t] of before.cells('Register')) {
      const address = `${'ABCDEFGHIJ'[c - 1]}${r}`;
      if (!changed.has(address)) expect(after.cellText('Register', address)).toBe(t);
    }
    for (const d of defects) expect(after.cellText('Register', d.cell)).toBe(d.after);
    expect(defects[0]!.sheet).toBe('Register');
  });

  it('skips a defect whose column the sheet does not have, and says why', async () => {
    const source = csvOf([['Id', 'Name', 'Definition'], ...Array.from({ length: 30 }, (_, i) => [`${i + 1}`, `N${i}`, `Def ${i}`])]);
    const { defects, skipped } = await plantDefects(source);
    expect(defects.map((d) => d.kind)).toEqual(['blank_definition', 'duplicate_id', 'vague_definition']);
    expect(skipped.join(' ')).toMatch(/blank_reason: no reason column/);
  });

  it('refuses a file with no register-like sheet', async () => {
    await expect(plantDefects(csvOf([['A', 'B'], ['1', '2']]))).rejects.toThrow(/No register-like sheet/);
  });
});

describe('scoring a run against the planted defects', () => {
  const defects = [
    { id: 'P-01', kind: 'blank_definition' as const, sheet: 'Sheet1', cell: 'D10', row: 10, recordId: '1.6', before: 'x', after: '', description: '' },
    { id: 'P-02', kind: 'duplicate_id' as const, sheet: 'Sheet1', cell: 'A20', row: 20, recordId: '1.15', before: '1.16', after: '1.15', description: '' },
    { id: 'P-03', kind: 'broken_parent' as const, sheet: 'Sheet1', cell: 'H30', row: 30, recordId: '1.26', before: '1', after: '99.99.99', description: '' },
  ];
  const f = (id: string, over: Partial<ScoredFinding>): ScoredFinding => ({ id, title: 't', detail: 'd', location: null, reportedBy: ['A'], kept: true, ...over });

  it('counts a defect as caught by the row it points at, its cell, or its id as a whole token', () => {
    const score = scorePlanted(defects, [
      f('F-01', { location: { sheet: 'Sheet1', cell: 'E10' } }),
      f('F-02', { detail: 'Id 1.15 appears twice.', reportedBy: ['B'] }),
      f('F-03', { detail: 'Entry 11.26 is odd.', location: { sheet: 'Sheet1', cell: 'A3' } }),
    ]);
    expect(score.caught).toBe(2);
    expect(score.results.map((r) => r.inReport)).toEqual([true, true, false]);
    expect(score.otherInReport).toBe(1);
  });

  it('also catches a duplicate from the row above, and does not match an id inside a longer id', () => {
    const score = scorePlanted(defects, [f('F-01', { location: { sheet: 'Sheet1', cell: 'A19' } }), f('F-02', { detail: 'See 1.150 and 1.15.2.' })]);
    expect(score.results[1]!.caughtBy).toEqual(['F-01']);
  });

  it('counts a defect caught only by a finding the app set aside separately, and credits the examiner', () => {
    const score = scorePlanted(defects, [f('F-01', { location: { sheet: 'Sheet1', cell: 'D10' }, kept: false, reportedBy: ['C'] }), f('F-02', { title: 'Vague', reportedBy: ['B'], kept: false })]);
    expect(score.caught).toBe(0);
    expect(score.caughtRaw).toBe(1);
    expect(score.perExaminer.C).toEqual({ caught: 1, otherFindings: 0 });
    expect(score.perExaminer.B).toEqual({ caught: 0, otherFindings: 1 });
    expect(score.otherInReport).toBe(0);
  });
});

describe('the code sweep against planted defects', () => {
  // Composite rows have no data type by design; atomic rows all do. Every row but the first has parent 1, which exists. Children are all 0.
  const register = (): Array<Array<string | number>> => {
    const out: Array<Array<string | number>> = [['Planted test register'], [''], [''], ['Path id', 'Level', 'Name', 'Definition', 'Reason it exists', 'Data type', 'Required', 'Parent id', 'Children', 'Kind']];
    for (let i = 1; i <= 80; i++) {
      const composite = i % 4 === 0;
      out.push([`${i}`, 3, `Field ${i}`, `Definition of field ${i}.`, `Reason ${i}.`, composite ? '' : 'text', i % 2 ? 'Required' : 'Optional', i === 1 ? '' : '1', 0, composite ? 'composite' : 'atomic']);
    }
    return out;
  };

  it('finds every kind that was planted, at the cell it was planted in', async () => {
    const { bytes, defects } = await plantDefects(csvOf(register()));
    const found = sweepWorkbook(await WorkbookModel.load(bytes));
    const at = new Set(found.map((f) => `${f.location.sheet}!${f.location.cell}`));
    const missed = defects.filter((d) => !at.has(`${d.sheet}!${d.cell}`)).map((d) => `${d.kind}@${d.cell}`);
    expect(missed).toEqual([]);
    expect(defects).toHaveLength(8);
  });

  it('finds nothing in the register before anything was planted', async () => {
    expect(sweepWorkbook(await WorkbookModel.load(csvOf(register())))).toEqual([]);
  });
});
