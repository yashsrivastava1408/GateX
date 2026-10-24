import type { DimensionSpec, Scorecard } from '@ddd/shared';
import type { WorkbookModel } from './workbook.js';

/** Pages added to each question on top of the ones the scorecard names. */
export const EXTRA_PAGES = 3;

const PAGE = /^Page \d+$/;
const STOP = new Set(
  'the and for are with that this from have has not all any each must should shall can will its into than then them they their there what when where which who how why was were been being out one two use used using per via also only more most such other about over under between within without across'.split(' '),
);

const wordsOf = (text: string): string[] =>
  (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP.has(w));

const dimensionText = (d: DimensionSpec): string =>
  [d.name, d.description, d.measure, ...Object.values(d.anchors ?? {})].filter(Boolean).join(' ');

/**
 * The page ranges a scorecard names were chosen by a model that saw only the first lines of each page, so they can miss
 * the page that holds the evidence. For a PDF, this adds the few pages whose text best matches each question's own
 * words (rarer words count more). It only adds, never removes, only from pages the scorecard already lets raters see,
 * and the same file and scorecard always give the same pages. A workbook, or a question with no `reads`, is untouched.
 */
export function addRelevantPages(scorecard: Scorecard, wb: WorkbookModel, extra = EXTRA_PAGES): Scorecard {
  const allowed = scorecard.artifact.sheets.map((s) => wb.resolveSheet(s.name)).filter((n): n is string => !!n && PAGE.test(n));
  if (extra <= 0 || allowed.length === 0) return scorecard;

  const counts = new Map<string, Map<string, number>>();
  const df = new Map<string, number>();
  for (const page of allowed) {
    const tf = new Map<string, number>();
    for (const [, , text] of wb.cells(page)) for (const w of wordsOf(text)) tf.set(w, (tf.get(w) ?? 0) + 1);
    counts.set(page, tf);
    for (const w of tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  }
  const idf = (w: string) => Math.log(1 + allowed.length / (df.get(w) ?? 1));

  const pick = (d: DimensionSpec): string[] => {
    const have = new Set((d.reads ?? []).map((r) => r.toLowerCase()));
    const terms = [...new Set(wordsOf(dimensionText(d)))].filter((w) => df.has(w));
    if (terms.length === 0) return [];
    return allowed
      .filter((p) => !have.has(p.toLowerCase()))
      .map((p) => ({ p, s: terms.reduce((sum, w) => sum + idf(w) * Math.log(1 + (counts.get(p)!.get(w) ?? 0)), 0) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.p.localeCompare(b.p, undefined, { numeric: true }))
      .slice(0, extra)
      .map((x) => x.p);
  };

  return {
    ...scorecard,
    dimensions: scorecard.dimensions.map((d) =>
      d.measuredBy === 'raters' && d.reads && d.reads.length > 0 ? { ...d, reads: [...d.reads, ...pick(d)] } : d,
    ),
  };
}
