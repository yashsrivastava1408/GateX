import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { listLibrary, listPlanted, readLibraryCase } from '../src/library/library.js';

const finding = (id: string, cell: string, title = `Finding ${id}`) => ({ id, severity: 'HIGH', dimensionId: 'G01', title, location: { sheet: 'README', cell }, reportedBy: ['A'] });
const report = (promptVersion: string, findings: unknown[], score = 60) => ({
  header: { promptVersion, finishedAt: '2026-10-23T10:00:00.000Z', raters: [{ model: 'm1' }], consolidator: { model: 'k' } },
  verdict: { weightedScore: score, decision: 'red' },
  dimensions: [{ id: 'G01', status: 'scored' }, { id: 'G02', status: 'unscored' }],
  findings,
});

let dataDir = '';
beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'ddd-library-'));
  for (const dir of ['library', 'run1', 'run2', 'reviews']) await mkdir(path.join(dataDir, dir), { recursive: true });
  await writeFile(path.join(dataDir, 'run1', 'report.json'), JSON.stringify(report('l1-prompts/1.3', [finding('F-01', 'A1'), finding('F-02', 'A2'), finding('F-03', 'A3'), finding('F-04', 'A4')])));
  await writeFile(
    path.join(dataDir, 'reviews', 'run1.json'),
    JSON.stringify({ labels: [{ id: 'F-01', verdict: 'real', note: 'true' }, { id: 'F-02', verdict: 'wrong', note: 'sheet exists' }, { id: 'F-03', verdict: 'vague', note: 'no detail' }] }),
  );
  await writeFile(path.join(dataDir, 'run2', 'report.json'), JSON.stringify(report('l1-prompts/1.4', [finding('F-01', 'A1', 'Reworded'), finding('F-09', 'B9')], 70)));
  await writeFile(
    path.join(dataDir, 'library', 'case-a.json'),
    JSON.stringify({
      id: 'case-a', title: 'Case A', step: 'Step 9', workbook: 'w.xlsx', scorecard: 's.xlsx',
      runs: [
        { label: 'Run 1', runDir: 'run1', reviewFile: 'reviews/run1.json' },
        { label: 'Run 2', runDir: 'run2' },
        { label: 'Removed', runDir: 'gone' },
      ],
    }),
  );
});

describe('the test library', () => {
  it('counts the verdicts of a reviewed run, and the share that is useful among the checked findings', async () => {
    const [c] = await listLibrary(dataDir);
    const run1 = c!.runs[0]!;
    expect(run1.counts).toMatchObject({ real: 1, wrong: 1, vague: 1, unreviewed: 1 });
    // 1 useful of the 3 that were checked; the unreviewed one is not counted against it.
    expect(run1.usableShare).toBeCloseTo(1 / 3);
    expect(run1.unscored).toEqual(['G02']);
    expect(run1.promptVersion).toBe('l1-prompts/1.3');
  });

  it('carries a verdict to a later run only for a finding at the same cell and question, and says so', async () => {
    const detail = await readLibraryCase(dataDir, 'case-a');
    const byId = new Map(detail.findingsOfLatest.map((f) => [f.id, f]));
    expect(byId.get('F-01')).toMatchObject({ verdict: 'real', inherited: true });
    expect(byId.get('F-01')!.note).toMatch(/Same cell and question/);
    expect(byId.get('F-09')).toMatchObject({ verdict: 'unreviewed', inherited: false });
  });

  it('skips a run whose folder is gone, and lists the runs in order', async () => {
    const [c] = await listLibrary(dataDir);
    expect(c!.runs.map((r) => r.label)).toEqual(['Run 1', 'Run 2']);
  });

  it('returns an empty list when there is no library folder, and refuses an unsafe or unknown id', async () => {
    expect(await listLibrary(path.join(dataDir, 'nowhere'))).toEqual([]);
    await expect(readLibraryCase(dataDir, '../secret')).rejects.toMatchObject({ status: 404 });
    await expect(readLibraryCase(dataDir, 'missing')).rejects.toMatchObject({ status: 404 });
  });
});

describe('the planted-defect results', () => {
  it('lists saved results newest first, and an empty list when there are none', async () => {
    expect(await listPlanted(path.join(dataDir, 'nowhere'))).toEqual([]);
    const result = (label: string, runAt: string) => ({ label, runAt, workbook: 'w.csv', scorecard: 's.csv', seed: 1, models: [], planted: 8, caught: 5, caughtRaw: 6, caughtByExaminers: 3, caughtByCode: 4, otherInReport: 2, perExaminer: {}, weightedScore: 70, decision: 'amber', defects: [], skipped: [] });
    for (const [label, runAt] of [['older', '2026-10-24T01:00:00.000Z'], ['newer', '2026-10-24T02:00:00.000Z']] as const) {
      await mkdir(path.join(dataDir, 'planted', label), { recursive: true });
      await writeFile(path.join(dataDir, 'planted', label, 'result.json'), JSON.stringify(result(label, runAt)));
    }
    await mkdir(path.join(dataDir, 'planted', 'unfinished'), { recursive: true });
    expect((await listPlanted(dataDir)).map((r) => r.label)).toEqual(['newer', 'older']);
  });
});
