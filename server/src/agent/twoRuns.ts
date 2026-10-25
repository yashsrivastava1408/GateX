import { UNSTABLE_GAP, bandOf } from '@ddd/shared';
import type { EvaluationCore, TwoRuns, UsageLine } from '@ddd/shared';
import { floor1 } from '../util/text.js';
import { evaluate, type EvaluateArgs, type EvaluationOutput } from './orchestrator.js';
import { buildVerdictSection } from './verdict.js';

/** The score of one finished evaluation, as its own report would show it. */
export const scoreOf = (core: EvaluationCore): number =>
  buildVerdictSection(core.scorecard, core.dimensions, null, core.findings).weightedScore;

/**
 * Two scores in, the run-twice result out: the average, the gap, and whether the pair is unstable (a gap of
 * UNSTABLE_GAP points or more, or the two runs landing on different colours). Colours come from the score alone.
 */
export function summariseTwoRuns(first: number, second: number): TwoRuns {
  const a = floor1(first);
  const b = floor1(second);
  const average = floor1((first + second) / 2);
  const gap = floor1(Math.abs(first - second));
  const decisions: TwoRuns['decisions'] = [bandOf(a), bandOf(b)];
  return { scores: [a, b], decisions, average, gap, unstable: gap >= UNSTABLE_GAP || decisions[0] !== decisions[1] };
}

const sum = (a: number | null, b: number | null) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));

/** Both runs used the same examiners, so their calls share ids: add up tokens and attempts, keep the first run's prompt. */
function mergeCalls(a: EvaluationOutput['calls'], b: EvaluationOutput['calls']): EvaluationOutput['calls'] {
  const byId = new Map(a.map((c) => [c.model.id, { ...c }]));
  for (const c of b) {
    const mine = byId.get(c.model.id);
    if (!mine) { byId.set(c.model.id, { ...c }); continue; }
    mine.attempts += c.attempts;
    mine.latencyMs += c.latencyMs;
    mine.inputTokens = sum(mine.inputTokens, c.inputTokens);
    mine.outputTokens = sum(mine.outputTokens, c.outputTokens);
    mine.discarded += c.discarded;
    mine.discardedDetail = [...mine.discardedDetail, ...c.discardedDetail];
    mine.rawResponse = `${mine.rawResponse}\n--- second run ---\n${c.rawResponse}`;
    if (c.status === 'ok') mine.status = 'ok';
  }
  return [...byId.values()];
}

/** Both runs' token use added together (the cost of a run-twice check is both runs). */
function mergeUsage(a: UsageLine[], b: UsageLine[]): UsageLine[] {
  const byKey = new Map<string, UsageLine>();
  for (const u of [...a, ...b]) {
    const key = `${u.id}|${u.model}`;
    const mine = byKey.get(key);
    if (mine) byKey.set(key, { ...mine, calls: mine.calls + u.calls, inputTokens: mine.inputTokens + u.inputTokens, outputTokens: mine.outputTokens + u.outputTokens });
    else byKey.set(key, { ...u });
  }
  return [...byKey.values()];
}

/**
 * "Run twice": two full evaluations with the same examiners, one after the other. The run closer to the average
 * supplies the details (areas, issues, path to green); the report's score and colour come from the average, and
 * the gap between the two runs is recorded. Everything else about a run (adaptive repeats, checks) is unchanged.
 */
export async function evaluateTwice(args: EvaluateArgs): Promise<EvaluationOutput> {
  // The average of two runs is the range finder here, so each run skips the extra look near a colour line.
  const twice = { ...args, models: { ...args.models, settings: { ...args.models.settings, closeLook: false } } };
  const first = await evaluate(twice);
  const second = await evaluate(twice);
  const result = summariseTwoRuns(scoreOf(first.core), scoreOf(second.core));
  const base = Math.abs(scoreOf(first.core) - result.average) <= Math.abs(scoreOf(second.core) - result.average) ? first : second;

  const note = `Run twice: the whole check was run two times with the same examiners (${result.scores[0].toFixed(1)} and ${result.scores[1].toFixed(1)}). The areas, issues and path to green come from the run closest to the average.`;
  const core: EvaluationCore = {
    ...base.core,
    header: { ...base.core.header, startedAt: first.core.header.startedAt, finishedAt: second.core.header.finishedAt },
    notes: [note, ...base.core.notes],
    twoRuns: result,
    ...(first.core.usage || second.core.usage ? { usage: mergeUsage(first.core.usage ?? [], second.core.usage ?? []) } : {}),
  };
  const calls = mergeCalls(first.calls, second.calls);
  const participants = calls.map((c) => ({
    id: c.model.id, role: c.role, status: c.status, attempts: c.attempts, latencyMs: c.latencyMs,
    inputTokens: c.inputTokens, outputTokens: c.outputTokens, discarded: c.discarded, error: c.error,
  }));
  const t1 = first.runLog.timings;
  const t2 = second.runLog.timings;
  return {
    core,
    calls,
    runLog: {
      ...base.runLog,
      timings: { totalMs: t1.totalMs + t2.totalMs, checksMs: t1.checksMs + t2.checksMs, ratingMs: t1.ratingMs + t2.ratingMs, consolidationMs: t1.consolidationMs + t2.consolidationMs },
      participants,
    },
  };
}
