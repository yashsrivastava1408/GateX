import YAML from 'yaml';
import { STANDARD_ANCHORS, scorecardFileSchema, type ScorecardFile } from '@ddd/shared';
import { pickColumns, sheetProfile } from '../excel/profile.js';
import { CHECKS } from '../agent/checks/index.js';
import { TEXT_CHECKS, validateTextCheck } from '../agent/checks/textChecks.js';
import { parseReadsEntry } from '../agent/sectionPlanner.js';
import { estimateTokens } from '../agent/rater.js';
import { serializeSheet } from '../excel/serialize.js';
import { errorMessage } from '../util/errors.js';
import type { DocumentOutline, ImportResult, ImportedQuestion } from './importer.js';

/** Pages one question may read from a PDF when a model has a small prompt limit (the free Groq tier). */
export const MAX_PAGES_PER_QUESTION = 3;
/** Pages one question may read when no rater is limited that tightly (for example on Bedrock). */
export const MAX_PAGES_ROOMY = 10;
/** Tokens of workbook text one question may read when no rater sets a tighter limit. */
export const QUESTION_TOKEN_BUDGET = 30_000;
/** Columns kept when code has to cut a wide sheet down for a question. */
const MAX_PICKED_COLUMNS = 8;

const RANGE = /^pages?\s+(\d+)\s*(?:-|–|to)\s*(\d+)$/i;
const SINGLE_PAGE = /^page\s+(\d+)$/i;

/** [2, 8, 9] → ["Page 2", "Page 8-9"]: only the pages given, never the gaps between them. */
function pageRanges(pages: number[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < pages.length; ) {
    let end = i;
    while (end + 1 < pages.length && pages[end + 1] === pages[end]! + 1) end++;
    out.push(end === i ? `Page ${pages[i]}` : `Page ${pages[i]}-${pages[end]}`);
    i = end + 1;
  }
  return out;
}

/** The page numbers a `reads` list names, in order, or null when an entry is not a page or a page range. */
function pagesOf(reads: string[]): number[] | null {
  const pages: number[] = [];
  for (const entry of reads) {
    const range = RANGE.exec(entry.trim());
    const single = SINGLE_PAGE.exec(entry.trim());
    if (range) for (let n = Number(range[1]); n <= Number(range[2]); n++) pages.push(n);
    else if (single) pages.push(Number(single[1]));
    else return null;
  }
  return pages;
}

export interface Draft {
  file: ScorecardFile;
  /** For each question counted by code on a workbook: what the count gave on the real file, by question id. */
  trials: Record<string, string>;
  uncertain: string[];
  adjustments: string[];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()) : [];
}

/** Checks the model's reply and repairs what code can. Throws, with a readable reason, when it cannot be used. */
type Dimension = Record<string, any>;

interface Criterion {
  id: string;
  name: string;
  /** judged: a reader scores it. counted: a count settles it. unmeasurable: it names something outside the file (a second run, an interview, a sign-off); the examiners still score what the file records about it. */
  kind: 'judged' | 'counted' | 'unmeasurable';
  measure?: string;
  anchors?: Record<string, string>;
  /** A count that code can make exactly, proposed by the model and tried on the real file before it is kept. */
  check?: { id: string; params: Record<string, unknown>; fix?: string; /** What the count gave when tried on the real file. */ trial?: string };
}

/** How far a count may differ from the source's own figure and still be taken as counting the same thing. */
const SAME_RATIO = 0.01;

/** Tries a proposed workbook count on the real file. It must run, and must find rows to count. */
function tryOnWorkbook(id: string, params: Record<string, unknown>, outline: DocumentOutline, source?: { n: number; d: number }): string {
  const definition = CHECKS[id];
  if (!definition || !outline.wb || !outline.headerRows) throw new Error(`"${id}" is not a count the app can make`);
  const outcome = definition.run({ wb: outline.wb, headerRows: outline.headerRows }, params);
  if (outcome.total === 0) throw new Error('it found no rows to count');
  const text = `${outcome.passed} of ${outcome.total} pass on your file (${Math.round((outcome.passed / outcome.total) * 100)}%)`;
  if (source && source.d > 0) {
    // The scorecard states its own figure for this criterion. A count that disagrees is not counting what the scorecard counts.
    if (Math.abs(outcome.passed / outcome.total - source.n / source.d) > SAME_RATIO) {
      throw new Error(`it gave ${outcome.passed} of ${outcome.total}, but your scorecard says ${source.n} of ${source.d}, so it is not counting the same thing`);
    }
  } else if (outcome.passed === 0) {
    throw new Error(`it passed none of ${outcome.total} rows, which usually means the count is set up wrongly`);
  }
  return text;
}

function checkOf(criterion: Record<string, unknown>, adjustments: string[], outline: DocumentOutline | null): Criterion['check'] {
  const n = Number(criterion.source_n);
  const d = Number(criterion.source_d);
  const source = Number.isFinite(n) && Number.isFinite(d) && d > 0 && n >= 0 && n <= d ? { n, d } : undefined;
  const raw = criterion.check as { id?: unknown; params?: unknown; fix?: unknown } | undefined;
  if (!raw || typeof raw.id !== 'string') return undefined;
  try {
    const params = (raw.params ?? {}) as Record<string, unknown>;
    let trial: string | undefined;
    if (raw.id in TEXT_CHECKS) validateTextCheck(raw.id, params);
    else if (outline?.kind === 'excel') trial = tryOnWorkbook(raw.id, params, outline, source);
    else throw new Error(`"${raw.id}" is not a count the app can make`);
    return { id: raw.id, params, ...(typeof raw.fix === 'string' ? { fix: raw.fix } : {}), ...(trial ? { trial } : {}) };
  } catch (error) {
    adjustments.push(`${String(criterion.id ?? criterion.name)}: the proposed count was dropped (${errorMessage(error)}), so the examiners estimate it by reading the file.`);
    return undefined;
  }
}

const LEVELS = ['0', '1', '2', '3', '4', '5'];
const fullAnchors = (value: unknown): Record<string, string> | undefined => {
  const a = value as Record<string, unknown> | undefined;
  return a && LEVELS.every((l) => typeof a[l] === 'string' && (a[l] as string).trim() !== '') ? Object.fromEntries(LEVELS.map((l) => [l, String(a[l])])) : undefined;
};
const safeId = (id: unknown) => String(id ?? '').trim().replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');

function criteriaOf(dim: Dimension, adjustments: string[], outline: DocumentOutline | null): Criterion[] {
  if (!Array.isArray(dim.criteria)) return [];
  return dim.criteria.flatMap((c: Record<string, unknown>) => {
    if ((c.kind !== 'judged' && c.kind !== 'counted' && c.kind !== 'unmeasurable') || typeof c.name !== 'string') return [];
    const check = c.kind === 'counted' ? checkOf(c, adjustments, outline) : undefined;
    const anchors = fullAnchors(c.anchors);
    return [
      {
        id: safeId(c.id),
        name: c.name,
        kind: c.kind,
        ...(typeof c.measure === 'string' && c.measure.trim() ? { measure: c.measure.trim() } : {}),
        ...(anchors ? { anchors } : {}),
        ...(check ? { check } : {}),
      } as Criterion,
    ];
  });
}

/**
 * Keeps every criterion inside its dimension, so the dimension keeps the source's weight and its score is combined from its
 * criteria by the scorecard's own rule. A counted criterion whose exact count worked on the real file is counted by code; a
 * count that could not be made, and a criterion about evidence from outside the file, go to the examiners.
 */
function nestCriteria(dimensions: Dimension[], adjustments: string[], outline: DocumentOutline | null, trials: Record<string, string>, taken: Set<string>): Dimension[] {
  return dimensions.map((dim): Dimension => {
    const criteria = criteriaOf(dim, adjustments, outline);
    delete dim.criteria;
    if (criteria.length === 0) return dim;
    const estimated = criteria.filter((c) => c.kind === 'counted' && !c.check);
    const outside = criteria.filter((c) => c.kind === 'unmeasurable');
    const coded = criteria.filter((c) => c.kind === 'counted' && c.check);
    if (estimated.length > 0) {
      adjustments.push(`${dim.id}: ${estimated.map((c) => c.name).join('; ')} cannot be counted exactly by the app, so the examiners estimate it by reading the file.`);
    }
    if (outside.length > 0) {
      adjustments.push(`${dim.id}: ${outside.map((c) => c.name).join('; ')} names evidence from outside the file, so the examiners score what the file records about it.`);
    }
    const nested = criteria.map((c, index) => {
      // Ids share one namespace with dimension ids; a clash or a blank id gets a generated one.
      let id = c.id || `${dim.id}-C${String(index + 1).padStart(2, '0')}`;
      while (taken.has(id)) id = `${id}x`;
      taken.add(id);
      if (c.check?.trial) trials[id] = c.check.trial;
      if (c.check) adjustments.push(`${id}: counted by code (${c.check.id}) on ${c.check.id in TEXT_CHECKS ? 'the words or pattern' : 'the sheet and column'} shown; the 0-5 bands are the source's ratio bands.`);
      return {
        id,
        name: c.name,
        kind: c.kind,
        ...(c.measure ? { measure: c.measure } : {}),
        ...(c.anchors ? { anchors: c.anchors } : {}),
        ...(c.check ? { check: { id: c.check.id, params: c.check.params, ...(c.check.fix ? { fix: c.check.fix } : {}) } } : {}),
      };
    });
    const { measured_by: _by, measurable_by_agent: _agent, needs: _needs, check: _check, ...rest } = dim;
    adjustments.push(`${dim.id}: scored criterion by criterion (${criteria.length - coded.length} by the examiners${coded.length ? `, ${coded.length} counted by code` : ''}), combined by the scorecard's rule.`);
    return { ...rest, criteria: nested };
  });
}

/** The combination rule the source states (for example GS-1: mean rounded down, a 0 caps at 2, a not-measurable criterion caps at 3). */
function aggregateOf(raw: unknown, adjustments: string[]): Record<string, unknown> | undefined {
  const a = raw as { rule?: unknown; zero_caps_at?: unknown; unmeasured_caps_at?: unknown } | undefined;
  if (!a || typeof a !== 'object') return undefined;
  const rule = a.rule === 'mean_floor' || a.rule === 'mean' || a.rule === 'weighted' ? a.rule : 'mean';
  const cap = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 5 ? (v as number) : undefined);
  const out = { rule, ...(cap(a.zero_caps_at) !== undefined ? { zero_caps_at: cap(a.zero_caps_at) } : {}), ...(cap(a.unmeasured_caps_at) !== undefined ? { unmeasured_caps_at: cap(a.unmeasured_caps_at) } : {}) };
  adjustments.push(`Criteria are combined as the source states: ${rule === 'mean_floor' ? 'the mean rounded down' : rule === 'weighted' ? 'the weighted mean' : 'the mean'}${out.zero_caps_at !== undefined ? `, a 0 caps the dimension at ${out.zero_caps_at}` : ''}${out.unmeasured_caps_at !== undefined ? `, a criterion with nothing in the file caps it at ${out.unmeasured_caps_at}` : ''}.`);
  return out;
}

/** A judged question with no anchors of its own gets the source's general anchor when it has one, else the standard 0 to 5 scale. */
function fillAnchors(dimensions: Dimension[], general: unknown, adjustments: string[]): void {
  const anchors = general as Record<string, unknown> | undefined;
  const usable = anchors && ['0', '1', '2', '3', '4', '5'].every((level) => typeof anchors[level] === 'string' && anchors[level] !== '');
  for (const dim of dimensions) {
    if ((dim.measured_by !== 'raters' && !dim.criteria) || dim.anchors) continue;
    dim.anchors = usable ? Object.fromEntries(['0', '1', '2', '3', '4', '5'].map((level) => [level, anchors![level]])) : { ...STANDARD_ANCHORS };
    adjustments.push(`${dim.id}: it had no anchors of its own, so ${usable ? "the source's general anchor" : 'a standard 0 to 5 scale'} was used.`);
  }
}

/**
 * A `reads` entry such as "Sheet[Col A|Col B]" names the only columns a question needs, which keeps a big sheet's prompt small.
 * The columns are matched to the sheet's real headers (ignoring case and spacing) and written with their exact titles;
 * a column the sheet does not have is dropped, and if none is left the question reads the whole sheet.
 */
function withRealColumns(entry: string, outline: DocumentOutline, dimId: string, adjustments: string[]): string {
  const { name, columns } = parseReadsEntry(entry);
  if (!columns || outline.kind !== 'excel' || !outline.wb) return entry;
  const sheet = outline.names.find((n) => n.toLowerCase() === name.toLowerCase()) ?? name;
  const headerRow = outline.headerRows?.get(sheet.toLowerCase()) ?? 1;
  const key = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();
  const titles = new Map(outline.wb.table(sheet, headerRow).headers.map((h) => [key(h.title), h.title]));
  const real = [...new Set(columns.map((c) => titles.get(key(c))).filter((t): t is string => Boolean(t)))];
  const missing = columns.filter((c) => !titles.has(key(c)));
  if (missing.length > 0) {
    adjustments.push(`${dimId}: ${sheet} has no column ${missing.map((m) => `"${m}"`).join(', ')}, so ${real.length > 0 ? 'it was left out' : 'the whole sheet is read'}.`);
  }
  return real.length > 0 ? `${sheet}[${real.join('|')}]` : sheet;
}

function entrySize(entry: string, outline: DocumentOutline): number {
  const { name, columns } = parseReadsEntry(entry);
  const sheet = outline.names.find((n) => n.toLowerCase() === name.toLowerCase());
  if (!sheet || !outline.wb) return 0;
  return estimateTokens(serializeSheet(outline.wb, { name: sheet, headerRow: outline.headerRows?.get(sheet.toLowerCase()) ?? 1, ...(columns ? { columns } : {}) }));
}

/** The text a question is about, for choosing its columns: its name, its measure and its criteria. */
const questionText = (dim: Dimension) =>
  [dim.name, dim.measure, ...(Array.isArray(dim.criteria) ? dim.criteria.map((c: { name?: string; measure?: string }) => `${c.name ?? ''} ${c.measure ?? ''}`) : [])].filter(Boolean).join(' ');

/**
 * A safety net under the model's own choice of columns: when what a question reads is still bigger than the models can take,
 * its widest whole sheets are cut, by code, to the columns the workbook profile ranks most relevant to the question (by
 * title and contents, weighted by how full they are), plus the row's id. Deterministic, so the same scorecard always reads
 * the same columns.
 */
function fitToBudget(dim: Dimension, outline: DocumentOutline, budget: number, adjustments: string[]): void {
  if (outline.kind !== 'excel' || !outline.wb || !outline.profile || !Array.isArray(dim.reads)) return;
  const reads = dim.reads as string[];
  const sizes = reads.map((entry) => entrySize(entry, outline));
  const total = () => sizes.reduce((sum, n) => sum + n, 0);
  if (total() <= budget) return;
  const before = total();
  const question = questionText(dim);
  const order = reads.map((_, i) => i).sort((a, b) => sizes[b]! - sizes[a]!);
  for (const i of order) {
    if (total() <= budget) break;
    const { name, columns } = parseReadsEntry(reads[i]!);
    if (columns) continue;
    const sheet = sheetProfile(outline.profile, name);
    if (!sheet || sheet.columns.filter((c) => c.title).length <= 2) continue;
    // Without an id column the first column stands in, so a cited row can still be told apart.
    const first = sheet.idColumn ? null : sheet.columns.find((c) => c.title)?.title ?? null;
    const picked = pickColumns(sheet, question, MAX_PICKED_COLUMNS).filter((t) => t !== first).slice(0, first ? MAX_PICKED_COLUMNS - 1 : MAX_PICKED_COLUMNS);
    reads[i] = `${sheet.name}[${[...(first ? [first] : []), ...picked].join('|')}]`;
    sizes[i] = entrySize(reads[i]!, outline);
  }
  const after = total();
  if (after < before) {
    adjustments.push(`${dim.id}: what it reads was about ${before.toLocaleString('en')} tokens, too big for the models, so code kept only the columns that match the question (now about ${after.toLocaleString('en')}).`);
  }
  if (after > budget) {
    adjustments.push(`${dim.id}: it still reads about ${after.toLocaleString('en')} tokens, more than the ${budget.toLocaleString('en')} planned; a model with a small limit may not take it.`);
  }
}

/**
 * A scorecard that gives no weight to a question (a blank, a zero, or a word) used to be refused whole by the format check, so a
 * source with weights on only some rows could not be used at all. A question without a usable weight now gets the average of
 * the others, or 1 when none has one, and the adjustment says so, so the score stays a share of the whole.
 */
export function repairWeights(dimensions: Dimension[], adjustments: string[]): void {
  const usable = (w: unknown) => (typeof w === 'number' ? w : typeof w === 'string' ? Number(w.replace(/%$/, '')) : Number.NaN);
  const given = dimensions.map((d) => usable(d.weight)).filter((w) => Number.isFinite(w) && w > 0);
  const fallback = given.length > 0 ? Math.round((given.reduce((sum, w) => sum + w, 0) / given.length) * 100) / 100 : 1;
  const lacking: string[] = [];
  for (const dim of dimensions) {
    const w = usable(dim.weight);
    if (Number.isFinite(w) && w > 0) dim.weight = w;
    else {
      dim.weight = fallback;
      lacking.push(dim.id as string);
    }
    for (const c of Array.isArray(dim.criteria) ? (dim.criteria as Array<Record<string, unknown>>) : []) {
      if (c.weight === undefined) continue;
      const cw = usable(c.weight);
      if (Number.isFinite(cw) && cw > 0) c.weight = cw;
      else delete c.weight;
    }
  }
  if (lacking.length > 0) {
    adjustments.push(
      `${lacking.join(', ')} had no usable weight in the source (blank, zero or not a number), so ${lacking.length === 1 ? 'it was' : 'they were'} given ${given.length > 0 ? `the average weight of the others, ${fallback}` : 'a weight of 1, like every other question'}. Check it matches the original.`,
    );
  }
}

export function checkDraft(
  reply: unknown,
  sourceName: string,
  outline: DocumentOutline | null,
  maxPages = MAX_PAGES_PER_QUESTION,
  tokenBudget = QUESTION_TOKEN_BUDGET,
): Draft {
  if (!reply || typeof reply !== 'object' || !('scorecard' in reply)) throw new Error('the reply has no "scorecard" object');
  const { scorecard: raw, uncertain, adjustments } = reply as { scorecard: Record<string, unknown>; uncertain?: unknown; adjustments?: unknown };
  const notes = { uncertain: strings(uncertain), adjustments: strings(adjustments) };
  const draft = JSON.parse(JSON.stringify(raw)) as Record<string, any>;

  // Used straight away: frozen by its hash, and checked by code below rather than by a person.
  draft.frozen = true;
  draft.approval = `Converted automatically from ${sourceName}`;
  draft.id = String(draft.id ?? 'SC-IMPORTED').replace(/[^\w-]+/g, '-');
  const t = draft.thresholds as { accept?: number; refine?: number } | undefined;
  if (!t || typeof t.accept !== 'number' || typeof t.refine !== 'number' || t.refine >= t.accept) {
    draft.thresholds = { accept: 75, refine: 60 };
    notes.adjustments.push('The thresholds were missing or inconsistent, so the standard 75 (green) and 60 (amber) were used.');
  }

  // A question the examiners find nothing in the file to measure is left out of the score; nobody is waited for.
  draft.unmeasured = 'skip';
  const trials: Record<string, string> = {};
  const source = Array.isArray(draft.dimensions) ? (draft.dimensions as Dimension[]) : [];
  const taken = new Set(source.map((d) => String(d.id)));
  const dimensions = nestCriteria(source, notes.adjustments, outline, trials, taken);
  draft.dimensions = dimensions;
  const aggregate = aggregateOf(draft.aggregate, notes.adjustments);
  if (aggregate) draft.aggregate = aggregate;
  else delete draft.aggregate;
  for (const dim of dimensions) {
    if (dim.criteria) continue;
    if (dim.measured_by === 'code' || (dim.check && dim.measured_by !== 'raters' && dim.measured_by !== 'human')) {
      dim.measured_by = 'raters';
      delete dim.check;
      notes.adjustments.push(`${dim.id}: the app cannot count this itself from an imported scorecard, so the examiners score it by reading the file.`);
    }
    if (dim.measured_by === 'human' || dim.measurable_by_agent === false) {
      // The model may still hand a question to a person; the examiners take it instead.
      const what = [dim.measure, dim.needs].filter((t: unknown) => typeof t === 'string' && t.trim() !== '').join(' ') || dim.name;
      dim.measured_by = 'raters';
      delete dim.measurable_by_agent;
      delete dim.needs;
      dim.measure = `${what} Score only what the file itself records about this.`;
      notes.adjustments.push(`${dim.id}: it was meant for a person, so the examiners score what the file records about it.`);
    }
  }

  fillAnchors(dimensions, (reply as { general_anchor?: unknown }).general_anchor, notes.adjustments);
  repairWeights(dimensions, notes.adjustments);

  const available = new Set((outline?.names ?? []).map((n) => n.toLowerCase()));
  if (outline) {
    const pages = outline.pages;
    const valid = (entry: string) => {
      const range = RANGE.exec(entry.trim());
      if (range) return outline.kind === 'pdf' && Number(range[1]) >= 1 && Number(range[2]) <= pages && Number(range[1]) <= Number(range[2]);
      return available.has(parseReadsEntry(entry).name.toLowerCase());
    };
    for (const dim of dimensions) {
      if (!Array.isArray(dim.reads)) continue;
      const kept = (dim.reads as string[]).filter(valid);
      if (kept.length !== dim.reads.length) {
        notes.adjustments.push(`${dim.id}: dropped ${dim.reads.length - kept.length} page or sheet name(s) that the document does not have.`);
      }
      if (kept.length > 0) dim.reads = kept.map((entry) => withRealColumns(entry, outline, dim.id, notes.adjustments));
      else delete dim.reads;
      fitToBudget(dim, outline, tokenBudget, notes.adjustments);
    }
    if (outline.kind === 'pdf') {
      for (const dim of dimensions) {
        const pages = Array.isArray(dim.reads) ? pagesOf(dim.reads as string[]) : null;
        if (!pages || pages.length <= maxPages) continue;
        const kept = pages.slice(0, maxPages);
        dim.reads = pageRanges(kept);
        notes.adjustments.push(`${dim.id}: it named ${pages.length} pages, more than the models can read at once, so it was cut to ${(dim.reads as string[]).join(', ')}. Widen it by hand if the evidence is elsewhere.`);
      }
    }
    const sheets = outline.kind === 'pdf' ? [{ name: `Page 1-${pages}`, header_row: 1 }] : outline.names.map((name) => ({ name, header_row: outline.headerRows?.get(name.toLowerCase()) ?? 1 }));
    draft.artifact = { sheets, context_sheets: [] };
  } else {
    draft.artifact ??= { sheets: [{ name: 'Sheet1', header_row: 1 }], context_sheets: [] };
    notes.uncertain.push('No document was given, so the sheets and pages each question reads are not set. They are filled in when the scorecard is used with a file.');
  }

  const result = scorecardFileSchema.safeParse({ scorecard: draft });
  if (!result.success) {
    const lines = result.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`the scorecard does not match the format: ${lines.join('; ')}`);
  }
  return { file: result.data, trials, ...notes };
}

type FileDim = ScorecardFile['scorecard']['dimensions'][number];
const isCodeDim = (d: FileDim) => !d.criteria && (d.measured_by === 'code' || (Boolean(d.check) && d.measured_by === undefined));
const isCountedCriterion = (c: NonNullable<FileDim['criteria']>[number]) => c.kind === 'counted' && Boolean(c.check);

/** Counts questions: each criterion of a dimension that has criteria, else the dimension itself. */
export function summarise(file: ScorecardFile): ImportResult['summary'] {
  const dims = file.scorecard.dimensions;
  const questions = dims.flatMap((d) => (d.criteria ? d.criteria.map((c) => (isCountedCriterion(c) ? 'code' : 'examiners')) : [isCodeDim(d) ? 'code' : 'examiners']));
  const byCode = questions.filter((q) => q === 'code').length;
  return {
    dimensions: dims.length,
    byExaminers: questions.length - byCode,
    byCode,
    critical: dims.filter((d) => d.critical).length,
    weightTotal: Math.round(dims.reduce((sum, d) => sum + d.weight, 0) * 100) / 100,
  };
}

/** What a count does, in words a reviewer can check against the original. */
function describeCheck(check: { id: string; params: Record<string, unknown> }): string {
  const p = check.params as { terms?: string[]; find?: string; valid?: string };
  if (check.id === 'text_terms_absent') return `Counts the lines that avoid: ${(p.terms ?? []).join(', ')}`;
  if (check.id === 'text_terms_present') return `Looks for each of: ${(p.terms ?? []).join(', ')}`;
  if (check.id === 'text_ids_valid') return `Checks that every ID shaped like ${p.find} fits ${p.valid}`;
  const w = check.params as { sheet?: string; column?: string; columns?: string[]; pattern?: string; list?: string; max?: number; min?: number; forbidden?: string[]; where?: { column?: string; equals?: unknown; not_blank?: boolean } };
  const at = `${w.sheet ?? 'the sheet'}${w.column ? ` › ${w.column}` : ''}`;
  const only = w.where ? ` (only rows where ${w.where.column} ${w.where.not_blank ? 'is filled' : `is ${String(w.where.equals)}`})` : '';
  const sentence: Record<string, string> = {
    column_filled: `${at} is filled${w.pattern ? ` and matches ${w.pattern}` : ''}`,
    unique: `${at} has no repeated value`,
    values_in_list: `${at} is one of the allowed values in the list ${w.list ?? ''}`.trim(),
    max_value: `${at} is at most ${w.max}`,
    value_not_in: `${at} is not one of: ${(w.forbidden ?? []).join(', ')}`,
    any_filled: `${w.sheet ?? 'the sheet'}: at least one of ${(w.columns ?? []).join(', ')} is filled`,
    row_count_at_least: `${w.sheet ?? 'the sheet'} has at least ${w.min} rows`,
  };
  return `${sentence[check.id] ?? `Counted by code (${check.id})`}${only}`;
}

export function listQuestions(file: ScorecardFile, trials: Record<string, string> = {}): ImportedQuestion[] {
  return file.scorecard.dimensions.map((d) => {
    const code = isCodeDim(d);
    return {
      id: d.id,
      name: d.name,
      weight: d.weight,
      critical: d.critical,
      by: code || (d.criteria && d.criteria.every(isCountedCriterion)) ? 'code' : 'examiners',
      reads: d.reads ?? [],
      ...(code && d.check ? { how: `${describeCheck(d.check)}${trials[d.id] ? `. ${trials[d.id]}` : ''}` } : {}),
      ...(d.criteria
        ? {
            criteria: d.criteria.map((c, i) => {
              const id = c.id ?? `${d.id}-C${String(i + 1).padStart(2, '0')}`;
              return {
                id,
                name: c.name,
                by: isCountedCriterion(c) ? ('code' as const) : ('examiners' as const),
                ...(isCountedCriterion(c) ? { how: `${describeCheck(c.check!)}${trials[id] ? `. ${trials[id]}` : ''}` } : {}),
              };
            }),
          }
        : {}),
    };
  });
}

export const draftToYaml = (file: ScorecardFile, sourceName: string): string =>
  `# Converted automatically from ${sourceName}. Used as it is; edit and upload this file only if you want to change it.\n${YAML.stringify(file, { lineWidth: 110 })}`;

