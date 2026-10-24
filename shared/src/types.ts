/**
 * Shared contract between the evaluator (server) and the dashboard (web).
 * Everything here mirrors the Level 1 pages of the Agentic Roadmap PDF:
 * 3 raters + 1 consolidator, 0-5 scores with evidence, green/amber/red verdict,
 * and the fixed eight-section evaluation report.
 */

export type Decision = 'green' | 'amber' | 'red';
export type Severity = 'HIGH' | 'MEDIUM' | 'LOW';
export type MeasuredBy = 'code' | 'raters' | 'human';
export type Gate = 'D1' | 'D3';
export type ReturnTo = 'Discover' | 'Define' | 'Generate' | 'Analyse' | 'Validate' | 'Refine';
export type Confidence = 'steady' | 'shaky' | 'single';
export type DimensionStatus = 'scored' | 'unscored' | 'not_measurable';
export type RunStatus = 'queued' | 'running' | 'done' | 'failed';
export type RunStage =
  | 'queued'
  | 'reading'
  | 'checks'
  | 'rating'
  | 'consolidating'
  | 'reporting'
  | 'done'
  | 'failed';
export type Resolution =
  | 'agreement'
  | 'claims_checked'
  | 'lower_stands'
  | 'single_rater'
  | 'code'
  | 'none';
export type ParticipantStatus = 'waiting' | 'running' | 'ok' | 'failed';

export const SEVERITY_ORDER: Record<Severity, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

/* ----------------------------- scorecard ----------------------------- */

export interface Band {
  /** Minimum pass ratio (0-1) for this band. */
  min: number;
  score: number;
}

export interface CheckSpec {
  id: string;
  params: Record<string, unknown>;
  bands: Band[];
  fix?: string;
}

export interface SheetSpec {
  name: string;
  headerRow: number;
  /** Raters see only these columns (by header title). Code checks still read the whole sheet. */
  columns?: string[];
  /** Raters see only these rows (plus the header row): the rows of the file most related to a question, chosen by code. */
  rows?: number[];
}

/**
 * One criterion of a dimension. A dimension with criteria is scored criterion by criterion (judged ones by the examiners,
 * counted ones exactly by code) and code combines them with the scorecard's `aggregate` rule.
 */
export interface CriterionSpec {
  id: string;
  name: string;
  kind: 'judged' | 'counted';
  measure?: string;
  /** Judged criteria: what each score 0-5 means. Falls back to the dimension's anchors, then the standard scale. */
  anchors?: Record<number, string>;
  /** Counted criteria: the exact count and how its ratio maps to 0-5. */
  check?: CheckSpec;
  /** Share of the dimension under the `weighted` rule (default 1). */
  weight?: number;
  /** The scorecard says this needs evidence from outside the file (an interview, a second run). Only such a criterion triggers the "nothing in the file" cap. */
  outside?: boolean;
}

/** How a dimension's criteria combine into its 0-5 score. Mirrors the rules a scorecard such as GS-1 states. */
export interface AggregateRule {
  /** mean_floor: the mean rounded down (GS-1). mean: the plain mean. weighted: the mean weighted by criterion weight. */
  rule: 'mean_floor' | 'mean' | 'weighted';
  /** Any criterion scored 0 caps the dimension at this score (GS-1: 2). */
  zeroCapsAt?: number;
  /** Any criterion the file holds nothing for caps the dimension at this score, and it is left out of the mean (GS-1: 3). */
  unmeasuredCapsAt?: number;
}

export interface DimensionSpec {
  id: string;
  name: string;
  weight: number;
  critical: boolean;
  measuredBy: MeasuredBy;
  description?: string;
  measure?: string;
  /** Rater dimensions: anchor text for each score 0-5. */
  anchors?: Record<number, string>;
  /** Code dimensions: the deterministic check and how its ratio maps to 0-5. */
  check?: CheckSpec;
  /** Legacy: what a person had to supply. Such questions are now scored by the examiners from what the file shows. */
  needs?: string;
  returnTo?: ReturnTo;
  /**
   * Optional. Sheet names (matching artifact.sheets or artifact.context) that this
   * rater dimension actually needs to read. When set, only those sheets are included
   * in the prompt for this dimension's section — keeping token counts small.
   * When absent, the dimension sees the full workbook (backward-compatible default).
   */
  reads?: string[];
  /** Scored criterion by criterion when present; the dimension's score is then combined by code. */
  criteria?: CriterionSpec[];
  /** Set by the agent on the working copy of a criterion: the dimension it belongs to. Never in a scorecard file. */
  criterionOf?: { id: string; name: string };
}

export interface Scorecard {
  id: string;
  name: string;
  version: string;
  gate: Gate;
  step?: string;
  /** Always true once the app has read it: the scorecard is frozen by its hash when the work is submitted. */
  frozen: boolean;
  /** Where the scorecard came from (for example "Converted automatically from GS1.xlsx"). Shown in the report header. */
  approval?: string;
  thresholds: { accept: number; refine: number };
  /** Optional: a critical dimension scoring at or below this forces RED, whatever the total. */
  redAtOrBelow?: number;
  /** What to do with a question the examiners find nothing in the file to measure: leave it out of the score (default), or count it as 0. */
  unmeasured?: 'skip' | 'zero';
  artifact: { sheets: SheetSpec[]; context: SheetSpec[] };
  dimensions: DimensionSpec[];
  /** How criteria combine into a dimension score. Default: the plain mean, no caps. */
  aggregate?: AggregateRule;
}

/* ------------------------------ models ------------------------------- */

export interface ModelRef {
  id: string;
  provider: string;
  model: string;
  family: string;
}

/* ------------------------------ report ------------------------------- */

export interface CellRef {
  sheet: string;
  cell: string;
}

export interface Evidence extends CellRef {
  quote?: string;
}

export interface ReportHeader {
  runId: string;
  projectName: string;
  iteration: number;
  step?: string;
  gate: Gate;
  artifactName: string;
  artifactHash: string;
  scorecardId: string;
  scorecardName: string;
  scorecardVersion: string;
  scorecardHash: string;
  scorecardApproval?: string;
  raters: ModelRef[];
  consolidator: ModelRef;
  promptVersion: string;
  /** Extra instructions typed by the person who submitted the work, and their hash. */
  instructions?: string;
  instructionsHash?: string;
  startedAt: string;
  finishedAt: string;
}

/** The result of one criterion of a dimension. */
export interface CriterionResult {
  id: string;
  name: string;
  kind: 'judged' | 'counted';
  status: DimensionStatus;
  raterScores: Record<string, number | null>;
  consolidated: number | null;
  spread: number | null;
  resolution: Resolution;
  flagged: boolean;
  confidence?: Confidence;
  rationale: string;
  evidence: Evidence[];
  codeDetail?: { passed: number; total: number; summary: string };
  /** Carried from the criterion's spec. */
  outside?: boolean;
}

export interface DimensionResult {
  id: string;
  name: string;
  weight: number;
  critical: boolean;
  measuredBy: MeasuredBy;
  status: DimensionStatus;
  /** Valid, evidence-backed score from each rater; null = abstained or discarded. */
  raterScores: Record<string, number | null>;
  consolidated: number | null;
  spread: number | null;
  resolution: Resolution;
  flagged: boolean;
  /** How far to trust a judged score: steady (examiners and repeat runs agree), shaky (they differ), single (only one examiner could score it). */
  confidence?: Confidence;
  rationale: string;
  evidence: Evidence[];
  /** Code dimensions only. */
  codeDetail?: { passed: number; total: number; summary: string };
  error?: string;
  /** Per-criterion results when the dimension is scored criterion by criterion; `consolidated` is then their combination. */
  criteria?: CriterionResult[];
}

export interface Finding {
  id: string;
  severity: Severity;
  dimensionId: string;
  location: CellRef | null;
  title: string;
  detail: string;
  fix: string;
  returnTo: ReturnTo;
  source: 'code' | 'raters';
  reportedBy: string[];
}

/** An examiner finding the fact check removed because the file plainly contradicts it. Kept, with the reason, for the record. */
export interface DroppedFinding {
  dimensionId: string;
  severity: Severity;
  title: string;
  location: CellRef | null;
  reportedBy: string[];
  reason: string;
}

export interface Strength {
  dimensionId: string;
  text: string;
  location: CellRef | null;
}

export interface AgreementRow {
  dimensionId: string;
  name: string;
  scores: Record<string, number | null>;
  spread: number | null;
  resolution: Resolution;
  flagged: boolean;
  note: string;
}

export interface Override {
  id: string;
  runId: string;
  decision: Decision;
  reason: string;
  by: string;
  createdAt: string;
}

export interface CriticalGate {
  dimensionId: string;
  name: string;
  score: number | null;
  status: 'passed' | 'failed' | 'skipped';
}

export interface VerdictSection {
  weightedScore: number;
  decision: Decision;
  agentDecision: Decision;
  thresholds: { accept: number; refine: number };
  criticalGates: CriticalGate[];
  /** Ids of HIGH-risk findings. Until they are fixed the verdict cannot be green (PDF p.11). */
  blockingFindings: string[];
  /** Ids of questions left out of the score because the examiners found nothing in the file to measure them. */
  skipped: string[];
  reasons: string[];
  override: Override | null;
}

export interface NotMeasurableItem {
  dimensionId: string;
  name: string;
  critical: boolean;
  weight: number;
  /** Why it has no score. */
  reason: string;
  /** How it was treated: left out of the score, or counted as 0. */
  treatment: 'skipped' | 'zero';
}

export interface PathStep {
  order: number;
  dimensionId: string;
  name: string;
  from: number;
  to: number;
  scoreGain: number;
  reason: 'critical gate' | 'score';
  findingIds: string[];
}

export interface PathToGreen {
  steps: PathStep[];
  /** HIGH-risk findings that must be fixed before resubmission. */
  blockingFindingIds: string[];
  resultingScore: number;
  resultingDecision: Decision;
  note: string;
}

/** The immutable result of one evaluation. Verdict-related sections are derived from it. */
/** "Run twice" mode: two full evaluations with the same examiners. The report shows their average. */
export interface TwoRuns {
  /** Score of each run, one decimal. */
  scores: [number, number];
  /** Colour of each run, by score alone. */
  decisions: [Decision, Decision];
  /** The mean of the two scores. The verdict colour comes from this. */
  average: number;
  /** Difference between the two scores. */
  gap: number;
  /** The gap is 8 points or more, or the two runs landed on different colours. */
  unstable: boolean;
}

/** A gap of this many points or more between two runs means the result is a range, not a number. */
export const UNSTABLE_GAP = 8;

export interface EvaluationCore {
  header: ReportHeader;
  scorecard: Scorecard;
  dimensions: DimensionResult[];
  findings: Finding[];
  strengths: Strength[];
  consolidatorFailed: boolean;
  notes: string[];
  /** Examiner findings the fact check dropped (absent in runs made before it existed). */
  droppedFindings?: DroppedFinding[];
  /** Present only when the check was run twice. */
  twoRuns?: TwoRuns;
}

/** The eight-section report (PDF page 11), assembled from the core (and an optional override). */
export interface Report {
  header: ReportHeader;
  verdict: VerdictSection;
  dimensions: DimensionResult[];
  strengths: Strength[];
  findings: Finding[];
  agreement: AgreementRow[];
  notMeasurable: NotMeasurableItem[];
  pathToGreen: PathToGreen;
  notes: string[];
  /** Examiner findings the fact check dropped, with the reason. */
  droppedFindings?: DroppedFinding[];
  /** Present only when the check was run twice: both scores, the average (which sets the colour) and the gap. */
  twoRuns?: TwoRuns;
}

/* -------------------------------- API -------------------------------- */

export interface ParticipantProgress {
  /** The participant's id (A, B, C, K). The provider and model shown are whichever is answering now. */
  id: string;
  role: 'rater' | 'consolidator';
  provider: string;
  model: string;
  family: string;
  status: ParticipantStatus;
  error?: string;
  latencyMs?: number;
}

export interface RunProgress {
  participants: ParticipantProgress[];
}

export interface RunSummary {
  id: string;
  projectId: string;
  projectName: string;
  iteration: number;
  status: RunStatus;
  stage: RunStage;
  gate: Gate | null;
  scorecardId: string | null;
  artifactName: string | null;
  weightedScore: number | null;
  agentDecision: Decision | null;
  finalDecision: Decision | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface RunDetail extends RunSummary {
  progress: RunProgress | null;
  error: string | null;
  report: Report | null;
  runLog: RunLog | null;
}

export interface RunLog {
  appVersion: string;
  nodeVersion: string;
  promptVersion: string;
  promptHashes: Record<string, string>;
  settings: { temperature: number; maxOutputTokens: number };
  models: ModelRef[];
  artifactHash: string;
  scorecardHash: string;
  timings: { totalMs: number; checksMs: number; ratingMs: number; consolidationMs: number };
  /** How repeats were spent: adaptive runs repeat only disputed questions. Absent when nothing went to the raters. */
  repeats?: { mode: 'all' | 'adaptive'; repeats: number; planned: number; made: number; saved: number; repeated: string[] };
  /** The second check that reads each examiner finding against the file. Absent when it was off or nothing was left to check. */
  verification?: {
    /** The model that answered. */
    model?: string;
    checked: number;
    skipped: number;
    calls: number;
    failed: number;
    dropped: number;
    /** What the first look said about the checked findings, how many "false" answers code proved, and how many the second reading confirmed. */
    said?: { true: number; false: number; unsure: number; falseProven: number; confirmed: number };
    /** The models that gave the second reading, when any finding needed one. */
    confirmModel?: string;
    inputTokens: number;
    outputTokens: number;
    /** Each finding set aside, with the cell and words that showed the claim is wrong. */
    droppedFindings: Array<{ title: string; dimensionId: string; reason: string }>;
  };
  participants: Array<{
    id: string;
    role: 'rater' | 'consolidator';
    status: ParticipantStatus;
    attempts: number;
    latencyMs: number;
    inputTokens: number | null;
    outputTokens: number | null;
    discarded: number;
    error?: string;
  }>;
}

export interface ProjectSummary {
  id: string;
  name: string;
  step: string | null;
  runCount: number;
  latest: RunSummary | null;
  scores: Array<number | null>;
}

export interface TrendPoint {
  runId: string;
  iteration: number;
  score: number | null;
  decision: Decision | null;
  createdAt: string;
}

export interface FindingDiff {
  runId: string;
  iteration: number;
  fixed: number;
  stillOpen: number;
  added: number;
}

export interface DimensionTrendRow {
  dimensionId: string;
  name: string;
  critical: boolean;
  scores: Array<number | null>;
}

export interface ProjectHistory {
  project: { id: string; name: string; step: string | null };
  runs: RunSummary[];
  trend: TrendPoint[];
  dimensions: DimensionTrendRow[];
  findingDiffs: FindingDiff[];
  thresholds: { accept: number; refine: number } | null;
}

export interface RosterProblem {
  level: 'error' | 'warning';
  message: string;
}

export interface FallbackStatus {
  provider: string;
  model: string;
  keyPresent: boolean;
  approved: boolean;
}

export interface ConfigResponse {
  mock: boolean;
  raters: Array<ModelRef & { keyPresent: boolean; approved: boolean; fallbacks: FallbackStatus[] }>;
  consolidator: ModelRef & { keyPresent: boolean; approved: boolean; fallbacks: FallbackStatus[] };
  problems: RosterProblem[];
  ready: boolean;
  promptVersion: string;
  thresholds: { accept: number; refine: number };
}

/* ----------------------------- test library ----------------------------- */

/** What a reviewer found when checking one finding against the real file. */
export type ReviewVerdict = 'real' | 'partly' | 'wrong' | 'vague' | 'duplicate' | 'unchecked' | 'unreviewed';

export interface LibraryRunSummary {
  label: string;
  runDir: string;
  promptVersion: string;
  finishedAt: string;
  weightedScore: number | null;
  decision: string;
  findings: number;
  /** Findings per verdict; "unreviewed" are findings nobody has checked against the file yet. */
  counts: Record<ReviewVerdict, number>;
  /** Share of the reviewed findings that are real or partly right, null when none are reviewed. */
  usableShare: number | null;
  unscored: string[];
  models: string[];
}

export interface LibraryFinding {
  id: string;
  severity: Severity;
  dimensionId: string;
  title: string;
  location: CellRef | null;
  reportedBy: string[];
  verdict: ReviewVerdict;
  note: string;
  /** True when the verdict was carried over from an earlier run's finding at the same cell and question. */
  inherited: boolean;
}

export interface LibraryCaseSummary {
  id: string;
  title: string;
  step: string;
  workbook: string;
  scorecard: string;
  notes: string;
  runs: LibraryRunSummary[];
}

export interface LibraryCaseDetail extends LibraryCaseSummary {
  /** The findings of the newest run, each with its verdict. */
  findingsOfLatest: LibraryFinding[];
}

/* ------------------------- how reliable each examiner is ------------------------- */

export interface ReliabilityTally {
  /** Findings that were checked against the real file. */
  n: number;
  /** Of those, how many were real or partly right. */
  useful: number;
}

export interface FamilyReliability {
  /** Findings this model family reported alone. */
  solo: ReliabilityTally;
  /** Findings it reported at all, alone or with others. */
  any: ReliabilityTally;
}

/**
 * Measured from the test library: for every model family, how often its findings were right once checked against the real file.
 * A finding only one examiner raised is set aside when that family's lone findings are rarely right (see agent/reliability.ts).
 */
export interface ReliabilityTable {
  computedAt: string;
  thresholds: { minSamples: number; dropBelow: number };
  /** Keyed by model family (for example "meta"), not by model name, so a fallback model counts as the same examiner. */
  families: Record<string, FamilyReliability>;
}

/* ------------------------------- planted-defect tests ------------------------------- */

export interface PlantedDefectResult {
  id: string;
  kind: string;
  cell: string;
  description: string;
  /** Caught by a finding in the report. */
  caught: boolean;
  /** Caught by any finding, including one the app set aside. */
  caughtRaw: boolean;
  examiners: string[];
}

/** One run of the planted-defect test: a good file broken in known ways, run through the app, and scored against what was planted. */
export interface PlantedResult {
  label: string;
  runAt: string;
  workbook: string;
  scorecard: string;
  seed: number;
  models: Array<{ id: string; family: string; model: string }>;
  planted: number;
  caught: number;
  caughtRaw: number;
  /** Found by an AI examiner (in the report or set aside later): what the models alone find. */
  caughtByExaminers: number;
  /** Found by an exact check in code (the row-by-row sweep). */
  caughtByCode: number;
  /** Findings in the report that point at no planted defect: real old problems, or false alarms. */
  otherInReport: number;
  perExaminer: Record<string, { family: string; model: string; caught: number; otherFindings: number }>;
  weightedScore: number | null;
  decision: string;
  defects: PlantedDefectResult[];
  skipped: string[];
}


/* ------------------------------- score colours ------------------------------- */

/**
 * The one rule for colour, used everywhere (report, dashboard, history, docs): below 60 is red, 60 to 74 is amber, 75 and above is light green.
 * No scorecard can change it.
 */
export const SCORE_BANDS = { accept: 75, refine: 60 } as const;

export function bandOf(score: number): Decision {
  return score < SCORE_BANDS.refine ? 'red' : score < SCORE_BANDS.accept ? 'amber' : 'green';
}
