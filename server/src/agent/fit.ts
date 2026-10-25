import type { DimensionSpec } from '@ddd/shared';
import type { WorkbookModel } from '../excel/workbook.js';

/**
 * Does this scorecard fit this file? A check made in code before any examiner is asked, which never stops a run and never changes a score.
 *
 * Step 3 case: a scorecard that asks whether "table X exists in schema/04_tables.sql", whether searches "have supporting indexes", or to run EXPLAIN, was
 * put against a feature list (Feature_Discovery_Schema_3A.xlsx: features, competitors and gaps, no tables at all). It scored RED 50.9, a number about the
 * mismatch and not about the file. The same file against its own scorecard scored GREEN 100.
 *
 * The one kind of mismatch found so far, and the only one checked: a question about the parts of a BUILT database (tables, indexes, SQL, foreign keys,
 * migrations, query plans) put to a file that mentions such things almost never. Measured on the 13 cached scorecard conversions in data/scorecards against
 * their files (`npm run exact:measure` pairs): it fires on 4 of 25 questions of the old Step 3 pairing and on nothing in the 11 other pairs (Step 2, the
 * correct Step 3, Step 4, Step 5, the docket, the five raw steps). A word-overlap check between every question and the file was tried and rejected:
 * it flagged 5 of the 6 questions of the correct Step 3 pairing, whose scorecard uses abstract words ("hierarchy depth") that no file repeats.
 */
const ASKS = /\b(?:tables?|indexes|indices|index(?:ed)?|ddl|sql|explain|query plans?|foreign keys?|migrations?|triggers?|constraints?|stored procedures?)\b/i;
const HOLDS = /\b(?:tables?|indexes|indices|index(?:ed)?|ddl|sql|explain|query plans?|foreign keys?|migrations?|triggers?|constraints?|stored procedures?)\b/gi;

/** A file that mentions these things this few times (in all its cells) is not a description of a built database. */
export const BUILT_PARTS_MENTIONS = 2;

export interface FitQuestion {
  id: string;
  name: string;
}

export interface ScorecardFit {
  /** Questions about the parts of a built database, put to a file that has next to none. */
  builtParts: FitQuestion[];
  /** Questions checked (those the examiners score). */
  checked: number;
  /** How many times the file mentions tables, indexes, SQL and the like in all its cells. */
  mentions: number;
}

export function mentionsOfBuiltParts(wb: WorkbookModel): number {
  let n = 0;
  for (const sheet of wb.sheetNames()) {
    n += (sheet.match(HOLDS) ?? []).length;
    for (const [, , text] of wb.cells(sheet)) {
      n += (text.match(HOLDS) ?? []).length;
      if (n > BUILT_PARTS_MENTIONS) return n;
    }
  }
  return n;
}

/** Null when the scorecard fits as far as this check can tell. `questions` are the working questions of the run (criteria already expanded). */
export function checkScorecardFit(questions: DimensionSpec[], wb: WorkbookModel): ScorecardFit | null {
  const rated = questions.filter((q) => q.measuredBy === 'raters' && !q.criterionOf?.outside);
  const asking = rated.filter((q) => ASKS.test(`${q.name} ${q.measure ?? ''}`));
  if (asking.length === 0) return null;
  const mentions = mentionsOfBuiltParts(wb);
  if (mentions > BUILT_PARTS_MENTIONS) return null;
  return { builtParts: asking.map((q) => ({ id: q.id, name: q.name })), checked: rated.length, mentions };
}

/** The plain-words note for the report. */
export function fitNote(fit: ScorecardFit): string {
  const n = fit.builtParts.length;
  const list = fit.builtParts.slice(0, 6).map((q) => `${q.id} (${q.name})`).join('; ') + (n > 6 ? '; and more' : '');
  return `Scorecard fit: ${n} of the ${fit.checked} questions ask about the tables, indexes or SQL of a built database (${list}), and this file mentions such things ${fit.mentions === 0 ? 'nowhere' : fit.mentions === 1 ? 'once' : `only ${fit.mentions} times`}, so it may not be the kind of file this scorecard was written for. The examiners scored what the file shows. If those questions score low, check that this is the right scorecard for this file before acting on the result.`;
}
