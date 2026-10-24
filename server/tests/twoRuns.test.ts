import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import type { EvaluationCore } from '@ddd/shared';
import { evaluate } from '../src/agent/orchestrator.js';
import { evaluateTwice, summariseTwoRuns } from '../src/agent/twoRuns.js';
import { buildVerdictSection } from '../src/agent/index.js';
import { assembleReport } from '../src/report/assemble.js';
import { renderMarkdown } from '../src/report/markdown.js';
import { renderXlsx } from '../src/report/xlsx.js';
import { renderPdf } from '../src/report/pdf.js';
import { MockProvider } from '../src/llm/mock.js';
import type { LlmProvider, LlmRequest } from '../src/llm/types.js';
import { TALENTRA_XLSX, loadTalentraScorecard, mockModels } from './helpers.js';

describe('run twice: the arithmetic', () => {
  it('averages the two scores, takes the colour from the average, and reports the gap', () => {
    const t = summariseTwoRuns(76.0, 72.2);
    expect(t.scores).toEqual([76, 72.2]);
    expect(t.average).toBe(74.1);
    expect(t.gap).toBe(3.8);
    expect(t.decisions).toEqual(['green', 'amber']);
    // Different colours: unstable, even though the gap is under 8.
    expect(t.unstable).toBe(true);
  });

  it('calls a pair stable when the gap is small and the colours match', () => {
    const t = summariseTwoRuns(77, 80);
    expect(t).toMatchObject({ average: 78.5, gap: 3, unstable: false, decisions: ['green', 'green'] });
  });

  it('calls a pair unstable at a gap of 8 points even when the colours match', () => {
    expect(summariseTwoRuns(62, 70).unstable).toBe(true);
    expect(summariseTwoRuns(62, 69.9).unstable).toBe(false);
  });

  it('puts the average on the right side of the 60 and 75 lines', () => {
    expect(buildVerdictSectionFor(summariseTwoRuns(70, 80)).decision).toBe('green'); // average 75
    expect(buildVerdictSectionFor(summariseTwoRuns(55, 64)).decision).toBe('red'); // average 59.5
    expect(buildVerdictSectionFor(summariseTwoRuns(55, 66)).decision).toBe('amber'); // average 60.5
  });
});

function buildVerdictSectionFor(t: ReturnType<typeof summariseTwoRuns>) {
  // Dimensions do not matter here: the average replaces the single-run score.
  return buildVerdictSection({ dimensions: [] } as never, [], null, [], t);
}

/** The mock, but once the first run's rater calls are done the scores are pulled down, so the two runs differ. */
function drifting(firstRunRaterCalls: number, counter = { n: 0 }) {
  const mock = new MockProvider(0);
  const state = counter;
  const provider: LlmProvider = {
    name: 'mock',
    async complete(request: LlmRequest) {
      const isRater = !request.system.includes('You are the consolidator') && !request.system.includes('SCORECARD_IMPORT') && !request.system.includes('You check claims');
      if (!isRater) return mock.complete(request);
      state.n += 1;
      // After the first run, the examiners mark harshly, so the second run scores lower.
      return mock.complete(state.n <= firstRunRaterCalls ? request : { ...request, model: 'mock-low' });
    },
  };
  return provider;
}

async function runTwice() {
  const parsed = await loadTalentraScorecard();
  const models = mockModels(['mock-mid', 'mock-mid', 'mock-mid']);
  models.settings = { ...models.settings, repeats: 1 };
  const args = { runId: 'r', projectName: 'p', iteration: 1, workbookPath: TALENTRA_XLSX, artifactName: 'a.xlsx', scorecard: parsed.scorecard, scorecardHash: parsed.hash, sources: '', models, env: {} };
  // Count the rater calls one run makes, so the second run can be the one that drifts.
  const counter = { n: 0 };
  const counting = drifting(Infinity, counter);
  await evaluate({ ...args, providers: () => counting });
  const second = drifting(counter.n);
  return evaluateTwice({ ...args, providers: () => second });
}

describe('run twice: a whole evaluation', () => {
  it('runs two evaluations, shows the average, and merges the calls without clashing ids', async () => {
    const out = await runTwice();
    const two = out.core.twoRuns!;
    expect(two.scores[0]).toBeGreaterThan(two.scores[1]);
    expect(two.average).toBe(Math.floor(((two.scores[0] + two.scores[1]) / 2) * 10 + 1e-9) / 10);
    expect(two.unstable).toBe(true);

    const ids = out.calls.map((c) => c.model.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(out.runLog.participants.map((p) => p.id)).toEqual(ids);

    const report = assembleReport(out.core, null);
    expect(report.verdict.weightedScore).toBe(two.average);
    expect(report.verdict.reasons.join(' ')).toMatch(/run twice/);
    expect(report.verdict.reasons.join(' ')).toMatch(/Needs attention: Result is unstable, treat it as a range/);
    // The unstable note is a note, not a colour: the colour is the average's band alone.
    expect(report.verdict.decision).toBe(two.average >= 75 ? 'green' : two.average >= 60 ? 'amber' : 'red');
  }, 60_000);

  it('shows both runs, the average and the gap in the PDF, Excel and Markdown reports', async () => {
    const out = await runTwice();
    const report = assembleReport(out.core as EvaluationCore, null);
    const md = renderMarkdown(report);
    expect(md).toMatch(/Run twice: .* average .*, gap .* points\. Result is unstable, treat it as a range\./);

    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await renderXlsx(report)) as unknown as ExcelJS.Buffer);
    const labels: string[] = [];
    book.getWorksheet('Summary')!.eachRow((row) => labels.push(String(row.getCell(1).value)));
    expect(labels).toEqual(expect.arrayContaining(['Run 1 score', 'Run 2 score', 'Average (shown above)', 'Needs attention']));

    const pdf = await renderPdf(report);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  }, 60_000);

  it('leaves a normal single run without any two-run fields', async () => {
    const parsed = await loadTalentraScorecard();
    const { runEvaluation } = await import('./helpers.js');
    const run = await runEvaluation({ workbook: TALENTRA_XLSX });
    expect(parsed).toBeTruthy();
    expect(run.core.twoRuns).toBeUndefined();
    expect(renderMarkdown(assembleReport(run.core, null))).not.toMatch(/Run twice/);
  }, 60_000);
});
