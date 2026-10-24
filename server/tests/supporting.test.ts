import { describe, expect, it } from 'vitest';
import type { DimensionSpec } from '@ddd/shared';
import { serializeSheet } from '../src/excel/serialize.js';
import { WorkbookModel } from '../src/excel/workbook.js';
import { withSupportingRows } from '../src/agent/supporting.js';
import type { EvalSection } from '../src/agent/sectionPlanner.js';
import { makeWorkbook } from './helpers.js';

const question = (id: string, name: string, measure: string): DimensionSpec =>
  ({ id, name, weight: 5, critical: false, measuredBy: 'raters', measure, anchors: { 0: 'a', 1: 'b', 2: 'c', 3: 'd', 4: 'e', 5: 'f' } }) as DimensionSpec;

const load = async () =>
  WorkbookModel.load(
    await makeWorkbook({
      Permission_Matrix: [['Id', 'Resource', 'Read'], ['P-1', 'Own profile', 'Conditional'], ['P-2', 'Block list', 'Allowed']],
      L2_Parameters: [
        ['Id', 'Name', 'Meaning'],
        ['D3-S03-P19', 'Data class touched', 'Highest data classification the capability reads or writes.'],
        ['D3-S04-P23', 'Access purpose', 'Purpose of the access, from the purpose register.'],
        ['D3-S01-P01', 'Matrix ID', 'Unique ID of this matrix.'],
        ['D3-S01-P02', 'Version', 'Version of this matrix.'],
      ],
      Corrections_Log: [['Id', 'Note'], ['C-1', 'Data classification column added']],
    }),
  );

const section = (wb: WorkbookModel, q: DimensionSpec): EvalSection => ({
  label: 'section 1',
  dimensions: [q],
  sheets: [{ name: 'Permission_Matrix', headerRow: 1 }],
  context: [],
});

describe('supporting rows', () => {
  it('adds the rows of other sheets that share the question\'s distinctive words, with their header row', async () => {
    const wb = await load();
    const [out] = withSupportingRows([section(wb, question('Q1', 'Data classification coverage', 'Every capability is classified by data class'))], wb);
    const spec = out!.context.find((s) => s.name === 'L2_Parameters');
    expect(spec).toMatchObject({ headerRow: 1 });
    expect(spec!.rows).toContain(2);
    expect(spec!.rows).not.toContain(4);
    // The sheet the question already reads in full is not repeated, and a discussion sheet is never offered.
    expect(out!.context.some((s) => s.name === 'Permission_Matrix' || s.name === 'Corrections_Log')).toBe(false);
  });

  it('leaves a section alone when it already reads every sheet, or when nothing in the file relates', async () => {
    const wb = await load();
    const all: EvalSection = { label: 'full', dimensions: [question('Q1', 'Data classification', 'class')], sheets: wb.sheetNames().map((name) => ({ name, headerRow: 1 })), context: [] };
    expect(withSupportingRows([all], wb)[0]).toBe(all);
    const unrelated = section(wb, question('Q2', 'Zebra migration', 'giraffe savannah'));
    expect(withSupportingRows([unrelated], wb)[0]!.context).toEqual([]);
  });

  it('serializes only the supporting rows, with the header row, and says so', async () => {
    const wb = await load();
    const text = serializeSheet(wb, { name: 'L2_Parameters', headerRow: 1, rows: [3] });
    expect(text).toContain('## Sheet: L2_Parameters (5 rows, 1 supporting rows)');
    expect(text).toContain('A1="Id"');
    expect(text).toContain('B3="Access purpose"');
    expect(text).not.toContain('Matrix ID');
  });
});
