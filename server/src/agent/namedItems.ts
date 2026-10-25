import type { DimensionSpec } from '@ddd/shared';
import type { WorkbookModel } from '../excel/workbook.js';
import { profileWorkbook } from '../excel/profile.js';

/**
 * Items a question names that the file has no column for.
 *
 * Some counted criteria list what must be present: "Governance items present: status, migration, extensibility, owner × 116 sets". Examiners see the
 * columns that exist (Extensibility, Owner) and score it 5; they do not notice that two of the four named items have no column at all. The human
 * assessment of the Step 2 workbook scored this question 2 (the file holds 232 of 464 items) and every live run scored it 5, the one question where
 * GateX was far above the human mark in every run.
 *
 * Code reads the header row of every sheet the question reads and checks each named item against it. The score is capped by the share of named items
 * that have a column, on the scale the scorecard family uses for shares of items (98% or more 5, 90% 4, 75% 3, 50% 2, any 1, none 0). A cap only
 * ever lowers a mark. Strict on purpose: the wording must say "present:" followed by a short list, the sheets must be named by the question, and an
 * item counts as present when ANY header there holds its stem, so a differently worded column never causes a cap.
 */
export interface NamedItems {
  items: string[];
  present: string[];
  missing: string[];
  sheets: string[];
}

const LIST = /\b(?:items?|fields?|columns?|attributes?|metadata|properties|elements?)\s+(?:are\s+)?present\s*:\s*([^×;.\n]{3,120}?)(?:\s*[×x]\s*\d[\d,]*\s*\w*)?\s*(?:\.|$|\s+Estimate\b)/i;

/** The items a question names after "present:", or null when it names none (or more than eight, or a long phrase that is not an item). */
export function namedItemsOf(text: string): string[] | null {
  const m = LIST.exec(text.trim());
  if (!m) return null;
  const items = m[1]!
    .split(/\s*(?:,|\band\b|\/)\s*/i)
    .map((s) => s.trim().replace(/^(?:and|or)\s+/i, ''))
    .filter((s) => s.length > 0);
  if (items.length < 2 || items.length > 8) return null;
  if (items.some((s) => s.split(/\s+/).length > 3 || /\d/.test(s))) return null;
  return items;
}

/** A five-letter stem of the item's longest word, so "migration" matches "Migration rule" and "status" matches "Status (live)". */
const stemOf = (item: string): string => {
  const word = [...(item.toLowerCase().match(/[a-z]{3,}/g) ?? [])].sort((a, b) => b.length - a.length)[0] ?? '';
  return word.slice(0, 5);
};

/** The scale for a share of named items. */
export function scoreForItems(present: number, total: number): number {
  const share = total === 0 ? 1 : present / total;
  return share >= 0.98 ? 5 : share >= 0.9 ? 4 : share >= 0.75 ? 3 : share >= 0.5 ? 2 : share > 0 ? 1 : 0;
}

export function checkNamedItems(question: Pick<DimensionSpec, 'name' | 'measure' | 'reads'>, wb: WorkbookModel): NamedItems | null {
  const items = namedItemsOf(question.measure ?? '') ?? namedItemsOf(question.name);
  if (!items || !question.reads || question.reads.length === 0) return null;
  const profile = profileWorkbook(wb);
  // A read is "Sheet name[Column|Column]"; only the sheet name matters here.
  const sheets = question.reads.map((name) => wb.resolveSheet(name.replace(/\[[\s\S]*$/, '').trim())).filter((s): s is string => Boolean(s));
  // Every sheet the question reads must exist; otherwise nothing can be said about where the items should be.
  if (sheets.length === 0 || sheets.length < question.reads.length) return null;
  const headers = sheets.flatMap((s) => profile.sheets.find((p) => p.name === s)?.columns.map((c) => c.title.toLowerCase()) ?? []);
  if (headers.length === 0) return null;
  const present: string[] = [];
  const missing: string[] = [];
  for (const item of items) {
    const stem = stemOf(item);
    (stem.length >= 3 && headers.some((h) => h.includes(stem)) ? present : missing).push(item);
  }
  return { items, present, missing, sheets };
}
