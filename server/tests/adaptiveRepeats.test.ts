import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseScorecard } from '../src/scorecard/parse.js';
import { evaluate } from '../src/agent/orchestrator.js';
import { idsToRepeat } from '../src/agent/repeats.js';
import type { RaterDimension, RaterOutcome } from '../src/agent/types.js';
import type { ModelsConfig } from '../src/config.js';
import { MockProvider } from '../src/llm/mock.js';
import type { LlmProvider, LlmRequest } from '../src/llm/types.js';
import { TALENTRA_XLSX, loadTalentraScorecard, mockModels } from './helpers.js';

const isRater = (r: LlmRequest) => !r.system.includes('You are the consolidator') && !r.system.includes('SCORECARD_IMPORT') && !r.system.includes('You check claims');
const askedIds = (r: LlmRequest): string[] => {
  const card = /<scorecard>\n([\s\S]*?)\n<\/scorecard>/.exec(r.user)?.[1];
  return card ? (JSON.parse(card) as { dimensions: Array<{ id: string }> }).dimensions.map((d) => d.id) : [];
};

/**
 * The scripted mock, with two twists for these tests: every rater call is recorded, and a rater can be told to give a
 * different score for some questions (so the examiners disagree on exactly those).
 */
function recording(overrides: Record<string, Record<string, number>> = {}) {
  const mock = new MockProvider(0);
  const calls: Array<{ model: string; ids: string[] }> = [];
  const provider: LlmProvider = {
    name: 'mock',
    async complete(request) {
      const response = await mock.complete(request);
      if (!isRater(request)) return response;
      calls.push({ model: request.model, ids: askedIds(request) });
      const change = overrides[request.model];
      if (!change) return response;
      const reply = JSON.parse(response.text) as { dimensions: Array<{ id: string; score: number | null }> };
      for (const d of reply.dimensions) if (d.id in change) d.score = change[d.id]!;
      return { ...response, text: JSON.stringify(reply) };
    },
  };
  return { provider, calls };
}

async function run(models: ModelsConfig, overrides: Record<string, Record<string, number>> = {}, sectioned = false) {
  const parsed = sectioned
    ? parseScorecard(await readFile(new URL('../../samples/talentra/talentra-schema-d2-sectioned.yaml', import.meta.url), 'utf8'))
    : await loadTalentraScorecard();
  const rec = recording(overrides);
  const out = await evaluate({
    runId: 'r', projectName: 'p', iteration: 1, workbookPath: TALENTRA_XLSX, artifactName: 'a.xlsx', scorecard: parsed.scorecard,
    scorecardHash: parsed.hash, sources: '', models, providers: () => rec.provider, env: {},
  });
  return { out, calls: rec.calls };
}

const withRepeats = (repeats: number, repeatMode: 'all' | 'adaptive', raters: [string, string, string] = ['mock-mid', 'mock-mid', 'mock-mid']) => {
  const models = mockModels(raters);
  models.settings = { ...models.settings, repeats, repeatMode };
  return models;
};

describe('adaptive repeats', () => {
  it('scores each section once when the examiners agree, and says how many calls it saved', async () => {
    const { out, calls } = await run(withRepeats(3, 'adaptive'));
    expect(calls).toHaveLength(3);
    expect(out.runLog.repeats).toEqual({ mode: 'adaptive', repeats: 3, planned: 9, made: 3, saved: 6, repeated: [] });
    expect(out.core.notes.join(' ')).toMatch(/the examiners agreed on every question, so nothing was scored again \(3 rater calls instead of 9\)/);
  });

  it('scores again only the questions the examiners disagree on, with a prompt that holds just those', async () => {
    // Rater B gives J02 a 1 where the others give 4: only J02 is disputed.
    const { out, calls } = await run(withRepeats(3, 'adaptive', ['mock-mid', 'mock-mid-b', 'mock-mid']), { 'mock-mid-b': { J02: 1 } });
    const all = out.core.dimensions.filter((d) => d.measuredBy === 'raters').map((d) => d.id);
    const full = calls.filter((c) => c.ids.length === all.length);
    const again = calls.filter((c) => c.ids.length < all.length);
    expect(full).toHaveLength(3);
    expect(again).toHaveLength(6); // three raters, two more times each
    for (const c of again) expect(c.ids).toEqual(['J02']);
    expect(out.runLog.repeats).toMatchObject({ planned: 9, made: 9, saved: 0, repeated: ['J02'] });
    // made equals planned here only because the scorecard is one section; the repeat prompts are far smaller
    expect(out.core.notes.join(' ')).toMatch(/only the questions the examiners disagreed on were scored again \(J02\)/);
  });

  it('makes fewer calls when only one section is disputed', async () => {
    const { out, calls } = await run(withRepeats(3, 'adaptive', ['mock-mid', 'mock-mid-b', 'mock-mid']), { 'mock-mid-b': { J05: 1 } }, true);
    const { planned, made, saved, repeated } = out.runLog.repeats!;
    expect(repeated).toEqual(['J05']);
    expect(made).toBe(calls.length);
    expect(saved).toBe(planned - made);
    expect(saved).toBeGreaterThan(0);
    // J05 has a section of its own: scored once by each rater, then twice more.
    expect(calls.filter((c) => c.ids.includes('J05'))).toHaveLength(9);
  });

  it('keeps the median: a disputed question that stays disputed is decided exactly as before', async () => {
    const adaptive = await run(withRepeats(3, 'adaptive', ['mock-mid', 'mock-mid-b', 'mock-mid']), { 'mock-mid-b': { J02: 1 } });
    const everything = await run(withRepeats(3, 'all', ['mock-mid', 'mock-mid-b', 'mock-mid']), { 'mock-mid-b': { J02: 1 } });
    const scores = (o: typeof adaptive) => o.out.core.dimensions.map((d) => [d.id, d.raterScores, d.consolidated, d.resolution]);
    expect(scores(adaptive)).toEqual(scores(everything));
  });

  it('scores every question `repeats` times in "all" mode', async () => {
    const { out, calls } = await run(withRepeats(3, 'all'));
    expect(calls).toHaveLength(9);
    expect(new Set(calls.map((c) => c.ids.length)).size).toBe(1);
    expect(out.runLog.repeats).toMatchObject({ mode: 'all', planned: 9, made: 9, saved: 0 });
    expect(out.core.notes.join(' ')).not.toMatch(/Adaptive repeats/);
  });

  it('does nothing extra with one repeat, and does not ask a failed rater again', async () => {
    const single = await run(withRepeats(1, 'adaptive'));
    expect(single.calls).toHaveLength(3);
    expect(single.out.core.notes.join(' ')).not.toMatch(/Adaptive repeats/);

    const failing = await run(withRepeats(3, 'adaptive', ['mock-mid', 'mock-down', 'mock-strict']));
    // mid (4) and strict (3) are within a point, and mock-down never answers: nothing to repeat.
    expect(failing.calls.filter((c) => c.model === 'mock-down')).toHaveLength(0); // it throws before the recorder sees it
    expect(failing.out.runLog.repeats!.repeated).toEqual([]);
  });

  it('defaults to adaptive when the settings do not say', () => {
    const models = mockModels();
    expect(models.settings.repeatMode).toBe('adaptive');
  });
});

describe('which questions are worth asking again', () => {
  const dim = (id: string, score: number | null, notMeasurable = false): RaterDimension =>
    ({ id, score, notMeasurable, anchor: '', rationale: '', evidence: [] }) as unknown as RaterDimension;
  const outcome = (dims: RaterDimension[], status: 'ok' | 'failed' = 'ok') => ({ status, dimensions: dims }) as unknown as RaterOutcome;

  it('repeats a spread over one point, and leaves a spread of one alone', () => {
    const first = [outcome([dim('A', 2), dim('B', 3)]), outcome([dim('A', 4), dim('B', 4)])];
    expect(idsToRepeat(['A', 'B'], first)).toEqual(['A']);
  });

  it('repeats a question an answering rater gave no usable score for, but not one it called not measurable', () => {
    const first = [outcome([dim('A', 3), dim('B', 3)]), outcome([dim('A', null), dim('B', null, true)]), outcome([dim('A', 3)])];
    // C answered but said nothing about B: that is unusable too.
    expect(idsToRepeat(['A', 'B'], first)).toEqual(['A', 'B']);
    const allAbstain = [outcome([dim('B', null, true)]), outcome([dim('B', null, true)])];
    expect(idsToRepeat(['B'], allAbstain)).toEqual([]);
  });

  it('ignores raters that failed altogether, and repeats nothing when none answered', () => {
    expect(idsToRepeat(['A'], [outcome([dim('A', 4)]), outcome([], 'failed')])).toEqual([]);
    expect(idsToRepeat(['A'], [outcome([], 'failed')])).toEqual([]);
  });
});
