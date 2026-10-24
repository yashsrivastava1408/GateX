import { describe, expect, it } from 'vitest';
import type { Scorecard } from '@ddd/shared';
import { runCodeChecks, scoreFromRatio } from '../src/agent/checks/index.js';
import { WorkbookModel } from '../src/excel/workbook.js';
import { makeWorkbook } from './helpers.js';

const BANDS = [{ min: 1, score: 5 }, { min: 0.9, score: 4 }, { min: 0.5, score: 2 }, { min: 0.01, score: 1 }];

function card(checks: Array<{ id: string; check: string; params: Record<string, unknown> }>): Scorecard {
  return {
    id: 'S', name: 'S', version: '1', gate: 'D1', frozen: true, thresholds: { accept: 90, refine: 75 },
    artifact: { sheets: [{ name: 'Tree', headerRow: 1 }, { name: 'Lists', headerRow: 1 }], context: [] },
    dimensions: checks.map((c) => ({
      id: c.id, name: c.id, weight: 10, critical: false, measuredBy: 'code' as const,
      check: { id: c.check, params: c.params, bands: BANDS },
    })),
  };
}

async function run(rows: Record<string, Array<Array<string | number | null>>>, checks: Parameters<typeof card>[0]) {
  const wb = await WorkbookModel.load(await makeWorkbook(rows));
  return runCodeChecks(card(checks), wb);
}

describe('code checks', () => {
  it('max_value: counts rows at or under the maximum and points at the ones over', async () => {
    const [out] = await run({ Tree: [['Level'], [1], [2], [3], [4]], Lists: [['List']] }, [{ id: 'D', check: 'max_value', params: { sheet: 'Tree', column: 'Level', max: 3 } }]);
    expect(out!.result.codeDetail).toMatchObject({ passed: 3, total: 4 });
    expect(out!.failures).toEqual([{ sheet: 'Tree', cell: 'A5' }]);
    expect(out!.result.consolidated).toBe(2);
  });

  it('leaves a summary row such as COUNT or Total out of every count', async () => {
    const tree = { Tree: [['Name', 'Type', 'Level'], ['a', 'text', 1], ['b', 'text', 2], ['COUNT', '', 2], ['Total:', '', 3]], Lists: [['List']] };
    const [filled, max] = await run(tree, [
      { id: 'F', check: 'column_filled', params: { sheet: 'Tree', column: 'Type' } },
      { id: 'M', check: 'max_value', params: { sheet: 'Tree', column: 'Level', max: 2 } },
    ]);
    // Without the rule the COUNT row would fail "Type is filled" (1 blank) and the Total row would fail "Level at most 2".
    expect(filled!.result.codeDetail).toMatchObject({ passed: 2, total: 2 });
    expect(filled!.failures).toEqual([]);
    expect(max!.result.codeDetail).toMatchObject({ passed: 2, total: 2 });
  });

  it('keeps a real row whose first cell only starts with a total word', async () => {
    const [filled] = await run({ Tree: [['Name', 'Type'], ['Counting rules', 'text'], ['Total cost', '']], Lists: [['List']] }, [
      { id: 'F', check: 'column_filled', params: { sheet: 'Tree', column: 'Type' } },
    ]);
    expect(filled!.result.codeDetail).toMatchObject({ passed: 1, total: 2 });
  });

  it('column_filled: honours where and a pattern', async () => {
    const tree = { Tree: [['Level', 'Type', 'Ref'], [1, '', 'x'], [3, 'text', 'list: A'], [3, '', 'list: B'], [3, 'enum', 'oops']], Lists: [['List']] };
    const [filled, pattern] = await run(tree, [
      { id: 'F', check: 'column_filled', params: { sheet: 'Tree', column: 'Type', where: { column: 'Level', equals: 3 } } },
      { id: 'P', check: 'column_filled', params: { sheet: 'Tree', column: 'Ref', pattern: '^list:', where: { column: 'Type', equals: 'enum' } } },
    ]);
    expect(filled!.result.codeDetail).toMatchObject({ passed: 2, total: 3 });
    expect(filled!.failures).toEqual([{ sheet: 'Tree', cell: 'B4' }]);
    expect(pattern!.result.codeDetail).toMatchObject({ passed: 0, total: 1 });
  });

  it('unique: marks every row involved in a duplicate', async () => {
    const [out] = await run({ Tree: [['Id'], ['1'], ['2'], ['2'], ['3']], Lists: [['List']] }, [{ id: 'U', check: 'unique', params: { sheet: 'Tree', column: 'Id' } }]);
    expect(out!.result.codeDetail).toMatchObject({ passed: 2, total: 4 });
    expect(out!.failures.map((f) => f.cell)).toEqual(['A3', 'A4']);
  });

  it('any_filled: needs at least one of the listed columns', async () => {
    const [out] = await run({ Tree: [['Id', 'Used', 'Key'], ['a', '1.1', ''], ['b', '', 'PK'], ['c', '', '']], Lists: [['List']] }, [{ id: 'A', check: 'any_filled', params: { sheet: 'Tree', columns: ['Used', 'Key'] } }]);
    expect(out!.result.codeDetail).toMatchObject({ passed: 2, total: 3 });
  });

  it('list_refs_resolve: needs the list name to match exactly, so a rule glued onto the name fails', async () => {
    const wb = { Tree: [['Allowed'], ['list: Stage'], ['list: Comparator; required when set'], ['1 to 100 characters']], Lists: [['List', 'Value'], ['Stage', 'a'], ['Comparator', 'b']] };
    const [out] = await run(wb, [{ id: 'L', check: 'list_refs_resolve', params: { sheet: 'Tree', column: 'Allowed', lists_sheet: 'Lists', lists_column: 'List' } }]);
    expect(out!.result.codeDetail).toMatchObject({ passed: 1, total: 2 });
    expect(out!.failures).toEqual([{ sheet: 'Tree', cell: 'A3' }]);
  });

  it('lists_referenced: flags a list that nothing points at', async () => {
    const wb = { Tree: [['Allowed'], ['list: Stage']], Lists: [['List'], ['Stage'], ['Stage'], ['Unused']] };
    const [out] = await run(wb, [{ id: 'R', check: 'lists_referenced', params: { sheet: 'Tree', column: 'Allowed', lists_sheet: 'Lists', lists_column: 'List' } }]);
    expect(out!.result.codeDetail).toMatchObject({ passed: 1, total: 2 });
    expect(out!.failures).toEqual([{ sheet: 'Lists', cell: 'A4' }]);
  });

  it('values_in_list: checks data against an allowed list and ignores blanks', async () => {
    const wb = { Tree: [['Status'], ['Set'], ['Bogus'], [null], ['Proposed']], Lists: [['List', 'Value'], ['TargetStatus', 'Set'], ['TargetStatus', 'Proposed'], ['Other', 'Bogus']] };
    const [out] = await run(wb, [{ id: 'V', check: 'values_in_list', params: { sheet: 'Tree', column: 'Status', lists_sheet: 'Lists', lists_name_column: 'List', lists_value_column: 'Value', list: 'TargetStatus' } }]);
    expect(out!.result.codeDetail).toMatchObject({ passed: 2, total: 3 });
  });

  it('value_not_in: catches placeholder values such as "Not recorded", and blanks', async () => {
    const [out] = await run({ Tree: [['Id', 'Source'], ['a', 'Not recorded'], ['b', 'Brief p2'], ['c', null], ['d', 'not recorded']], Lists: [['List']] }, [{ id: 'N', check: 'value_not_in', params: { sheet: 'Tree', column: 'Source', forbidden: ['Not recorded'] } }]);
    expect(out!.result.codeDetail).toMatchObject({ passed: 1, total: 4 });
  });

  it('row_count_at_least: needs the minimum, and counts partial progress', async () => {
    const [out] = await run({ Tree: [['Competitor'], ['A'], ['B']], Lists: [['List']] }, [{ id: 'C', check: 'row_count_at_least', params: { sheet: 'Tree', min: 3 } }]);
    expect(out!.result.codeDetail).toMatchObject({ passed: 2, total: 3 });
  });

  it('turns a check that cannot run into an unscored dimension and a flagged finding, not a crash', async () => {
    const [missingColumn, unknown] = await run({ Tree: [['A'], ['1']], Lists: [['List']] }, [
      { id: 'X', check: 'column_filled', params: { sheet: 'Tree', column: 'Nope' } },
      { id: 'Y', check: 'does_not_exist', params: {} },
    ]);
    expect(missingColumn!.result.status).toBe('unscored');
    expect(missingColumn!.result.error).toMatch(/Column "Nope" was not found.*Columns: A/);
    expect(unknown!.result.error).toMatch(/Unknown check/);
    expect(missingColumn!.result.flagged).toBe(true);
  });

  it('maps ratios to scores by band, with no rounding up at the edges', () => {
    expect(scoreFromRatio(1, BANDS)).toBe(5);
    expect(scoreFromRatio(0.999, BANDS)).toBe(4);
    expect(scoreFromRatio(0.9, BANDS)).toBe(4);
    expect(scoreFromRatio(0.89, BANDS)).toBe(2);
    expect(scoreFromRatio(0, BANDS)).toBe(0);
  });
});
