import {
  STANDARD_ANCHORS,
  type AggregateRule,
  type Confidence,
  type CriterionResult,
  type CriterionSpec,
  type DimensionResult,
  type DimensionSpec,
  type Resolution,
  type Scorecard,
} from '@ddd/shared';
import type { DraftFinding } from './types.js';

/**
 * Criterion-by-criterion scoring.
 *
 * A dimension with `criteria` is not scored as one vague whole. Before the run, `expandCriteria` turns each criterion into a
 * working question of its own: a judged one goes to the examiners with its own anchors, a counted one is counted exactly by
 * code. The rest of the agent (code checks, sections, rating, consolidation, the evidence rule) handles those questions
 * exactly as it handles any dimension. After the run, `collapseCriteria` combines them back into the dimension's 0-5 score
 * with the scorecard's own rule (`aggregate`), so the score follows the scorecard's arithmetic, not a model's impression.
 * A dimension without criteria passes through both steps untouched.
 */

/**
 * Wording that says a criterion needs evidence a single file cannot hold: several independent runs, or the author's interview or answers.
 * The converter is told to mark these `unmeasurable` but sometimes does not (it called "agreed by at least 2 build runs" `counted`), so code
 * does it again at the start of a run. Anything with an exact code check is left alone.
 */
const NEEDS_OUTSIDE_EVIDENCE =
  /\b(?:independent|second|build|generation|separate|blind)\s+(?:build\s+)?(?:runs?|derivations?|fills?)\b|\bagreed (?:by|in|on by)\s+(?:at least\s+)?(?:\d+|two|three)\s+(?:build\s+|independent\s+)?runs?\b|\bacross\s+(?:independent\s+|build\s+)?runs\b|\bauthor(?:'s)?\s+(?:interview|understanding|answers?)\b|\binter-?rater\b|\binterview\b|\bverbal(?:ly)?\b|\boral(?:ly)?\s+defen[cs]e\b|\bdefen[cs]e\s+drill\b|\bvisual(?:ly)?\b|\bappearance\b|\blook and feel\b/i;

export function retypeOutsideCriteria(scorecard: Scorecard): { scorecard: Scorecard; notes: string[] } {
  const notes: string[] = [];
  const dimensions = scorecard.dimensions.map((d) => {
    // A question without sub-criteria that needs outside evidence ("Visual / Format Quality" of a PDF read as text) becomes one outside criterion, so an
    // examiner's 0 on it counts as "not in the file" instead of dragging the score down.
    if (!d.criteria) {
      if (d.measuredBy !== 'raters' || !NEEDS_OUTSIDE_EVIDENCE.test(`${d.name} ${d.measure ?? ''}`)) return d;
      notes.push(`${d.id} (${d.name}) needs evidence from outside the file, so it was treated as unmeasurable.`);
      return { ...d, criteria: [{ id: `${d.id}-C01`, name: d.name, kind: 'judged' as const, outside: true, ...(d.measure ? { measure: d.measure } : {}), ...(d.anchors ? { anchors: d.anchors } : {}) }] };
    }
    const criteria = d.criteria.map((c) => {
      if (c.outside || c.check) return c;
      if (!NEEDS_OUTSIDE_EVIDENCE.test(`${c.name} ${c.measure ?? ''}`)) return c;
      notes.push(`${c.id} (${c.name}) needs evidence from outside the file, so it was treated as unmeasurable, not ${c.kind}.`);
      return { ...c, kind: 'judged' as const, outside: true };
    });
    return { ...d, criteria };
  });
  return notes.length === 0 ? { scorecard, notes } : { scorecard: { ...scorecard, dimensions }, notes };
}

export const DEFAULT_AGGREGATE: AggregateRule = { rule: 'mean' };

const STANDARD_NUMERIC: Record<number, string> = Object.fromEntries(Object.entries(STANDARD_ANCHORS).map(([k, v]) => [Number(k), v]));

function criterionQuestion(dim: DimensionSpec, c: CriterionSpec): DimensionSpec {
  const base = {
    id: c.id,
    name: c.name,
    weight: c.weight ?? 1,
    critical: dim.critical,
    ...(c.measure ? { measure: c.measure } : {}),
    ...(dim.measure || dim.description ? { description: [dim.measure, dim.description].filter(Boolean).join(' ') } : {}),
    ...(dim.returnTo ? { returnTo: dim.returnTo } : {}),
    ...(dim.reads ? { reads: dim.reads } : {}),
    criterionOf: { id: dim.id, name: dim.name },
  };
  if (c.kind === 'counted' && c.check) return { ...base, measuredBy: 'code', check: c.check };
  return { ...base, measuredBy: 'raters', anchors: c.anchors ?? dim.anchors ?? STANDARD_NUMERIC };
}

/** The working copy of a scorecard the agent runs on: every criterion is a question of its own. Safe to call twice. */
export function expandCriteria(scorecard: Scorecard): Scorecard {
  if (!scorecard.dimensions.some((d) => d.criteria && d.criteria.length > 0)) return scorecard;
  return {
    ...scorecard,
    dimensions: scorecard.dimensions.flatMap((d) => (d.criteria && d.criteria.length > 0 ? d.criteria.map((c) => criterionQuestion(d, c)) : [d])),
  };
}

/** Criterion id → the id of its dimension, for every criterion in the scorecard. */
export function criterionParents(scorecard: Scorecard): Map<string, string> {
  const parents = new Map<string, string>();
  for (const d of scorecard.dimensions) for (const c of d.criteria ?? []) parents.set(c.id, d.id);
  return parents;
}

export interface CriterionScore {
  status: DimensionResult['status'];
  score: number | null;
  weight: number;
  /** The scorecard says this criterion needs evidence from outside the file. */
  outside?: boolean;
}

export interface Combined {
  score: number | null;
  status: DimensionResult['status'];
  /** Which cap applied, if any. */
  capped: 'zero' | 'unmeasured' | null;
  /** Criteria no examiner could score with evidence, left out of the mean (only present when there are some). */
  leftOut?: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The scorecard's rule, applied by code. Three kinds of criterion without a score are told apart:
 *  - one the examiners found nothing in the file for (not measurable) is left out of the mean, and only when the scorecard says it needs
 *    evidence from outside the file (`outside`) does it trigger the "nothing in the file" cap (GS-1: 3);
 *  - one no examiner could back with evidence (unscored) is left out of the mean too, instead of counting as 0, because it says
 *    more about the run than about the file. The dimension is then uncertain; and if fewer than half of its criteria could be
 *    scored it counts as unscored, so a score built on a sliver can never help.
 * GS-1's order is kept: a criterion scored 0 caps the dimension first, otherwise a cap for outside evidence.
 */
export function combineCriteria(rawParts: CriterionScore[], rule: AggregateRule = DEFAULT_AGGREGATE): Combined {
  // A 0 (or no usable score at all) on a question that needs evidence from outside the file says "there is none here", not "this file is bad at it".
  // GS-1's own rule for that is the cap for missing outside evidence, so it is treated as not being in the file instead of triggering the zero cap
  // or counting as an unscored zero.
  const parts = rawParts.map((p): CriterionScore => (p.outside && ((p.status === 'scored' && p.score === 0) || p.status === 'unscored') ? { ...p, status: 'not_measurable' } : p));
  const measurable = parts.filter((p) => p.status !== 'not_measurable');
  if (measurable.length === 0) return { score: null, status: 'not_measurable', capped: null };
  const scored = measurable.filter((p) => p.status === 'scored');
  const leftOut = measurable.length - scored.length;
  // Too little to stand on: a dimension needs at least half of its measurable criteria scored.
  if (scored.length === 0 || scored.length * 2 < measurable.length) return { score: null, status: 'unscored', capped: null, leftOut };
  const values = scored.map((p) => ({ score: p.score ?? 0, weight: rule.rule === 'weighted' ? p.weight : 1 }));
  const totalWeight = values.reduce((sum, v) => sum + v.weight, 0);
  const mean = values.reduce((sum, v) => sum + v.score * v.weight, 0) / totalWeight;
  let score = rule.rule === 'mean_floor' ? Math.floor(mean + 1e-9) : round2(mean);
  let capped: Combined['capped'] = null;
  const anyZero = scored.some((p) => p.score === 0);
  const outsideMissing = parts.some((p) => p.status === 'not_measurable' && p.outside);
  if (anyZero && rule.zeroCapsAt !== undefined) {
    if (score > rule.zeroCapsAt) capped = 'zero';
    score = Math.min(score, rule.zeroCapsAt);
  } else if (outsideMissing && rule.unmeasuredCapsAt !== undefined) {
    if (score > rule.unmeasuredCapsAt) capped = 'unmeasured';
    score = Math.min(score, rule.unmeasuredCapsAt);
  }
  return { score, status: 'scored', capped, ...(leftOut > 0 ? { leftOut } : {}) };
}

/** From weakest to strongest: the dimension takes its least reliable criterion's resolution. */
const RESOLUTION_RANK: Resolution[] = ['lower_stands', 'single_rater', 'claims_checked', 'agreement', 'code', 'none'];

function weakest<T>(values: T[], order: T[]): T | undefined {
  return [...values].sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
}

export function describeRule(rule: AggregateRule): string {
  const how = rule.rule === 'mean_floor' ? 'the mean of its criteria, rounded down' : rule.rule === 'weighted' ? 'the weighted mean of its criteria' : 'the mean of its criteria';
  const caps = [
    rule.zeroCapsAt !== undefined ? `a criterion scored 0 caps it at ${rule.zeroCapsAt}` : '',
    rule.unmeasuredCapsAt !== undefined ? `a criterion that needs evidence from outside the file and has none caps it at ${rule.unmeasuredCapsAt}` : '',
  ].filter(Boolean);
  return `Scored as ${how}${caps.length ? `; ${caps.join('; ')}` : ''}.`;
}

function toCriterionResult(spec: CriterionSpec, r: DimensionResult | undefined): CriterionResult {
  return {
    id: spec.id,
    name: spec.name,
    kind: spec.kind === 'counted' && spec.check ? 'counted' : 'judged',
    status: r?.status ?? 'not_measurable',
    raterScores: r?.raterScores ?? {},
    consolidated: r?.consolidated ?? null,
    spread: r?.spread ?? null,
    resolution: r?.resolution ?? 'none',
    flagged: r?.flagged ?? false,
    ...(r?.confidence ? { confidence: r.confidence } : {}),
    rationale: r?.rationale ?? 'Nothing in the file measures this.',
    evidence: r?.evidence ?? [],
    ...(r?.codeDetail ? { codeDetail: r.codeDetail } : {}),
    ...(spec.outside ? { outside: true } : {}),
  };
}

const scoreText = (c: CriterionResult) =>
  c.status === 'not_measurable' ? 'not in the file' : c.status === 'unscored' ? 'unscored (0)' : `${c.consolidated}${c.codeDetail ? ` (${c.codeDetail.passed} of ${c.codeDetail.total})` : ''}`;

function collapseOne(dim: DimensionSpec, byId: Map<string, DimensionResult>, rule: AggregateRule): DimensionResult {
  const criteria = dim.criteria!.map((c) => toCriterionResult(c, byId.get(c.id)));
  const weights = new Map(dim.criteria!.map((c) => [c.id, c.weight ?? 1]));
  const combined = combineCriteria(criteria.map((c) => ({ status: c.status, score: c.consolidated, weight: weights.get(c.id)!, outside: c.outside })), rule);

  // Each examiner's own view of the dimension, by the same rule, over the criteria it scored; shown in the agreement table.
  const raterIds = [...new Set(criteria.flatMap((c) => Object.keys(c.raterScores)))].sort();
  const raterScores: Record<string, number | null> = {};
  for (const id of raterIds) {
    const given = criteria.filter((c) => c.kind === 'judged' && c.raterScores[id] != null);
    raterScores[id] = given.length === 0 ? null : combineCriteria(given.map((c) => ({ status: 'scored', score: c.raterScores[id]!, weight: weights.get(c.id)! })), rule).score;
  }
  const shown = Object.values(raterScores).filter((v): v is number => v !== null);
  const judged = criteria.filter((c) => c.kind === 'judged' && c.status !== 'not_measurable');
  const confidences = judged.map((c) => c.confidence).filter((c): c is Confidence => Boolean(c));
  const weakestResolution = combined.status === 'not_measurable' ? 'none' : (weakest(criteria.filter((c) => c.status !== 'not_measurable').map((c) => c.resolution), RESOLUTION_RANK) ?? 'none');
  // A dimension some of whose criteria no examiner could score is uncertain: it cannot make green or force red on its own.
  const resolution: Resolution = combined.leftOut && RESOLUTION_RANK.indexOf(weakestResolution) > RESOLUTION_RANK.indexOf('single_rater') ? 'single_rater' : weakestResolution;
  const capNote = combined.capped === 'zero' ? ' Capped because a criterion scored 0.' : combined.capped === 'unmeasured' ? ' Capped because a criterion that needs evidence from outside the file has none.' : '';
  const leftNote = combined.leftOut ? ` ${combined.leftOut} criterion/criteria with no usable score ${combined.status === 'unscored' ? 'left too little to score this dimension' : 'were left out of the mean'}.` : '';

  return {
    id: dim.id,
    name: dim.name,
    weight: dim.weight,
    critical: dim.critical,
    measuredBy: dim.measuredBy,
    status: combined.status,
    raterScores,
    consolidated: combined.score,
    spread: shown.length > 1 ? Math.max(...shown) - Math.min(...shown) : shown.length === 1 ? 0 : null,
    resolution,
    flagged: criteria.some((c) => c.flagged) || Boolean(combined.leftOut),
    ...(combined.leftOut ? { confidence: 'single' as Confidence } : confidences.length > 0 ? { confidence: weakest(confidences, ['single', 'shaky', 'steady'] as Confidence[])! } : {}),
    rationale:
      combined.status === 'not_measurable'
        ? 'The examiners found nothing in the file that measures any criterion of this dimension.'
        : `${describeRule(rule)}${capNote}${leftNote} ${criteria.map((c) => `${c.id} ${c.name}: ${scoreText(c)}`).join(' · ')}.`,
    evidence: criteria.flatMap((c) => c.evidence).slice(0, 5),
    criteria,
  };
}

/**
 * Turns the results of the working questions back into one result per dimension of the scorecard, in its order. A dimension
 * without criteria keeps its own result; a dimension with criteria gets the combined score and its criteria's results.
 */
export function collapseCriteria(scorecard: Scorecard, results: DimensionResult[]): DimensionResult[] {
  const byId = new Map(results.map((r) => [r.id, r]));
  const rule = scorecard.aggregate ?? DEFAULT_AGGREGATE;
  return scorecard.dimensions.flatMap((dim): DimensionResult[] => {
    if (dim.criteria && dim.criteria.length > 0) return [collapseOne(dim, byId, rule)];
    const own = byId.get(dim.id);
    return own ? [own] : [];
  });
}

/** A finding raised on a criterion belongs to its dimension in the report. */
export function findingsToDimensions(scorecard: Scorecard, findings: DraftFinding[]): DraftFinding[] {
  const parents = criterionParents(scorecard);
  if (parents.size === 0) return findings;
  return findings.map((f) => (parents.has(f.dimensionId) ? { ...f, dimensionId: parents.get(f.dimensionId)! } : f));
}
