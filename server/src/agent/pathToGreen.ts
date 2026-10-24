import { SCORE_BANDS } from '@ddd/shared';
import type { DimensionResult, Finding, PathStep, PathToGreen, Scorecard } from '@ddd/shared';
import { floor1 } from '../util/text.js';
import { CRITICAL_MINIMUM, blockingFindings, decide, effectiveDimensions, weightedScore, type EffectiveDimension } from './verdict.js';

/**
 * "The smallest set of fixes that would change the verdict, in priority order."
 * First lift every critical gate that is below 4, then raise the dimensions that add
 * the most weighted score until the accept threshold is reached. Plain arithmetic.
 */
export function buildPathToGreen(
  scorecard: Scorecard,
  dimensions: DimensionResult[],
  findings: Finding[],
): PathToGreen {
  const start = effectiveDimensions(scorecard, dimensions);
  const blockingIds = blockingFindings(findings).map((f) => f.id);
  const current = decide(scorecard, start);

  if (current.decision === 'green' && blockingIds.length === 0) {
    return {
      steps: [],
      blockingFindingIds: [],
      resultingScore: floor1(current.score),
      resultingDecision: 'green',
      note: 'Already green. Nothing to fix.',
    };
  }

  const sim = new Map(start.map((d) => [d.id, d.score ?? 0]));
  const simulated = (): EffectiveDimension[] =>
    start.map((d) => {
      if (!d.counted) return d;
      const score = sim.get(d.id) ?? 0;
      return { ...d, score, gate: score >= CRITICAL_MINIMUM ? 'passed' : 'failed' };
    });
  const order: Array<{ id: string; reason: PathStep['reason'] }> = [];

  const blockers = start
    .filter((d) => d.counted && d.critical && (d.score ?? 0) < CRITICAL_MINIMUM)
    .sort((a, b) => b.weight - a.weight);
  for (const dim of blockers) {
    sim.set(dim.id, CRITICAL_MINIMUM);
    order.push({ id: dim.id, reason: 'critical gate' });
  }

  while (weightedScore(simulated()) < SCORE_BANDS.accept) {
    const next = start
      .filter((d) => d.counted && (sim.get(d.id) ?? 0) < 5)
      .sort((a, b) => b.weight * (5 - (sim.get(b.id) ?? 0)) - a.weight * (5 - (sim.get(a.id) ?? 0)))[0];
    if (!next) break;
    sim.set(next.id, 5);
    order.push({ id: next.id, reason: order.some((o) => o.id === next.id) ? 'critical gate' : 'score' });
  }

  // One step per dimension, showing its journey from the current score to the final one.
  const merged = new Map<string, PathStep['reason']>();
  for (const item of order) if (!merged.has(item.id)) merged.set(item.id, item.reason);

  const replay = new Map(start.map((d) => [d.id, d.score ?? 0]));
  const steps: PathStep[] = [];
  for (const [id, reason] of merged) {
    const dim = start.find((d) => d.id === id)!;
    const before = weightedScore(start.map((d) => ({ ...d, score: d.counted ? (replay.get(d.id) ?? 0) : d.score })));
    const from = replay.get(id) ?? 0;
    const to = sim.get(id) ?? from;
    replay.set(id, to);
    const after = weightedScore(start.map((d) => ({ ...d, score: d.counted ? (replay.get(d.id) ?? 0) : d.score })));
    steps.push({
      order: steps.length + 1,
      dimensionId: id,
      name: dim.name,
      from,
      to,
      scoreGain: floor1(after - before),
      reason,
      findingIds: findings.filter((f) => f.dimensionId === id).map((f) => f.id),
    });
  }

  // The simulation assumes the fixes are made, which also clears the findings they address.
  const after = decide(scorecard, simulated());
  const parts: string[] = [];
  if (steps.length > 0) parts.push('These fixes reach the score and gate targets.');
  else if (blockingIds.length > 0) parts.push('The score and gates are already enough.');
  if (blockingIds.length > 0) parts.push('Every high-risk finding must also be fixed before resubmission.');
  if (parts.length === 0) parts.push('If these dimensions reach the scores shown, the verdict becomes green.');
  return {
    steps,
    blockingFindingIds: blockingIds,
    resultingScore: floor1(after.score),
    resultingDecision: after.decision,
    note: parts.join(' '),
  };
}
