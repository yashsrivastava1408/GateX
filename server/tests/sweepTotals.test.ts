import { describe, expect, it } from 'vitest';
import { WorkbookModel } from '../src/excel/workbook.js';
import { emptyStats, sweepAll } from '../src/agent/sweep.js';
import { makeWorkbook } from './helpers.js';

/** A numbered list of 60 leaves, then a total row that labels itself in column B. Column A numbers every leaf. */
const rows = (total: string): Array<Array<string | number>> => {
  const out: Array<Array<string | number>> = [['Leaf composition'], [''], ['#', 'Leaf type', 'Prefix', 'Count', 'Stated']];
  for (let i = 1; i <= 60; i++) out.push([`S${i}`, `Type ${i}`, `P-${i}`, i, i]);
  out.push(['', total, 'P-ALL', 1830, 1830]);
  return out;
};

describe('a total row is not an entry that is missing something', () => {
  it('is left alone when it labels itself in the second column (the Step 3 summary: "TOTAL L4 LEAVES" under numbered rows)', async () => {
    const wb = await WorkbookModel.load(await makeWorkbook({ Summary: rows('TOTAL L4 LEAVES') }));
    expect(sweepAll(wb, { all: true, stats: emptyStats() }).filter((f) => f.kind === 'empty_cell')).toEqual([]);
  });
  it('still finds a number that is really missing from a row of the list', async () => {
    const data = rows('TOTAL L4 LEAVES');
    data[6]![0] = '';
    const wb = await WorkbookModel.load(await makeWorkbook({ Summary: data }));
    expect(sweepAll(wb, { all: true, stats: emptyStats() }).filter((f) => f.kind === 'empty_cell').map((f) => f.location.cell)).toEqual(['A7']);
  });
  it('does not mistake a long cell that merely begins with "Total" for a total row', async () => {
    const wb = await WorkbookModel.load(await makeWorkbook({ Summary: rows('Total evaluation order: identity gate, restriction, deny, allow, default deny') }));
    // The row has no number in column A, so it is reported like any other entry with a gap.
    expect(sweepAll(wb, { all: true, stats: emptyStats() }).filter((f) => f.kind === 'empty_cell').map((f) => f.location.cell)).toEqual(['A64']);
  });
});
