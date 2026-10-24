import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import type { EvaluationCore, Finding } from '@ddd/shared';
import { absentThings, checkFinding, checkFindings, claimsAbsence, mergeDuplicates } from '../src/agent/findingCheck.js';
import type { DraftFinding } from '../src/agent/types.js';
import { profileWorkbook } from '../src/excel/profile.js';
import { WorkbookModel } from '../src/excel/workbook.js';
import { assembleReport } from '../src/report/assemble.js';
import { renderMarkdown } from '../src/report/markdown.js';
import { renderXlsx } from '../src/report/xlsx.js';
import { TALENTRA_XLSX, makeWorkbook, runEvaluation } from './helpers.js';

const finding = (over: Partial<DraftFinding>): DraftFinding => ({
  source: 'raters', dimensionId: 'G07', severity: 'HIGH', title: 't', detail: 'd', fix: 'f', returnTo: 'Define',
  location: { sheet: 'Fields', cell: 'A2' }, reportedBy: ['A'], ...over,
});

/** A small schema sheet: id, type, allowed values, definition and DQ tags; some cells empty or "TBD". */
async function schema() {
  const rows: Array<Array<string | null>> = [['Field ID', 'Type and format', 'Allowed values (value set)', 'Definition', 'DQ dimensions', 'Owner']];
  for (let i = 2; i <= 21; i++) {
    rows.push([`F-${String(i).padStart(3, '0')}`, 'text(20)', 'YES_NO', i === 5 || i === 6 ? null : `Definition of field ${i}.`, i >= 8 && i <= 10 ? null : i === 11 ? 'TBD' : 'COMPLETENESS', i === 21 ? 'TBD' : 'Data team']);
  }
  const wb = await WorkbookModel.load(await makeWorkbook({ Fields: rows, Codes: [['Value set', '# codes'], ['YES_NO', 2], ['STATUS', 4]] }));
  return { wb, profile: profileWorkbook(wb) };
}

describe('what counts as a claim that something is missing', () => {
  it('recognises absence, and leaves claims that text is wrong, unclear or cut off alone', () => {
    expect(claimsAbsence(finding({ title: 'Missing DQ tags' }))).toBe(true);
    expect(claimsAbsence(finding({ title: 'x', detail: 'The sheet does not provide a legend.' }))).toBe(true);
    expect(claimsAbsence(finding({ title: 'Truncated definitions', detail: 'M59 is cut off mid-sentence.' }))).toBe(false);
  });

  it('reads the short things said to be missing, a list after a colon, and a "X absent" title; not words before the phrase', () => {
    expect(absentThings('No fields in the schema declare ISO required elements: data type, permissible values, or representation class.')).toEqual(
      expect.arrayContaining(['data type', 'permissible values', 'representation class']),
    );
    expect(absentThings('Code definitions absent')).toContain('Code definitions');
    expect(absentThings('It does not explain why no actors are missing.')).not.toContain('actors');
    // Kind words such as "evidence" or "coverage" are not the thing, so an "Evidence Class" column cannot match.
    expect(absentThings('The artifact contains no evidence of downstream input coverage for each actor class.')).toEqual(['evidence of downstream input coverage']);
  });
});

describe('the fact check, on cells a finding names', () => {
  it('drops a finding when every cell it says is empty is filled', async () => {
    const { wb, profile } = await schema();
    const v = checkFinding(finding({ title: 'Missing DQ tags', detail: 'Rows 2-4 have no DQ dimensions in column E.' }), wb, profile);
    expect(v).toMatchObject({ keep: false, reason: expect.stringMatching(/Every cell it names is filled \(Fields column E rows 2-4\)/) });
  });

  it('narrows the claim to the rows that really are empty, and says which were taken out', async () => {
    const { wb, profile } = await schema();
    const v = checkFinding(finding({ title: 'Missing DQ tags', detail: 'Rows 6-11 lack DQ dimensions (column E).' }), wb, profile);
    expect(v.keep).toBe(true);
    if (!v.keep) return;
    expect(v.narrowed).toBe(true);
    // Row 11 holds "TBD", a placeholder, so it counts as empty.
    expect(v.finding.detail).toMatch(/confirmed empty in Fields column E rows 8-11\. Filled, so taken out of the claim: Fields column E rows 6-7\./);
  });

  it('tests the column the missing thing is about: "rules in column B but no tags in column E" tests E', async () => {
    const { wb, profile } = await schema();
    const v = checkFinding(finding({ title: 'Untagged rules', detail: 'Rows 2-3 have a type in column B but no DQ dimensions in column E.' }), wb, profile);
    expect(v).toMatchObject({ keep: false, reason: expect.stringMatching(/column E rows 2-3/) });
  });

  it('finds the column from its title when no letter is given, and from cell addresses like D5-6', async () => {
    const { wb, profile } = await schema();
    const byTitle = checkFinding(finding({ title: 'Undefined fields', detail: 'Rows 5-7 lack a Definition.' }), wb, profile);
    expect(byTitle.keep && byTitle.finding.detail).toMatch(/confirmed empty in Fields column D rows 5-6\. Filled.*rows 7\./);
    const byCell = checkFinding(finding({ title: 'Undefined fields', detail: 'The cells D5-6 and D9 lack a definition.' }), wb, profile);
    expect(byCell.keep && byCell.finding.detail).toMatch(/confirmed empty in Fields column D rows 5-6/);
  });

  it('does not test cells when the missing thing is not what the column holds ("row 3 lacks an article")', async () => {
    const { wb, profile } = await schema();
    const v = checkFinding(finding({ title: 'Wording', detail: 'The definition in row 3 lacks an article before the noun.' }), wb, profile);
    expect(v).toEqual({ keep: true, finding: expect.anything(), narrowed: false });
  });

  it('ignores the header row, ids such as D1-S01-P10 and dimension codes such as G04', async () => {
    const { wb, profile } = await schema();
    const v = checkFinding(finding({ title: 'Missing DQ dimensions', detail: 'Parameter D1-S01-P10 under G04 lacks DQ dimensions in E1.' }), wb, profile);
    expect(v).toEqual({ keep: true, finding: expect.anything(), narrowed: false });
  });

  it('only checks cells named in a sentence that says something is missing, or in the examples right after it', async () => {
    const { wb, profile } = await schema();
    const elsewhere = checkFinding(finding({ title: 'Some rules are fragmented', detail: 'Many rules have no continuation marker. D2 and D3 are fragments.' }), wb, profile);
    expect(elsewhere).toMatchObject({ keep: true, narrowed: false });
    const examples = checkFinding(finding({ title: 'Missing DQ dimensions', detail: 'Several rules lack DQ dimensions (column E). Examples include rows 2-3.' }), wb, profile);
    expect(examples.keep).toBe(false);
  });
});

describe('the fact check, on things a finding says the file lacks', () => {
  it('drops a claim about every field when nearly full columns hold most of what it lists', async () => {
    const { wb, profile } = await schema();
    const v = checkFinding(finding({ title: 'Missing mandatory metadata', detail: 'No fields in the schema declare the required elements: data type, permissible values, or representation class.' }), wb, profile);
    expect(v).toMatchObject({ keep: false });
    if (v.keep) return;
    expect(v.reason).toMatch(/"data type": column B "Type and format" is 100% filled; "permissible values": column C "Allowed values \(value set\)" is 100% filled/);
    expect(v.reason).toMatch(/not checked: .*representation class/);
  });

  it('keeps a claim about some rows, or about quality, even when the column is full', async () => {
    const { wb, profile } = await schema();
    expect(checkFinding(finding({ title: 'Missing data type', detail: 'Some fields (F-012, F-013) lack a data type.' }), wb, profile).keep).toBe(true);
    expect(checkFinding(finding({ title: 'Insufficient type detail', detail: 'No fields in the schema give a clear data type.' }), wb, profile).keep).toBe(true);
  });

  it('keeps it when only one of several listed things is there, when the match is a count, or when the column is mostly "TBD"', async () => {
    const { wb, profile } = await schema();
    const one = finding({ title: 'Missing metadata', detail: 'No fields in the schema declare: data type, unit of measure, or representation class.' });
    expect(checkFinding(one, wb, profile).keep).toBe(true);
    const count = finding({ location: { sheet: 'Codes', cell: 'A1' }, title: 'Codes absent', detail: 'No codes are listed anywhere for each value set.' });
    expect(checkFinding(count, wb, profile).keep).toBe(true);
    const placeholderWb = await WorkbookModel.load(await makeWorkbook({ Fields: [['Field ID', 'Owner'], ...Array.from({ length: 10 }, (_, i) => [`F-${i + 10}`, 'TBD'])] }));
    const owner = finding({ title: 'Owners absent', detail: 'No fields in the schema have: owner.' });
    expect(checkFinding(owner, placeholderWb).keep).toBe(true);
  });

  it('never touches a code finding, and never raises a severity', async () => {
    const { wb } = await schema();
    const code = finding({ source: 'code', title: 'Missing DQ tags', detail: 'Rows 2-4 have no DQ dimensions in column E.' });
    expect(checkFinding(code, wb)).toEqual({ keep: true, finding: code, narrowed: false });
    const low = finding({ severity: 'LOW', title: 'Missing DQ tags', detail: 'Rows 6-11 lack DQ dimensions (column E).' });
    const v = checkFinding(low, wb);
    expect(v.keep && v.finding.severity).toBe('LOW');
  });
});

describe('merging findings that say the same thing', () => {
  it('merges the same cell with similar words, very similar titles, and the same column with overlapping rows', async () => {
    const { profile } = await schema();
    const a = finding({ title: 'Unresolved actor conflicts', detail: 'Two actors are marked CONFLICT and not reconciled.', location: { sheet: 'Fields', cell: 'K14' }, reportedBy: ['A', 'B'] });
    const b = finding({ title: 'CONFLICT evidence class unresolved', detail: 'Two actors are marked CONFLICT, which is unresolved.', location: { sheet: 'Fields', cell: 'K14' }, severity: 'MEDIUM', reportedBy: ['C'] });
    const c = finding({ title: 'Code definitions absent', location: { sheet: 'Codes', cell: 'A1' } });
    const d = finding({ title: 'Missing code definitions', location: { sheet: 'Codes', cell: 'A5' }, severity: 'LOW', reportedBy: ['B'] });
    const e = finding({ title: 'Untagged rules', detail: 'Rows 6-9 lack DQ dimensions in column E.' });
    const g = finding({ title: 'Quality tagging gaps', detail: 'Rows 8-10 have no DQ dimensions in column E.', reportedBy: ['C'] });
    const { findings, merged } = mergeDuplicates([a, b, c, d, e, g], profile);
    expect(merged).toBe(3);
    expect(findings).toHaveLength(3);
    const conflict = findings.find((f) => /conflict/i.test(f.title))!;
    expect(conflict).toMatchObject({ title: 'Unresolved actor conflicts', severity: 'HIGH', reportedBy: ['A', 'B', 'C'] });
    expect(conflict.detail).toMatch(/\[Also reported as: "CONFLICT evidence class unresolved"\.\]$/);
    expect(findings.find((f) => /code/i.test(f.title))).toMatchObject({ severity: 'HIGH', reportedBy: ['A', 'B'] });
  });

  it('merges the same question on the same sheet when the words mostly overlap, even at different cells', async () => {
    const { profile } = await schema();
    const gaps = { sheet: 'Gaps' };
    const a = finding({ title: 'No decision field on gap rows', detail: 'The schema has no column to record a decision for each gap.', location: { ...gaps, cell: 'A5' }, reportedBy: ['A'] });
    const b = finding({ title: 'No decisions recorded for gaps', detail: 'The artifact lists gaps but has no column to record a decision for them.', location: { ...gaps, cell: 'F6' }, severity: 'MEDIUM', reportedBy: ['C'] });
    const other = finding({ title: 'Owner names are free text', detail: 'Stewards are typed as names, with no list of people to pick from.', location: { ...gaps, cell: 'G9' } });
    const { findings, merged } = mergeDuplicates([a, b, other], profile);
    expect(merged).toBe(1);
    expect(findings.find((f) => /decision/i.test(f.title) && f.location?.sheet === 'Gaps')).toMatchObject({ reportedBy: ['A', 'C'], severity: 'HIGH' });
    expect(findings.map((f) => f.title)).toContain('Owner names are free text');
  });

  it('does not merge different topics on the same cell, the same words in different dimensions, or code findings', async () => {
    const { profile } = await schema();
    const at = { sheet: 'Codes', cell: 'A1' };
    const list = [
      finding({ title: 'Code definitions absent', location: at }),
      finding({ title: 'Missing unknown value handling', location: at }),
      finding({ title: 'Code definitions absent', location: at, dimensionId: 'G06' }),
      finding({ source: 'code', title: 'Code definitions absent', location: at }),
      finding({ source: 'code', title: 'Code definitions absent', location: at }),
    ];
    expect(mergeDuplicates(list, profile).merged).toBe(0);
  });

  it('does not chain loosely similar findings into one group', async () => {
    const { profile } = await schema();
    const list = [
      finding({ title: 'alpha beta gamma delta', location: null }),
      finding({ title: 'alpha beta gamma epsilon', location: null }),
      finding({ title: 'beta gamma epsilon zeta', location: null }),
    ];
    // The second repeats the first; the third repeats the second but not the first, so it starts its own group.
    expect(mergeDuplicates(list, profile).findings).toHaveLength(2);
  });
});

describe('checkFindings, end to end', () => {
  it('returns what it dropped with the reason, what it merged, and a note for each', async () => {
    const { wb } = await schema();
    const res = checkFindings(
      [
        finding({ title: 'Missing DQ tags', detail: 'Rows 2-4 have no DQ dimensions in column E.' }),
        finding({ title: 'Missing DQ tags', detail: 'Rows 6-11 lack DQ dimensions (column E).' }),
        finding({ title: 'Missing DQ tags on rules', detail: 'Rows 8-9 lack DQ dimensions (column E).', reportedBy: ['B'] }),
      ],
      wb,
    );
    expect(res.dropped).toEqual([expect.objectContaining({ title: 'Missing DQ tags', severity: 'HIGH', reason: expect.stringMatching(/Every cell it names is filled/) })]);
    expect(res.findings).toHaveLength(1);
    expect(res).toMatchObject({ merged: 1, narrowed: 1 });
    expect(res.notes.join(' ')).toMatch(/dropped 1 examiner finding.*narrowed 1 finding.*1 duplicate finding/);
  });

  it('is part of every evaluation: the run records its notes, and a clean run has no dropped list', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX });
    expect(run.core.droppedFindings ?? []).toEqual([]);
    expect(run.core.findings.every((f) => f.id.startsWith('F-'))).toBe(true);
  });
});

describe('the report shows what the fact check dropped', () => {
  it('mentions in plain words, without codes, that the fact check set claims aside, only when there are some', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX });
    const core: EvaluationCore = {
      ...run.core,
      droppedFindings: [{ dimensionId: 'C02', severity: 'HIGH', title: 'No definitions', location: { sheet: 'Tree', cell: 'H5' }, reportedBy: ['A'], reason: 'Every cell it names is filled (Tree column H rows 5-9).' }],
    };
    const report = assembleReport(core, null);
    const md = renderMarkdown(report);
    expect(md).toMatch(/1 claim was set aside because the file plainly contradicts it/);
    expect(md).not.toMatch(/\bC02\b/);
    const plain = assembleReport(run.core, null);
    expect(renderMarkdown(plain)).not.toMatch(/set aside/);
    expect(plain).not.toHaveProperty('droppedFindings');
  });
});

/**
 * The live Bedrock run of 23 Oct 2026 (159 findings, 54 HIGH) against the real workbook. Every claim below was checked
 * by hand against the file. The workbook is the user's own and is not in the repository, so this skips without it.
 */
const REAL = path.join(os.homedir(), 'Desktop', 'Talentra_Step2_Master_Schema.xlsx');
describe.skipIf(!existsSync(REAL))('on the real findings of the live GS-1 run', () => {
  const live = JSON.parse(readFileSync(new URL('./fixtures/live-gs1-findings.json', import.meta.url), 'utf8')) as { findings: Finding[] };
  const byId = new Map(live.findings.map((f) => [f.id, f]));
  const load = async () => WorkbookModel.load(readFileSync(REAL));
  const verdict = async (id: string) => checkFinding(byId.get(id)!, await load());

  it('drops the claim that no field has a data type or allowed values (columns G and H are 96% filled)', async () => {
    const v = await verdict('F-011');
    expect(v).toMatchObject({ keep: false, reason: expect.stringMatching(/column G "Type and format".*column H "Allowed values/) });
  });

  it('keeps every finding that was confirmed true by hand', async () => {
    for (const id of ['F-005', 'F-008', 'F-009', 'F-010', 'F-012', 'F-016', 'F-018', 'F-019', 'F-020', 'F-021']) expect((await verdict(id)).keep, id).toBe(true);
    // Findings an earlier, looser version of these rules dropped wrongly: "evidence of ..." against an "Evidence Class" column,
    // "why no actors are missing", "TBD" in the Enforcement Approach column, partial "some ... audit coverage", a header cell.
    for (const id of ['F-007', 'F-062', 'F-098', 'F-100', 'F-151', 'F-155', 'F-069', 'F-126']) expect((await verdict(id)).keep, id).toBe(true);
  });

  it('narrows the empty-cell claims to the rows that really are empty', async () => {
    const f010 = await verdict('F-010');
    expect(f010.keep && f010.finding.detail).toMatch(/confirmed empty in Schema_L2_Parameters column M rows 43-44/);
    expect(f010.keep && f010.finding.detail).toMatch(/taken out of the claim: Schema_L2_Parameters column M rows 59-60/);
    const f022 = await verdict('F-022');
    // Rows 47-50 are really empty in column S; rows 122 and 137 are filled.
    expect(f022.keep && f022.finding.detail).toMatch(/confirmed empty in Schema_L2_Parameters column S rows 47-50/);
    expect(f022.keep && f022.finding.detail).toMatch(/taken out of the claim: Schema_L2_Parameters column S rows 51-52, 122, 137/);
  });

  it('merges the known duplicates and cuts the list by about a third, with fewer HIGH findings', async () => {
    const res = checkFindings(live.findings, await load());
    const survives = (id: string) => res.findings.some((f) => f.title === byId.get(id)!.title && f.dimensionId === byId.get(id)!.dimensionId);
    for (const [kept, gone] of [['F-008', 'F-009'], ['F-016', 'F-021'], ['F-019', 'F-020']] as const) {
      expect(survives(kept) !== survives(gone), `${kept}/${gone} merged`).toBe(true);
    }
    expect(['F-022', 'F-024', 'F-025'].filter(survives)).toHaveLength(1);
    expect(live.findings).toHaveLength(159);
    expect(res.findings.length).toBeLessThan(115);
    expect(res.findings.filter((f) => f.severity === 'HIGH').length).toBeLessThan(45);
    expect(res.dropped.map((d) => d.title)).toContain(byId.get('F-011')!.title);
  });
});
