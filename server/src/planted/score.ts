import type { CellRef } from '@ddd/shared';
import type { PlantedDefect } from './plant.js';

/**
 * Scores a run on a file with planted defects. A defect is caught when a finding points at its row, or names its id or its cell.
 * Nothing here needs an opinion: the answer key is what was planted.
 */

export interface ScoredFinding {
  id: string;
  title: string;
  detail: string;
  location: CellRef | null;
  reportedBy: string[];
  /** True when the finding is in the report; false when the app set it aside (vague, contradicted, a lone weak examiner...). */
  kept: boolean;
}

export interface DefectResult {
  defect: PlantedDefect;
  caughtBy: string[];
  /** Examiner ids (A, B, C) that reported a finding that catches it. */
  examiners: string[];
  /** True if a finding in the report catches it. */
  inReport: boolean;
}

export interface PlantedScore {
  planted: number;
  /** Caught by a finding in the report. */
  caught: number;
  /** Caught by any finding, including ones the app set aside. */
  caughtRaw: number;
  /** Caught by a finding an AI examiner raised (in the report or set aside later): what the models alone find. */
  caughtByExaminers: number;
  /** Caught by an exact check in code (the row-by-row sweep). */
  caughtByCode: number;
  /** Per examiner: defects it caught (in a kept or set-aside finding) and the findings it raised that point at no planted defect. */
  perExaminer: Record<string, { caught: number; otherFindings: number }>;
  /** Findings in the report that point at no planted defect (real old problems, or false alarms). */
  otherInReport: number;
  results: DefectResult[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function catches(finding: ScoredFinding, defect: PlantedDefect): boolean {
  const loc = finding.location;
  if (loc && loc.sheet.toLowerCase() === defect.sheet.toLowerCase()) {
    const row = Number(/(\d+)$/.exec(loc.cell)?.[1]);
    if (row === defect.row) return true;
    // A duplicate id also spoils the row above it.
    if (defect.kind === 'duplicate_id' && row === defect.row - 1) return true;
  }
  const text = `${finding.title} ${finding.detail}`;
  if (new RegExp(`(?<![\\w.])${escape(defect.cell)}(?![\\w])`).test(text)) return true;
  // The register id, as a whole token: "1.1.2" must not match inside "11.1.2" or "1.1.20".
  return defect.recordId !== '' && new RegExp(`(?<![\\w.])${escape(defect.recordId)}(?![\\w]|\\.\\d)`).test(text);
}

export function scorePlanted(defects: PlantedDefect[], findings: ScoredFinding[], examiners: string[] = ['A', 'B', 'C']): PlantedScore {
  const results: DefectResult[] = defects.map((defect) => {
    const hits = findings.filter((f) => catches(f, defect));
    return {
      defect,
      caughtBy: hits.map((f) => f.id),
      examiners: [...new Set(hits.flatMap((f) => f.reportedBy))].sort(),
      inReport: hits.some((f) => f.kept),
    };
  });
  const perExaminer: PlantedScore['perExaminer'] = Object.fromEntries(examiners.map((e) => [e, { caught: 0, otherFindings: 0 }]));
  for (const r of results) for (const e of r.examiners) (perExaminer[e] ??= { caught: 0, otherFindings: 0 }).caught += 1;
  let otherInReport = 0;
  for (const f of findings) {
    if (defects.some((d) => catches(f, d))) continue;
    if (f.kept) otherInReport += 1;
    for (const e of f.reportedBy) (perExaminer[e] ??= { caught: 0, otherFindings: 0 }).otherFindings += 1;
  }
  return {
    planted: defects.length,
    caught: results.filter((r) => r.inReport).length,
    caughtRaw: results.filter((r) => r.caughtBy.length > 0).length,
    caughtByExaminers: results.filter((r) => r.examiners.some((e) => e !== 'code')).length,
    caughtByCode: results.filter((r) => r.examiners.includes('code')).length,
    perExaminer,
    otherInReport,
    results,
  };
}
