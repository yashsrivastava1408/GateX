import { SCORE_BANDS, bandOf } from '@ddd/shared';
import type {
  CriticalGate,
  Decision,
  DimensionResult,
  Finding,
  Override,
  Scorecard,
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
): VerdictSection {
  const blocking = blockingFindings(findings);
  const verdict = decide(scorecard, effectiveDimensions(scorecard, dimensions), blocking);
  const reasons = [...verdict.reasons];
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
    override,
  };
}
