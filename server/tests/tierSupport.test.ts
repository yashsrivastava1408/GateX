import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tierFindings, tierOf, type DimensionResult, type Finding } from '@ddd/shared';
import { aboutAFullMarkQuestion } from '../src/agent/tierSupport.js';

const dim = (over: Partial<DimensionResult>): DimensionResult => ({
  id: 'D01', name: 'Hierarchy depth', weight: 1, critical: false, measuredBy: 'raters', status: 'scored', raterScores: { A: 0, B: 5, C: 5 }, consolidated: 5, spread: 5,
  resolution: 'claims_checked', flagged: false, rationale: 'r.', evidence: [], ...over,
});
const finding = (over: Partial<Finding> = {}): Finding => ({
  id: 'F-01', severity: 'HIGH', dimensionId: 'D01', location: { sheet: 'Summary', cell: 'D12' }, title: 'Hierarchy depth issues', detail: 'Sections lack depth.', fix: 'Add levels.',
  returnTo: 'Discover', source: 'raters', reportedBy: ['A', 'B', 'C'], ...over,
});

describe('a finding about a question that was marked 5 in the end', () => {
  it('is Worth a look, whatever the number of examiners, and says why', () => {
    const f = finding();
    expect(aboutAFullMarkQuestion(f, [dim({})])).toBe(true);
    const [tiered] = tierFindings([f], undefined, () => false, (x) => aboutAFullMarkQuestion(x, [dim({})]));
    expect(tiered!.tier).toBe('worth_a_look');
    expect(tiered!.tierReason).toMatch(/marked 5/);
  });
  it('stays Confirmed on a question marked 4 or less, and when code found it or proved it', () => {
    expect(aboutAFullMarkQuestion(finding(), [dim({ consolidated: 4 })])).toBe(false);
    expect(aboutAFullMarkQuestion(finding({ source: 'code', reportedBy: ['code'] }), [dim({})])).toBe(false);
    expect(tierOf(finding({ proof: 'Code read the cells and they are empty.' }), undefined, false, true).tier).toBe('confirmed');
    expect(tierOf(finding({ source: 'code', reportedBy: ['code'] }), undefined, false, true).tier).toBe('confirmed');
    expect(tierOf(finding(), undefined, false, false).tier).toBe('confirmed');
  });
  it('is not moved when the question was not scored or is unknown', () => {
    expect(aboutAFullMarkQuestion(finding(), [dim({ status: 'unscored', consolidated: null })])).toBe(false);
    expect(aboutAFullMarkQuestion(finding({ dimensionId: 'Z' }), [dim({})])).toBe(false);
  });

  // The real case: the Step 3 run on the correct scorecard (data/live-step3-correct) put "Hierarchy depth issues" at the top as a Confirmed HIGH finding on a question marked 5.
  const saved = path.resolve(import.meta.dirname, '../../data/live-step3-correct/report.json');
  it.skipIf(!existsSync(saved))('on the saved Step 3 report, the high-risk "lacks depth" finding is no longer Confirmed', async () => {
    const report = JSON.parse(await readFile(saved, 'utf8')) as { findings: Finding[]; dimensions: DimensionResult[] };
    const before = report.findings.find((f) => f.title === 'Hierarchy depth issues')!;
    expect(before.severity).toBe('HIGH');
    const retiered = tierFindings(report.findings.map((f) => ({ ...f, tier: undefined })), undefined, () => false, (f) => aboutAFullMarkQuestion(f, report.dimensions));
    expect(retiered.find((f) => f.title === 'Hierarchy depth issues')!.tier).toBe('worth_a_look');
    expect(retiered.find((f) => f.source === 'code')!.tier).toBe('confirmed');
  });
});
