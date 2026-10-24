import type { SheetSpec } from '@ddd/shared';
import { profileWorkbook, sheetProfile } from '../excel/profile.js';
import type { WorkbookModel } from '../excel/workbook.js';
import { candidateRows, documentFrequency, indexRows } from './presence.js';
import { planSections, type EvalSection } from './sectionPlanner.js';
import type { Scorecard } from '@ddd/shared';
import { serializeSheets } from '../excel/serialize.js';
import { estimateTokens } from './rater.js';

/**
 * A question that names the sheets to read ("Validation_Rules, Permission_Matrix") shows the examiners only those. But the thing it asks about
 * (a data class, a purpose, a sign-off) is often defined on another sheet, so an examiner honestly reports it "not in the sheets given" and may
 * score 0 for it. So each section also gets SUPPORTING ROWS: the few rows of the rest of the file that share the most distinctive words with the
 * section's questions, picked by code, shown with their header row. Cells in them are cited like any other cell. Sections that already read
 * the whole workbook get nothing extra.
 */
const SUPPORT_ROWS = 16;
const PER_SHEET = 6;
/** Most tokens of supporting rows a section gets; less when the smallest examiner's prompt limit leaves less room. */
const SUPPORT_TOKENS = 5000;
const MIN_SUPPORT_TOKENS = 600;
/** The scorecard, instructions and answer need room too. */
const OVERHEAD_TOKENS = 3000;

export function withSupportingRows(sections: EvalSection[], wb: WorkbookModel, options: { limit?: number } = {}): EvalSection[] {
  const names = wb.sheetNames();
  const needing = sections.filter((s) => s.sheets.length + s.context.length < names.length);
  if (needing.length === 0) return sections;
  const docs = indexRows(wb);
  const df = documentFrequency(docs);
  const profile = profileWorkbook(wb);
  return sections.map((section) => {
    if (!needing.includes(section)) return section;
    // An examiner with a small prompt limit gets only what fits beside the section's own sheets.
    const used = estimateTokens(serializeSheets(wb, [...section.sheets, ...section.context])) + OVERHEAD_TOKENS;
    const budget = options.limit ? Math.min(SUPPORT_TOKENS, Math.floor(options.limit * 0.9) - used) : SUPPORT_TOKENS;
    if (budget < MIN_SUPPORT_TOKENS) return section;
    const maxChars = Math.floor(budget * 2.7);
    // Sheets already shown in full add nothing: only rows from other sheets, or from a sheet shown only in part, are worth adding.
    const shownWhole = new Set([...section.sheets, ...section.context].filter((s) => !s.columns && !s.rows).map((s) => s.name.toLowerCase()));
    const query = section.dimensions.map((d) => `${d.name} ${d.measure ?? ''} ${d.description ?? ''}`).join(' ');
    const pool = candidateRows(docs.filter((d) => !shownWhole.has(d.sheet.toLowerCase())), query, df, SUPPORT_ROWS, PER_SHEET);
    const bySheet = new Map<string, number[]>();
    let chars = 0;
    for (const d of pool) {
      chars += d.text.length;
      if (chars > maxChars) break;
      bySheet.set(d.sheet, [...(bySheet.get(d.sheet) ?? []), d.row]);
    }
    if (bySheet.size === 0) return section;
    const extra: SheetSpec[] = [...bySheet].map(([name, rows]) => ({ name, headerRow: sheetProfile(profile, name)?.headerRow ?? 1, rows: rows.sort((a, b) => a - b) }));
    return { ...section, context: [...section.context, ...extra] };
  });
}

/** The sections of a run, each with its supporting rows. The one place that decides what the examiners and the final reviewer are shown. */
export const planSectionsWithSupport = (scorecard: Scorecard, wb: WorkbookModel, options: { limit?: number } = {}): EvalSection[] => withSupportingRows(planSections(scorecard), wb, options);
