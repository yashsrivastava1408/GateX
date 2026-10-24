/**
 * Display-only helpers: what a person sees in place of codes and model names. The saved report keeps the real ids;
 * these rewrite text and labels just before they reach the screen.
 */
import { examinerLabel, issueNumbers, presentReport, type Report, type RunDetail } from '@ddd/shared';

const MODEL_WORDS =
  /\b(?:bedrock|groq|gemini|anthropic|openai|claude|llama|mistral|qwen|deepseek|cohere|gpt-?[\w.-]*|nova-?[\w.:-]*|amazon|meta-llama)\b[\w./:-]*/gi;

/** Takes AI model names and providers out of free text (error messages, notes). */
export function hideModels(text: string): string {
  return text
    .replace(/\b[\w-]+\/[\w.:-]*(?:claude|llama|gemini|gpt|nova|mistral|qwen|deepseek|anthropic|openai)[\w.:-]*/gi, 'an examiner')
    .replace(MODEL_WORDS, 'an examiner')
    .replace(/(?:an examiner[ ,/·-]*){2,}/g, 'an examiner ');
}

const WORDS: Array<[RegExp, string]> = [
  [/\bCritical gates?\b/g, 'Key check'],
  [/\bcritical gates?\b/g, 'key check'],
  [/\bconsolidator\b/gi, 'final reviewer'],
  [/\braters\b/gi, 'examiners'],
  [/\brater\b/gi, 'examiner'],
  [/\bfingerprints\b/gi, 'check codes'],
  [/\bfingerprint\b/gi, 'check code'],
  [/\bartifacts\b/gi, 'files'],
  [/\bartifact\b/gi, 'file'],
  [/\bhigh-risk (issues?)\b/gi, 'must-fix $1'],
  [/\bhigh-risk (findings?)\b/gi, 'must-fix $1'],
  [/\bfindings\b/g, 'issues'],
  [/\bfinding\b/g, 'issue'],
];

/**
 * Makes one sentence from the report safe to show: issue ids become "issue 3", area and question codes become their names,
 * model names disappear and a few jargon words are swapped.
 */
export function tidy(text: string, report: Pick<Report, 'findings' | 'dimensions'>): string {
  if (!text) return text;
  const issues = issueNumbers(report);
  let out = text;
  for (const [id, label] of [...issues].sort((a, b) => b[0].length - a[0].length)) out = out.split(id).join(label.toLowerCase());
  const names: Array<[string, string]> = [];
  for (const d of report.dimensions) {
    names.push([d.id, d.name]);
    for (const c of d.criteria ?? []) names.push([c.id, c.name]);
  }
  for (const [id, name] of names.sort((a, b) => b[0].length - a[0].length)) {
    out = out.replace(new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), name);
  }
  out = out.replace(/\bF-\d+\b/g, 'an issue').replace(/\b[GH]\d{2}(?:-[A-Za-z]+\d*)*\b/g, 'this area');
  out = hideModels(out);
  for (const [from, to] of WORDS) out = out.replace(from, to);
  return out;
}

/** The report as a person should see it: names not codes, examiners not models, plain sentences. */
export function presentRun(run: RunDetail): RunDetail {
  if (!run.report) return run;
  const base = presentReport(run.report);
  const t = (s: string) => tidy(s, run.report!);
  const report: Report = {
    ...base,
    verdict: { ...base.verdict, reasons: base.verdict.reasons.map(t) },
    findings: base.findings.map((f) => ({ ...f, title: t(f.title), detail: t(f.detail), fix: t(f.fix) })),
    dimensions: base.dimensions.map((d) => ({
      ...d,
      rationale: t(d.rationale),
      error: d.error ? t(d.error) : d.error,
      criteria: d.criteria?.map((c) => ({ ...c })),
    })),
    agreement: base.agreement.map((a) => ({ ...a, note: t(a.note) })),
    notMeasurable: base.notMeasurable.map((n) => ({ ...n, reason: t(n.reason) })),
    strengths: base.strengths.map((s) => ({ ...s, text: t(s.text) })),
    pathToGreen: { ...base.pathToGreen, note: t(base.pathToGreen.note) },
    notes: base.notes.map((n) => hideModels(n)),
  };
  return { ...run, report, error: run.error ? hideModels(run.error) : run.error };
}

/** "Issue 3" for a finding id, from the saved report. */
export const issueLabel = (issues: Map<string, string>, id: string): string => issues.get(id) ?? 'An issue';

export { examinerLabel };
