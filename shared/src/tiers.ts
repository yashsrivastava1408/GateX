import type { Finding, FindingTier, Severity } from './types.js';

/**
 * Two tiers for the findings in a report, decided by code from fields already on the finding, never by a model:
 *
 *   Confirmed     Code found it (the row-by-row sweep, exact counts, tallies), or at least `minExaminers` independent examiners raised it,
 *                 or code read the file and proved the claim (`proof`), or one examiner with a good checked record on lone findings raised it (`trustedLone`), or a single examiner raised it at one of `stayConfirmed` severities.
 *   Worth a look  Everything else: one examiner's judgement call that passed the filters. Real often enough to read, wrong often enough
 *                 that it must not drive the headline.
 *
 * The headline (needs-attention notes, the path to green, the counts) uses Confirmed only. Scores and colours do not depend on the tier.
 * The numbers below were measured on the labelled runs (`npm run tiers:measure`); see docs/agent.md.
 */
export interface TierRule {
  minExaminers: number;
  /** A finding from a single examiner at one of these severities stays Confirmed. */
  stayConfirmed: Severity[];
}

export const TIER_RULE: TierRule = { minExaminers: 2, stayConfirmed: [] };

/** How many different examiners raised it (the computer check is not an examiner). */
export const examinerCount = (f: Pick<Finding, 'reportedBy'>): number => new Set((f.reportedBy ?? []).filter((id) => id !== 'code')).size;

export function tierOf(
  f: Pick<Finding, 'source' | 'reportedBy' | 'severity' | 'proof' | 'tier'>,
  rule: TierRule = TIER_RULE,
  /** True when the one examiner who raised it has a checked track record on lone findings good enough to trust (see agent/reliability.ts). */
  trustedLone = false,
): { tier: FindingTier; reason: string } {
  if (f.source === 'code') return { tier: 'confirmed', reason: 'Found by a computer check of the file.' };
  if (f.proof) return { tier: 'confirmed', reason: f.proof };
  const n = examinerCount(f);
  if (n >= rule.minExaminers) return { tier: 'confirmed', reason: `Raised independently by ${n} examiners.` };
  if (trustedLone) return { tier: 'confirmed', reason: 'Raised by one examiner whose single-handed findings have mostly held up when checked against the real files.' };
  if (rule.stayConfirmed.includes(f.severity)) return { tier: 'confirmed', reason: 'Raised by one examiner, but it is high risk, so it stays on the main list.' };
  return { tier: 'worth_a_look', reason: 'Raised by one examiner only and not proved by the computer check. Read it, but it is a judgement call.' };
}

/** The tier a finding carries, or the one the rule gives it (reports saved before tiers existed have none). */
export const tierFor = (f: Parameters<typeof tierOf>[0], rule: TierRule = TIER_RULE): FindingTier => f.tier ?? tierOf(f, rule).tier;

export const isConfirmed = (f: Parameters<typeof tierOf>[0]): boolean => tierFor(f) === 'confirmed';

/** Findings with their tier set; the order is unchanged. Pass `trustedLone` to keep a lone examiner's finding Confirmed (see agent/reliability.ts). */
export function tierFindings(findings: Finding[], rule: TierRule = TIER_RULE, trustedLone: (f: Finding) => boolean = () => false): Finding[] {
  return findings.map((f) => {
    const { tier, reason } = tierOf({ ...f, tier: undefined }, rule, trustedLone(f));
    return { ...f, tier, tierReason: reason };
  });
}

/** Confirmed findings first, then Worth a look; the order inside each is unchanged. */
export const confirmedFirst = <T extends Pick<Finding, 'source' | 'reportedBy' | 'severity' | 'proof' | 'tier'>>(findings: T[]): T[] => [
  ...findings.filter((f) => tierFor(f) === 'confirmed'),
  ...findings.filter((f) => tierFor(f) !== 'confirmed'),
];
