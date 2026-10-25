import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  FEEDBACK_AS_LABEL, bandOf, computeAccuracy, stepLabel, verdictFromScores,
  type AccuracyInput, type AccuracyReport, type AccuracySlice, type Decision, type FindingLabel, type FindingLabelName, type HumanReview,
  type RerunGroup, type Report, type ScorePair, type SourceNote, type VerdictPair,
} from '@ddd/shared';
import { WorkbookModel } from '../excel/workbook.js';
import type { Store } from '../db/store.js';
import { parseCsv } from './spotCheck.js';

/**
 * Gathers what the accuracy page is made of, and keeps each kind apart.
 *
 *   human        reviews and issue thumbs saved in the app, and a spot-check sheet or calibration form filled in by a person
 *   ai-standin   the reference marks inside a scorecard workbook (another AI reader), our own issue labels, blind AI readers
 *   self         checks of the same file, to see whether the colour stays the same
 *
 * Nothing here calls a model. Saved reports of mock models are never read.
 */

const LABELS: FindingLabelName[] = ['real', 'partly', 'wrong', 'vague'];
const PAIR_STEP: Record<string, string> = { docket: 'Step 1', step1: 'Step 1', step2: 'Step 2', step3: 'Step 3', step4: 'Step 4', step5: 'Step 5' };
const pairStep = (pair: string) => PAIR_STEP[pair.trim().toLowerCase()] ?? stepLabel(pair);

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}
const readText = async (file: string) => readFile(file, 'utf8').catch(() => null);

const emptySlice = (): AccuracySlice => ({ scores: [], verdicts: [], labels: [] });

/* ------------------------------ saved reports ------------------------------ */

export interface RunFacts {
  runId: string;
  step: string;
  /** The file that was checked (its hash). */
  file: string;
  scorecardHash: string;
  promptVersion: string;
  /** The examiners and final reviewer that marked it. */
  roster: string;
  /** The calendar day it finished (UTC). */
  day: string;
  score: number | null;
  twice: boolean;
  criteria: Array<{ id: string; critical: boolean; mark: number }>;
  folder: string;
}

const SKIP_DIRS = new Set(['uploads', 'node_modules', 'archive', 'inputs', 'library', 'reviews', 'review-sheet', 'calibration-pack', 'scorecards', 'dumps', 'shots', 'learn', 'blind', 'blind-keys', 'presence']);

async function findReports(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth > 4) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isFile() && e.name === 'report.json') out.push(path.join(dir, e.name));
    else if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) await findReports(path.join(dir, e.name), depth + 1, out);
  }
}

/** Every real (not mock) finished report under the data folder, once per run. Colour is never read from the file: it is worked out from the score. */
export async function scanReports(dataDir: string, includeMock = false): Promise<RunFacts[]> {
  const files: string[] = [];
  await findReports(dataDir, 0, files);
  const seen = new Set<string>();
  const out: RunFacts[] = [];
  for (const file of files.sort()) {
    const r = await readJson<Report>(file);
    const h = r?.header;
    if (!r || !h?.artifactHash || !h.runId || seen.has(h.runId)) continue;
    if (!includeMock && [...(h.raters ?? []), h.consolidator].some((m) => m?.provider === 'mock')) continue;
    seen.add(h.runId);
    const criteria: RunFacts['criteria'] = [];
    for (const d of r.dimensions ?? []) {
      for (const c of d.criteria ?? []) {
        if (c.status === 'scored' && typeof c.consolidated === 'number') criteria.push({ id: c.id, critical: Boolean(d.critical), mark: c.consolidated });
      }
    }
    out.push({
      runId: h.runId, step: stepLabel(h.step), file: h.artifactHash, scorecardHash: h.scorecardHash, promptVersion: h.promptVersion,
      roster: [...(h.raters ?? []).map((m) => m.model), h.consolidator?.model].join(','), day: String(h.finishedAt ?? '').slice(0, 10),
      score: typeof r.verdict?.weightedScore === 'number' ? r.verdict.weightedScore : null, twice: Boolean(r.twoRuns), criteria, folder: path.dirname(file),
    });
  }
  return out;
}

const promptNumber = (v: string) => Number(/(\d+(?:\.\d+)?)\s*$/.exec(v)?.[1] ?? 0);

/**
 * Checks of the same file and scorecard, by the same prompt version and the same examiners, on the same day. GateX does not record which build of
 * the code made a check, so this is the nearest to "the same build": two builds on one day count as one, which can only make a re-run look
 * less steady than it is, never steadier.
 */
export function rerunGroups(runs: RunFacts[]): RerunGroup[] {
  const groups = new Map<string, RunFacts[]>();
  for (const r of runs) {
    if (r.score === null || r.twice) continue;
    const key = `${r.file}|${r.scorecardHash}|${r.promptVersion}|${r.roster}|${r.day}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const sets = [...groups.values()].filter((g) => g.length >= 2);
  // Only the newest prompt version: how steady an older build was says little about the one in use now.
  const newest = Math.max(0, ...sets.map((g) => promptNumber(g[0]!.promptVersion)));
  return sets.filter((g) => promptNumber(g[0]!.promptVersion) === newest).map((g) => ({ step: g[0]!.step, file: g[0]!.file, verdicts: g.map((r) => bandOf(r.score!)) }));
}

/* ------------------------------ the reference marks inside a scorecard workbook ------------------------------ */

interface ReferenceSet {
  id: string;
  step: string;
  /** The file the marks are about (its hash). */
  file: string;
  marks: Map<string, number>;
  score: number | null;
  lowestGate: number | null;
  /** What the workbook itself says about who made the marks. */
  provenance: string;
}

const REFERENCE_FILES = [
  { id: 'step2-v32', step: 'Step 2', schema: 'inputs/step2-v32/Talentra_Step2_Master_Schema_v3.2_Reconciled.xlsx', scorecard: 'inputs/step2-v32/Talentra_Step2_Master_Scorecard_v3.2_Reconciled.xlsx' },
];

const num = (text: string | undefined) => (text !== undefined && /^-?\d+(\.\d+)?$/.test(text.trim()) ? Number(text) : null);

async function loadReferenceSets(dataDir: string): Promise<ReferenceSet[]> {
  const out: ReferenceSet[] = [];
  for (const f of REFERENCE_FILES) {
    try {
      const schemaBytes = await readFile(path.join(dataDir, f.schema));
      const wb = await WorkbookModel.load(path.join(dataDir, f.scorecard));
      const marks = new Map<string, number>();
      const rows = new Map<number, Map<number, string>>();
      for (const [row, col, text] of wb.cells('Scorecard')) (rows.get(row) ?? rows.set(row, new Map()).get(row)!).set(col, text);
      for (const cols of rows.values()) {
        const id = cols.get(1)?.trim() ?? '';
        const mark = num(cols.get(10));
        if (/^G\d\d-C\d\d$/.test(id) && mark !== null && mark >= 0 && mark <= 5) marks.set(id, mark);
      }
      const master = wb.cellText('Master Scorecard', 'A2') ?? '';
      const assessor = /Assessor:[^.]*\.[^.]*\./.exec(master)?.[0] ?? master.slice(0, 220);
      out.push({
        id: f.id, step: f.step, file: sha256(schemaBytes), marks, score: num(wb.cellText('Summary', 'E4')), lowestGate: num(wb.cellText('Summary', 'E7')),
        // The workbook names the AI it used; the page speaks of "an AI assistant" so no model name reaches the screen.
        provenance: assessor.trim().replace(/\bClaude\b/g, 'an AI assistant'),
      });
    } catch {
      // the files are not there: nothing to compare with
    }
  }
  return out;
}

/* ------------------------------ our labels and the blind AI readers ------------------------------ */

interface CaseFile { id: string; step: string; runs: Array<{ runDir: string; reviewFile?: string }> }
interface ReviewFile { labels: Array<{ id: string; verdict: string }> }

async function ourLabels(dataDir: string, includeMock: boolean): Promise<FindingLabel[]> {
  const out: FindingLabel[] = [];
  let names: string[] = [];
  try {
    names = (await readdir(path.join(dataDir, 'library'))).filter((n) => n.endsWith('.json') && n !== 'reliability.json').sort();
  } catch {
    return out;
  }
  for (const name of names) {
    const file = await readJson<CaseFile>(path.join(dataDir, 'library', name));
    if (!file) continue;
    // The newest run of each pair that has verdicts, so older builds are not counted again.
    for (const run of [...file.runs].reverse()) {
      if (!run.reviewFile) continue;
      const report = await readJson<Report>(path.join(dataDir, run.runDir, 'report.json'));
      const review = await readJson<ReviewFile>(path.join(dataDir, run.reviewFile));
      if (!report || !review) continue;
      if (!includeMock && [...(report.header?.raters ?? []), report.header?.consolidator].some((m) => m?.provider === 'mock')) continue;
      const known = new Set((report.findings ?? []).map((f) => f.id));
      for (const l of review.labels) {
        if (known.has(l.id) && (LABELS as string[]).includes(l.verdict)) {
          out.push({ step: stepLabel(file.step), file: file.id, label: l.verdict as FindingLabelName, origin: 'our own labels (written by an AI agent)' });
        }
      }
      break;
    }
  }
  return out;
}

interface SpotKey { rows: Array<{ id: string; pair: string; ourLabel: string }> }
interface CalibrationKey { criteria: Array<{ id: string; pair: string; name: string; toolScore: number }>; findings: Array<{ id: string; pair: string }> }

/** Reads a filled spot-check sheet: one label per row that has exactly one box ticked. */
export function readSpotSheet(csv: string, key: SpotKey, origin: string): FindingLabel[] {
  const [head, ...rows] = parseCsv(csv);
  if (!head) return [];
  const col = (name: string) => head.findIndex((h) => h.trim().toLowerCase() === name);
  const idCol = col('id');
  const cols = LABELS.map((l) => col(l));
  if (idCol < 0 || cols.some((c) => c < 0)) return [];
  const byId = new Map(key.rows.map((k) => [k.id, k]));
  const out: FindingLabel[] = [];
  for (const row of rows) {
    const k = byId.get((row[idCol] ?? '').trim());
    if (!k) continue;
    const marked = LABELS.filter((_, i) => (row[cols[i]!] ?? '').trim() !== '');
    if (marked.length === 1) out.push({ step: pairStep(k.pair), file: k.pair, label: marked[0]!, origin });
  }
  return out;
}

/** Reads a filled calibration form: a 0 to 5 score per question (against the tool's score) and a label per issue. */
export function readCalibrationForm(csv: string, key: CalibrationKey, origin: string): { scores: ScorePair[]; labels: FindingLabel[] } {
  const [head, ...rows] = parseCsv(csv);
  const out = { scores: [] as ScorePair[], labels: [] as FindingLabel[] };
  if (!head) return out;
  const col = (name: string) => head.findIndex((h) => h.trim().toLowerCase() === name);
  const idCol = col('id');
  const scoreCol = col('score');
  const cols = LABELS.map((l) => col(l));
  if (idCol < 0 || scoreCol < 0 || cols.some((c) => c < 0)) return out;
  const crit = new Map(key.criteria.map((c) => [c.id, c]));
  const finds = new Map(key.findings.map((f) => [f.id, f]));
  for (const row of rows) {
    const id = (row[idCol] ?? '').trim();
    const c = crit.get(id);
    const f = finds.get(id);
    if (c) {
      const raw = (row[scoreCol] ?? '').trim();
      const v = num(raw);
      if (v !== null && v >= 0 && v <= 5) out.scores.push({ step: pairStep(c.pair), file: c.pair, item: id, critical: false, gatex: c.toolScore, reference: v });
    } else if (f) {
      const marked = LABELS.filter((_, i) => (row[cols[i]!] ?? '').trim() !== '');
      if (marked.length === 1) out.labels.push({ step: pairStep(f.pair), file: f.pair, label: marked[0]!, origin });
    }
  }
  return out;
}

async function sheetFiles(dir: string, filter: (name: string) => boolean): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((n) => n.endsWith('.csv') && filter(n)).sort().map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/* ------------------------------ what people did in the app ------------------------------ */

async function fromStore(store: Store, includeMock: boolean): Promise<{ slice: AccuracySlice; reviews: number; note: string; saved: number }> {
  const slice = emptySlice();
  const reviews = await store.human.allReviews();
  const feedback = await store.human.allFeedback();
  const steps = await store.human.stepOfRuns();
  const details = new Map<string, Awaited<ReturnType<Store['getRunDetail']>> | null>();
  const detailOf = async (runId: string) => {
    if (!details.has(runId)) details.set(runId, await store.getRunDetail(runId).catch(() => null));
    return details.get(runId)!;
  };
  let used = 0;
  for (const review of reviews) {
    const d = await detailOf(review.runId);
    const report = d?.report;
    if (!d || d.status !== 'done' || !report || (!includeMock && [...report.header.raters, report.header.consolidator].some((m) => m.provider === 'mock'))) continue;
    used++;
    const step = stepLabel(steps.get(review.runId) ?? report.header.step);
    const file = report.header.artifactHash;
    const dims = report.dimensions.filter((x) => x.status === 'scored' && typeof x.consolidated === 'number');
    let criticalFail: boolean | undefined;
    for (const dim of dims) {
      const person = review.scores[dim.id];
      if (typeof person !== 'number') continue;
      slice.scores.push({ step, file, item: dim.id, critical: dim.critical, gatex: dim.consolidated as number, reference: person });
      if (dim.critical) criticalFail = (criticalFail ?? false) || person < 4;
    }
    const gatex: Decision = report.verdict.agentDecision ?? (report.verdict.weightedScore === null ? 'red' : bandOf(report.verdict.weightedScore));
    const derived = review.verdict === null ? verdictFromScores(dims.map((x) => ({ weight: x.weight, score: typeof review.scores[x.id] === 'number' ? review.scores[x.id]! : null }))) : null;
    const reference = review.verdict ?? derived;
    if (reference && report.verdict.weightedScore !== null) {
      slice.verdicts.push({ step, file, gatex, reference, ...(criticalFail === undefined ? {} : { criticalFail }), ...(review.verdict === null ? { derived: true } : {}) });
    }
  }
  for (const f of feedback) {
    const d = await detailOf(f.runId);
    const report = d?.report;
    if (!report || (!includeMock && [...report.header.raters, report.header.consolidator].some((m) => m.provider === 'mock'))) continue;
    slice.labels.push({ step: stepLabel(steps.get(f.runId) ?? report.header.step), file: report.header.artifactHash, label: FEEDBACK_AS_LABEL[f.label], origin: 'right / wrong marks on issues in the app' });
  }
  return { slice, reviews: used, saved: reviews.length + feedback.length, note: `${used} of ${reviews.length} review(s) are of real (not demo) checks` };
}

/* ------------------------------ all together ------------------------------ */

export interface LoadedAccuracy {
  input: AccuracyInput;
  sources: SourceNote[];
  reviews: number;
}

/** `includeMock` is for tests only: saved checks of demo models are otherwise never read, so no demo number can look like a real one. */
export async function loadAccuracyInput(dataDir: string, store?: Store, options: { includeMock?: boolean } = {}): Promise<LoadedAccuracy> {
  const includeMock = options.includeMock ?? false;
  const human = emptySlice();
  const aiStandin = emptySlice();
  const sources: SourceNote[] = [];
  let reviews = 0;

  /* people, in the app */
  if (store) {
    const s = await fromStore(store, includeMock);
    human.scores.push(...s.slice.scores);
    human.verdicts.push(...s.slice.verdicts);
    human.labels.push(...s.slice.labels);
    reviews = s.reviews;
    sources.push({
      id: 'app-reviews', kind: 'human', title: 'People’s marks and issue ticks saved in the app', count: s.slice.scores.length + s.slice.labels.length,
      note: s.saved === 0 ? 'None yet. Open any finished check and use "Compare with a person", or mark issues right or wrong.' : s.note,
    });
  }

  /* people, on paper: a sheet filled in by a teammate */
  const sheetDir = path.join(dataDir, 'review-sheet');
  const packDir = path.join(dataDir, 'calibration-pack');
  const spotKey = await readJson<SpotKey>(path.join(sheetDir, 'answer-key.json'));
  const calKey = await readJson<CalibrationKey>(path.join(packDir, 'answer-key.json'));
  let spotLabels = 0;
  let spotFiles = 0;
  if (spotKey) {
    for (const f of await sheetFiles(sheetDir, (n) => n === 'spot-check.csv' || /filled-human/i.test(n))) {
      const labels = readSpotSheet((await readText(f)) ?? '', spotKey, 'spot-check sheet');
      if (labels.length > 0) spotFiles++;
      spotLabels += labels.length;
      human.labels.push(...labels);
    }
  }
  sources.push({
    id: 'spot-check', kind: 'human', title: 'Spot-check sheet (a teammate labels 40 issues)', count: spotLabels,
    note: spotLabels === 0 ? `Blank so far: ${spotKey ? spotKey.rows.length : 0} issues are waiting for a person (data/review-sheet/spot-check.csv).` : `${spotLabels} labels from ${spotFiles} filled sheet(s).`,
  });
  let calScores = 0;
  let calLabels = 0;
  if (calKey) {
    for (const f of await sheetFiles(packDir, (n) => n === 'calibration-form.csv' || /filled-human/i.test(n))) {
      const r = readCalibrationForm((await readText(f)) ?? '', calKey, 'calibration form');
      calScores += r.scores.length;
      calLabels += r.labels.length;
      human.scores.push(...r.scores);
      human.labels.push(...r.labels);
    }
  }
  sources.push({
    id: 'calibration', kind: 'human', title: 'Calibration form (a person scores about 50 questions)', count: calScores + calLabels,
    note: calScores + calLabels === 0 ? `Blank so far: ${calKey ? calKey.criteria.length : 0} questions and ${calKey ? calKey.findings.length : 0} issues are waiting for a person (data/calibration-pack/calibration-form.csv).` : `${calScores} scores and ${calLabels} labels.`,
  });

  /* the saved checks */
  const runs = await scanReports(dataDir, includeMock);

  /* AI stand-in 1: the reference marks inside the Step 2 scorecard workbook */
  for (const ref of await loadReferenceSets(dataDir)) {
    const matching = runs.filter((r) => r.file === ref.file && r.criteria.length > 0 && r.score !== null && !r.twice);
    const newest = Math.max(0, ...matching.map((r) => promptNumber(r.promptVersion)));
    const current = matching.filter((r) => promptNumber(r.promptVersion) === newest);
    let pairs = 0;
    for (const run of current) {
      for (const c of run.criteria) {
        const reference = ref.marks.get(c.id);
        if (reference === undefined) continue;
        aiStandin.scores.push({ step: ref.step, file: ref.file, item: c.id, critical: c.critical, gatex: c.mark, reference });
        pairs++;
      }
      if (ref.score !== null) {
        aiStandin.verdicts.push({
          step: ref.step, file: ref.file, gatex: bandOf(run.score!), reference: bandOf(ref.score), derived: true,
          ...(ref.lowestGate === null ? {} : { criticalFail: ref.lowestGate < 4 }),
        });
      }
    }
    sources.push({
      id: `reference-${ref.id}`, kind: 'ai-standin', title: `Reference marks in the ${ref.step} scorecard workbook`, count: ref.marks.size,
      note: `${ref.marks.size} question marks and a total of ${ref.score ?? 'unknown'}, compared with ${current.length} check(s) by the newest build (${pairs} pairs). `
        + `The workbook itself says who made them: "${ref.provenance || 'not stated'}" So this is another AI reader, not a person. Its colour is worked out from its total with GateX's one colour rule.`,
    });
  }

  /* AI stand-in 2: our labels, and blind AI readers */
  const ours = await ourLabels(dataDir, includeMock);
  aiStandin.labels.push(...ours);
  sources.push({
    id: 'our-labels', kind: 'ai-standin', title: 'Our own issue labels', count: ours.length,
    note: 'Written by an AI agent after checking each issue against the file, newest labelled check of each test pair. Not a person.',
  });
  if (spotKey) {
    let n = 0;
    for (const f of await sheetFiles(sheetDir, (name) => /filled-agent/i.test(name))) {
      const origin = `blind AI reader (${path.basename(f, '.csv').replace('spot-check-filled-', '')})`;
      const labels = readSpotSheet((await readText(f)) ?? '', spotKey, origin);
      n += labels.length;
      aiStandin.labels.push(...labels);
    }
    sources.push({ id: 'blind-ai', kind: 'ai-standin', title: 'Blind AI readers on the spot-check sheet', count: n, note: 'The same 40 issues labelled by fresh AI agents that did not see our labels. Not a person.' });
  }

  const reruns = rerunGroups(runs);
  sources.push({
    id: 'reruns', kind: 'self', title: 'Re-runs of the same file', count: reruns.reduce((s, g) => s + g.verdicts.length, 0),
    note: `${reruns.length} set(s) of checks of one file by the newest prompt version and the same examiners on the same day (the nearest we have to "the same build"). Older prompt versions are left out. This needs no person.`,
  });
  return { input: { human, aiStandin, reruns }, sources, reviews };
}

export async function loadAccuracy(dataDir: string, store?: Store, options: { includeMock?: boolean } = {}): Promise<AccuracyReport> {
  const loaded = await loadAccuracyInput(dataDir, store, options);
  return computeAccuracy(loaded.input, loaded.sources, loaded.reviews);
}

/** A person's issue ticks as a review file the library tools read: { labels: [{ id, verdict, note }] } per run. */
export function feedbackAsReview(feedback: Array<{ findingId: string; label: keyof typeof FEEDBACK_AS_LABEL; note: string }>): { labels: Array<{ id: string; verdict: FindingLabelName; note: string }> } {
  return { labels: feedback.map((f) => ({ id: f.findingId, verdict: FEEDBACK_AS_LABEL[f.label], note: f.note })) };
}

export type { HumanReview, VerdictPair };
