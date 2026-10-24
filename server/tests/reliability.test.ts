import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ReliabilityTable } from '@ddd/shared';
import { MIN_SOLO_SAMPLES, SOLO_DROP_BELOW, loneFindingReason } from '../src/agent/reliability.js';
import { checkFindings } from '../src/agent/findingCheck.js';
import type { DraftFinding } from '../src/agent/types.js';
import { loadReliability, measureReliability } from '../src/library/library.js';
import { WorkbookModel } from '../src/excel/workbook.js';
import { makeWorkbook } from './helpers.js';

const examiners = [{ id: 'A', family: 'zhipu' }, { id: 'B', family: 'meta' }, { id: 'C', family: 'newmaker' }];
const table = (families: ReliabilityTable['families']): ReliabilityTable => ({
  computedAt: '2026-10-24T00:00:00.000Z',
  thresholds: { minSamples: MIN_SOLO_SAMPLES, dropBelow: SOLO_DROP_BELOW },
  families,
});
const t = table({
  zhipu: { solo: { n: 35, useful: 20 }, any: { n: 76, useful: 53 } },
  meta: { solo: { n: 47, useful: 1 }, any: { n: 84, useful: 29 } },
  newmaker: { solo: { n: 5, useful: 0 }, any: { n: 5, useful: 0 } },
});
const finding = (over: Partial<DraftFinding>): DraftFinding => ({
  source: 'raters', dimensionId: 'G01', severity: 'HIGH', title: 'Decision column missing for ACT-01', detail: 'Row 5 (ACT-01) has no decision recorded.', fix: 'f', returnTo: 'Define',
  location: { sheet: 'Gaps', cell: 'A5' }, reportedBy: ['B'], ...over,
});

describe('setting aside a finding only a rarely-right examiner raised', () => {
  it('sets it aside for a family whose lone findings were right under the line, and says why', () => {
    const reason = loneFindingReason(finding({}), examiners, t);
    expect(reason).toMatch(/Only examiner B \(meta\)/);
    expect(reason).toMatch(/Across 47 findings.*1 were useful \(2%\)/);
  });

  it('keeps it for a family that is right often enough, one with too few checked findings, and when there is no table', () => {
    expect(loneFindingReason(finding({ reportedBy: ['A'] }), examiners, t)).toBeNull();
    expect(loneFindingReason(finding({ reportedBy: ['C'] }), examiners, t)).toBeNull();
    expect(loneFindingReason(finding({}), examiners, undefined)).toBeNull();
    expect(loneFindingReason(finding({ reportedBy: ['Z'] }), examiners, t)).toBeNull();
  });

  it('never touches a finding two examiners raised, or a code finding', () => {
    expect(loneFindingReason(finding({ reportedBy: ['A', 'B'] }), examiners, t)).toBeNull();
    expect(loneFindingReason(finding({ source: 'code' }), examiners, t)).toBeNull();
  });

  it('applies after the merge, so a finding two examiners raised in different words is confirmed, not two lone ones', async () => {
    const wb = await WorkbookModel.load(await makeWorkbook({ Gaps: [['Id', 'Note'], ['a', 'b'], ['c', 'd'], ['e', 'f'], ['g', 'h'], ['ACT-01', 'x']] }));
    const lone = loneFindingReason;
    const options = { loneReason: (f: DraftFinding) => lone(f, examiners, t) };
    const aloneB = checkFindings([finding({ title: 'Totally different problem about LC-77', detail: 'LC-77 lacks a unit.', location: { sheet: 'Gaps', cell: 'B9' } })], wb, options);
    expect(aloneB.findings).toHaveLength(0);
    expect(aloneB.dropped[0]!.reason).toMatch(/Only examiner B/);
    expect(aloneB.notes.join(' ')).toMatch(/raised by one examiner alone/);

    const both = checkFindings([finding({ reportedBy: ['B'] }), finding({ title: 'Decision column missing for ACT-01', reportedBy: ['A'] })], wb, options);
    expect(both.findings).toHaveLength(1);
    expect(both.findings[0]!.reportedBy).toEqual(['A', 'B']);
    expect(both.dropped).toEqual([]);
  });
});

describe('measuring how reliable each examiner is from the checked runs', () => {
  it('counts a verdict once for every examiner that reported the finding, and separately for lone findings', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ddd-reliability-'));
    for (const d of ['library', 'run']) await mkdir(path.join(dir, d), { recursive: true });
    const f = (id: string, reportedBy: string[], source = 'raters') => ({ id, source, severity: 'LOW', dimensionId: 'Q1', title: id, location: { sheet: 'S', cell: 'A1' }, reportedBy });
    await writeFile(
      path.join(dir, 'run', 'report.json'),
      JSON.stringify({
        header: { promptVersion: 'p', finishedAt: '2026-10-24T00:00:00.000Z', raters: [{ id: 'A', family: 'zhipu', model: 'a' }, { id: 'B', family: 'meta', model: 'b' }] },
        verdict: { weightedScore: 1, decision: 'red' },
        dimensions: [],
        findings: [f('F-01', ['A']), f('F-02', ['A', 'B']), f('F-03', ['B']), f('F-04', ['B']), f('F-05', ['A'], 'code'), f('F-06', ['B']), f('F-07', ['A'])],
      }),
    );
    await writeFile(
      path.join(dir, 'review.json'),
      JSON.stringify({ labels: [{ id: 'F-01', verdict: 'real' }, { id: 'F-02', verdict: 'partly' }, { id: 'F-03', verdict: 'wrong' }, { id: 'F-04', verdict: 'vague' }, { id: 'F-05', verdict: 'real' }, { id: 'F-06', verdict: 'unchecked' }] }),
    );
    await writeFile(path.join(dir, 'library', 'case.json'), JSON.stringify({ id: 'case', title: 'c', step: 's', workbook: 'w', scorecard: 'sc', runs: [{ label: 'r', runDir: 'run', reviewFile: 'review.json' }] }));

    const measured = await measureReliability(dir, new Date('2026-10-24T00:00:00.000Z'));
    // F-05 is a code finding, F-06 was not settled, F-07 was never reviewed: none of them count.
    expect(measured.families.zhipu).toEqual({ solo: { n: 1, useful: 1 }, any: { n: 2, useful: 2 } });
    expect(measured.families.meta).toEqual({ solo: { n: 2, useful: 0 }, any: { n: 3, useful: 1 } });
    expect(measured.thresholds).toEqual({ minSamples: MIN_SOLO_SAMPLES, dropBelow: SOLO_DROP_BELOW });

    expect(await loadReliability(dir)).toBeUndefined();
    await writeFile(path.join(dir, 'library', 'reliability.json'), JSON.stringify(measured));
    expect(await loadReliability(dir)).toEqual(measured);
    // The saved table is not mistaken for a test case.
    expect((await measureReliability(dir)).families.zhipu!.any.n).toBe(2);
  });
});
