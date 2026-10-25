import { bandOf, examinerLabel, issueNumbers, presentReport, severityLabel, tierFor, type Decision, type Report, type Severity } from '@ddd/shared';
import { costCell, costSentence } from './cost.js';

/**
 * One plain-language view of a report, shared by the PDF, Markdown and Excel downloads so they say the same things in the same words.
 * It starts from presentReport (names instead of codes, "Examiner 1/2/3" instead of model names) and then scrubs any code that is still
 * inside free text a person or a model wrote.
 */

export const HEADLINE: Record<Decision, string> = { green: 'Looks good', amber: 'Almost there', red: 'Not there yet' };
export const BAND_WORD: Record<Decision, string> = { green: 'GREEN', amber: 'AMBER', red: 'RED' };

export interface ViewArea { name: string; score: number | null; critical: boolean; passed: boolean | null; band: Decision | null; status: string }
export interface ViewIssue { tier: 'confirmed' | 'worth_a_look'; why: string; label: string; number: number; severity: Severity; severityWord: string; area: string; where: string; title: string; detail: string; fix: string }
export interface ViewExaminerRow { area: string; scores: Array<{ label: string; score: number | null }>; note: string; disagreed: boolean }
export interface ViewStep { order: number; area: string; from: number; to: number; gain: number; fixes: string[] }
export interface ViewStrength { area: string; text: string; where: string }
export interface ViewLeftOut { name: string; critical: boolean; reason: string; treatment: string }

export interface ReportView {
  report: Report;
  fileName: string;
  scorecard: string;
  checkNumber: number;
  finished: string;
  finishedLong: string;
  decision: Decision;
  score: number;
  headline: string;
  subline: string;
  thresholds: { accept: number; refine: number };
  meaning: string[];
  areas: ViewArea[];
  /** The Confirmed findings: the headline, the counts and the path to green use these only. */
  issues: ViewIssue[];
  /** Single-examiner judgement calls that passed the filters, shown apart from the issues. */
  lookIssues: ViewIssue[];
  /** One plain sentence that tells a reader what the "Worth a look" list is. */
  lookNote: string;
  /** The run's tokens (and price, when the price table has one), in plain words. Absent when the run recorded no usage. */
  cost?: { sentence: string; hasPrices: boolean; lines: Array<{ label: string; calls: number; tokensIn: number; tokensOut: number; price: string }> };
  bySeverity: Record<Severity, ViewIssue[]>;
  issuesByArea: Array<{ area: string; count: number }>;
  keyChecks: { passed: number; total: number };
  areasAtFour: { count: number; of: number };
  examiners: string[];
  examinerRows: ViewExaminerRow[];
  path: { steps: ViewStep[]; resultingScore: number; resultingDecision: Decision; note: string };
  strengths: ViewStrength[];
  leftOut: ViewLeftOut[];
  examinerCount: number;
  /** Present when the check was run twice: a one-line summary for the report headers. */
  twoRuns?: { line: string; unstable: boolean; first: number; second: number; average: number; gap: number };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function formatDate(iso: string, withTime = false): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return withTime ? `${date}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC` : date;
}

/** What the "Worth a look" list is, in the words every report uses. */
export const LOOK_NOTE =
  'These came from one examiner only and the computer check could not prove them. They are judgement calls: some are useful, but more of them are wrong or too vague to act on. They do not change the score, the colour, the counts above or the path to green.';
export const LOOK_TITLE = 'Worth a look';

const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** Plain wording for the sentences the verdict code writes. Anything it does not recognise is kept as it is. */
export function plainReason(text: string): string {
  let m: RegExpExecArray | null;
  if ((m = /^Score ([\d.]+) is in the (green|amber|red) band/.exec(text))) {
    const band = m[2]!;
    return `The score is ${m[1]} out of 100, which is in the ${band} range.`;
  }
  if ((m = /^Needs attention: critical question (.+) scored ([\d.]+), below (\d+)\.$/.exec(text))) return `A key check, "${m[1]}", scored ${m[2]} out of 5. It needs at least ${m[3]}.`;
  if ((m = /^Needs attention: (\d+) high-risk findings? \(.*?\) should be fixed before sign-off\.$/.exec(text))) {
    return `${m[1]} must-fix issue${m[1] === '1' ? '' : 's'} should be fixed before this work is signed off.`;
  }
  if ((m = /^Needs attention: only (\d+)% of the scorecard could be scored/.exec(text))) return `Only ${m[1]}% of the scorecard could be scored, so this score rests on little.`;
  if ((m = /^Needs attention: only one examiner could back the score, or the examiners could not agree, on (.+)\. Run it again to firm it up\.$/.exec(text))) {
    return `For ${m[1]}, only one examiner could back the score or the examiners could not agree. Run the check again to firm it up.`;
  }
  if ((m = /^Needs attention: examiners? .* failed and (?:was|were) left out, so this score rests on (\d+) of (\d+) examiners\./.exec(text))) {
    return `Some examiners could not finish, so this score rests on ${m[1]} of ${m[2]} examiners. Run the check again before relying on it.`;
  }
  if ((m = /^The file holds nothing to measure these, so they count as 0: (.+)\.$/.exec(text))) return `The file has nothing to measure ${m[1]}, so ${/,/.test(m[1]!) ? 'they count' : 'it counts'} as 0.`;
  if ((m = /^The file holds nothing to measure these, so they are left out of the score: (.+)\.$/.exec(text))) return `The file has nothing to measure ${m[1]}, so ${/,/.test(m[1]!) ? 'they are' : 'it is'} left out of the score.`;
  if ((m = /^A person overrode the verdict to (\w+): (.*)$/.exec(text))) return `A reviewer changed the colour to ${m[1]!.toUpperCase()}: ${m[2]}`;
  return text;
}

const RESOLUTION_NOTE: Record<string, string> = {
  agreement: 'The examiners agreed.',
  claims_checked: 'The examiners differed, so the final reviewer settled it from the file.',
  lower_stands: 'The examiners differed and the file could not settle it, so the lower score was used.',
  single_rater: 'Only one examiner could back this score.',
  code: 'Measured by a computer check.',
  none: '',
};

export function buildView(source: Report): ReportView {
  const report = presentReport(source);
  const issues = issueNumbers(source);
  const areaName = new Map(source.dimensions.map((d) => [d.id, report.dimensions.find((x) => x.id === d.id)!.name] as const));
  const issueLower = (id: string) => (issues.get(id) ?? '').replace(/^Issue/, 'issue');

  /** Removes anything that still looks like a code, a model or a provider from free text. */
  const scrub = (text: string): string =>
    String(text ?? '')
      .replace(/\b([A-Z]\d{2})-C\d{2}\b/g, (_m, g: string) => areaName.get(g) ?? 'this area')
      .replace(/\b([A-Z]\d{2})\b/g, (m, g: string) => areaName.get(g) ?? (/^G/.test(m) ? 'this area' : m))
      .replace(/\bF-\d+\b/g, (m) => issueLower(m) || 'an issue')
      .replace(/\b(?:bedrock|groq|gemini|mock)(?:\/[\w.:-]+|-[\w.-]+)?/gi, 'an AI model')
      .replace(/\bhigh-risk findings\b/gi, 'must-fix issues')
      .replace(/\bhigh-risk finding\b/gi, 'must-fix issue')
      .replace(/\s+/g, ' ')
      .trim();

  const decision = report.verdict.decision;
  const areas: ViewArea[] = report.dimensions.map((d) => ({
    name: d.name,
    score: d.consolidated,
    critical: d.critical,
    passed: d.consolidated === null ? null : d.consolidated >= 4,
    band: d.consolidated === null ? null : bandOf(d.consolidated * 20),
    status: d.status,
  }));

  const toIssue = (f: Report['findings'][number], n: number): ViewIssue => ({
    tier: tierFor(f),
    why: f.tierReason ?? '',
    label: issues.get(f.id) ?? `Issue ${n}`,
    number: n,
    severity: f.severity,
    severityWord: severityLabel(f.severity),
    area: areaName.get(f.dimensionId) ?? 'General',
    where: f.location ? `Sheet "${f.location.sheet}", cell ${f.location.cell}` : '',
    title: scrub(f.title),
    detail: scrub(f.detail),
    fix: scrub(f.fix),
  });
  const confirmedFindings = report.findings.filter((f) => tierFor(f) === 'confirmed');
  const lookFindings = report.findings.filter((f) => tierFor(f) !== 'confirmed');
  const list: ViewIssue[] = confirmedFindings.map((f, i) => toIssue(f, i + 1));
  const lookIssues: ViewIssue[] = lookFindings.map((f, i) => toIssue(f, i + 1));
  const bySeverity: Record<Severity, ViewIssue[]> = { HIGH: [], MEDIUM: [], LOW: [] };
  for (const i of list) bySeverity[i.severity].push(i);

  const counts = new Map<string, number>();
  for (const i of list) counts.set(i.area, (counts.get(i.area) ?? 0) + 1);
  const issuesByArea = [...counts].map(([area, count]) => ({ area, count })).sort((a, b) => b.count - a.count || a.area.localeCompare(b.area));

  const gates = report.verdict.criticalGates.filter((g) => g.status !== 'skipped');
  const scored = areas.filter((a) => a.score !== null);

  const meaning = report.verdict.reasons.map((r) => scrub(plainReason(r)));

  const nHigh = bySeverity.HIGH.length;
  const subline =
    decision === 'green'
      ? nHigh > 0
        ? `The score is in the green range, but ${nHigh} must-fix issue${nHigh === 1 ? '' : 's'} still ${nHigh === 1 ? 'needs' : 'need'} attention before sign-off.`
        : 'Nothing blocks sign-off.'
      : decision === 'amber'
        ? `Green needs ${report.verdict.thresholds.accept} or more. Fixing the issues below will move it closer.`
        : `Green needs ${report.verdict.thresholds.accept} or more.${nHigh > 0 ? ' Start with the issues marked Must fix.' : ' Work through the issues below.'}`;

  const examinerIds = source.header.raters.map((r) => r.id);
  const examiners = examinerIds.map(examinerLabel);
  const examinerRows: ViewExaminerRow[] = report.agreement.map((a) => ({
    area: a.name,
    scores: examinerIds.map((id) => ({ label: examinerLabel(id), score: a.scores[id] ?? null })),
    note: a.resolution === 'agreement' || a.resolution === 'code' ? '' : (RESOLUTION_NOTE[a.resolution] ?? scrub(a.note)),
    disagreed: a.resolution !== 'agreement' && a.resolution !== 'code' && a.resolution !== 'none',
  }));

  const steps: ViewStep[] = report.pathToGreen.steps.map((s) => ({
    order: s.order, area: s.name, from: s.from, to: s.to, gain: s.scoreGain, fixes: s.findingIds.map((id) => issues.get(id) ?? '').filter(Boolean),
  }));

  return {
    report,
    fileName: report.header.artifactName,
    scorecard: report.header.scorecardName,
    checkNumber: report.header.iteration,
    finished: formatDate(report.header.finishedAt),
    finishedLong: formatDate(report.header.finishedAt, true),
    decision,
    score: report.verdict.weightedScore,
    headline: HEADLINE[decision],
    subline,
    thresholds: report.verdict.thresholds,
    meaning,
    areas,
    issues: list,
    lookIssues,
    lookNote: LOOK_NOTE,
    ...(report.cost
      ? {
          cost: {
            sentence: costSentence(report.cost),
            hasPrices: report.cost.totalCost !== null,
            lines: report.cost.lines.map((l) => ({ label: l.label, calls: l.calls, tokensIn: l.inputTokens, tokensOut: l.outputTokens, price: costCell(l, report.cost!.currency) })),
          },
        }
      : {}),
    bySeverity,
    issuesByArea,
    keyChecks: { passed: gates.filter((g) => g.status === 'passed').length, total: gates.length },
    areasAtFour: { count: scored.filter((a) => (a.score ?? 0) >= 4).length, of: scored.length },
    examiners,
    examinerRows,
    path: { steps, resultingScore: report.pathToGreen.resultingScore, resultingDecision: report.pathToGreen.resultingDecision, note: scrub(report.pathToGreen.note) },
    strengths: report.strengths.map((s) => ({ area: areaName.get(s.dimensionId) ?? '', text: scrub(s.text), where: s.location ? `Sheet "${s.location.sheet}", cell ${s.location.cell}` : '' })),
    leftOut: report.notMeasurable.map((n) => ({ name: n.name, critical: n.critical, reason: scrub(n.reason), treatment: n.treatment === 'zero' ? 'Counted as 0 in the score' : 'Left out of the score' })),
    examinerCount: examinerIds.length,
    ...(report.twoRuns
      ? {
          twoRuns: {
            line: `Run twice: ${num(report.twoRuns.scores[0])} and ${num(report.twoRuns.scores[1])}, average ${num(report.twoRuns.average)}, gap ${num(report.twoRuns.gap)} points${report.twoRuns.unstable ? '. Result is unstable, treat it as a range.' : '.'}`,
            unstable: report.twoRuns.unstable,
            first: report.twoRuns.scores[0],
            second: report.twoRuns.scores[1],
            average: report.twoRuns.average,
            gap: report.twoRuns.gap,
          },
        }
      : {}),
  };
}

export { num as formatNumber };
