import { describe, expect, it } from 'vitest';
import type { CloseLook } from '@ddd/shared';
import { bandOf } from '@ddd/shared';
import { evaluate } from '../src/agent/orchestrator.js';
import { buildVerdictSection, closeLookReasons } from '../src/agent/verdict.js';
import { assembleReport } from '../src/report/assemble.js';
import { MockProvider } from '../src/llm/mock.js';
import type { ModelsConfig } from '../src/config.js';
import type { LlmProvider, LlmRequest } from '../src/llm/types.js';
import { TALENTRA_XLSX, loadTalentraScorecard, mockModels } from './helpers.js';
import { build } from './factories.js';

const isRater = (r: LlmRequest) => !r.system.includes('You are the consolidator') && !r.system.includes('SCORECARD_IMPORT') && !r.system.includes('You check claims');
const askedIds = (r: LlmRequest): string[] => {
  const card = /<scorecard>\n([\s\S]*?)\n<\/scorecard>/.exec(r.user)?.[1];
  return card ? (JSON.parse(card) as { dimensions: Array<{ id: string }> }).dimensions.map((d) => d.id) : [];
};

async function run(raters: [string, string, string], settings: Partial<ModelsConfig['settings']> = {}) {
  const models = mockModels(raters);
  models.settings = { ...models.settings, repeats: 3, verifyFindings: false, ...settings };
  const parsed = await loadTalentraScorecard();
  const mock = new MockProvider(0);
  const raterCalls: string[][] = [];
  let consolidatorCalls = 0;
  const provider: LlmProvider = {
    name: 'mock',
    async complete(request) {
      if (isRater(request)) raterCalls.push(askedIds(request));
      else if (request.system.includes('You are the consolidator')) consolidatorCalls += 1;
      return mock.complete(request);
    },
  };
  const out = await evaluate({ runId: 'r', projectName: 'p', iteration: 1, workbookPath: TALENTRA_XLSX, artifactName: 'a.xlsx', scorecard: parsed.scorecard, scorecardHash: parsed.hash, sources: '', models, providers: () => provider, env: {} });
  return { out, raterCalls, consolidatorCalls };
}

describe('the second look near a colour line', () => {
  it('scores the disputed questions again, and says in plain words that the result is close to the line and how wide it is', async () => {
    // Raters give 1, 5 and 3: the score lands on 75.2, 0.2 above the green line, with every question in dispute.
    const { out, raterCalls } = await run(['mock-low', 'mock-lenient', 'mock-strict']);
    const look = out.core.closeLook!;
    expect(look).toMatchObject({ line: 75, first: 75.2, final: 75.2 });
    expect(look.questions.length).toBeGreaterThan(0);
    expect(look.questions.length).toBeLessThanOrEqual(8);
    expect(look.low).toBeLessThan(look.final);
    expect(look.high).toBeGreaterThan(look.final);
    // 3 raters x 3 answers for the first pass and the adaptive repeat, then 3 raters x 2 more answers for the second look.
    const secondLook = raterCalls.slice(-6);
    for (const ids of secondLook) expect(ids.every((id) => look.questions.includes(id))).toBe(true);
    expect(out.runLog.secondLook).toMatchObject({ line: 75, questions: look.questions, calls: look.calls });
    expect(look.calls).toBe(7); // six examiner calls and one for the final reviewer
    const report = assembleReport(out.core, null);
    expect(report.verdict.reasons.join(' ')).toMatch(/Close to the line: the score is 75\.2 and green starts at 75/);
    expect(report.verdict.reasons.join(' ')).toMatch(/Read this result as about [\d.]+ to [\d.]+/);
  });

  it('never changes the colour: it follows the score alone', async () => {
    const { out } = await run(['mock-low', 'mock-lenient', 'mock-strict']);
    const report = assembleReport(out.core, null);
    expect(report.verdict.decision).toBe(bandOf(report.verdict.weightedScore));
  });

  it('makes no extra call when the setting is off, but still reports that the score is close to the line', async () => {
    const off = await run(['mock-low', 'mock-lenient', 'mock-strict'], { closeLook: false });
    const on = await run(['mock-low', 'mock-lenient', 'mock-strict']);
    expect(off.raterCalls.length).toBe(on.raterCalls.length - 6);
    expect(off.consolidatorCalls).toBe(on.consolidatorCalls - 1);
    expect(off.out.core.closeLook).toMatchObject({ line: 75, questions: [], calls: 0 });
  });

  it('says nothing when the score is not close to a line, and asks nothing extra', async () => {
    const { out } = await run(['mock-mid', 'mock-mid', 'mock-mid']);
    expect(out.core.closeLook).toBeUndefined();
    expect(assembleReport(out.core, null).verdict.reasons.join(' ')).not.toMatch(/Close to the line/);
  });

  it('has nothing to look at again when the examiners agree closely, and says so', async () => {
    const { out, raterCalls } = await run(['mock-strict', 'mock-strict', 'mock-mid']);
    expect(out.core.closeLook).toMatchObject({ line: 75, questions: [], calls: 0 });
    expect(raterCalls).toHaveLength(9); // 3 first answers, and the heavy questions a point apart asked 2 more times by each; nothing for the second look
    expect(assembleReport(out.core, null).verdict.reasons.join(' ')).toMatch(/agreed closely on every question/);
  });

  it('is not run for a quick check (one repeat)', async () => {
    const { out, raterCalls } = await run(['mock-low', 'mock-lenient', 'mock-strict'], { repeats: 1 });
    expect(raterCalls).toHaveLength(3);
    expect(out.core.closeLook?.calls).toBe(0);
  });
});

describe('the words for a score close to a line', () => {
  const look: CloseLook = { line: 60, first: 61.5, final: 62.9, low: 58.1, high: 66.4, questions: ['G01-C01', 'G07-C05'], calls: 20, stillDisputed: ['G07-C05'] };

  it('names the line, what was looked at, the range, and that the colour comes from the score', () => {
    const [text] = closeLookReasons(look);
    expect(text).toContain('the score is 62.9 and amber starts at 60');
    expect(text).toContain('We looked again at the 2 questions the examiners disagreed on (61.5 before, 62.9 after)');
    expect(text).toContain('1 question is still in dispute');
    expect(text).toContain('58.1');
    expect(text).toContain('66.4');
    expect(text).toContain('The colour comes from the score alone.');
  });

  it('goes second in the verdict reasons, but not on a run-twice result, which already says how wide it is', () => {
    const { scorecard, dimensions } = build([{ id: 'A', weight: 1, score: 3 }]);
    const withLook = buildVerdictSection(scorecard, dimensions, null, [], undefined, look);
    expect(withLook.reasons[1]).toMatch(/^Close to the line/);
    const twice = buildVerdictSection(scorecard, dimensions, null, [], { scores: [60, 62], decisions: ['amber', 'amber'], average: 61, gap: 2, unstable: false }, look);
    expect(twice.reasons.join(' ')).not.toMatch(/Close to the line/);
  });
});
