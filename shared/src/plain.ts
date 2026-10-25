import type { Report, RunDetail, Severity } from './types.js';
import { tierFor } from './tiers.js';

/** The product's name and the one line under it, used by the dashboard, the downloads and the docs. */
export const BRAND = { name: 'GateX', tagline: 'Checks your work against a scorecard' } as const;

/** "Field-definition quality · GATE" → "Field-definition quality"; "Purpose (counted)" → "Purpose (numbers to check)". */
export const plainName = (name: string): string =>
  name
    .replace(/\s*·\s*GATE\s*$/i, '')
    .replace(/\s*\(counted\)\s*$/i, ' (numbers to check)')
    .trim();

/** The people-friendly name of whoever marked: A, B, C are examiners 1, 2, 3 and K is the final reviewer. Model names are never shown. */
export function examinerLabel(id: string): string {
  const n = 'ABCDEFGH'.indexOf(id.toUpperCase());
  if (id.toUpperCase() === 'K') return 'Final reviewer';
  if (id.toLowerCase() === 'code') return 'Computer check';
  return n >= 0 ? `Examiner ${n + 1}` : `Examiner ${id}`;
}

/** What a finding's severity is called for people: how soon to fix it. */
export const SEVERITY_LABEL: Record<Severity, string> = { HIGH: 'Must fix', MEDIUM: 'Should fix', LOW: 'Nice to fix' };
export const severityLabel = (severity: Severity): string => SEVERITY_LABEL[severity];

/**
 * The page and the downloads show names, not codes. This rewrites a report for display only: names lose their tags, sentences that say
 * "G09 (Privacy…)" say just the name. The saved report keeps the codes.
 */
export function simplifyReport(report: Report): Report {
  const forms = report.dimensions
    .flatMap((d) => [`${d.id} (${d.name})`, `${d.id} · ${d.name}`, `${d.id} ${d.name}`].map((from) => [from, plainName(d.name)] as const))
    .sort((a, b) => b[0].length - a[0].length);
  const say = (text: string) => forms.reduce((t, [from, to]) => t.split(from).join(to), text);
  const named = <T extends { name: string }>(item: T): T => ({ ...item, name: plainName(item.name) });

  return {
    ...report,
    dimensions: report.dimensions.map(named),
    agreement: report.agreement.map(named),
    notMeasurable: report.notMeasurable.map(named),
    verdict: {
      ...report.verdict,
      reasons: report.verdict.reasons.map(say),
      criticalGates: report.verdict.criticalGates.map(named),
    },
    pathToGreen: {
      ...report.pathToGreen,
      steps: report.pathToGreen.steps.map(named),
      note: say(report.pathToGreen.note),
    },
  };
}

export const simplifyRun = (run: RunDetail): RunDetail => (run.report ? { ...run, report: simplifyReport(run.report) } : run);

/**
 * "Issue 1", "Issue 2" ... in the order the report lists its findings, so a person can say "issue 3" to a colleague. The saved ids (F-01)
 * stay in the data; downloads and the page show these.
 */
export function issueNumbers(report: Pick<Report, 'findings'>): Map<string, string> {
  let issue = 0;
  let look = 0;
  return new Map(report.findings.map((f) => [f.id, tierFor(f) === 'confirmed' ? `Issue ${++issue}` : `Look ${++look}`] as const));
}

/**
 * A copy of the report that is safe to hand to anyone: names instead of codes, "Examiner 1/2/3" and "Final reviewer" instead of model names
 * and providers, and issue numbers instead of F-codes inside the sentences. Used by every download.
 */
export function presentReport(report: Report): Report {
  const plain = simplifyReport(report);
  const issues = issueNumbers(report);
  const lower = (label: string) => label.replace(/^Issue/, 'issue').replace(/^Look/, 'worth-a-look item');
  const sayIssues = (text: string) => {
    let out = text;
    for (const [id, label] of [...issues].sort((a, b) => b[0].length - a[0].length)) out = out.split(id).join(lower(label));
    return out;
  };
  const hidden = (id: string) => ({ id, provider: '', model: examinerLabel(id), family: '' });
  return {
    ...plain,
    header: {
      ...plain.header,
      raters: plain.header.raters.map((r) => hidden(r.id)),
      consolidator: hidden('K'),
    },
    verdict: { ...plain.verdict, reasons: plain.verdict.reasons.map(sayIssues) },
    findings: plain.findings.map((f) => ({ ...f, reportedBy: f.reportedBy.map(examinerLabel) })),
    ...(plain.cost ? { cost: { ...plain.cost, lines: plain.cost.lines.map((l) => ({ ...l, model: l.label })) } } : {}),
    pathToGreen: { ...plain.pathToGreen, note: sayIssues(plain.pathToGreen.note) },
    notes: plain.notes.map((n) => n.replace(/\b(?:bedrock|groq|gemini)\/[\w.:-]+/gi, 'an AI model')),
    droppedFindings: plain.droppedFindings?.map((d) => ({ ...d, reportedBy: d.reportedBy.map(examinerLabel) })),
  };
}
