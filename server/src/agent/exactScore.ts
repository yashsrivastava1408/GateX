import type { DimensionResult, DimensionSpec } from '@ddd/shared';
import type { WorkbookModel } from '../excel/workbook.js';
import { profileWorkbook } from '../excel/profile.js';
import { emptyStats, sweepAll, type SweepFinding, type SweepStats } from './sweep.js';
import { pdfOwnChecks, sweepPdfDeep } from './pdfSweep.js';
import { statedChildLimit, statedIdPattern, sweepDeep, sweepIdFormats, sweepWidth } from './sweepDeep.js';

/**
 * Exact scores for criteria that are counts.
 *
 * A criterion such as "no duplicate ids", "every field has a definition" or "every reference resolves" is a count: code can read every row and say
 * how many are wrong. The examiners read a long sheet and skim it, so a register with eight planted mistakes used to score about the same as the
 * clean one. For each such criterion, code now computes the score from a fixed rule and the examiners' score can only be LOWER than it allows
 * (a ceiling, never a raise: a clean count proves only that these mistakes are absent, not that everything else about the criterion is fine).
 *
 * The rule (the same for every counted family except tallies):
 *
 *     clean share = 1 - (rows with a mistake / rows looked at)
 *     100%  -> 5        at least 99%   -> 4       at least 97.5% -> 3
 *     at least 95% -> 2   at least 90% -> 1       below 90%      -> 0
 *     and any mistake at all caps the score at 4.
 *
 * Tallies the file states about itself ("68 fields", "283 of 426 (66%)") are scored by how many are wrong: 5 minus the number of wrong tallies
 * (one wrong -> 4, two -> 3, ... five or more -> 0).
 *
 * A criterion is made exact only when its own words name the count (see FAMILIES). Anything else stays a judgement.
 */

export type ExactFamilyId = 'empty' | 'duplicate' | 'idformat' | 'width' | 'restate' | 'reference' | 'children' | 'allowed' | 'tally';

interface Family {
  id: ExactFamilyId;
  label: string;
  kinds: SweepFinding['kind'][];
  /** Does the criterion's own wording ask for this count? */
  asks: (text: string) => boolean;
  /** How many things the sweep looked at for this family. */
  looked: (stats: SweepStats) => number;
  /** Name a few of the wrong cells in the summary (for the families added with the deep checks, whose issues are not listed in the report). */
  cells?: boolean;
}

const GENERIC_EMPTY = /\b(?:no|zero)\s+(?:blank|empty|missing)\b|\b(?:blank|empty)\s+(?:cells?|values?|fields?|entries)\b|\bevery\s+(?:cell|column)\b[^.]{0,40}\b(?:value|filled|populated)/i;
/** "Definition present", "Cell fill", "Fields with a type", "Atomic leaves with definition, type, reason": a count of cells that must be filled. */
const PRESENT_EMPTY = /\b(?:definition|data type|type|reason|owner|source|unit|description|name)s? present\b|\bcell fill\b|\bfilled cells\b|\b(?:fields?|leaves|attributes?|rows?|entries|rules?|codes?)\s+with\s+(?:an?\s+|the\s+|all\s+\w+\s+)?(?:\S+\s+){0,2}?(?:definition|data type|type|reason|owner|source|unit|description)s?\b/i;
/** "every table stays small ... at most 40 columns", "every rule states X or a schema-wide rule covers it": a limit or a choice between two ways, not a count of filled cells. */
const NOT_A_FILL_COUNT = /\b(?:at most|no more than|more than|at least|fewer than|less than|stays?|within)\b|[≤≥]|\bor (?:a |an |the )?(?:schema|file|document|general|global|default)[- ]/i;
const NAMED_EMPTY = /\b(?:every|each|all)\b[^.]{0,80}\b(?:has|have|with|carr(?:y|ies)|states?|names?|gives?|provides?|includes?|filled|populated|recorded)\b/i;

export const FAMILIES: Family[] = [
  { id: 'empty', label: 'empty cells', kinds: ['empty_cell', 'conditional_empty'], asks: (t) => GENERIC_EMPTY.test(t) || PRESENT_EMPTY.test(t) || (NAMED_EMPTY.test(t) && !NOT_A_FILL_COUNT.test(t)), looked: (s) => s.rows },
  { id: 'duplicate', label: 'repeated ids', kinds: ['duplicate_id'], asks: (t) => /\bunique(?:ness)?\b|\bduplicat|\bdistinct ids?\b|\bone (?:id|row|entry) per\b/i.test(t), looked: (s) => s.ids },
  {
    id: 'idformat', label: 'ids that break the id pattern', kinds: ['bad_id_format'], cells: true,
    asks: (t) => /\bids?\b[^.]{0,40}\b(?:follow|match|pattern|format|well-?formed|stated pattern)|\b(?:id|identifier)s? (?:pattern|format)\b|\bnaming (?:pattern|convention)\b/i.test(t),
    looked: (s) => s.ids,
  },
  {
    id: 'width', label: 'parents with more children than the limit', kinds: ['too_wide'], cells: true,
    asks: (t) => statedChildLimit(t) !== null,
    looked: (s) => s.childCounts,
  },
  {
    id: 'restate', label: 'reasons that only repeat the definition', kinds: ['restated_reason'], cells: true,
    asks: (t) => /\b(?:reasons?|why)\b[^.]{0,60}\brestat|\brestat\w*\b[^.]{0,60}\bdefinition|\bnot (?:a )?(?:restatement|copy)\b/i.test(t),
    looked: (s) => s.rows,
  },
  {
    id: 'reference', label: 'references to ids that do not exist', kinds: ['dangling_reference', 'missing_target', 'cross_reference', 'orphan_row'], cells: true,
    asks: (t) => /\bresolv|\bdangling\b|\borphan|\bforeign keys?\b|\bcross-?sheet\b|\b(?:has|have|with) an? (?:existing |valid )?parent\b|\bbroken (?:link|ref)|\bcross-?refer|\b(?:valid|existing) (?:parent|reference|link|id)s?\b|\breferences? (?:an? )?(?:existing|valid)\b|\b(?:parent|reference|link)s? (?:exist|point|resolve)|\bids? (?:cited|referenced)\b|\bevery (?:parent|reference|ref|link)\b/i.test(t),
    looked: (s) => s.references,
  },
  {
    id: 'children', label: 'wrong child counts', kinds: ['wrong_count'],
    asks: (t) => /\bchild(?:ren)?\b[^.]{0,40}\b(?:count|match|correct|agree|accurate|right)|\b(?:counts?|numbers?) of children\b[^.]{0,30}\b(?:match|correct|right|agree)/i.test(t),
    looked: (s) => s.childCounts,
  },
  {
    id: 'allowed', label: 'values outside the allowed ones', kinds: ['invalid_value', 'near_miss_value'], cells: true,
    asks: (t) => /\b(?:hold|contain|use|take)s? only\b[^.]{0,40}\b(?:allowed|valid|permitted)|\bonly (?:allowed|valid|permitted)\b|\b(?:no )?(?:invalid|illegal|unlisted) (?:values?|entries)\b|\bvalues? (?:are |is )?(?:all )?(?:within|from|in) the (?:allowed|valid|permitted|controlled)|\bcontrolled vocabular|\b(?:from|in) the (?:allowed|permitted|controlled) (?:list|set|values)/i.test(t),
    looked: (s) => s.obligations,
  },
  {
    id: 'tally', label: 'tallies the file gets wrong', kinds: ['stated_count', 'tally_mismatch'],
    asks: (t) => /\b(?:counts?|tall(?:y|ies)|totals?|figures?)\b[^.]{0,60}\b(?:match|agree|correct|reconcil\w*|add up|consistent|accurate|stated)\b|\breconcil\w*\b|\badd up\b|\bself-?reported\b|\bstated (?:counts?|totals?)\b/i.test(t),
    looked: (s) => s.tallies,
  },
];

/** The 0-5 score for a share of clean rows. Any mistake caps it at 4. */
export function scoreForShare(clean: number, mistakes: number): number {
  const by = clean >= 1 ? 5 : clean >= 0.99 ? 4 : clean >= 0.975 ? 3 : clean >= 0.95 ? 2 : clean >= 0.9 ? 1 : 0;
  return mistakes > 0 ? Math.min(by, 4) : by;
}

/** The 0-5 score for a count of wrong tallies: five minus the number wrong. */
export const scoreForTallies = (wrong: number): number => Math.max(0, 5 - wrong);

export interface ExactCeiling {
  family: ExactFamilyId;
  /** The most this question may score. */
  ceiling: number;
  mistakes: number;
  looked: number;
  summary: string;
}

/** Whole words of a text, plural cut off, without the words every register has ("data", "value", "field"): "defined" does not match "Definition". */
const GENERIC_WORDS = new Set(['data', 'value', 'values', 'field', 'fields', 'column', 'columns', 'cell', 'cells', 'list', 'with', 'that', 'every', 'each', 'this', 'from', 'have', 'does', 'rows']);
const wordsOf = (text: string): Set<string> => new Set((text.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !GENERIC_WORDS.has(w)).map((w) => (w.length > 4 ? w.replace(/s$/, '') : w)));

/** Wording about what a gate or check can detect: a judgement about a mechanism, never a count over rows. */
export const ABOUT_A_MECHANISM = /\b(?:detects?|detection|catch(?:es)?|computed against)\b/i;
const DEEP_KINDS = new Set<SweepFinding['kind']>(['cross_reference', 'orphan_row', 'near_miss_value', 'restated_reason']);
const cellRow = (f: SweepFinding) => `${f.location.sheet}!${/\d+/.exec(f.location.cell)?.[0] ?? f.location.cell}`;

/**
 * The ceilings for every question the file's own counts settle. `questions` are the working questions of the run (criteria already expanded).
 * Returns nothing for a question whose words do not ask for one of the counted families, or when the count found no mistake.
 */
export function exactCeilings(
  questions: DimensionSpec[],
  found: SweepFinding[],
  stats: SweepStats,
  /** The ids that break the pattern a question states or shares: they depend on the question's own words. */
  ownFor?: (family: ExactFamilyId, text: string) => { found: SweepFinding[]; looked: number } | null,
): Map<string, ExactCeiling> {
  const out = new Map<string, ExactCeiling>();
  for (const q of questions) {
    if (q.measuredBy !== 'raters') continue;
    const text = `${q.name} ${q.measure ?? ''}`;
    // "Gate detects missing, duplicate and orphan requirements" is about a mechanism the file describes, not a count of duplicates in the file.
    if (ABOUT_A_MECHANISM.test(text)) continue;
    for (const fam of FAMILIES) {
      if (!fam.asks(text)) continue;
      const own = fam.id === 'idformat' || fam.id === 'width';
      let mine = own ? [] : found.filter((f) => fam.kinds.includes(f.kind));
      let lookedOverride: number | undefined;
      if (own && ownFor) {
        const r = ownFor(fam.id, text);
        if (r) {
          mine = r.found;
          lookedOverride = r.looked;
        }
      }
      // A deep check names a column or a sheet: it counts for a question only when the question talks about that column or sheet (or about orphans).
      if (mine.some((f) => DEEP_KINDS.has(f.kind))) {
        const named = wordsOf(text);
        mine = mine.filter((f) => !DEEP_KINDS.has(f.kind) || (f.kind === 'orphan_row' && /\borphan/i.test(text)) || [...wordsOf(`${f.topic} ${f.title}`)].some((w) => named.has(w)));
      }
      if (fam.id === 'empty' && !GENERIC_EMPTY.test(text)) {
        // "Every field has a definition, a type and a reason": only the columns the question names.
        const named = wordsOf(text);
        mine = mine.filter((f) => [...wordsOf(f.topic)].some((w) => named.has(w)));
      }
      if (mine.length === 0) continue;
      const rows = new Set(mine.map(cellRow));
      const mistakes = fam.id === 'tally' ? new Set(mine.map((f) => `${cellRow(f)}|${f.title}`)).size : rows.size;
      const looked = Math.max(lookedOverride ?? fam.looked(stats), mistakes);
      const ceiling = fam.id === 'tally' ? scoreForTallies(mistakes) : scoreForShare(1 - mistakes / looked, mistakes);
      const where = fam.cells ? ` (${mine.slice(0, 3).map((f) => `${f.location.sheet}!${f.location.cell}`).join(', ')}${mine.length > 3 ? ', ...' : ''})` : '';
      const summary = fam.id === 'tally'
        ? `${mistakes} of the ${looked} tallies the file states about itself ${mistakes === 1 ? 'is' : 'are'} wrong`
        : `${mistakes} of ${looked} (${((mistakes / looked) * 100).toFixed(1)}%) ${fam.label}${where}`;
      const prior = out.get(q.id);
      if (!prior || ceiling < prior.ceiling) out.set(q.id, { family: fam.id, ceiling, mistakes, looked, summary });
    }
  }
  return out;
}

/** The count over the whole file: what the sweep found, how much it looked at, and the counts that depend on a criterion's own words. */
function countFile(wb: WorkbookModel, noPdf = false) {
  const stats = emptyStats();
  const profile = profileWorkbook(wb);
  const real = { sheets: profile.sheets.filter((s) => !/^Page \d+$/.test(s.name)) };
  const found = [...sweepAll(wb, { all: true, stats, noPdf }), ...sweepDeep(wb, real, { all: true, stats }), ...(noPdf ? [] : sweepPdfDeep(wb, { all: true, stats }))];
  const own = (family: ExactFamilyId, text: string): { found: SweepFinding[]; looked: number } | null => {
    if (family !== 'idformat' && family !== 'width') return null;
    const mine = family === 'idformat' ? sweepIdFormats(wb, real, statedIdPattern(text), { all: true }) : sweepWidth(wb, real, statedChildLimit(text), { all: true });
    // The tables of a PDF are counted the same way, and their ids and parents add to the sheets' (a file is one or the other in practice).
    const pdf = noPdf ? null : pdfOwnChecks(wb, family, text, { all: true });
    return pdf ? { found: [...mine.found, ...pdf.found], looked: mine.looked + pdf.looked } : mine;
  };
  return { stats, found, own };
}

/** Runs the full count over the file and returns the ceilings. Cheap: one pass over the cells. */
export function exactCeilingsFor(questions: DimensionSpec[], wb: WorkbookModel): Map<string, ExactCeiling> {
  const { stats, found, own } = countFile(wb);
  return exactCeilings(questions, found, stats, own);
}

/**
 * Which questions the file's own counts actually looked at. A question can ask for a count (its words say "unique ids") and still get no
 * ceiling because the code read no rows for it (a PDF whose tables were never swept); this says, per question, how many things each asked
 * family looked at, so the share that is truly counted (and not only worded as a count) can be measured. `pdf: false` is the count without the
 * tables of a PDF.
 */
export function exactCoverage(questions: DimensionSpec[], wb: WorkbookModel, options: { pdf?: boolean } = {}): Map<string, Array<{ family: ExactFamilyId; looked: number }>> {
  const { stats, own } = countFile(wb, options.pdf === false);
  const out = new Map<string, Array<{ family: ExactFamilyId; looked: number }>>();
  for (const q of questions) {
    if (q.measuredBy !== 'raters') continue;
    const text = `${q.name} ${q.measure ?? ''}`;
    if (ABOUT_A_MECHANISM.test(text)) continue;
    const covered = FAMILIES.filter((f) => f.asks(text))
      .map((f) => ({ family: f.id, looked: own(f.id, text)?.looked ?? f.looked(stats) }))
      .filter((c) => c.looked > 0);
    if (covered.length > 0) out.set(q.id, covered);
  }
  return out;
}

/**
 * Lowers each rated question to its ceiling. A score is only ever lowered; a question the examiners could not score, or that code scored, is
 * left as it is. Returns the notes that explain each cap.
 */
export function applyExactCeilings(results: DimensionResult[], ceilings: ReadonlyMap<string, ExactCeiling>): { results: DimensionResult[]; notes: string[] } {
  const notes: string[] = [];
  const next = results.map((d) => {
    const c = ceilings.get(d.id);
    if (!c || d.measuredBy !== 'raters' || d.status !== 'scored' || d.consolidated === null || d.consolidated <= c.ceiling) return d;
    notes.push(`${d.id} was set to ${c.ceiling} (the examiners gave ${d.consolidated}): code counted ${c.summary}.`);
    return { ...d, consolidated: c.ceiling, rationale: `${d.rationale} Set to ${c.ceiling} by an exact count (the examiners gave ${d.consolidated}): ${c.summary}.` };
  });
  return { results: next, notes };
}
