import type { Report, Severity } from '@ddd/shared';

export interface ImprovementRow {
  priority: number;
  severity: Severity | 'SCORE' | 'UNMEASURED';
  dimension: string;
  where: string;
  problem: string;
  action: string;
  returnTo: string;
  gain: number | null;
}

const RANK: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/** One ordered to-do list: findings by severity, then low-scoring dimensions without a finding, then questions the file gave nothing to measure. */
export function improvementPlan(report: Report): ImprovementRow[] {
  const gainByDimension = new Map(report.pathToGreen.steps.map((s) => [s.dimensionId, s.scoreGain]));
  const rows: Omit<ImprovementRow, 'priority'>[] = [];
  const named = new Map(report.dimensions.map((d) => [d.id, d.name]));
  const status = new Map(report.dimensions.map((d) => [d.id, d.status]));
  const label = (id: string) => (named.has(id) ? `${id} ${named.get(id)}` : id);

  const findings = [...report.findings].sort((a, b) => (RANK[a.severity] ?? 3) - (RANK[b.severity] ?? 3));
  for (const f of findings) {
    rows.push({
      severity: f.severity,
      dimension: label(f.dimensionId),
      where: f.location ? `${f.location.sheet}!${f.location.cell}` : '',
      problem: f.title,
      action: f.fix,
      returnTo: f.returnTo,
      gain: gainByDimension.get(f.dimensionId) ?? null,
    });
  }

  const covered = new Set(report.findings.map((f) => f.dimensionId));
  for (const step of report.pathToGreen.steps) {
    if (covered.has(step.dimensionId)) continue;
    rows.push({
      severity: 'SCORE',
      dimension: `${step.dimensionId} ${step.name}`,
      where: '',
      problem: status.get(step.dimensionId) === 'scored' ? `Scored ${step.from} out of 5.` : 'Not scored in this run (the models could not rate it), so it counts as 0.',
      action: status.get(step.dimensionId) === 'scored' ? `Raise this to ${step.to} (adds ${step.scoreGain} points).` : `Run it again, with higher-limit model keys if it keeps failing (worth ${step.scoreGain} points).`,
      returnTo: '',
      gain: step.scoreGain,
    });
  }

  for (const n of report.notMeasurable) {
    rows.push({
      severity: 'UNMEASURED',
      dimension: `${n.dimensionId} ${n.name}`,
      where: '',
      problem: `${n.reason} ${n.treatment === 'zero' ? 'It counts as 0.' : 'It is left out of the score.'}`,
      action: 'Add to the file what this question asks for, so the examiners can score it next time.',
      returnTo: '',
      gain: null,
    });
  }
  return rows.map((r, i) => ({ ...r, priority: i + 1 }));
}
