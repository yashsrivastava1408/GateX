import type { DimensionResult } from '@ddd/shared';
import type { WorkbookModel } from '../excel/workbook.js';
import { hasQuotedProof } from './finalMark.js';

/**
 * A high mark on a must-pass question needs proof.
 *
 * A false green is the costliest error, and the questions that gate a step (the critical ones) are where it hurts most. Every mark already has to cite a
 * cell that exists; this goes one step further for a critical question marked 4 or 5: at least one cell it cites must be quoted (words of 8 or more characters
 * that code found in that cell, or a short cell quoted whole). A cell address alone shows where the examiner looked, not that the cell says what the mark claims.
 * A mark that fails this is lowered to 3, and the report says why. A cap only ever lowers a mark, and code-scored and unscored questions are left alone.
 *
 * Measured on the 37 saved reports (data/live-*, quote of 8 or more characters): with the current prompts every high mark on a critical question already
 * carries a quote, so this changes nothing today; in the oldest runs (prompts before 1.5: d2-sectioned, step04, step3) it would have lowered a handful of
 * marks. It is a guard against a prompt or model change that stops quoting, not a measured improvement.
 */
export const PROOF_CEILING = 3;
export const PROOF_NEEDED_FROM = 4;

export function applyCriticalProof(results: DimensionResult[], wb: WorkbookModel): { results: DimensionResult[]; notes: string[] } {
  const notes: string[] = [];
  const next = results.map((d) => {
    if (!d.critical || d.measuredBy !== 'raters' || d.status !== 'scored' || d.consolidated === null || d.consolidated < PROOF_NEEDED_FROM) return d;
    if (hasQuotedProof(d.evidence, (e) => wb.cellText(e.sheet, e.cell))) return d;
    notes.push(`${d.id} was set to ${PROOF_CEILING} (the examiners gave ${d.consolidated}): it is a must-pass question and no cell the marks cite holds quoted words that show it.`);
    return { ...d, consolidated: PROOF_CEILING, rationale: `${d.rationale} Set to ${PROOF_CEILING}: a high mark on a must-pass question needs a quoted cell, and none was given.` };
  });
  return { results: next, notes };
}
