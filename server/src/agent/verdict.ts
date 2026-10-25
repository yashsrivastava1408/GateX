import { CLOSE_TO_LINE, SCORE_BANDS, SCORE_NOISE, bandOf } from '@ddd/shared';
import type {
  CloseLook,
  CriticalGate,
  Decision,
  DimensionResult,
  Finding,
  Override,
  Scorecard,
  ScoreRange,
  TwoRuns,
  VerdictSection,
} from '@ddd/shared';
import { floor1 } from '../util/text.js';

/** A dimension as the verdict sees it. */
export interface EffectiveDimension {
  id: string;
  name: string;
  weight: number;
  critical: boolean;
  /** In the weighted score? A question left out because nothing in the file could measure it is not. */
  counted: boolean;
  /** The 0-5 score used; unscored counted dimensions are 0. */
  score: number | null;
  /** The examiners found nothing in the file to measure this and the scorecard says to leave such questions out. */
  skipped: boolean;
  /** The examiners found nothing to measure and the scorecard says to count such questions as 0. */
  zeroed: boolean;
  gate: CriticalGate['status'];
  /** Is the score solid enough to force RED alone? Not when one examiner scored it, or the examiners could not agree. */
  reliable: boolean;
}

export const CRITICAL_MINIMUM = 4;

/** Green needs at least this share of the scorecard's weight to have a score. A 100 built on a sliver of it is not a pass. */
export const MINIMUM_COVERAGE = 0.5;

/**
 * Every question gets a result without waiting for anyone. A question the examiners found nothing in the file to
 * measure is left out of the score (`unmeasured: skip`, the default) or counted as 0 (`unmeasured: zero`).
 */
export function effectiveDimensions(scorecard: Scorecard, dimensions: DimensionResult[]): EffectiveDimension[] {
  const byId = new Map(dimensions.map((d) => [d.id, d]));
  const zero = scorecard.unmeasured === 'zero';

  return scorecard.dimensions.map((spec): EffectiveDimension => {
    const result = byId.get(spec.id);
    const base = { id: spec.id, name: spec.name, weight: spec.weight, critical: spec.critical };

    // Older runs may still hold a question once kept for a person; it is treated like any unmeasurable one.
    if (!result || result.status === 'not_measurable' || spec.measuredBy === 'human') {
      if (zero) return { ...base, counted: true, score: 0, skipped: false, zeroed: true, gate: 'failed', reliable: true };
      return { ...base, counted: false, score: null, skipped: true, zeroed: false, gate: 'skipped', reliable: true };
    }

    // Code and rater dimensions: an unscored one counts as 0, so a missing score can never help.
    const score = result.status === 'scored' ? (result.consolidated ?? 0) : 0;
    const reliable = result.resolution !== 'single_rater' && result.resolution !== 'lower_stands';
    return { ...base, counted: true, score, skipped: false, zeroed: false, gate: score >= CRITICAL_MINIMUM ? 'passed' : 'failed', reliable };
  });
}

export function weightedScore(dimensions: EffectiveDimension[]): number {
  const counted = dimensions.filter((d) => d.counted);
  const total = counted.reduce((sum, d) => sum + d.weight, 0);
  if (total === 0) return 0;
  return (counted.reduce((sum, d) => sum + d.weight * (d.score ?? 0), 0) * 100) / (total * 5);
}

export interface AgentVerdict {
  score: number;
  decision: Decision;
  criticalGates: CriticalGate[];
  reasons: string[];
  skipped: string[];
}

/** HIGH-risk findings are listed first as needing a fix before sign-off (ADR-18: they no longer change the colour). */
export const blockingFindings = (findings: Finding[]): Finding[] => findings.filter((f) => f.severity === 'HIGH');

/**
 * The decision rule from PDF pages 11-12, applied by code and never by a model:
 *   Green  score >= accept, every critical gate passed, no HIGH-risk finding open, every judged
 *          score backed by two agreeing examiners, and at least half the weight scored
 *   Amber  score between refine and accept, or any critical gate below 4, or a HIGH finding
 *   Red    score below refine, or a critical gate at or below the scorecard's `red_at_or_below` line (when it sets one)
 */
export function decide(scorecard: Scorecard, dimensions: EffectiveDimension[], blocking: Finding[] = []): AgentVerdict {
  const score = weightedScore(dimensions);
  const { accept, refine } = SCORE_BANDS;
  const gates: CriticalGate[] = dimensions
    .filter((d) => d.critical)
    .map((d) => ({ dimensionId: d.id, name: d.name, score: d.score, status: d.gate }));
  const failed = gates.filter((g) => g.status === 'failed');
  const skipped = dimensions.filter((d) => d.skipped);
  // A score only one examiner could back, or one the examiners could not agree on, is a single opinion.
  const unsure = dimensions.filter((d) => d.counted && !d.reliable);
  const totalWeight = dimensions.reduce((sum, d) => sum + d.weight, 0);
  const coverage = totalWeight > 0 ? dimensions.filter((d) => d.counted).reduce((sum, d) => sum + d.weight, 0) / totalWeight : 1;
  const shown = floor1(score);
  const reasons: string[] = [];

  // The colour is the score's band and nothing else: below 60 red, 60 to 74 amber, 75 and above green. Everything else is shown as a note.
  const decision: Decision = bandOf(score);
  reasons.push(
    decision === 'green'
      ? `Score ${shown} is in the green band (${accept} and above).`
      : decision === 'amber'
        ? `Score ${shown} is in the amber band (${refine} to ${accept - 1}). Green starts at ${accept}.`
        : `Score ${shown} is in the red band (below ${refine}). Amber starts at ${refine}.`,
  );
  // Things worth attention that do not change the colour.
  for (const gate of failed) {
    reasons.push(`Needs attention: critical question ${gate.dimensionId} (${gate.name}) scored ${gate.score ?? 0}, below ${CRITICAL_MINIMUM}.`);
  }
  if (blocking.length > 0) {
    const shownIds = blocking.slice(0, 5).map((f) => f.id).join(', ');
    reasons.push(`Needs attention: ${blocking.length} high-risk finding${blocking.length === 1 ? '' : 's'} (${shownIds}${blocking.length > 5 ? ' and more' : ''}) should be fixed before sign-off.`);
  }
  if (coverage < MINIMUM_COVERAGE) {
    reasons.push(`Needs attention: only ${Math.round(coverage * 100)}% of the scorecard could be scored, so the score rests on little.`);
  }
  if (unsure.length > 0) {
    reasons.push(`Needs attention: only one examiner could back the score, or the examiners could not agree, on ${unsure.map((d) => `${d.id} (${d.name})`).join(', ')}. Run it again to firm it up.`);
  }
  const zeroed = dimensions.filter((d) => d.zeroed);
  if (zeroed.length > 0) {
    reasons.push(`The file holds nothing to measure these, so they count as 0: ${zeroed.map((d) => `${d.id} (${d.name})`).join(', ')}.`);
  }
  if (skipped.length > 0) {
    reasons.push(`The file holds nothing to measure these, so they are left out of the score: ${skipped.map((d) => `${d.id} (${d.name})`).join(', ')}.`);
  }
  return { score, decision, criticalGates: gates, reasons, skipped: skipped.map((d) => d.id) };
}

export function buildVerdictSection(
  scorecard: Scorecard,
  dimensions: DimensionResult[],
  override: Override | null,
  findings: Finding[] = [],
  twoRuns?: TwoRuns,
  closeLook?: CloseLook,
): VerdictSection {
  const blocking = blockingFindings(findings);
  const verdict = decide(scorecard, effectiveDimensions(scorecard, dimensions), blocking);
  const reasons = [...verdict.reasons];
  if (twoRuns) {
    // Run twice: the average sets the score and the colour (by score alone); an unstable pair is a note, not a colour.
    verdict.score = twoRuns.average;
    verdict.decision = bandOf(twoRuns.average);
    reasons.splice(0, 1, ...twoRunsReasons(twoRuns));
  }
  // Near a colour line the score is a span, not a number: the second look's span when it ran, widened to the run-to-run noise.
  const range = scoreRangeOf(verdict.score, closeLook, twoRuns);
  if (range && !twoRuns) {
    // Next to the score line, in words; the colour above it is still the score's band and nothing else.
    reasons.splice(1, 0, ...(closeLook ? closeLookReasons(closeLook, range) : closeToLineReasons(verdict.score, range)));
  }
  if (override) {
    reasons.push(`A person overrode the verdict to ${override.decision.toUpperCase()}: ${override.reason}`);
  }
  return {
    weightedScore: floor1(verdict.score),
    decision: override?.decision ?? verdict.decision,
    agentDecision: verdict.decision,
    thresholds: { ...SCORE_BANDS },
    criticalGates: verdict.criticalGates,
    blockingFindings: blocking.map((f) => f.id),
    skipped: verdict.skipped,
    reasons,
    ...(range ? { scoreRange: range } : {}),
    override,
  };
}

const pts = (n: number) => floor1(n).toFixed(1);
const colourWord = { green: 'green', amber: 'amber', red: 'red' } as const;

/** The plain-words line for a score close to a colour line: what was looked at again and how wide the result is. */
/** The nearest colour line (75 or 60) to a score. */
export const nearestLine = (score: number): number => [SCORE_BANDS.accept, SCORE_BANDS.refine].reduce((best, line) => (Math.abs(score - line) < Math.abs(score - best) ? line : best));

const one = (n: number) => Math.round(n * 10) / 10;

/**
 * The span to read a score near a colour line as. It is the score plus or minus the run-to-run noise (SCORE_NOISE), widened to the span of the second look
 * (every question still in dispute going the lowest and the highest way) or, for two runs, to the two scores. Undefined when the score is not near a line.
 * Pure: the same inputs always give the same span, and the colour is never changed by it.
 */
export function scoreRangeOf(score: number, closeLook?: CloseLook, twoRuns?: TwoRuns): ScoreRange | undefined {
  const line = nearestLine(score);
  if (Math.abs(score - line) > CLOSE_TO_LINE) return undefined;
  let low = score - SCORE_NOISE;
  let high = score + SCORE_NOISE;
  let basis = `the same file has moved by about ${SCORE_NOISE} points from one run to the next`;
  if (twoRuns) {
    low = Math.min(...twoRuns.scores);
    high = Math.max(...twoRuns.scores);
    basis = 'the two runs of this check';
  } else if (closeLook && (closeLook.low < low || closeLook.high > high)) {
    low = Math.min(low, closeLook.low);
    high = Math.max(high, closeLook.high);
    basis = 'the questions the examiners still disagree on, taken the lowest and the highest way';
  }
  return { low: one(Math.max(0, low)), high: one(Math.min(100, high)), line, basis };
}

/** The plain-words line for a score close to a line when no second look was made (a quick check, or nothing in dispute). */
export function closeToLineReasons(score: number, range: ScoreRange): string[] {
  const side = range.line === SCORE_BANDS.accept ? `green starts at ${range.line}` : `amber starts at ${range.line}`;
  return [`Close to the line: the score is ${pts(score)} and ${side}, so another run could land on the other side. Read this result as about ${pts(range.low)} to ${pts(range.high)}, not as one exact number (${range.basis}). The colour comes from the score alone.`];
}

export function closeLookReasons(c: CloseLook, range?: ScoreRange): string[] {
  const side = c.line === SCORE_BANDS.accept ? `green starts at ${c.line}` : `amber starts at ${c.line}`;
  const asked =
    c.questions.length > 0
      ? ` We looked again at the ${c.questions.length} question${c.questions.length === 1 ? '' : 's'} the examiners disagreed on (${pts(c.first)} before, ${pts(c.final)} after).`
      : ' The examiners agreed closely on every question, so there was nothing to look at again.';
  const left =
    c.stillDisputed.length > 0
      ? ` ${c.stillDisputed.length} question${c.stillDisputed.length === 1 ? ' is' : 's are'} still in dispute: if they all went the lowest way the score would be ${pts(c.low)}, the highest way ${pts(c.high)}.`
      : ' No question is still in dispute.';
  return [`Close to the line: the score is ${pts(c.final)} and ${side}, so another run could land on the other side.${asked}${left} Read this result as about ${pts(range?.low ?? c.low)} to ${pts(range?.high ?? c.high)}, not as one exact number. The colour comes from the score alone.`];
}

/** The plain-words lines for a two-run result: how the average was reached, and the unstable note when it applies. */
export function twoRunsReasons(t: TwoRuns): string[] {
  const { accept, refine } = SCORE_BANDS;
  const band = bandOf(t.average);
  const lines = [
    `The check was run twice: ${pts(t.scores[0])} and ${pts(t.scores[1])}. The score shown is the average, ${pts(t.average)}, which is in the ${colourWord[band]} band (${band === 'green' ? `${accept} and above` : band === 'amber' ? `${refine} to ${accept - 1}` : `below ${refine}`}). The two runs differ by ${pts(t.gap)} points.`,
  ];
  if (t.unstable) {
    const colours = t.decisions[0] !== t.decisions[1] ? ` The two runs landed on different colours (${t.decisions[0]} and ${t.decisions[1]}).` : '';
    lines.push(`Needs attention: Result is unstable, treat it as a range (${pts(Math.min(...t.scores))} to ${pts(Math.max(...t.scores))}).${colours}`);
  }
  return lines;
}
