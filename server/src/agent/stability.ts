import type { Decision, DimensionResult } from '@ddd/shared';

/** What stability reads of a question: a dimension of the report, or one of its criteria. */
type Leaf = Pick<DimensionResult, 'id' | 'name' | 'status' | 'raterScores' | 'consolidated'>;
type Question = Leaf & { weight: number; criteria?: Leaf[] };

/**
 * Run stability: how much the same file's result moves when it is checked again. The PDF asks for "same inputs, re-run: verdicts that stay the same
 * divided by re-runs, 95% or more". This reads the saved reports of several runs of one file against one scorecard (no model call) and says: how many
 * verdicts agree, how wide the scores range, and which questions swing most and why (the examiners' own marks moved, or the final mark moved while the
 * examiners' marks did not, which points at the final reviewer or at code).
 */
export interface RunSummary {
  label: string;
  score: number;
  decision: Decision;
  dimensions: Question[];
}

export interface Swing {
  id: string;
  name: string;
  /** The final mark in each run, in the order of the runs. */
  marks: Array<number | null>;
  spread: number;
  /** The examiners' marks (one entry per run) when they moved by 2 or more between runs; otherwise the final mark moved alone. */
  cause: 'examiners' | 'final reviewer or code';
  /** Points of the weighted score this question can move: its weight share times its spread. */
  points: number;
}

export interface Stability {
  runs: number;
  scores: number[];
  decisions: Decision[];
  /** Share of runs that landed on the most common colour, 0 to 1. The PDF's target is at least 0.95. */
  sameVerdict: number;
  range: { low: number; high: number; width: number };
  sd: number;
  swings: Swing[];
}

const leaves = (d: Question): Leaf[] => (d.criteria && d.criteria.length > 0 ? d.criteria : [d]);
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

export function analyseStability(runs: RunSummary[]): Stability {
  if (runs.length < 2) throw new Error('Stability needs at least two runs of the same file.');
  const scores = runs.map((r) => r.score);
  const tally = new Map<Decision, number>();
  for (const r of runs) tally.set(r.decision, (tally.get(r.decision) ?? 0) + 1);
  const sameVerdict = Math.max(...tally.values()) / runs.length;
  const avg = mean(scores);
  const sd = Math.sqrt(mean(scores.map((s) => (s - avg) ** 2)));

  const ids = new Map<string, { name: string; weight: number }>();
  for (const r of runs) {
    for (const d of r.dimensions) {
      const parts = leaves(d);
      for (const p of parts) ids.set(p.id, { name: p.name, weight: parts.length > 1 ? d.weight / parts.length : d.weight });
    }
  }
  const totalWeight = [...runs[0]!.dimensions].reduce((s, d) => s + d.weight, 0) || 1;
  const swings: Swing[] = [];
  for (const [id, info] of ids) {
    const per = runs.map((r) => r.dimensions.flatMap(leaves).find((l) => l.id === id));
    const marks = per.map((p) => (p && p.status === 'scored' ? (p.consolidated ?? null) : null));
    const known = marks.filter((m): m is number => m !== null);
    if (known.length < 2) continue;
    const spread = Math.max(...known) - Math.min(...known);
    if (spread === 0) continue;
    // Did the examiners' marks move (the median of their marks differs by 2 or more between runs)?
    const medians = per.map((p) => {
      const v = Object.values(p?.raterScores ?? {}).filter((x): x is number => typeof x === 'number').sort((a, b) => a - b);
      return v.length ? v[Math.floor((v.length - 1) / 2)]! : null;
    }).filter((m): m is number => m !== null);
    const examinersMoved = medians.length >= 2 && Math.max(...medians) - Math.min(...medians) >= 2;
    swings.push({ id, name: info.name, marks, spread, cause: examinersMoved ? 'examiners' : 'final reviewer or code', points: (info.weight / totalWeight) * spread * 20 });
  }
  swings.sort((a, b) => b.points - a.points || b.spread - a.spread);
  return { runs: runs.length, scores, decisions: runs.map((r) => r.decision), sameVerdict, range: { low: Math.min(...scores), high: Math.max(...scores), width: Math.max(...scores) - Math.min(...scores) }, sd, swings };
}

export function describeStability(s: Stability, top = 6): string[] {
  const lines = [
    `${s.runs} runs: scores ${s.scores.map((x) => x.toFixed(1)).join(', ')}; range ${s.range.low.toFixed(1)} to ${s.range.high.toFixed(1)} (width ${s.range.width.toFixed(1)}, sd ${s.sd.toFixed(1)}).`,
    `Same verdict in ${Math.round(s.sameVerdict * s.runs)} of ${s.runs} runs (${(s.sameVerdict * 100).toFixed(0)}%; the PDF's target is 95% or more): ${s.decisions.join(', ')}.`,
  ];
  if (s.swings.length === 0) lines.push('No question moved between the runs.');
  else {
    lines.push(`Questions that moved most (points of the weighted score they can move):`);
    for (const w of s.swings.slice(0, top)) lines.push(`  ${w.id.padEnd(9)} ${w.marks.map((m) => (m === null ? '-' : m)).join(' / ').padEnd(14)} ${w.points.toFixed(1).padStart(4)} pts  ${w.cause}  ${w.name}`);
  }
  return lines;
}
