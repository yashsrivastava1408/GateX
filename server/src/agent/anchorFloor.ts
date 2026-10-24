import type { DimensionResult, DimensionSpec } from '@ddd/shared';
import { parseAddress, type WorkbookModel } from '../excel/workbook.js';
import { normalise } from '../util/text.js';

/**
 * The anchor floor.
 *
 * A scorecard describes a scale: "5 a machine-readable schema matches the prose; 3 structured tables but no machine format; 1 prose only". The
 * lowest thing it describes is 1, so a file that has prose and is given 0 for "machine-readable" is scored below the scale's own bottom rung: 0
 * would mean "absent or contradicted", and the cited cells show the prose. Examiners sometimes read the 0 as "no machine format" and one 0 caps
 * the whole dimension (GS-1), so the mistake is expensive. Code pulls such a score back up to the lowest rung the scale describes.
 *
 * The floor is applied only when all of these hold, so it never rescues a score the evidence does not support:
 *  - the scale's lowest described rung is 1, found in the criterion's own words: a scale written in the measure ("5 ...; 3 ...; 1 ...")
 *    or anchors in which the lowest score and the next one carry the same text (the converter spreads "1 prose only" over 0 and 1), or whose
 *    scale starts at 1;
 *  - that rung does not say "absent" (none, nothing, missing, not stated): a 0 below such a rung is rightly 0;
 *  - the criterion is scored (not unscored, not outside the file) and its final score is below the rung;
 *  - it cites at least one cell that exists, holds text, and contains the quote it gives.
 */

export interface Rung {
  score: number;
  text: string;
}

const ABSENT = /^(?:absent|none|nothing|missing|no\b|not (?:present|stated|defined|given|found|in the file)|n\/a|empty)/i;

/** "5 a machine-readable schema; 3 structured tables; 1 prose only" -> rungs. Needs two or more segments that start with a score 0-5. */
export function parseScaleText(text: string): Rung[] {
  const rungs: Rung[] = [];
  for (const part of text.split(/[;\n]/)) {
    const m = /^\s*([0-5])\s*[:=\-–)]?\s+(\S.*?)\s*\.?\s*$/.exec(part);
    if (m) rungs.push({ score: Number(m[1]), text: m[2]! });
  }
  const scores = new Set(rungs.map((r) => r.score));
  return rungs.length >= 2 && scores.size === rungs.length ? rungs.sort((a, b) => a.score - b.score) : [];
}

const key = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The lowest rung the criterion's own scale describes, when it is 1 (so 0 is the one score the scale leaves undescribed) and does not mean
 * "absent". A scale that starts at 2 ("2 several") leaves 0 and 1 open, and a lower score may be right, so nothing is pulled up there.
 */
export function lowestRung(spec: Pick<DimensionSpec, 'anchors' | 'measure'>): Rung | null {
  const fromText = parseScaleText(spec.measure ?? '');
  let low: Rung | null = null;
  if (fromText.length > 0) {
    low = fromText[0]!;
  } else if (spec.anchors) {
    const rungs = Object.entries(spec.anchors)
      .map(([k, v]) => ({ score: Number(k), text: String(v) }))
      .filter((r) => Number.isInteger(r.score) && r.score >= 0 && r.score <= 5)
      .sort((a, b) => a.score - b.score);
    if (rungs.length < 2) return null;
    // The scale's bottom is the last score of the first run of equal texts ("0 prose only, 1 prose only" -> 1).
    const first = rungs[0]!;
    const run = rungs.filter((r, i) => key(r.text) === key(first.text) && rungs.slice(0, i).every((p) => key(p.text) === key(first.text)));
    low = run[run.length - 1]!;
  }
  if (!low || low.score !== 1 || ABSENT.test(low.text.trim()) || key(low.text) === '') return null;
  return low;
}

/** Cited cells that exist, hold text, and contain the quote given with them. */
function supportedCells(wb: WorkbookModel, evidence: DimensionResult['evidence']): string[] {
  const ok: string[] = [];
  for (const e of evidence) {
    const parsed = parseAddress(e.cell.replace(/\$/g, '').split(':')[0]!.trim());
    if (!parsed) continue;
    const sheet = wb.resolveSheet(e.sheet);
    if (!sheet) continue;
    const text = wb.cellText(sheet, `${parsed.letters}${parsed.row}`) ?? '';
    if (text.trim() === '') continue;
    const quote = (e.quote ?? '').replace(/(…|\.\.\.)$/, '').trim();
    if (quote !== '' && !normalise(text).includes(normalise(quote))) continue;
    ok.push(`${sheet}!${parsed.letters}${parsed.row}`);
  }
  return ok;
}

/**
 * Pulls a score that is below the scale's lowest described rung back to that rung. `questions` are the working questions of the run (criteria
 * already expanded); `skip` holds the ids of questions that need evidence from outside the file, where a 0 means "not in the file".
 */
export function applyAnchorFloors(
  results: DimensionResult[],
  questions: DimensionSpec[],
  wb: WorkbookModel,
  skip: ReadonlySet<string> = new Set(),
): { results: DimensionResult[]; notes: string[] } {
  const notes: string[] = [];
  const specs = new Map(questions.map((q) => [q.id, q]));
  const next = results.map((d) => {
    const spec = specs.get(d.id);
    if (!spec || skip.has(d.id) || d.measuredBy !== 'raters' || d.status !== 'scored' || d.consolidated === null) return d;
    const rung = lowestRung(spec);
    if (!rung || d.consolidated >= rung.score) return d;
    const cells = supportedCells(wb, d.evidence);
    if (cells.length === 0) return d;
    notes.push(`${d.id} was raised from ${d.consolidated} to ${rung.score}: the scorecard's own scale starts at ${rung.score} ("${rung.text}") and the cited cell${cells.length === 1 ? '' : 's'} ${cells.slice(0, 3).join(', ')} exist${cells.length === 1 ? 's' : ''} and hold text.`);
    return { ...d, consolidated: rung.score, rationale: `${d.rationale} Raised to ${rung.score} (the examiners gave ${d.consolidated}): the scorecard's lowest rung is ${rung.score} ("${rung.text}") and the cited cells ${cells.slice(0, 3).join(', ')} hold text.` };
  });
  return { results: next, notes };
}
