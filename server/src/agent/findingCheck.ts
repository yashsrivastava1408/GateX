import type { DroppedFinding } from '@ddd/shared';
import { SEVERITY_ORDER } from '@ddd/shared';
import { profileWorkbook, sheetProfile, type ColumnProfile, type WorkbookProfile } from '../excel/profile.js';
import { columnIndex, type WorkbookModel } from '../excel/workbook.js';
import type { DraftFinding } from './types.js';

/**
 * A fact check and a duplicate merge for the examiners' findings, done by code against the workbook itself (via its
 * profile), so no model is asked to mark its own homework.
 *
 *   Fact check   A finding that says something is missing is tested against the file. When it names rows and a column,
 *                each cell is read: rows that are in fact filled are taken out of the claim, and the finding is dropped
 *                when none is left. When it names things a column plainly holds (for example "no data type" on a sheet
 *                whose "Type and format" column is 96% filled, said of every field), it is dropped. Each drop keeps its
 *                reason. Conservative on purpose: only a plain contradiction drops a finding, and severity never goes up.
 *   Merge        Findings in the same dimension about the same thing (same cell and similar words, very similar
 *                titles, or the same column and overlapping rows) become one: highest severity, every examiner who
 *                reported it, the best-supported wording.
 *
 * Code findings are never touched: they come from exact counts.
 */

export interface FindingCheckResult {
  findings: DraftFinding[];
  dropped: DroppedFinding[];
  /** Findings folded into another one. */
  merged: number;
  /** Findings whose claim was narrowed to the rows the file confirms. */
  narrowed: number;
  notes: string[];
}

/* ------------------------------- words ------------------------------- */

const GENERIC = new Set([
  'with', 'that', 'this', 'from', 'each', 'every', 'have', 'into', 'only', 'what', 'which', 'their', 'there', 'where', 'when',
  'does', 'were', 'been', 'being', 'also', 'such', 'than', 'then', 'these', 'those', 'they', 'them', 'some', 'many', 'most',
  'more', 'multiple', 'several', 'other', 'various', 'actual', 'clear', 'clearly', 'proper', 'properly', 'explicit',
  'explicitly', 'required', 'requires', 'corresponding', 'relevant', 'specific', 'within', 'across', 'about', 'should', 'would',
  'could', 'must', 'make', 'makes', 'sheet', 'artifact', 'schema', 'workbook', 'file', 'document', 'dimension', 'measure',
  // Words that name a kind of thing rather than the thing, so "evidence of X" or "a section for X" is not about a column called Evidence or Section.
  'evidence', 'section', 'sections', 'parameter', 'parameters', 'coverage', 'documentation', 'approach', 'structure', 'mapping',
  'information', 'data', 'rationale', 'process', 'field', 'fields', 'column', 'columns', 'entry', 'entries', 'value', 'values',
  'level', 'note', 'notes', 'list', 'item', 'items', 'details', 'definition', 'rule', 'rules',
]);
/** Different words for the same thing, so "permissible values" finds an "Allowed values" column. */
const SYNONYMS: Record<string, string> = { permi: 'allow', permit: 'allow', datat: 'type', descr: 'defin' };
/** Words that only say something is absent; they carry no meaning about *what* is absent. */
const ABSENCE_WORDS = new Set(['missing', 'absent', 'lacks', 'lack', 'lacking', 'without', 'none', 'specified', 'unspecified', 'provided', 'defined', 'undefined', 'declared', 'stated', 'documented', 'found']);

/** A word cut to a stem: plural "s" dropped, then five letters, so "codes", "code" and "coded" meet. */
const stem = (word: string) => {
  const s = word.toLowerCase().replace(/(ies)$/, 'y').replace(/(?<=[a-z]{3})s$/, '').slice(0, 5);
  return SYNONYMS[s] ?? s;
};

function stemsOf(text: string, drop: Set<string> = GENERIC): string[] {
  return (text.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((w) => w.length >= 4 && !drop.has(w)).map(stem);
}

/** The distinctive word stems of a text (generic words and the words that only say "missing" removed), for matching a claim to the cells that could settle it. */
export const keyStems = (text: string): string[] => [...topic(text)];

/** What a finding is about, without the words that only say "missing". */
function topic(text: string): Set<string> {
  return new Set(stemsOf(text).filter((s) => ![...ABSENCE_WORDS].some((a) => stem(a) === s)));
}

const jaccard = (a: Set<string>, b: Set<string>) => {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / (a.size + b.size - shared);
};

/* --------------------------- absence claims --------------------------- */

const ABSENCE = /\b(missing|absent|lacks?|lacking|without|no|none of|not (?:provided|specified|defined|declared|stated|documented|given|listed|included|present)|does not (?:provide|define|specify|declare|include|list|contain|state|give|record|have)|do not (?:provide|define|specify|declare|include|list|contain|state|give|record|have))\b/i;

/** Says something is absent, as opposed to wrong, unclear or cut off. */
export const claimsAbsence = (f: Pick<DraftFinding, 'title' | 'detail'>) => ABSENCE.test(f.title) || ABSENCE.test(f.detail);

/** Said of everything ("no fields in the schema declare ...", "none of the rules", "not at all"), not of some. */
const UNIVERSAL = /\b(no (?:fields?|rows?|columns?|entries|parameters?|rules?|items?|values?)\b|none of|not any|no\b[^.]{0,60}\bin the (?:schema|sheet|artifact|workbook|file|register)|anywhere|at all|entirely|completely lack)/i;

/** Things longer than this are descriptions of a gap ("evidence of downstream input coverage"), not a column's content. */
const MAX_THING_WORDS = 3;

/**
 * The short things a finding says are missing: the words right after the absence phrase ("lacks a version parameter"), a
 * list after a colon in that sentence ("required elements: data type, permissible values, or representation class"), or a
 * title of the form "Code definitions absent". Words before the phrase are not used: "why no actors are missing" is not a
 * claim that actors are missing.
 */
export function absentThings(text: string): string[] {
  const things: string[] = [];
  const keep = (t: string) => {
    const words = topic(t);
    if (words.size > 0 && words.size <= MAX_THING_WORDS) things.push(t.trim());
  };
  const title = /^(.{3,60}?)\s+(?:absent|missing|not (?:specified|defined|provided|declared|stated|documented))\.?$/i.exec(text.trim());
  if (title) keep(title[1]!);
  for (const sentence of text.split(/(?<=[.;!?])\s+/)) {
    const hit = ABSENCE.exec(sentence);
    if (!hit) continue;
    const colon = sentence.indexOf(':', hit.index);
    if (colon >= 0) for (const part of sentence.slice(colon + 1).split(/,|\bor\b|\band\b/)) keep(part.replace(/[.;]$/, ''));
    const after = sentence.slice(hit.index + hit[0].length);
    // "why no actors are missing" says nothing is missing.
    if (/^\s*[\w\s-]{1,40}?\b(?:is|are|was|were)\s+(?:missing|absent|lacking|left out|omitted)\b/i.test(after)) continue;
    const object = after.split(/\b(?:in|on|for|from|within|across|to|which|that|so|because|while|but|per|as|is|are|was|were|with)\b|[,.(:;]/)[0]!;
    keep(object.replace(/^\s*(?:the|any|a|an|clear|actual|explicit)\s+/i, ''));
  }
  return [...new Set(things.map((t) => t.replace(/^(?:the|any|a|an|clear|actual|explicit)\s+/i, '').trim()))];
}

/**
 * A column on the cited sheet that plainly holds the thing: every word of the thing is in its title, it holds text, codes or
 * ids (a count such as "# codes" proves nothing about definitions), and it is nearly always filled.
 */
function columnHolding(profile: WorkbookProfile, sheet: string, thing: string, minFill: number): ColumnProfile | null {
  const words = topic(thing);
  const sheetProf = sheetProfile(profile, sheet);
  if (!sheetProf || words.size === 0) return null;
  return (
    sheetProf.columns.find((c) => {
      if (!c.title || c.fillRate < minFill || !(c.kind === 'text' || c.kind === 'code' || c.kind === 'id')) return false;
      const title = new Set(stemsOf(c.title, new Set()).map((w) => SYNONYMS[w] ?? w));
      return [...words].every((w) => title.has(w));
    }) ?? null
  );
}

/* ------------------------------ row claims ----------------------------- */

interface RowClaim {
  sheet: string;
  column: string;
  rows: number[];
}

const MAX_ROWS_PER_CLAIM = 2000;

function expand(list: string): number[] {
  const rows: number[] = [];
  for (const part of list.split(/,|\band\b/)) {
    const range = /(\d+)\s*-\s*(\d+)/.exec(part);
    const single = /(\d+)/.exec(part);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])];
      if (b >= a && b - a < MAX_ROWS_PER_CLAIM) for (let r = a; r <= b; r++) rows.push(r);
    } else if (single) rows.push(Number(single[1]));
  }
  return rows;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A sentence that only gives examples of the one before it ("Examples include rows 47-52 ..."). */
const EXAMPLES = /^(?:examples?\b|for example|e\.g\.|such as|these\b|including|rows?\b)/i;

/**
 * The cells a finding says are empty: "rows 47-52, 122 ... no tags in column S", "M85-86 lack ...", or rows plus a column
 * named by its title ("rows 43-44 ... lack Definition and Reason columns"). Only rows and cells in a sentence that says
 * something is missing count (or in the sentence of examples right after it), and only a column the missing thing is about:
 * "rules in column O but no tags in column S" tests S, and "row 14 lacks an article" tests nothing. Rows followed by
 * "in <other sheet>" belong to that sheet.
 */
export function rowClaims(f: DraftFinding, profile: WorkbookProfile): RowClaim[] {
  const home = f.location?.sheet;
  const sheetNames = profile.sheets.map((s) => s.name);
  const sentences = f.detail.split(/(?<=[.;!?])\s+(?=[A-Z(])/);
  const claims: RowClaim[] = [];
  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i]!;
    const hit = ABSENCE.exec(sentence);
    if (!hit) continue;
    const tail = sentence.slice(hit.index);
    const object = new Set(stemsOf(tail.slice(hit[0].length).split(/[.;]/)[0]!, new Set()));
    const scope = EXAMPLES.test(sentences[i + 1] ?? '') ? `${sentence} ${sentences[i + 1]}` : sentence;
    const about = (sheet: string, letter: string) => {
      const column = sheetProfile(profile, sheet)?.columns.find((c) => c.letter === letter);
      return Boolean(column && stemsOf(column.title, new Set()).some((w) => object.has(w)));
    };

    // Cell addresses, "M59" or "M85-86". Not ids such as "D1-S01-P10" or "ACT-10", nor zero-padded codes such as "G04".
    for (const m of scope.matchAll(/(?<![\w-])([A-Z]{1,3})([1-9]\d{0,5})(?:\s*-\s*(\d{1,6}))?(?![\w-]|-[A-Za-z])/g)) {
      const [col, a, b] = [m[1]!, Number(m[2]), m[3] ? Number(m[3]) : Number(m[2])];
      if (home && b >= a && b - a < MAX_ROWS_PER_CLAIM && about(home, col)) {
        claims.push({ sheet: home, column: col, rows: Array.from({ length: b - a + 1 }, (_, k) => a + k) });
      }
    }

    // Row lists: "rows 47-52, 122-123, 124, and 137".
    const rowList = /\brows?\s+(\d+(?:\s*-\s*\d+)?(?:\s*(?:,|,?\s*and)\s*\d+(?:\s*-\s*\d+)?)*)/gi;
    for (const m of scope.matchAll(rowList)) {
      const rows = expand(m[1]!);
      const after = scope.slice(m.index! + m[0].length, m.index! + m[0].length + 60);
      const named = sheetNames.find((n) => new RegExp(`^\\s*(?:in|of|on)\\s+(?:the\\s+)?(?:sheet\\s+)?${escape(n)}\\b`, 'i').test(after));
      const sheet = named ?? home;
      if (!sheet || rows.length === 0) continue;
      const sp = sheetProfile(profile, sheet);
      if (!sp) continue;
      // Which column is said to be empty: a letter after the absence phrase, else titles named after it, else the cited cell's column.
      const letters = [...tail.matchAll(/\bcolumns?\s+([A-Z]{1,3})\b|\(column\s+([A-Z]{1,3})\)/g)].map((x) => x[1] ?? x[2]!);
      const titled = sp.columns.filter((c) => c.title.length >= 3 && new RegExp(`\\b${escape(c.title)}\\b`, 'i').test(tail)).map((c) => c.letter);
      const fromCell = !named && f.location && f.location.sheet === sheet ? [/^[A-Z]+/.exec(f.location.cell)?.[0]].filter((x): x is string => Boolean(x)) : [];
      const columns = (letters.length > 0 ? letters : titled.length > 0 ? titled : fromCell).filter((c) => about(sheet, c));
      for (const column of [...new Set(columns)]) claims.push({ sheet, column, rows });
    }
  }
  return claims;
}

/** Placeholders that hold a cell's place without giving its content. */
const PLACEHOLDER = /^(?:tbd|tbc|todo|to do|n\/?a|unknown|unspecified|pending|-|—|–|\?+)$/i;

const isEmpty = (wb: WorkbookModel, sheet: string, column: string, row: number) => {
  const text = (wb.cellText(sheet, `${column}${row}`) ?? '').trim();
  return text === '' || PLACEHOLDER.test(text);
};

const ranges = (rows: number[]): string => {
  const sorted = [...new Set(rows)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    out.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return out.join(', ');
};

/* ------------------------------ the check ----------------------------- */

type Verdict = { keep: true; finding: DraftFinding; narrowed: boolean } | { keep: false; reason: string };

/* ---------------------------- vague findings --------------------------- */

/** Words that soften a claim into a possibility or a share ("some rules ... could lead to"). */
const HEDGED =
  /\b(?:some|many|several|may|might|could|potentially|possibly|minor|generally|unclear|not (?:cover|covered|fully|all|completely|systematically|clearly|sufficiently|clear))\b|\bit is not clear\b/i;
/** The scorecard's own score wording handed back as a finding ("minor gaps that do not affect the outcome", "required for a perfect score"). */
const RESTATES_THE_SCORE = /\bminor gaps?\b[^.]{0,40}\b(?:do(?:es)? not|cannot|can't|won't)\s+(?:change|affect|alter)\b|\bperfect score\b|\bgap that cannot change an outcome\b/i;
/** Something a person could go and look at: a number, a quoted phrase, an id such as VR-22 or ACT-01, or an acronym such as DPDP. */
const ANCHOR = /(?<![A-Za-z_])\d|\b[A-Z]{1,3}\d+\b|["“”‘’'][^"“”‘’']{3,}["“”‘’']|\b[A-Z][A-Z0-9]{1,}[-_][A-Z0-9]+\b|\b[A-Z]{3,}\b/;
/** A finding this short and this loose cannot be fixed or checked, so it is noise. */
const VAGUE_MAX_CHARS = 260;

/**
 * A finding that names nothing to look at and only says that "some" things "could" be wrong. The detail is read without the
 * "[Also reported as ...]" tail a merge adds, which carries other examiners' titles. Findings that say something specific is
 * missing ("does not state which risks this controls") are not hedged and are kept.
 */
export function restatesTheScore(f: Pick<DraftFinding, 'title' | 'detail'>): boolean {
  return RESTATES_THE_SCORE.test(`${f.title}. ${f.detail}`);
}

export function isVague(f: Pick<DraftFinding, 'title' | 'detail'>): boolean {
  // A page or line number says where, not what, so "Page 3" does not make a finding concrete.
  const detail = f.detail.replace(/\s*\[(?:Also reported as|Fact check):.*$/s, '').replace(/\b(?:pages?|lines?)\s+\d+(?:\s*(?:,|and|-|to)\s*\d+)*/gi, '').trim();
  return detail.length <= VAGUE_MAX_CHARS && HEDGED.test(detail) && !ANCHOR.test(detail);
}

/**
 * "No evidence of a blind second run" about a criterion the scorecard says needs evidence from outside the file. The scorecard already
 * handles that with a cap on the score (GS-1: 3), so the same complaint must not also block green as a defect of the file.
 */
export const complainsAboutOutsideEvidence = (f: Pick<DraftFinding, 'dimensionId' | 'title' | 'detail'>, outsideCriteria: ReadonlySet<string>) =>
  outsideCriteria.has(f.dimensionId) && claimsAbsence(f);

/* ------------------- complaints about what the rater was shown ------------------ */

/**
 * "The sheet was not provided", "feature names are not visible in the provided artifact": the rater saw only part of the file and
 * blames the file. That is a fact about the prompt, not a defect in the work, so such a finding is dropped. (Prompt rule 11 asks
 * raters not to write them; this catches the ones that still do.)
 */
const ABOUT_THE_PROMPT = /\bnot\s+(?:visible|shown)\s+in\s+the\s+(?:provided|given|supplied|shared)\s+(?:artifact|sheets?|excerpt|data|text|content)|\b(?:was|were)\s+not\s+provided\s+(?:to|for)\b|\bnot\s+provided\s+to\s+(?:verify|check|confirm|assess|evaluate)|\bin\s+the\s+(?:provided|given|supplied)\s+(?:artifact|sheets?)\b[^.]{0,40}\bnot\s+visible\b/i;

export const complainsAboutThePrompt = (f: Pick<DraftFinding, 'title' | 'detail'>) => ABOUT_THE_PROMPT.test(`${f.title}. ${f.detail}`);

/* ------------------- asking the file for work done outside it ------------------- */

/**
 * "No evidence of two independent runs", "no author interview results", "no reviewer spot-checks": these name a step that people or other
 * runs carry out beside the file, so no file can show it. The scorecard already handles such a question with its own cap, and the same
 * complaint must not also count as a defect of the file. Read from the labelled runs: 11 findings of this kind were wrong and none was real
 * or partly right. A workbook that has a sheet for such work (runs, interviews, agreement, spot-checks) is left to the examiners.
 */
const OUTSIDE_WORK =
  /\b(?:independent(?:ly)?\s+(?:build\s+|generation\s+)?(?:runs?|derivations?|fills?)|second\s+(?:independent\s+)?(?:runs?|derivations?|analyst|fill)|blind\s+(?:second\s+)?(?:derivations?|runs?)|run\s+B\b|two\s+(?:independent\s+)?runs|author\s+(?:interview|answers?|understanding)|reviewer\s+spot-?checks?)\b/i;
const OUTSIDE_WORK_SHEET = /run|interview|agreement|spot|blind|derivation/i;

export const asksFileForOutsideWork = (f: Pick<DraftFinding, 'title' | 'detail'>, sheetNames: readonly string[] = []) =>
  claimsAbsence(f) && OUTSIDE_WORK.test(`${f.title}. ${f.detail}`) && !sheetNames.some((n) => OUTSIDE_WORK_SHEET.test(n));

/* ------------------- a finding that says the work is fine ------------------- */

/** "Which appears consistent. However, this should be verified", "TH-008 (SPOOFING) is present ... despite its presence": the finding itself reports no defect. */
const SAYS_ITS_FINE = /\b(?:appears?|seems?)\s+(?:to be\s+)?(?:consistent|correct|fine|complete|well[- ]defined)\b|\bdespite\s+(?:its|their)\s+presence\b/i;
export const saysTheWorkIsFine = (f: Pick<DraftFinding, 'title' | 'detail'>) => SAYS_ITS_FINE.test(`${f.title}. ${f.detail}`);

/* ------------------- asking a schema for filled data ------------------- */

/**
 * "Test links defined but not shown populated": a schema defines fields; it does not hold the rows a user will fill in later. Said about the schema's own
 * templates or definitions, that is not a defect. Applies only to a scorecard that judges schema design, and not when the complaint is about sample content
 * the workbook does hold (personas, actors, permission rows).
 */
const NOT_POPULATED = /\bnot\s+(?:yet\s+)?(?:shown\s+)?(?:populated|filled(?:\s+in)?)\b|\bno\s+(?:actual|filled|populated|instance)\s+(?:data|rows|instances|records|values)\b/i;
const ABOUT_THE_SCHEMA = /\b(?:schema|template|definition|defined|D\d-S\d+)\b/i;
const ABOUT_HELD_CONTENT = /\b(?:persona|actor|permission row|register entr|content sheet)\w*\b/i;
export const asksSchemaForFilledData = (f: Pick<DraftFinding, 'title' | 'detail'>) => {
  const text = `${f.title}. ${f.detail}`;
  return NOT_POPULATED.test(text) && ABOUT_THE_SCHEMA.test(text) && !ABOUT_HELD_CONTENT.test(text);
};

/* ------------------- a named column that is a cell of the file ------------------- */

const QUOTE = `['"“‘]([^'"”’]{3,60})['"”’]`;
const KIND = '(?:column|field|sheet|row|section|header|attribute|value set|list)';
/** "the column 'Gap description' is missing", "'Priority' is absent", "no 'Decision' column", "missing the field 'Owner'". */
const NAMED_MISSING = [
  new RegExp(`${QUOTE}\\s+${KIND}?\\s*(?:is|are|was|were)\\s+(?:missing|absent|not\\s+(?:found|present|defined|declared|included|listed))`, 'i'),
  new RegExp(`\\b(?:missing|lacks?|without|absent|no)\\s+(?:the\\s+|an?\\s+)?${KIND}\\s+${QUOTE}`, 'i'),
  new RegExp(`\\b(?:no|missing)\\s+${QUOTE}\\s+${KIND}`, 'i'),
];

/** The name a finding says is missing, when it is quoted and called a column, field, sheet and so on. */
export function namedMissing(text: string): string[] {
  const out = new Set<string>();
  for (const re of NAMED_MISSING) {
    const hit = re.exec(text);
    if (hit?.[1]) out.add(hit[1].trim());
  }
  return [...out];
}

/** Where a cell on the sheet (or anywhere, when no sheet is cited) says exactly this name. */
function cellSaying(wb: WorkbookModel, name: string, sheet?: string): string | null {
  const want = name.toLowerCase().replace(/\s+/g, ' ');
  const sheets = sheet && wb.resolveSheet(sheet) ? [wb.resolveSheet(sheet)!] : wb.sheetNames();
  for (const s of sheets) {
    for (const [row, col, text] of wb.cells(s)) {
      if (text.length <= 80 && text.toLowerCase().replace(/\s+/g, ' ').trim() === want) return `${s}!${columnLettersOf(col)}${row}`;
    }
  }
  return null;
}

/* ----------------------- missing things the file holds ---------------------- */

/** Words of a sheet name or cell, so "Exit_Gate_Checks" gives exit, gate and check. */
const wordsOf = (text: string) => new Set(stemsOf(text, new Set()));

/** How many places in the file mention every word of the thing: a sheet name, a column title, or a cell. */
export function placesHolding(wb: WorkbookModel, thing: string, onlySheets?: string[]): { count: number; example: string } {
  const need = [...topic(thing)];
  if (need.length < 2) return { count: 0, example: '' };
  let count = 0;
  let example = '';
  const note = (where: string) => {
    count++;
    if (!example) example = where;
  };
  for (const sheet of wb.sheetNames()) {
    if (onlySheets && !onlySheets.includes(sheet)) continue;
    if (need.every((w) => wordsOf(sheet).has(w))) note(`sheet "${sheet}"`);
    for (const [row, col, text] of wb.cells(sheet)) {
      if (text.length < 4 || text.length > 600) continue;
      const have = wordsOf(text);
      if (need.every((w) => have.has(w))) note(`${sheet}!${columnLettersOf(col)}${row}`);
    }
  }
  return { count, example };
}

const columnLettersOf = (index: number): string => {
  let out = '';
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
};

/** Places needed before "it is missing" counts as contradicted: one mention could be the finding's own subject. */
const MIN_PLACES = 3;

/** Fact-checks one examiner finding against the file. */
export function checkFinding(f: DraftFinding, wb: WorkbookModel, profile = profileWorkbook(wb), schemaDesign = false): Verdict {
  if (f.source !== 'raters') return { keep: true, finding: f, narrowed: false };
  if (schemaDesign && asksSchemaForFilledData(f)) {
    return { keep: false, reason: 'It asks a schema for filled example rows. A schema defines the fields; the rows are filled in when it is used.' };
  }
  if (asksFileForOutsideWork(f, wb.sheetNames())) {
    return { keep: false, reason: 'It asks the file for proof of work done outside it (independent runs, an author interview, reviewer spot-checks). A file cannot show that; the scorecard handles it with its own cap.' };
  }
  if (saysTheWorkIsFine(f)) {
    return { keep: false, reason: 'The finding itself says the thing appears consistent or is present, so it reports no defect.' };
  }
  if (complainsAboutThePrompt(f)) {
    return { keep: false, reason: 'It says something was not provided or not visible to the examiner. That describes what the examiner was shown, not a defect in the file.' };
  }
  if (restatesTheScore(f)) {
    return { keep: false, reason: 'It repeats the wording of the score ("minor gaps that do not change an outcome") instead of describing a defect.' };
  }
  if (isVague(f)) {
    return { keep: false, reason: 'It names nothing to look at: it says only that some things could be wrong, with no id, number, quote or name.' };
  }
  if (!claimsAbsence(f)) return { keep: true, finding: f, narrowed: false };

  // 0a. A column, field or sheet it names as missing is a cell of the file, word for word.
  for (const name of namedMissing(`${f.title}. ${f.detail}`)) {
    const at = cellSaying(wb, name, f.location?.sheet);
    if (at) return { keep: false, reason: `It says "${name}" is missing, but cell ${at} says exactly that.` };
  }
  // 0b. The thing said to be missing is named in several places of the file (a sheet, a title, a definition).
  const quality = QUALITY.test(f.title) || QUALITY.test(f.detail);
  if (!quality) {
    // A claim about a sheet it names ("L4_Attribute_Guide has no worked example") is tested on that sheet only.
    const text = `${f.title} ${f.detail}`.toLowerCase();
    const named = wb.sheetNames().filter((n) => text.includes(n.toLowerCase()));
    for (const thing of [...new Set(absentThings(f.title).concat(absentThings(f.detail)).map((t) => t.toLowerCase().replace(/["“”]/g, '').trim()))]) {
      const found = placesHolding(wb, thing, named.length > 0 ? named : undefined);
      if (found.count >= MIN_PLACES) {
        return { keep: false, reason: `It says "${thing}" is missing, but the file names it in ${found.count} places (first: ${found.example}).` };
      }
    }
  }

  // 1. Named cells: read each one.
  const claims = rowClaims(f, profile)
    .filter((c) => wb.resolveSheet(c.sheet) && columnIndex(c.column) > 0)
    // The header row and anything above it are titles, not data.
    .map((c) => ({ ...c, rows: c.rows.filter((r) => r > (sheetProfile(profile, wb.resolveSheet(c.sheet)!)?.headerRow ?? 0)) }))
    .filter((c) => c.rows.length > 0);
  if (claims.length > 0) {
    const empty: string[] = [];
    const filled: string[] = [];
    for (const c of claims) {
      const sheet = wb.resolveSheet(c.sheet)!;
      const rows = c.rows;
      const blank = rows.filter((r) => isEmpty(wb, sheet, c.column, r));
      const full = rows.filter((r) => !isEmpty(wb, sheet, c.column, r));
      if (blank.length > 0) empty.push(`${sheet} column ${c.column} rows ${ranges(blank)}`);
      if (full.length > 0) filled.push(`${sheet} column ${c.column} rows ${ranges(full)}`);
    }
    if (empty.length === 0) {
      return { keep: false, reason: `Every cell it names is filled (${filled.join('; ')}).` };
    }
    // The cells it names were read and are empty: the claim is proved by the file itself, which the report tiers as confirmed.
    const proof = `Code read the cells the finding names and they are empty: ${empty.join('; ')}.`;
    if (filled.length > 0) {
      const detail = `${f.detail} [Fact check: confirmed empty in ${empty.join('; ')}. Filled, so taken out of the claim: ${filled.join('; ')}.]`;
      return { keep: true, finding: { ...f, detail, proof }, narrowed: true };
    }
    return { keep: true, finding: { ...f, proof }, narrowed: false };
  }

  // 2. Named things: does a nearly full column on the cited sheet hold them? Only for a claim about everything ("no fields
  // declare a data type"): "some actions lack clear audit coverage" is about quality, and a full column does not contradict it.
  if (!f.location || QUALITY.test(f.title) || QUALITY.test(f.detail)) return { keep: true, finding: f, narrowed: false };
  if (!UNIVERSAL.test(f.detail) && !UNIVERSAL.test(f.title)) return { keep: true, finding: f, narrowed: false };
  const sheet = wb.resolveSheet(f.location.sheet);
  if (!sheet) return { keep: true, finding: f, narrowed: false };
  const minFill = 0.9;
  const things = absentThings(f.detail).concat(absentThings(f.title));
  const unique = [...new Set(things.map((t) => t.toLowerCase()))];
  if (unique.length === 0) return { keep: true, finding: f, narrowed: false };
  const held = unique
    .map((t) => ({ thing: t, column: columnHolding(profile, sheet, t, minFill) }))
    // A column full of "TBD" holds nothing, and a finding pointing at an empty cell of that column is about that cell.
    .filter((h) => h.column && realFill(wb, sheet, h.column, profile) >= minFill && !citesEmptyCellOf(f, wb, sheet, h.column.letter));
  // Drop only when most of what it says is missing is plainly there; one match among many claims is not a contradiction.
  if (held.length > 0 && held.length * 2 >= unique.length) {
    const said = held.map((h) => `"${h.thing}": column ${h.column!.letter} "${h.column!.title}" is ${Math.round(h.column!.fillRate * 100)}% filled`).join('; ');
    const rest = unique.filter((t) => !held.some((h) => h.thing === t));
    return { keep: false, reason: `The file holds what it says is missing (${said})${rest.length > 0 ? `; not checked: ${rest.join(', ')}` : ''}.` };
  }
  return { keep: true, finding: f, narrowed: false };
}

/** "Not clear", "insufficient", "some ... lack": a claim about how good something is, which a filled column cannot settle. */
const QUALITY = /\b(?:insufficient|inadequate|unclear|incomplete|inconsistent|weak|vague|partial|partially|not (?:clear|clearly|explicit|sufficient|systematic|consistent)|(?:no|lacks?|without|not provide)\s+(?:clear|proper|sufficient|adequate|explicit|systematic|consistent|complete|detailed|meaningful)|some\b)/i;

/** The share of data rows with real content in a column: placeholders such as "TBD" do not count. */
function realFill(wb: WorkbookModel, sheet: string, column: ColumnProfile, profile: WorkbookProfile): number {
  const sp = sheetProfile(profile, sheet);
  if (!sp || sp.dataRows === 0) return 0;
  let real = 0;
  for (const [row, col, text] of wb.cells(sheet)) if (col === column.index && row > sp.headerRow && text.trim() !== '' && !PLACEHOLDER.test(text.trim())) real++;
  return real / sp.dataRows;
}

function citesEmptyCellOf(f: DraftFinding, wb: WorkbookModel, sheet: string, letter: string): boolean {
  const m = /^([A-Z]+)(\d+)$/.exec(f.location?.cell ?? '');
  return Boolean(m && m[1] === letter && isEmpty(wb, sheet, letter, Number(m[2])));
}

/* ------------------------------ the merge ----------------------------- */

const MERGE_SAME_CELL = 0.2;
const MERGE_TITLES = 0.5;
const MERGE_SAME_SHEET = 0.3;

function sameThing(a: DraftFinding, b: DraftFinding, aRows: RowClaim[], bRows: RowClaim[]): boolean {
  if (a.dimensionId !== b.dimensionId) return false;
  const titles = jaccard(topic(a.title), topic(b.title));
  const sameCell = a.location && b.location && a.location.sheet === b.location.sheet && a.location.cell === b.location.cell;
  if (sameCell && Math.max(titles, jaccard(topic(a.detail), topic(b.detail))) >= MERGE_SAME_CELL) return true;
  if (titles >= MERGE_TITLES) return true;
  // The same question, on the same sheet, in words that mostly overlap, even when the cited cells differ ("no decision column", cited at
  // three different rows of the same gap list).
  const sameSheet = a.location && b.location && a.location.sheet.toLowerCase() === b.location.sheet.toLowerCase();
  if (sameSheet && jaccard(topic(`${a.title} ${a.detail}`), topic(`${b.title} ${b.detail}`)) >= MERGE_SAME_SHEET) return true;
  // The same column of the same sheet, with rows in common.
  return aRows.some((x) =>
    bRows.some((y) => x.sheet.toLowerCase() === y.sheet.toLowerCase() && x.column === y.column && x.rows.some((r) => y.rows.includes(r))),
  );
}

/**
 * Folds duplicates together. A finding joins the first group whose first finding it repeats (not any member, so a chain
 * of loosely similar findings cannot snowball into one). The representative is the most severe, then the one most
 * examiners reported, then the first.
 */
export function mergeDuplicates(findings: DraftFinding[], profile: WorkbookProfile): { findings: DraftFinding[]; merged: number } {
  const groups: Array<{ seed: DraftFinding; seedRows: RowClaim[]; members: DraftFinding[] }> = [];
  const passthrough: DraftFinding[] = [];
  for (const f of findings) {
    if (f.source !== 'raters') {
      passthrough.push(f);
      continue;
    }
    const rows = claimsAbsence(f) ? rowClaims(f, profile) : [];
    const group = groups.find((g) => sameThing(g.seed, f, g.seedRows, rows));
    if (group) group.members.push(f);
    else groups.push({ seed: f, seedRows: rows, members: [f] });
  }
  const out: DraftFinding[] = [...passthrough];
  for (const { members } of groups) {
    const best = [...members].sort(
      (a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || b.reportedBy.length - a.reportedBy.length,
    )[0]!;
    if (members.length === 1) {
      out.push(best);
      continue;
    }
    // Other wordings are kept in the detail, so a merge never hides a point one examiner made.
    const others = [...new Set(members.filter((m) => m !== best).map((m) => m.title.trim()))].filter((t) => t.toLowerCase() !== best.title.trim().toLowerCase());
    out.push({
      ...best,
      detail: others.length > 0 ? `${best.detail} [Also reported as: ${others.map((t) => `"${t}"`).join('; ')}.]` : best.detail,
      reportedBy: [...new Set(members.flatMap((m) => m.reportedBy))].sort(),
      ...(members.find((m) => m.proof)?.proof ? { proof: members.find((m) => m.proof)!.proof } : {}),
    });
  }
  return { findings: out, merged: findings.length - out.length };
}

/** Fact-checks, then merges, the examiners' findings. Code findings pass through untouched. */
export function checkFindings(findings: DraftFinding[], wb: WorkbookModel, options: { loneReason?: (f: DraftFinding) => string | null; schemaDesign?: boolean } = {}): FindingCheckResult {
  const profile = profileWorkbook(wb);
  const kept: DraftFinding[] = [];
  const dropped: DroppedFinding[] = [];
  let narrowed = 0;
  for (const f of findings) {
    const verdict = checkFinding(f, wb, profile, options.schemaDesign);
    if (verdict.keep) {
      kept.push(verdict.finding);
      if (verdict.narrowed) narrowed++;
    } else {
      dropped.push({ dimensionId: f.dimensionId, severity: f.severity, title: f.title, location: f.location, reportedBy: f.reportedBy, reason: verdict.reason });
    }
  }
  const { findings: mergedAll, merged: mergedCount } = mergeDuplicates(kept, profile);
  // After the merge, so a finding two examiners raised in different words counts as confirmed, not as two lone ones.
  const merged: DraftFinding[] = [];
  let lone = 0;
  for (const f of mergedAll) {
    const reason = options.loneReason?.(f) ?? null;
    if (reason) {
      lone++;
      dropped.push({ dimensionId: f.dimensionId, severity: f.severity, title: f.title, location: f.location, reportedBy: f.reportedBy, reason });
    } else merged.push(f);
  }
  const notes: string[] = [];
  if (dropped.length > 0) notes.push(`The fact check dropped ${dropped.length} examiner finding(s) that the file plainly contradicts; they are listed with the reason under "Findings dropped by the fact check".`);
  if (lone > 0) notes.push(`${lone} finding(s) raised by one examiner alone were set aside because that examiner's lone findings have rarely been right on checked work; they are listed with the dropped findings.`);
  if (narrowed > 0) notes.push(`The fact check narrowed ${narrowed} finding(s) to the rows the file confirms are empty.`);
  if (mergedCount > 0) notes.push(`${mergedCount} duplicate finding(s) were merged into the finding they repeat.`);
  return { findings: merged, dropped, merged: mergedCount, narrowed, notes };
}
