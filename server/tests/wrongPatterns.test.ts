import { describe, expect, it } from 'vitest';
import { asksFileForOutsideWork, checkFinding, saysTheWorkIsFine } from '../src/agent/findingCheck.js';
import type { DraftFinding } from '../src/agent/types.js';
import { WorkbookModel } from '../src/excel/workbook.js';
import { makeWorkbook } from './helpers.js';

/**
 * Two filters built from the findings we labelled "wrong" across the labelled runs (npm run wrongs, npm run replay:all). The texts below are
 * taken from those runs. The "kept" cases are the nearest real or partly-right findings, which must survive.
 */
const finding = (over: Partial<DraftFinding>): DraftFinding => ({
  source: 'raters', dimensionId: 'G12', severity: 'HIGH', title: 't', detail: 'd', fix: 'f', returnTo: 'Define',
  location: { sheet: 'Fields', cell: 'A2' }, reportedBy: ['A'], ...over,
});

const wbWith = async (sheets: Record<string, Array<Array<string | number | null>>>) => WorkbookModel.load(await makeWorkbook(sheets));

describe('filter: asking the file for work done outside it', () => {
  const cases: Array<[string, string, string]> = [
    ['live-v32-run2 F-16', 'Lack of Evidence for Independent Generation Runs', 'The artifact does not provide evidence of multiple independent generation runs or their agreement on design points.'],
    ['live-v32-run3 F-16', 'No evidence of run consistency or item-level agreement', 'The dimension requires evidence that L2 items are matched by at least one independent run, but the artifact contains no mention of runs.'],
    ['live-step4-run1 F-02', 'No reviewer spot-checks', 'No evidence of reviewer spot-checks to ensure the register matches the source docket.'],
    ['live-step4-run1 F-04', 'No author answers to sample questions', 'No evidence of author answers to sample questions to ensure understanding.'],
    ['live-step4-run1 F-06', 'No evidence of two independent runs', 'No evidence of two independent runs to ensure parameters agree.'],
    ['live-step5-run3 F-01', 'No evidence of blind second derivation (Run B)', 'The schema claims to be validated by an independent run, but no data, mapping, or reference to Run B exists in the artifact.'],
    ['live-step5-run3 F-02', 'No author interview evidence', 'The schema requires a human-only gate: the author must answer 10 interview questions. No interview sheet or results are provided.'],
  ];
  it.each(cases)('drops %s', async (_name, title, detail) => {
    const wb = await wbWith({ Fields: [['ID'], ['F-1']] });
    const f = finding({ title, detail });
    expect(asksFileForOutsideWork(f)).toBe(true);
    const verdict = checkFinding(f, wb);
    expect(verdict.keep).toBe(false);
    if (!verdict.keep) expect(verdict.reason).toMatch(/outside it/);
  });

  it('keeps findings that only mention these words, or a file that has a sheet for such work', async () => {
    const wb = await wbWith({ Fields: [['ID'], ['F-1']] });
    // Not a claim of absence: it says what the file does.
    expect(asksFileForOutsideWork(finding({ title: 'Independent runs disagree', detail: 'Run B gives a different count of actors than run A.' }))).toBe(false);
    // A real, nearby gap (labelled real in live-v32-run1): about content, not about outside work.
    expect(checkFinding(finding({ dimensionId: 'G03', title: 'No consumers stated', detail: 'The README does not name the consumers of this register.' }), wb).keep).toBe(true);
    // The workbook records independent runs itself, so the examiners' complaint about them is not dismissed by code.
    const withRuns = await wbWith({ Fields: [['ID'], ['F-1']], Independent_Runs: [['Run'], ['A']] });
    expect(asksFileForOutsideWork(finding({ title: 'No evidence of two independent runs', detail: 'No evidence of two independent runs.' }), withRuns.sheetNames())).toBe(false);
  });
});

describe('filter: a finding that says the work is fine', () => {
  it('drops the findings that report their own subject as consistent or present', async () => {
    const wb = await wbWith({ Fields: [['ID'], ['F-1']] });
    const a = finding({ dimensionId: 'S03-08', title: 'L4 count inconsistency with header', detail: "The header states 'L4 = 3' but the summary count row shows 3 L4 IDed leaves, which appears consistent. However, this should be verified against the stated source document counts." });
    const b = finding({ dimensionId: 'G10', severity: 'LOW', title: "Missing STRIDE category 'Spoofing' in threat list", detail: 'TH-008 (SPOOFING) is present, but the threat model does not explicitly list Spoofing in the header; this may cause audit confusion despite its presence in row B12.' });
    for (const f of [a, b]) {
      expect(saysTheWorkIsFine(f)).toBe(true);
      expect(checkFinding(f, wb).keep).toBe(false);
    }
  });

  it('keeps a real finding that merely says part of the work is present', async () => {
    const wb = await wbWith({ Fields: [['ID'], ['F-1']] });
    const real = finding({ title: 'Four goals are UNSPECIFIED', detail: 'Goals are defined for most actors, but H5, H6, H7 and H13 are marked UNSPECIFIED.' });
    expect(saysTheWorkIsFine(real)).toBe(false);
    expect(checkFinding(real, wb).keep).toBe(true);
  });
});
