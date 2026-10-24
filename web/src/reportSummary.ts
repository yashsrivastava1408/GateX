import type { RunDetail } from '@ddd/shared';

/** The short version of a report, for pasting into a chat or an email. */
export function summaryText(run: RunDetail): string {
  const report = run.report;
  if (!report) return '';
  const { verdict, findings, pathToGreen } = report;
  const lines = [
    `${run.projectName} v${run.iteration}: ${verdict.decision.toUpperCase()} (${verdict.weightedScore.toFixed(1)})`,
    ...verdict.reasons.map((r) => `- ${r}`),
  ];
  const top = findings.filter((f) => f.severity === 'HIGH').slice(0, 3);
  if (top.length > 0) {
    lines.push('', 'Fix first:');
    top.forEach((f) => lines.push(`- ${f.title}: ${f.fix}`));
  }
  if (pathToGreen.steps.length > 0) {
    lines.push('', `Path to green: ${pathToGreen.steps.map((s) => s.name).join(', then ')} (expected ${pathToGreen.resultingScore.toFixed(1)})`);
  }
  return lines.join('\n');
}
