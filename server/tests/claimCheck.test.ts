import { describe, expect, it } from 'vitest';
import { checkClaims, claimVerdicts, alreadyDisclosed, citedCellContent, definedNames } from '../src/agent/claimCheck.js';
import type { DraftFinding } from '../src/agent/types.js';
import { WorkbookModel } from '../src/excel/workbook.js';
import { makeWorkbook } from './helpers.js';

const finding = (over: Partial<DraftFinding>): DraftFinding => ({
  source: 'raters', dimensionId: 'G09', severity: 'HIGH', title: 't', detail: 'd', fix: 'f', returnTo: 'Define' as never,
  location: { sheet: 'L2_Parameters', cell: 'A1' }, reportedBy: ['A'], ...over,
});

/** Shaped like the cases a blind re-check found wrong: ids defined on another sheet, a PDF table row, a schema csv with an empty H5. */
async function fixture() {
  return WorkbookModel.load(await makeWorkbook({
    Fitness_Tests: [['Test', 'Needs'], ['T9', 'D3-S04-P27..P29 field-level visibility']],
    L2_Parameters: [
      ['Parameter id', 'Name', 'Meaning', 'In this master?'],
      ['D3-S04-P27', 'Masked data categories', 'Categories whose values the role never receives.', 'Yes'],
      ['D3-S04-P28', 'Hidden data categories', 'Categories the role cannot see at all.', 'Yes'],
      ['D3-S04-P29', 'Editable data categories', 'Categories the role may change.', 'Yes'],
      ['D3-S04-P31', 'Retention', 'How long.', 'To add'],
    ],
    'Page 35': [['S15 04 | | source_of_truth | Which side owns the exchanged data | Ownership decides who wins | Enum LV 34'], ['S15 05 | | data_stored | Information the product keeps from the exchange | Needed for audit | Text']],
    Notes: [['See D3-S04-P40 for the open question about retention.']],
    Decision_Log: [['D3-S04-P50', 'Proposed: a field called retention_days will be added later']],
    Schema: [['Name', 'Type', 'Atomic or composite'], ['id', 'text', 'Atomic'], ['Section row'], [null, null, null], ['Section', null, null, null, null, null, null, null]],
  }));
}

describe('definedNames: "X is not defined" when the file defines X', () => {
  it('drops a range of ids that are rows of another sheet, naming the cells', async () => {
    const wb = await fixture();
    const f = finding({ title: 'Field-level visibility fields missing', detail: 'Fitness test T9 requires field-level visibility, but D3-S04-P27..P29 are not defined in the provided schema.' });
    const reason = definedNames(f, wb)!;
    expect(reason).toContain('L2_Parameters!A2');
    expect(reason).toContain('D3-S04-P29');
    expect(claimVerdicts(f, wb).map((v) => [v.rule, v.action])).toEqual([['definedNames', 'drop']]);
  });

  it('drops snake_case field names defined in a PDF table row ("lacks clear definitions for ...")', async () => {
    const wb = await fixture();
    const f = finding({ title: 'Lack of Clear Definitions', detail: "The artifact lacks clear definitions for some control elements, such as 'source_of_truth' and 'data_stored'.", location: { sheet: 'Page 35', cell: 'A1' } });
    expect(definedNames(f, wb)).toMatch(/source_of_truth.*Page 35!A1.*data_stored.*Page 35!A2/);
  });

  it('keeps the finding when even one name is not defined', async () => {
    const wb = await fixture();
    const f = finding({ title: 'Ids missing', detail: 'D3-S04-P27 and D3-S04-P99 are not defined in the schema.' });
    expect(definedNames(f, wb)).toBeNull();
  });

  it('does not treat a mention in prose or in a decision log as a definition', async () => {
    const wb = await fixture();
    expect(definedNames(finding({ detail: 'D3-S04-P40 is not defined anywhere.' }), wb)).toBeNull();
    expect(definedNames(finding({ detail: 'The field retention_days is not defined.' }), wb)).toBeNull();
    expect(definedNames(finding({ detail: 'D3-S04-P50 is not defined.' }), wb)).toBeNull();
  });

  it('leaves a finding alone when it is about the values of the fields, or says the field exists', async () => {
    const wb = await fixture();
    expect(definedNames(finding({ title: 'Missing values', detail: 'D3-S04-P27 and D3-S04-P28 have missing values in the meaning column.' }), wb)).toBeNull();
    expect(definedNames(finding({ title: 'No example', detail: 'The field D3-S04-P27 is defined but no example shows it. Nothing is missing otherwise.' }), wb)).toBeNull();
    expect(definedNames(finding({ title: 'Tests missing', detail: 'Missing test links for D3-S04-P27 in Fitness_Tests.' }), wb)).toBeNull();
  });

  it('only runs on claims of absence, and never on code findings', async () => {
    const wb = await fixture();
    const f = finding({ title: 'Ids are odd', detail: 'D3-S04-P27 is listed twice.' });
    expect(claimVerdicts(f, wb)).toEqual([]);
    expect(claimVerdicts(finding({ source: 'code', detail: 'D3-S04-P27..P29 are not defined.' }), wb)).toEqual([]);
  });
});

describe('citedCellContent: the cited cell is not what the finding says it holds', () => {
  it('flags "H5 contains Atomic" when H5 of the file is empty (the limit lives in the scorecard)', async () => {
    const wb = await fixture();
    const f = finding({ title: 'Simplicity limit not defined', detail: "The measure for SD-03 refers to a limit in H5, but H5 contains 'Atomic' (a data value), not a numeric column limit.", location: { sheet: 'Schema', cell: 'H5' } });
    expect(citedCellContent(f, wb)).toContain('H5 of "Schema" is empty');
    expect(claimVerdicts(f, wb).map((v) => [v.rule, v.action])).toEqual([['citedCellContent', 'flag']]);
  });

  it('says nothing when the cell does hold the quoted text, and ignores ids such as D1-S08', async () => {
    const wb = await fixture();
    expect(citedCellContent(finding({ detail: "C2 contains 'Atomic' only.", location: { sheet: 'Schema', cell: 'C2' } }), wb)).toBeNull();
    expect(citedCellContent(finding({ detail: "The Open questions parameter (D1-S08-P02) shows 'Partial'.", location: { sheet: 'L2_Parameters', cell: 'Y52' } }), wb)).toBeNull();
  });
});

describe('alreadyDisclosed: the cited cell is the file\'s own marker for a known gap', () => {
  it('notes it when the cell is the marker and the finding quotes it', async () => {
    const wb = await fixture();
    const f = finding({ title: 'Retention to add', detail: "The retention parameter is marked 'To add' so it is not mastered yet.", location: { sheet: 'L2_Parameters', cell: 'D5' } });
    expect(alreadyDisclosed(f, wb)).toContain('the file already marks this as open');
  });

  it('is silent for a normal cell, or when the finding is about something else', async () => {
    const wb = await fixture();
    expect(alreadyDisclosed(finding({ detail: 'Meaning is too short.', location: { sheet: 'L2_Parameters', cell: 'C5' } }), wb)).toBeNull();
    expect(alreadyDisclosed(finding({ detail: 'The id scheme is unclear.', location: { sheet: 'L2_Parameters', cell: 'D5' } }), wb)).toBeNull();
  });
});

describe('checkClaims', () => {
  it('drops the proven one, annotates the flagged one, and passes the rest and code findings through', async () => {
    const wb = await fixture();
    const gone = finding({ title: 'Visibility ids missing', detail: 'D3-S04-P27..P29 are not defined.' });
    const flagged = finding({ title: 'Retention to add', detail: "Retention is 'To add'.", location: { sheet: 'L2_Parameters', cell: 'D5' } });
    const plain = finding({ title: 'Other', detail: 'Something else is wrong.' });
    const code = finding({ source: 'code', detail: 'D3-S04-P27 is not defined.' });
    const out = checkClaims([gone, flagged, plain, code], wb);
    expect(out.dropped).toHaveLength(1);
    expect(out.dropped[0]!.reason).toContain('L2_Parameters!A2');
    expect(out.findings.map((f) => f.title)).toEqual(['Retention to add', 'Other', 't']);
    expect(out.findings[0]!.detail).toContain('[Fact check:');
    expect(out.findings[1]).toBe(plain);
    expect(out.flagged).toBe(1);
    expect(out.notes).toHaveLength(2);
  });

  it('runs only the rules asked for', async () => {
    const wb = await fixture();
    const gone = finding({ detail: 'D3-S04-P27..P29 are not defined.' });
    expect(checkClaims([gone], wb, { rules: [] }).findings).toHaveLength(1);
    expect(checkClaims([gone], wb, { rules: ['alreadyDisclosed'] }).dropped).toHaveLength(0);
  });
});
