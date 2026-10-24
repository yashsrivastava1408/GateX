import { describe, expect, it } from 'vitest';
import { checkFinding, complainsAboutOutsideEvidence, complainsAboutThePrompt, isVague, namedMissing, placesHolding } from '../src/agent/findingCheck.js';
import type { DraftFinding } from '../src/agent/types.js';
import { WorkbookModel } from '../src/excel/workbook.js';
import { makeWorkbook } from './helpers.js';

const finding = (over: Partial<DraftFinding>): DraftFinding => ({
  source: 'raters', dimensionId: 'G11', severity: 'HIGH', title: 't', detail: 'd', fix: 'f', returnTo: 'Define',
  location: { sheet: 'README', cell: 'A1' }, reportedBy: ['A'], ...over,
});

/** A small schema that has an exit-gate sheet and defines owners, so "missing" claims about them are false. */
async function workbook() {
  return WorkbookModel.load(
    await makeWorkbook({
      README: [['Title'], ['A schema for personas.'], ['What is NOT here'], ['Filled templates.']],
      Exit_Gate_Checks: [['ID', 'Check'], ['MC-01', 'Every requirement names an actor at the exit gate'], ['MC-02', 'Exit gate result is recorded']],
      L1_Sections: [['ID', 'About'], ['S1', 'Owner and steward of the register'], ['S2', 'Exit gate: every requirement has an actor']],
      L4_Attribute_Guide: [['Attribute', 'Example'], ['Name', 'Alpha']],
    }),
  );
}

describe('vague findings', () => {
  it('flags a hedged, short finding that names nothing to look at', () => {
    expect(isVague({ title: 'x', detail: 'Some rules are not fully specified, which could lead to incorrect outcomes.' })).toBe(true);
    expect(isVague({ title: 'x', detail: 'The artifact does not cover all least-privilege guards.' })).toBe(true);
  });

  it('keeps a finding that names an id, a number, a quote or an acronym', () => {
    expect(isVague({ title: 'x', detail: 'Some actors (ACT-01, ACT-02) have no privileges, which could confuse access.' })).toBe(false);
    expect(isVague({ title: 'x', detail: 'Some goals say "(UNSPECIFIED)", which could hide a gap.' })).toBe(false);
    expect(isVague({ title: 'x', detail: 'Four goals are missing, which could block the DPDP review.' })).toBe(false);
    expect(isVague({ title: 'x', detail: 'Sheet L2_Parameters has 3 empty cells, which may break loading.' })).toBe(false);
  });

  it('does not count a page number as something concrete', () => {
    expect(isVague({ title: 'x', detail: 'The documentation on Page 1 could be more detailed. Some elements are missing.' })).toBe(true);
    expect(isVague({ title: 'x', detail: 'Some fields on Page 3 and Page 4 could be formatted better.' })).toBe(true);
  });

  it('keeps a plain, unhedged statement of what is missing, and a long finding', () => {
    expect(isVague({ title: 'x', detail: 'The executive opening does not state which risks this artifact controls or mitigates.' })).toBe(false);
    expect(isVague({ title: 'x', detail: `Some things could be wrong. ${'More words here. '.repeat(30)}` })).toBe(false);
  });

  it('does not count the "[Also reported as ...]" tail a merge adds', () => {
    expect(isVague({ title: 'x', detail: 'Some items may be off. [Also reported as: "Item 42 off"; "Row 7"]' })).toBe(true);
  });

  it('drops a vague examiner finding, with a reason, and never a code finding', async () => {
    const wb = await workbook();
    const vague = finding({ detail: 'Some sections may lack detail, which could confuse readers.' });
    const verdict = checkFinding(vague, wb);
    expect(verdict.keep).toBe(false);
    expect(!verdict.keep && verdict.reason).toMatch(/names nothing to look at/);
    expect(checkFinding({ ...vague, source: 'code' }, wb).keep).toBe(true);
  });
});

describe('a missing thing the file holds', () => {
  it('finds the places that mention every word of a thing, in sheet names and cells', async () => {
    const found = placesHolding(await workbook(), 'exit gate');
    expect(found.count).toBeGreaterThanOrEqual(3);
    expect(found.example).toMatch(/Exit_Gate_Checks/);
  });

  it('needs at least two words, so one common word proves nothing', async () => {
    expect(placesHolding(await workbook(), 'steward').count).toBe(0);
  });

  it('drops "no exit gate" when the file names the exit gate in several places', async () => {
    const verdict = checkFinding(finding({ title: 'Missing exit gate', detail: 'The artifact does not provide any evidence of an exit gate.' }), await workbook());
    expect(verdict.keep).toBe(false);
    expect(!verdict.keep && verdict.reason).toMatch(/names it in \d+ places/);
  });

  it('keeps "no risk register" when the file does not mention one', async () => {
    const verdict = checkFinding(finding({ title: 'Missing risk register', detail: 'The artifact does not provide a risk register for the personas.' }), await workbook());
    expect(verdict.keep).toBe(true);
  });

  it('tests a claim about a named sheet on that sheet only', async () => {
    const wb = await workbook();
    // "exit gate" is all over the file, but this finding is about L4_Attribute_Guide, which does not mention it.
    const verdict = checkFinding(
      finding({ title: 'No exit gate example', detail: 'The L4_Attribute_Guide does not include an exit gate example.', location: { sheet: 'L4_Attribute_Guide', cell: 'A1' } }),
      wb,
    );
    expect(verdict.keep).toBe(true);
  });

  it('leaves a claim about quality alone, even when the words are in the file', async () => {
    const verdict = checkFinding(finding({ title: 'Exit gate unclear', detail: 'The exit gate description is incomplete and does not give a clear exit gate rule.' }), await workbook());
    expect(verdict.keep).toBe(true);
  });
});

describe('complaints about what the examiner was shown', () => {
  it('recognises "not provided", "not visible in the provided artifact" and "was not provided to verify"', () => {
    expect(complainsAboutThePrompt({ title: 'Feature names not visible', detail: 'The feature names are not visible in the provided artifact (columns A-G).' })).toBe(true);
    expect(complainsAboutThePrompt({ title: 'x', detail: 'The L1-3 Coverage Matrix sheet was not provided to verify this requirement.' })).toBe(true);
    expect(complainsAboutThePrompt({ title: 'x', detail: 'The Permission_Matrix sheet was not provided for review.' })).toBe(true);
  });

  it('leaves a finding about the file alone, even one that says something is not provided', () => {
    expect(complainsAboutThePrompt({ title: 'x', detail: 'The schema does not provide a decision column for the gap rows.' })).toBe(false);
    expect(complainsAboutThePrompt({ title: 'x', detail: 'No owner is provided for ACT-01 in column G.' })).toBe(false);
  });

  it('drops such a finding with a reason that says it is about what was shown', async () => {
    const wb = await WorkbookModel.load(await makeWorkbook({ README: [['Title']] }));
    const verdict = checkFinding(finding({ title: 'Matrix not shown', detail: 'The Coverage Matrix sheet was not provided to verify the register columns for VR-22.' }), wb);
    expect(verdict.keep).toBe(false);
    expect(!verdict.keep && verdict.reason).toMatch(/what the examiner was shown/);
  });
});

describe('a quoted name said to be missing that is a cell of the file', () => {
  it('reads the name from the usual ways of saying a column or field is missing', () => {
    expect(namedMissing("The column 'Gap description' is missing in the schema.")).toEqual(['Gap description']);
    expect(namedMissing('There is no "Decision" column on the gap rows.')).toEqual(['Decision']);
    expect(namedMissing("The sheet lacks the field 'Owner' for each row.")).toEqual(['Owner']);
    expect(namedMissing("A reader cannot know what 'Source explicit' means without documentation.")).toEqual([]);
  });

  it('drops the finding when a cell on the cited sheet says exactly that name, and keeps it when none does', async () => {
    const wb = await WorkbookModel.load(await makeWorkbook({ Sheet1: [['Id', 'Name'], ['8.2.1', 'Gap type'], ['8.2.2', 'Gap description']], Other: [['Priority']] }));
    const there = checkFinding(finding({ title: 'Missing column', detail: "The column 'Gap description' is missing in the schema.", location: { sheet: 'Sheet1', cell: 'A3' } }), wb);
    expect(there.keep).toBe(false);
    expect(!there.keep && there.reason).toMatch(/Sheet1!B3 says exactly that/);
    // The name exists only on another sheet, so a claim about this sheet stands.
    expect(checkFinding(finding({ title: 'Missing column', detail: "The column 'Priority' is missing from this sheet.", location: { sheet: 'Sheet1', cell: 'A1' } }), wb).keep).toBe(true);
    expect(checkFinding(finding({ title: 'Missing column', detail: "The column 'Decision' is missing.", location: { sheet: 'Sheet1', cell: 'A1' } }), wb).keep).toBe(true);
  });

  it('does not drop a finding that merely quotes a name it is not calling missing', async () => {
    const wb = await WorkbookModel.load(await makeWorkbook({ Sheet1: [['Id', 'Code'], ['1', 'Source explicit']] }));
    expect(checkFinding(finding({ title: 'Meanings absent', detail: "The schema lists 'Source explicit' but does not define what it means.", location: { sheet: 'Sheet1', cell: 'B2' } }), wb).keep).toBe(true);
  });
});

describe('missing-evidence complaints about a criterion that needs outside evidence', () => {
  const outside = new Set(['SD5-C01']);
  it('sets one aside only when the criterion needs outside evidence and the finding says something is absent', () => {
    expect(complainsAboutOutsideEvidence({ dimensionId: 'SD5-C01', title: 'No evidence of blind second derivation', detail: 'No data from run B exists in the artifact.' }, outside)).toBe(true);
    expect(complainsAboutOutsideEvidence({ dimensionId: 'SD5-C01', title: 'Run labels are inconsistent', detail: 'Row 5 says run B and row 9 says run 2.' }, outside)).toBe(false);
    expect(complainsAboutOutsideEvidence({ dimensionId: 'SD4-C01', title: 'No evidence of codes', detail: 'No source codes exist.' }, outside)).toBe(false);
  });
});
