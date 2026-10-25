import { sha256 } from '../util/hash.js';
import type { RaterDimension, RaterOutcome } from './types.js';

const median = (scores: number[]): number => [...scores].sort((a, b) => a - b)[Math.floor((scores.length - 1) / 2)]!;

/**
 * One rater scored one section several times. Keep the median score of each question (the lower middle when there are
 * two, so a tie never rounds up), with the evidence and reasoning from a run that gave that score, and note how far the
 * runs disagreed. Findings and strengths are pooled without duplicates. One run comes back untouched.
 */
export function medianOutcome(runs: RaterOutcome[]): RaterOutcome {
  if (runs.length === 1) return runs[0]!;
  const ok = runs.filter((r) => r.status === 'ok');
  if (ok.length === 0) return runs[0]!;

  const ids = [...new Set(ok.flatMap((r) => r.dimensions.map((d) => d.id)))];
  const dimensions = ids.map((id): RaterDimension => {
    const entries = ok.flatMap((r) => r.dimensions.filter((d) => d.id === id));
    const scored = entries.filter((d) => d.score !== null);
    if (scored.length === 0) return entries[0]!;
    const middle = median(scored.map((d) => d.score!));
    const scores = scored.map((d) => d.score!);
    return { ...scored.find((d) => d.score === middle)!, repeatSpread: Math.max(...scores) - Math.min(...scores) };
  });

  const seen = new Set<string>();
  const findings = ok.flatMap((r) => r.findings).filter((f) => {
    const key = `${f.dimensionId}|${f.title.trim().toLowerCase()}`;
    return seen.has(key) ? false : (seen.add(key), true);
  }).map((f, i) => ({ ...f, ref: `${f.raterId}${i + 1}` })); // pooled from several runs, so the references must be made unique again
  const said = new Set<string>();
  const strengths = ok.flatMap((r) => r.strengths).filter((s) => (said.has(s.text) ? false : (said.add(s.text), true)));

  const sum = (pick: (o: RaterOutcome) => number | null) => runs.reduce((total, o) => total + (pick(o) ?? 0), 0);
  const known = (pick: (o: RaterOutcome) => number | null) => (runs.some((o) => pick(o) != null) ? sum(pick) : null);
  return {
    ...ok[0]!,
    prompt: ok[0]!.prompt,
    promptHash: sha256(runs.map((r) => r.promptHash).join(',')),
    rawResponse: runs.map((r) => r.rawResponse).join('\n---\n'),
    attempts: sum((o) => o.attempts),
    latencyMs: Math.max(...runs.map((o) => o.latencyMs)),
    inputTokens: known((o) => o.inputTokens),
    outputTokens: known((o) => o.outputTokens),
    dimensions,
    findings,
    strengths,
    discarded: runs.flatMap((r) => r.discarded),
  };
}

/** A spread above this, between the examiners' first answers, is worth asking again. */
export const REPEAT_SPREAD = 1;

/**
 * The questions that carry the most of the score: those of the heaviest dimensions (the top quarter of them by weight, ties included).
 * Works on the working questions, where a criterion knows the weight of its dimension. A scorecard of three dimensions or fewer has
 * no "heavy" ones: when everything is heavy, nothing is singled out.
 */
export function heavyQuestionIds(questions: Array<{ id: string; weight: number; criterionOf?: { id: string; weight?: number } }>): Set<string> {
  const parents = new Map<string, number>();
  for (const q of questions) parents.set(q.criterionOf?.id ?? q.id, q.criterionOf?.weight ?? q.weight);
  if (parents.size <= 3) return new Set();
  const weights = [...parents.values()].sort((a, b) => b - a);
  const threshold = weights[Math.max(1, Math.ceil(parents.size / 4)) - 1]!;
  return new Set(questions.filter((q) => (q.criterionOf?.weight ?? q.weight) >= threshold).map((q) => q.id));
}

/**
 * Adaptive repeats: after every rater has scored a section once, the questions worth scoring again. A question is
 * repeated when
 *  - two or more examiners are more than a point apart, or
 *  - it is a heavy question (see heavyQuestionIds) and the examiners are not all the same, since a one-point difference there is worth
 *    most to the score and is where the final reviewer's pick used to swing it, or
 *  - an examiner that answered gave no usable score for it (missing, or discarded for lack of evidence) without calling it not measurable.
 * Questions the examiners agree on, or all called not measurable, are not asked again, which is where the saving comes from. Generic over
 * whatever ids the rater outcomes carry (dimensions today, criteria if raters score those).
 */
export function idsToRepeat(ids: string[], firstPass: RaterOutcome[], heavy: ReadonlySet<string> = new Set()): string[] {
  const answered = firstPass.filter((o) => o.status === 'ok');
  if (answered.length === 0) return [];
  return ids.filter((id) => {
    const entries = answered.map((o) => o.dimensions.find((d) => d.id === id));
    const scores = entries.filter((d): d is RaterDimension => d !== undefined && d.score !== null).map((d) => d.score!);
    const unusable = entries.some((d) => !d || (d.score === null && !d.notMeasurable));
    const spread = scores.length >= 2 ? Math.max(...scores) - Math.min(...scores) : 0;
    return unusable || spread > REPEAT_SPREAD || (heavy.has(id) && spread >= 1);
  });
}

/** How many rater calls a run made, against what scoring every section `repeats` times would have made. */
export interface RepeatStats {
  mode: 'all' | 'adaptive';
  repeats: number;
  /** Calls scoring everything `repeats` times would make. */
  planned: number;
  /** Calls actually made (one per rater, section and repeat; fallbacks inside a call are not counted). */
  made: number;
  saved: number;
  /** Question ids that were scored again. */
  repeated: string[];
}
