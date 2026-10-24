import { parseCsv } from '../src/library/spotCheck.js';

/**
 * The pure parts of the calibration pack (scripts/calibration.ts): reading a filled form back and comparing it with the tool.
 * Nothing here touches the model or the disk.
 */

export const LABELS = ['real', 'partly', 'wrong', 'vague'] as const;
export type Label = (typeof LABELS)[number];
const useful = (a: string) => a === 'real' || a === 'partly';

export interface CriterionKey {
  id: string;
  pair: string;
  criterionId: string;
  name: string;
  toolScore: number;
}
export interface FindingKey {
  id: string;
  pair: string;
  /** Our label, or null when we never labelled it (for example a finding the app would not have shown). */
  ourLabel: string | null;
  shownByTool: boolean;
}
export interface CalibrationKey {
  criteria: CriterionKey[];
  findings: FindingKey[];
}

export interface ScoreStats {
  n: number;
  meanAbsDiff: number;
  within1: number;
  exact: number;
  /** Mean of (tool - human). Above 0 means the tool scores higher than the person. */
  bias: number;
  toolHigher: number;
  toolLower: number;
}

export interface CalibrationReport {
  criteriaAsked: number;
  criteriaScored: number;
  findingsAsked: number;
  findingsLabelled: number;
  skipped: Array<{ id: string; why: string }>;
  scores: ScoreStats | null;
  scoresByPair: Record<string, ScoreStats>;
  noEvidence: number;
  /** Human labels against our labels, only for findings we had labelled. */
  labels: { n: number; exact: number; usefulAgree: number; matrix: Record<string, Record<string, number>>; ours: { useful: number; wrong: number }; theirs: { useful: number; wrong: number } };
  /** The findings we never labelled (the app would not show them): what the person made of them. */
  unlabelled: { n: number; useful: number; wrong: number };
  bigMisses: Array<{ id: string; pair: string; criterion: string; tool: number; human: number }>;
  labelDisagreements: Array<{ id: string; pair: string; ours: string; theirs: string }>;
}

function stats(pairs: Array<[number, number]>): ScoreStats {
  const n = pairs.length;
  const diffs = pairs.map(([tool, human]) => tool - human);
  const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
  return {
    n,
    meanAbsDiff: sum(diffs.map(Math.abs)) / n,
    within1: diffs.filter((d) => Math.abs(d) <= 1).length / n,
    exact: diffs.filter((d) => d === 0).length / n,
    bias: sum(diffs) / n,
    toolHigher: diffs.filter((d) => d > 0).length,
    toolLower: diffs.filter((d) => d < 0).length,
  };
}

/** "3", "3.0" and " 4 " are scores; NM, n/a, text and numbers outside 0 to 5 are not. */
export function parseScore(cell: string): number | null {
  const t = cell.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const v = Number(t);
  return v >= 0 && v <= 5 ? v : null;
}

export function scoreForm(csv: string, key: CalibrationKey): CalibrationReport {
  const [head, ...rows] = parseCsv(csv);
  if (!head) throw new Error('The form is empty.');
  const col = (name: string) => head.findIndex((h) => h.trim().toLowerCase() === name);
  const idCol = col('id');
  const scoreCol = col('score');
  const labelCols = LABELS.map((l) => col(l));
  const evidenceCol = col('cell evidence');
  if (idCol < 0 || scoreCol < 0 || labelCols.some((c) => c < 0)) {
    throw new Error('The form needs the columns id, score, real, partly, wrong, vague. Was it re-ordered or saved with other headings?');
  }
  const critById = new Map(key.criteria.map((c) => [c.id, c]));
  const findById = new Map(key.findings.map((f) => [f.id, f]));
  const report: CalibrationReport = {
    criteriaAsked: key.criteria.length, criteriaScored: 0, findingsAsked: key.findings.length, findingsLabelled: 0, skipped: [],
    scores: null, scoresByPair: {}, noEvidence: 0,
    labels: { n: 0, exact: 0, usefulAgree: 0, matrix: Object.fromEntries(LABELS.map((a) => [a, Object.fromEntries(LABELS.map((b) => [b, 0]))])), ours: { useful: 0, wrong: 0 }, theirs: { useful: 0, wrong: 0 } },
    unlabelled: { n: 0, useful: 0, wrong: 0 }, bigMisses: [], labelDisagreements: [],
  };
  const seen = new Set<string>();
  const all: Array<[number, number]> = [];
  const byPair = new Map<string, Array<[number, number]>>();
  for (const row of rows) {
    const id = (row[idCol] ?? '').trim();
    if (!id) continue;
    const crit = critById.get(id);
    const find = findById.get(id);
    if (!crit && !find) { report.skipped.push({ id, why: 'not in the answer key' }); continue; }
    if (seen.has(id)) { report.skipped.push({ id, why: 'row appears twice' }); continue; }
    seen.add(id);
    if (crit) {
      const raw = (row[scoreCol] ?? '').trim();
      if (raw === '') { report.skipped.push({ id, why: 'no score given' }); continue; }
      const human = parseScore(raw);
      if (human === null) { report.skipped.push({ id, why: `score "${raw}" is not a number from 0 to 5` }); continue; }
      report.criteriaScored++;
      all.push([crit.toolScore, human]);
      (byPair.get(crit.pair) ?? byPair.set(crit.pair, []).get(crit.pair)!).push([crit.toolScore, human]);
      if (evidenceCol >= 0 && (row[evidenceCol] ?? '').trim() === '') report.noEvidence++;
      if (Math.abs(crit.toolScore - human) >= 2) report.bigMisses.push({ id, pair: crit.pair, criterion: crit.name, tool: crit.toolScore, human });
    } else if (find) {
      const marked = LABELS.filter((_, i) => (row[labelCols[i]!] ?? '').trim() !== '');
      if (marked.length === 0) { report.skipped.push({ id, why: 'no label given' }); continue; }
      if (marked.length > 1) { report.skipped.push({ id, why: `more than one column marked (${marked.join(', ')})` }); continue; }
      const theirs = marked[0]!;
      report.findingsLabelled++;
      const ours = find.ourLabel;
      if (!ours || !(LABELS as readonly string[]).includes(ours)) {
        report.unlabelled.n++;
        if (useful(theirs)) report.unlabelled.useful++;
        if (theirs === 'wrong') report.unlabelled.wrong++;
        continue;
      }
      const l = report.labels;
      l.n++;
      l.matrix[ours]![theirs]!++;
      if (ours === theirs) l.exact++;
      if (useful(ours) === useful(theirs)) l.usefulAgree++;
      if (useful(ours)) l.ours.useful++;
      if (ours === 'wrong') l.ours.wrong++;
      if (useful(theirs)) l.theirs.useful++;
      if (theirs === 'wrong') l.theirs.wrong++;
      if (ours !== theirs) report.labelDisagreements.push({ id, pair: find.pair, ours, theirs });
    }
  }
  for (const k of [...key.criteria, ...key.findings]) if (!seen.has(k.id)) report.skipped.push({ id: k.id, why: 'row missing from the form' });
  if (all.length > 0) report.scores = stats(all);
  for (const [pair, pairs] of byPair) report.scoresByPair[pair] = stats(pairs);
  return report;
}

export const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(0)}%`);
