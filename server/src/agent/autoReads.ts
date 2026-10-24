import type { DimensionSpec, Scorecard } from '@ddd/shared';
import { profileWorkbook, pickColumns, rankColumns, sheetProfile, stems, type SheetProfile } from '../excel/profile.js';
import { serializeSheet } from '../excel/serialize.js';
import type { WorkbookModel } from '../excel/workbook.js';
import { estimateTokens } from './rater.js';

/**
 * A question with no `reads` list is sent the whole workbook. On a big workbook that is far more than any model takes (the
 * Step 2 schema is about 316,000 tokens), so every examiner fails it and the question goes unscored. This gives such a
 * question a `reads` list chosen by code: the sheets whose titles and contents best match the question, each cut to its id
 * column plus the best-matching columns, until the budget is full. Deterministic: the same scorecard and file always read the
 * same sheets. A question that already says what it reads, or a workbook small enough to send whole, is left alone.
 */

/** Tokens one question may read when it names nothing itself; the same plan the scorecard converter uses. */
export const AUTO_READS_BUDGET = 30_000;
const COLUMNS_PER_SHEET = 6;
const SMALL_SHEETS_WHEN_NOTHING_MATCHES = 3;

const questionText = (dim: DimensionSpec) => [dim.name, dim.measure, dim.description].filter(Boolean).join(' ');

function sheetRelevance(sheet: SheetProfile, question: string): number {
  const words = stems(question);
  const nameHits = [...stems(sheet.name.replace(/[_-]+/g, ' '))].filter((w) => words.has(w)).length;
  const columnScore = rankColumns(sheet, question)
    .slice(0, 3)
    .reduce((sum, r) => sum + r.score, 0);
  return nameHits * 5 + columnScore;
}

function entryFor(sheet: SheetProfile, question: string): { entry: string; tokens: number } {
  const columns = pickColumns(sheet, question, COLUMNS_PER_SHEET);
  const whole = sheet.tokens;
  if (columns.length === 0 || columns.length >= sheet.columns.filter((c) => c.title).length) return { entry: sheet.name, tokens: whole };
  return { entry: `${sheet.name}[${columns.join('|')}]`, tokens: -1 };
}

export interface AutoReadsResult {
  scorecard: Scorecard;
  /** One line per question that was given a `reads` list, with the sheets (for the run log). */
  notes: string[];
  /** One short line for the report: how many questions, and how big the file is. Empty when none. */
  summary: string;
}

export function withAutoReads(scorecard: Scorecard, wb: WorkbookModel, budget = AUTO_READS_BUDGET): AutoReadsResult {
  const needs = scorecard.dimensions.filter((d) => d.measuredBy === 'raters' && (!d.reads || d.reads.length === 0));
  if (needs.length === 0) return { scorecard, notes: [], summary: '' };
  const profile = profileWorkbook(wb);
  const names = [...scorecard.artifact.sheets, ...(scorecard.artifact.context ?? [])].map((s) => s.name);
  const sheets = names.map((n) => sheetProfile(profile, n)).filter((s): s is SheetProfile => Boolean(s && s.dataRows > 0));
  const wholeSize = sheets.reduce((sum, s) => sum + s.tokens, 0);
  if (wholeSize <= budget) return { scorecard, notes: [], summary: '' };

  const notes: string[] = [];
  const reads = new Map<string, string[]>();
  for (const dim of needs) {
    const question = questionText(dim);
    const ranked = sheets
      .map((sheet) => ({ sheet, score: sheetRelevance(sheet, question) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.sheet.tokens - b.sheet.tokens);
    const pool = ranked.length > 0 ? ranked.map((r) => r.sheet) : [...sheets].sort((a, b) => a.tokens - b.tokens).slice(0, SMALL_SHEETS_WHEN_NOTHING_MATCHES);
    const chosen: string[] = [];
    let used = 0;
    for (const sheet of pool) {
      const planned = entryFor(sheet, question);
      const tokens =
        planned.tokens >= 0
          ? planned.tokens
          : estimateTokens(serializeSheet(wb, { name: sheet.name, headerRow: sheet.headerRow, columns: pickColumns(sheet, question, COLUMNS_PER_SHEET) }));
      if (used + tokens > budget) continue;
      chosen.push(planned.entry);
      used += tokens;
    }
    if (chosen.length === 0 && pool[0]) {
      // Nothing fits the budget. The best match is still better than nothing, cut to its id and two best columns.
      const sheet = pool[0];
      const columns = pickColumns(sheet, question, 3);
      const entry = columns.length > 0 && columns.length < sheet.columns.filter((c) => c.title).length ? `${sheet.name}[${columns.join('|')}]` : sheet.name;
      used = estimateTokens(serializeSheet(wb, { name: sheet.name, headerRow: sheet.headerRow, ...(entry.includes('[') ? { columns } : {}) }));
      chosen.push(entry);
    }
    if (chosen.length === 0) continue;
    reads.set(dim.id, chosen);
    notes.push(`${dim.id} named no sheets and the whole file is about ${wholeSize.toLocaleString('en')} tokens, so code gave it ${chosen.length} sheet${chosen.length === 1 ? '' : 's'} (about ${used.toLocaleString('en')} tokens): ${chosen.join(', ')}.`);
  }
  if (reads.size === 0) return { scorecard, notes, summary: '' };
  const summary = `The file is large (about ${wholeSize.toLocaleString('en')} tokens), so code chose which sheets ${reads.size} question${reads.size === 1 ? '' : 's'} that named none should read (${[...reads.keys()].join(', ')}).`;
  return {
    scorecard: { ...scorecard, dimensions: scorecard.dimensions.map((d) => (reads.has(d.id) ? { ...d, reads: reads.get(d.id)! } : d)) },
    notes,
    summary,
  };
}
