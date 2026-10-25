import type { Evidence } from '@ddd/shared';

/**
 * The final mark for one question is set by code, so the same examiner marks always give the same result.
 *
 *  1. Marks that need proof (a 0, or a lone mark far from two examiners who agree) count only when the examiner cited a cell that holds
 *     the words it quoted. Otherwise the mark is set aside for that question.
 *  2. The final mark is the median of the marks that count (the lower middle when two are left, so a tie never rounds up).
 *  3. The final reviewer can move it only by citing cells that code checked, and only as far as that evidence goes: all the way
 *     to a mark an examiner gave from the same cell, otherwise one point.
 *
 * Everything here is pure; the orchestration (who cited what) lives in consolidate.ts.
 */

/** The median of the marks; for an even number of marks the lower middle one. */
export function medianMark(scores: number[]): number {
  if (scores.length === 0) throw new Error('medianMark needs at least one mark');
  return [...scores].sort((a, b) => a - b)[Math.floor((scores.length - 1) / 2)]!;
}

/** A mark this far from another examiner's mark is a "stray" one. */
export const STRAY_GAP = 2;

/**
 * Which marks need proof. A 0 when another examiner gave 2 or more and none of them came within a point of it; or, with three or more marks, a mark that is 2 or more points from
 * every other while the others are within one point of each other (one examiner against two who agree). Returns the indexes of those marks.
 * Two examiners who simply differ (1 and 4) are a dispute, not a stray: neither is singled out.
 */
export function strayMarks(scores: number[]): Set<number> {
  const stray = new Set<number>();
  if (scores.length < 2) return stray;
  scores.forEach((mark, i) => {
    const others = scores.filter((_, j) => j !== i);
    // A 0 that another examiner also gave (or came within a point of) is a shared view, not a stray.
    if (mark === 0 && others.some((o) => o >= STRAY_GAP) && !others.some((o) => o <= 1)) {
      stray.add(i);
      return;
    }
    if (scores.length >= 3 && others.every((o) => Math.abs(o - mark) >= STRAY_GAP) && Math.max(...others) - Math.min(...others) <= 1) stray.add(i);
  });
  return stray;
}

/** Shortest quote that counts as words from the cell, unless it is most of what the cell says (a short cell can only be quoted whole). */
export const MIN_PROOF_QUOTE = 8;

/**
 * Does this examiner's mark carry proof? The evidence was already checked against the file (cell exists, any quote is really in it), so what is
 * left to ask is whether it quotes anything at all: a cell address alone shows the examiner looked somewhere, not that the cell says what it
 * claims. `cellText` gives the text of a cited cell, so a short cell quoted whole counts.
 */
export function hasQuotedProof(evidence: Evidence[], cellText?: (e: Pick<Evidence, 'sheet' | 'cell'>) => string | null | undefined): boolean {
  return evidence.some((e) => {
    const quote = (e.quote ?? '').trim();
    if (quote.length === 0) return false;
    if (quote.length >= MIN_PROOF_QUOTE) return true;
    const text = (cellText?.(e) ?? '').trim();
    return text.length > 0 && quote.length >= 0.8 * text.length;
  });
}

const cellKey = (e: Pick<Evidence, 'sheet' | 'cell'>) => `${e.sheet.toLowerCase()}!${e.cell.toUpperCase()}`;

export interface ReviewerMove {
  /** The mark the final reviewer proposed (already inside the examiners' range). */
  proposed: number;
  /** The cells the reviewer cited that code confirmed exist and hold the quote. */
  cited: Evidence[];
}

export interface MarkDecision {
  mark: number;
  /** The reviewer's move was applied, in whole or in part. */
  moved: boolean;
  /** Plain words for the log, when the reviewer proposed something other than the median. */
  note?: string;
}

/**
 * The median, unless the reviewer moves it with checked evidence. Moving all the way needs an examiner who gave the proposed mark to have cited
 * one of the same cells (two readers found the same proof); a reviewer citing cells nobody else cited moves it one point at most.
 * A move without any checked cell is refused.
 */
export function decideMark(given: Array<{ score: number; evidence: Evidence[] }>, move: ReviewerMove | null): MarkDecision {
  const median = medianMark(given.map((g) => g.score));
  if (!move || move.proposed === median) return { mark: median, moved: false };
  const proposed = move.proposed;
  if (move.cited.length === 0) {
    return { mark: median, moved: false, note: `The final reviewer suggested ${proposed} but cited no cell that code could confirm, so the median ${median} stands.` };
  }
  const cited = new Set(move.cited.map(cellKey));
  const corroborated = given.some((g) => g.score === proposed && g.evidence.some((e) => cited.has(cellKey(e))));
  if (corroborated) {
    return { mark: proposed, moved: true, note: `The final reviewer moved the mark from the median ${median} to ${proposed}: an examiner who gave ${proposed} cited the same cell (${[...cited].find((c) => given.some((g) => g.score === proposed && g.evidence.some((e) => cellKey(e) === c)))}).` };
  }
  const step = Math.sign(proposed - median);
  return {
    mark: median + step,
    moved: true,
    note: `The final reviewer suggested ${proposed}, but no examiner who gave ${proposed} cited the cells it cited, so the mark moved one point only, from the median ${median} to ${median + step}.`,
  };
}
