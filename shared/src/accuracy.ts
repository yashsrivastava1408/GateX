import { bandOf } from './types.js';
import type { Decision } from './types.js';
import { stepNumber } from './board.js';

/**
 * How accurate the evaluator is, measured the way the Roadmap (page 14) asks:
 *
 *   score within 1 point of the person      at least 90% of questions
 *   verdict matches the person              at least 95%
 *   false green (GateX green, person not)   0%, and 0% on critical questions
 *   false red (GateX red, person green)     at most 10%
 *   same verdict on a re-run                at least 95%
 *   wrong issues (our own target)           at most 10%
 *
 * Every figure comes from ONE kind of source and is never blended with another:
 *   'human'       a person scored or labelled it (a review in the app, a filled spot-check sheet or calibration form)
 *   'ai-standin'  an AI scored or labelled it (a reference mark made by another AI reader, our own labels, a blind AI reader).
 *                 It is shown apart, as a stand-in, and it is never a human check
 *   'self'        GateX against itself (re-runs of the same file), which needs no reference
 * A figure with too little data says so instead of passing or failing.
 */

export type AccuracySource = 'human' | 'ai-standin';
export type MeasureSource = AccuracySource | 'self';
export type MeasureStatus = 'pass' | 'fail' | 'not_enough_data';
export type MeasureId = 'scoreWithin1' | 'verdictMatch' | 'falseGreen' | 'criticalFalseGreen' | 'falseRed' | 'rerunStable' | 'wrongFindings';
export type FindingLabelName = 'real' | 'partly' | 'wrong' | 'vague';

/** A person's verdict on one issue in the dashboard. It counts as a human label: right is real, wrong is wrong, unclear is vague. */
export type FeedbackLabel = 'right' | 'wrong' | 'unclear';
export const FEEDBACK_AS_LABEL: Record<FeedbackLabel, FindingLabelName> = { right: 'real', wrong: 'wrong', unclear: 'vague' };

export interface FindingFeedback {
  runId: string;
  findingId: string;
  who: string;
  label: FeedbackLabel;
  note: string;
  createdAt: string;
}

/** A person's own marks for a finished check (shadow mode): a 0 to 5 mark per question area, and optionally their colour. */
export interface HumanReview {
  id: string;
  runId: string;
  reviewer: string;
  verdict: 'green' | 'amber' | 'red' | null;
  /** Question area id to the person's mark, 0 to 5. */
  scores: Record<string, number>;
  note: string;
  createdAt: string;
}

/** One question's score from GateX next to the reference's score for the same question, both 0 to 5. */
export interface ScorePair {
  step: string;
  /** The file the question was asked about (so one file is not mistaken for many). */
  file: string;
  /** The question, unique inside the file. */
  item: string;
  critical: boolean;
  gatex: number;
  reference: number;
}

/** GateX's colour for a whole check next to the reference colour. `criticalFail`: the reference marked a critical question below 4. */
export interface VerdictPair {
  step: string;
  file: string;
  gatex: Decision;
  reference: Decision;
  criticalFail?: boolean;
  /** The reference colour was worked out from the person's scores, not chosen by them. */
  derived?: boolean;
}

/** Checks of the same file by the same build of GateX: one entry per check. */
export interface RerunGroup {
  step: string;
  file: string;
  verdicts: Decision[];
}

export interface FindingLabel {
  step: string;
  file: string;
  label: FindingLabelName;
  /** Where the label came from, for example "spot-check sheet" or "our own labels". */
  origin: string;
}

export interface AccuracySlice {
  scores: ScorePair[];
  verdicts: VerdictPair[];
  labels: FindingLabel[];
}

export interface AccuracyInput {
  human: AccuracySlice;
  aiStandin: AccuracySlice;
  reruns: RerunGroup[];
}

export interface Needs {
  /** Distinct items (questions, checks, issues) needed before a figure is judged. */
  n: number;
  /** Distinct files they must come from, so one file is not mistaken for the whole. */
  files: number;
}

export interface MeasureRow {
  value: number | null;
  /** Items counted (the denominator of the value). */
  n: number;
  files: number;
  status: MeasureStatus;
}

export interface MeasureResult extends MeasureRow {
  id: MeasureId;
  source: MeasureSource;
  /** Only for issue labels: which set of labels this figure is made from. */
  origin?: string;
  title: string;
  /** One line in plain words about what the figure counts. */
  plain: string;
  /** For example "at least 90%". */
  target: string;
  direction: 'atLeast' | 'atMost';
  targetValue: number;
  needs: Needs;
  /** For example "9 of 40", or "". */
  counted: string;
  byStep: Array<MeasureRow & { step: string }>;
}

export interface SourceNote {
  id: string;
  kind: MeasureSource;
  title: string;
  /** How many items it holds (scores, labels, reviews). */
  count: number;
  note: string;
}

export interface AccuracyReport {
  generatedAt: string;
  /** What each figure needs before it is judged. */
  minimums: Record<MeasureId, Needs>;
  human: MeasureResult[];
  aiStandin: MeasureResult[];
  /** Measures that need no reference. */
  self: MeasureResult[];
  sources: SourceNote[];
  /** Counts of what a person has given so far. */
  humanTotals: { scores: number; verdicts: number; labels: number; reviews: number };
}

export const MINIMUMS: Record<MeasureId, Needs> = {
  scoreWithin1: { n: 30, files: 3 },
  verdictMatch: { n: 10, files: 3 },
  falseGreen: { n: 5, files: 3 },
  criticalFalseGreen: { n: 5, files: 3 },
  falseRed: { n: 3, files: 2 },
  rerunStable: { n: 6, files: 3 },
  wrongFindings: { n: 30, files: 3 },
};

const MEASURES: Record<MeasureId, { title: string; plain: string; target: string; direction: 'atLeast' | 'atMost'; targetValue: number }> = {
  scoreWithin1: {
    title: 'Scores close to a person',
    plain: 'How often GateX’s mark for a question is within 1 point of the reference mark.',
    target: 'at least 90%', direction: 'atLeast', targetValue: 0.9,
  },
  verdictMatch: {
    title: 'Same colour as a person',
    plain: 'How often the colour GateX gives a file is the colour the reference gives it.',
    target: 'at least 95%', direction: 'atLeast', targetValue: 0.95,
  },
  falseGreen: {
    title: 'Green when a person says not green',
    plain: 'Of the files GateX called green, how many the reference called amber or red. This is the costliest mistake.',
    target: '0%', direction: 'atMost', targetValue: 0,
  },
  criticalFalseGreen: {
    title: 'Green although a must-pass question fails',
    plain: 'Of the files GateX called green, how many the reference marked below 4 on a must-pass question.',
    target: '0%', direction: 'atMost', targetValue: 0,
  },
  falseRed: {
    title: 'Red when a person says green',
    plain: 'Of the files GateX called red, how many the reference called green.',
    target: 'at most 10%', direction: 'atMost', targetValue: 0.1,
  },
  rerunStable: {
    title: 'Same colour when run again',
    plain: 'Checks of the same file, by the same build, that give the colour most of the checks gave.',
    target: 'at least 95%', direction: 'atLeast', targetValue: 0.95,
  },
  wrongFindings: {
    title: 'Issues that are wrong',
    plain: 'Of the issues GateX raised that someone checked against the file, how many are wrong.',
    target: 'at most 10%', direction: 'atMost', targetValue: 0.1,
  },
};

export const stepLabel = (raw: string | null | undefined): string => {
  const n = stepNumber(raw);
  return n === null ? 'No step' : `Step ${n}`;
};

const eps = 1e-9;
const distinct = <T>(items: T[], key: (item: T) => string) => new Set(items.map(key)).size;

function judge(value: number | null, n: number, files: number, needs: Needs, direction: 'atLeast' | 'atMost', target: number): MeasureStatus {
  if (value === null || n < needs.n || files < needs.files) return 'not_enough_data';
  const ok = direction === 'atLeast' ? value + eps >= target : value <= target + eps;
  return ok ? 'pass' : 'fail';
}

interface Counted {
  /** Items in the denominator. `item` is set when the same question can be counted again by a later check of the same file. */
  denominators: Array<{ step: string; file: string; ok: boolean; item?: string }>;
}

function makeResult(id: MeasureId, source: MeasureSource, c: Counted, origin?: string): MeasureResult {
  const def = MEASURES[id];
  const needs = MINIMUMS[id];
  const row = (items: Counted['denominators'], needsRow: Needs): MeasureRow => {
    const n = items.length;
    const value = n === 0 ? null : items.filter((i) => i.ok).length / n;
    const files = distinct(items, (i) => i.file);
    // Repeated checks of the same question do not make the sample bigger.
    const units = items.every((i) => i.item !== undefined) ? distinct(items, (i) => `${i.file}|${i.item}`) : n;
    return { value, n, files, status: judge(value, units, files, needsRow, def.direction, def.targetValue) };
  };
  const all = row(c.denominators, needs);
  const steps = [...new Set(c.denominators.map((d) => d.step))].sort();
  const byStep = steps.map((step) => ({ step, ...row(c.denominators.filter((d) => d.step === step), needs) }));
  // "ok" is the counted event: the match for a higher-is-better figure, the mistake for a lower-is-better one.
  const ok = c.denominators.filter((d) => d.ok).length;
  const units = c.denominators.every((d) => d.item !== undefined) ? distinct(c.denominators, (d) => `${d.file}|${d.item}`) : c.denominators.length;
  const unitNote = units !== c.denominators.length ? ` (${units} different questions)` : '';
  return {
    id, source, ...(origin ? { origin } : {}), title: def.title, plain: def.plain, target: def.target, direction: def.direction, targetValue: def.targetValue,
    needs, counted: c.denominators.length === 0 ? '' : `${ok} of ${c.denominators.length}${unitNote}`, ...all, byStep,
  };
}

/** The person's colour from their per-question scores: the same rule GateX uses (the score alone), weighted. Null when they scored too little of it. */
export function verdictFromScores(items: Array<{ score: number | null; weight: number }>, minCoverage = 0.8): Decision | null {
  const total = items.reduce((s, i) => s + i.weight, 0);
  const covered = items.filter((i) => i.score !== null).reduce((s, i) => s + i.weight, 0);
  if (total <= 0 || covered / total < minCoverage) return null;
  const points = items.filter((i) => i.score !== null).reduce((s, i) => s + (i.weight * (i.score as number)) / 5, 0);
  return bandOf((100 * points) / covered);
}

function referenceMeasures(source: AccuracySource, slice: AccuracySlice): MeasureResult[] {
  const out: MeasureResult[] = [];
  out.push(makeResult('scoreWithin1', source, {
    denominators: slice.scores.map((p) => ({ step: p.step, file: p.file, item: p.item, ok: Math.abs(p.gatex - p.reference) <= 1 + eps })),
  }));

  out.push(makeResult('verdictMatch', source, { denominators: slice.verdicts.map((v) => ({ step: v.step, file: v.file, ok: v.gatex === v.reference })) }));
  const greens = slice.verdicts.filter((v) => v.gatex === 'green');
  // For the "bad rate" measures a counted event is the mistake, so the value is the share of mistakes.
  out.push(makeResult('falseGreen', source, { denominators: greens.map((v) => ({ step: v.step, file: v.file, ok: v.reference !== 'green' })) }));
  out.push(makeResult('criticalFalseGreen', source, {
    denominators: greens.filter((v) => v.criticalFail !== undefined).map((v) => ({ step: v.step, file: v.file, ok: v.criticalFail === true })),
  }));
  const reds = slice.verdicts.filter((v) => v.gatex === 'red');
  out.push(makeResult('falseRed', source, { denominators: reds.map((v) => ({ step: v.step, file: v.file, ok: v.reference === 'green' })) }));

  const origins = [...new Set(slice.labels.map((l) => l.origin))].sort();
  for (const origin of origins) {
    const own = slice.labels.filter((l) => l.origin === origin);
    out.push(makeResult('wrongFindings', source, { denominators: own.map((l) => ({ step: l.step, file: l.file, ok: l.label === 'wrong' })) }, origin));
  }
  if (origins.length === 0) out.push(makeResult('wrongFindings', source, { denominators: [] }));
  return out;
}

function rerunMeasure(reruns: RerunGroup[]): MeasureResult {
  const groups = reruns.filter((g) => g.verdicts.length >= 2);
  const steps = [...new Set(groups.map((g) => g.step))].sort();
  const tally = (list: RerunGroup[]) => {
    let runs = 0;
    let same = 0;
    for (const g of list) {
      const counts = new Map<Decision, number>();
      for (const v of g.verdicts) counts.set(v, (counts.get(v) ?? 0) + 1);
      runs += g.verdicts.length;
      same += Math.max(...counts.values());
    }
    return { runs, same };
  };
  const def = MEASURES.rerunStable;
  const needs = MINIMUMS.rerunStable;
  const row = (list: RerunGroup[], needsRow: Needs): MeasureRow => {
    const { runs, same } = tally(list);
    const value = runs === 0 ? null : same / runs;
    const files = distinct(list, (g) => g.file);
    return { value, n: runs, files, status: judge(value, runs, files, needsRow, def.direction, def.targetValue) };
  };
  const { runs, same } = tally(groups);
  return {
    id: 'rerunStable', source: 'self', title: def.title, plain: def.plain, target: def.target, direction: def.direction, targetValue: def.targetValue, needs,
    counted: runs === 0 ? '' : `${same} of ${runs} checks (${groups.length} ${groups.length === 1 ? 'set' : 'sets'} of the same file)`,
    ...row(groups, needs),
    byStep: steps.map((step) => ({ step, ...row(groups.filter((g) => g.step === step), needs) })),
  };
}

export function computeAccuracy(input: AccuracyInput, sources: SourceNote[] = [], humanReviews = 0, generatedAt = new Date().toISOString()): AccuracyReport {
  const h = input.human;
  return {
    generatedAt,
    minimums: MINIMUMS,
    human: referenceMeasures('human', h),
    aiStandin: referenceMeasures('ai-standin', input.aiStandin),
    self: [rerunMeasure(input.reruns)],
    sources,
    humanTotals: { scores: h.scores.length, verdicts: h.verdicts.length, labels: h.labels.length, reviews: humanReviews },
  };
}
