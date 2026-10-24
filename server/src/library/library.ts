import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { CellRef, FamilyReliability, LibraryCaseDetail, LibraryCaseSummary, LibraryFinding, LibraryRunSummary, PlantedResult, ReliabilityTable, ReviewVerdict, Severity } from '@ddd/shared';
import { MIN_SOLO_SAMPLES, SOLO_DROP_BELOW } from '../agent/reliability.js';
import { UserError } from '../util/errors.js';

/**
 * The test library: real test pairs, each with the runs made on it and a reviewer's verdict on every finding, checked
 * against the real file. It is kept as plain files under the data folder so it needs no database:
 *
 *   data/library/<case>.json   the pair (title, file names) and its runs: { label, runDir, reviewFile }
 *   data/<runDir>/report.json  a finished run, as written by `npm run evaluate`
 *   data/<reviewFile>          the verdicts: { labels: [{ id, verdict, note }] }
 *
 * A run with no review file shows its findings as "unreviewed". A verdict is carried to a later run's finding at the same
 * cell and question, marked "inherited", so a re-run is not left blank; only a person's or a checker's own look makes a
 * verdict firm.
 */

const VERDICTS: ReviewVerdict[] = ['real', 'partly', 'wrong', 'vague', 'duplicate', 'unchecked', 'unreviewed'];

interface CaseFile {
  id: string;
  title: string;
  step: string;
  workbook: string;
  scorecard: string;
  notes?: string;
  runs: Array<{ label: string; runDir: string; reviewFile?: string }>;
}

interface ReportFinding {
  id: string;
  severity: Severity;
  dimensionId: string;
  title: string;
  location: CellRef | null;
  reportedBy?: string[];
}

interface ReportFile {
  header: { promptVersion: string; finishedAt: string; raters?: Array<{ model: string; id?: string; family?: string }>; consolidator?: { model: string } };
  verdict: { weightedScore: number | null; decision: string };
  dimensions: Array<{ id: string; status: string }>;
  findings: ReportFinding[];
}

interface ReviewFile {
  labels: Array<{ id: string; verdict: ReviewVerdict; note: string }>;
}

const safeId = (id: string) => /^[\w.-]+$/.test(id);

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

const emptyCounts = (): Record<ReviewVerdict, number> => Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<ReviewVerdict, number>;
const spot = (f: Pick<ReportFinding, 'dimensionId' | 'location'>) => `${f.dimensionId}|${f.location?.sheet ?? ''}|${f.location?.cell ?? ''}`;

interface LoadedRun {
  summary: LibraryRunSummary;
  findings: LibraryFinding[];
}

async function loadRun(dataDir: string, run: CaseFile['runs'][number], earlier: LibraryFinding[]): Promise<LoadedRun | null> {
  const report = await readJson<ReportFile>(path.join(dataDir, run.runDir, 'report.json'));
  if (!report) return null;
  const review = run.reviewFile ? await readJson<ReviewFile>(path.join(dataDir, run.reviewFile)) : null;
  const own = new Map((review?.labels ?? []).map((l) => [l.id, l]));
  const carried = new Map(earlier.filter((f) => f.verdict !== 'unreviewed').map((f) => [spot(f), f]));
  const counts = emptyCounts();
  const findings: LibraryFinding[] = report.findings.map((f) => {
    const mine = own.get(f.id);
    const before = !mine ? carried.get(spot(f)) : undefined;
    const verdict: ReviewVerdict = mine?.verdict ?? before?.verdict ?? 'unreviewed';
    counts[verdict] += 1;
    return {
      id: f.id,
      severity: f.severity,
      dimensionId: f.dimensionId,
      title: f.title,
      location: f.location,
      reportedBy: f.reportedBy ?? [],
      verdict,
      note: mine?.note ?? (before ? `Same cell and question as an earlier finding: ${before.note}` : ''),
      inherited: !mine && Boolean(before),
    };
  });
  const reviewed = findings.length - counts.unreviewed - counts.unchecked;
  const usable = counts.real + counts.partly;
  return {
    findings,
    summary: {
      label: run.label,
      runDir: run.runDir,
      promptVersion: report.header.promptVersion,
      finishedAt: report.header.finishedAt,
      weightedScore: report.verdict.weightedScore,
      decision: report.verdict.decision,
      findings: findings.length,
      counts,
      usableShare: reviewed > 0 ? usable / reviewed : null,
      unscored: report.dimensions.filter((d) => d.status !== 'scored').map((d) => d.id),
      models: [...(report.header.raters ?? []).map((r) => r.model), ...(report.header.consolidator ? [report.header.consolidator.model] : [])],
    },
  };
}

async function loadCase(dataDir: string, file: CaseFile): Promise<{ summary: LibraryCaseSummary; latest: LibraryFinding[] }> {
  const runs: LibraryRunSummary[] = [];
  let latest: LibraryFinding[] = [];
  let earlier: LibraryFinding[] = [];
  for (const run of file.runs) {
    const loaded = await loadRun(dataDir, run, earlier);
    if (!loaded) continue; // a run folder that was removed is simply not shown
    runs.push(loaded.summary);
    latest = loaded.findings;
    earlier = loaded.findings;
  }
  return {
    latest,
    summary: { id: file.id, title: file.title, step: file.step, workbook: file.workbook, scorecard: file.scorecard, notes: file.notes ?? '', runs },
  };
}

export async function listLibrary(dataDir: string): Promise<LibraryCaseSummary[]> {
  const dir = path.join(dataDir, 'library');
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const out: LibraryCaseSummary[] = [];
  for (const name of names) {
    const file = await readJson<CaseFile>(path.join(dir, name));
    if (file?.id && Array.isArray(file.runs)) out.push((await loadCase(dataDir, file)).summary);
  }
  return out;
}

export async function readLibraryCase(dataDir: string, id: string): Promise<LibraryCaseDetail> {
  if (!safeId(id)) throw new UserError('That test case does not exist.', 404);
  const file = await readJson<CaseFile>(path.join(dataDir, 'library', `${id}.json`));
  if (!file?.id || !Array.isArray(file.runs)) throw new UserError('That test case does not exist.', 404);
  const loaded = await loadCase(dataDir, file);
  return { ...loaded.summary, findingsOfLatest: loaded.latest };
}


/* ----------------------- how reliable each examiner is ----------------------- */

const RELIABILITY_FILE = ['library', 'reliability.json'];

/**
 * Counts, per model family, how often its findings were right once a reviewer checked them against the real file. Only a run's
 * own verdicts count (not ones carried over from an earlier run), and findings nobody checked or could not settle are left out.
 */
export async function measureReliability(dataDir: string, now = new Date()): Promise<ReliabilityTable> {
  const families: Record<string, FamilyReliability> = {};
  const tally = (family: string): FamilyReliability => (families[family] ??= { solo: { n: 0, useful: 0 }, any: { n: 0, useful: 0 } });
  let names: string[] = [];
  try {
    names = (await readdir(path.join(dataDir, 'library'))).filter((n) => n.endsWith('.json') && n !== RELIABILITY_FILE[1]).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    const file = await readJson<CaseFile>(path.join(dataDir, 'library', name));
    for (const run of file?.runs ?? []) {
      if (!run.reviewFile) continue;
      const report = await readJson<ReportFile>(path.join(dataDir, run.runDir, 'report.json'));
      const review = await readJson<ReviewFile>(path.join(dataDir, run.reviewFile));
      if (!report || !review) continue;
      const familyOf = new Map((report.header.raters ?? []).flatMap((r) => (r.id && r.family ? [[r.id, r.family] as const] : [])));
      const verdicts = new Map(review.labels.map((l) => [l.id, l.verdict]));
      for (const f of report.findings as Array<ReportFinding & { source?: string }>) {
        const verdict = verdicts.get(f.id);
        if (!verdict || verdict === 'unchecked' || verdict === 'unreviewed' || f.source === 'code') continue;
        const useful = verdict === 'real' || verdict === 'partly' ? 1 : 0;
        const by = [...new Set(f.reportedBy ?? [])];
        for (const id of by) {
          const family = familyOf.get(id);
          if (!family) continue;
          tally(family).any.n += 1;
          tally(family).any.useful += useful;
          if (by.length === 1) {
            tally(family).solo.n += 1;
            tally(family).solo.useful += useful;
          }
        }
      }
    }
  }
  return { computedAt: now.toISOString(), thresholds: { minSamples: MIN_SOLO_SAMPLES, dropBelow: SOLO_DROP_BELOW }, families };
}

/** The saved table, or undefined when none has been measured yet (then nothing is filtered by examiner). */
export async function loadReliability(dataDir: string): Promise<ReliabilityTable | undefined> {
  return (await readJson<ReliabilityTable>(path.join(dataDir, ...RELIABILITY_FILE))) ?? undefined;
}


/* --------------------------- planted-defect test results --------------------------- */

/** Every saved planted-defect result (data/planted/<label>/result.json), newest first. */
export async function listPlanted(dataDir: string): Promise<PlantedResult[]> {
  const dir = path.join(dataDir, 'planted');
  let labels: string[] = [];
  try {
    labels = await readdir(dir);
  } catch {
    return [];
  }
  const out: PlantedResult[] = [];
  for (const label of labels) {
    const result = await readJson<PlantedResult>(path.join(dir, label, 'result.json'));
    if (result?.label && Array.isArray(result.defects)) out.push(result);
  }
  return out.sort((a, b) => b.runAt.localeCompare(a.runAt));
}
