import type { CellRef, DimensionResult, DimensionSpec, ReturnTo, Scorecard, Severity } from '@ddd/shared';
import { keyStems } from './findingCheck.js';
import { profileWorkbook, stems, type ColumnProfile, type SheetProfile, type WorkbookProfile } from '../excel/profile.js';
import { columnLetters, type WorkbookModel } from '../excel/workbook.js';
import type { DraftFinding } from './types.js';
import { recountTallies } from './tallies.js';

/**
 * A row-by-row sweep done in code, whatever the scorecard asks. Models that read a whole sheet skim it and miss a blank cell or a repeated
 * id; code reads every row. It finds only things that are wrong by the file's own pattern, never by taste:
 *
 *   empty cell      a cell empty in a column that is otherwise (almost) always filled
 *   duplicate id    the same id on two rows
 *   dangling ref    a reference to an id that does not exist, in a column whose other values all resolve
 *   wrong count     a "children" count that does not match the rows under that id (ids such as 1.2.3)
 *   vague words     a definition or reason that is mostly filler ("various things as needed, etc.")
 *   conditional gap a cell empty in a column that is filled on every row of one kind (every leaf has a data type) and empty on the others
 *   invalid value   a value in a "Required" or "Mandatory" column that is not a way of saying required, optional or conditional ("Maybe")
 *   stated count    a count the file states about its own sheet ("278 parameters") that is not the number of rows that sheet has
 *   missing target  text that cites an id of a family the file defines (D3-S14-P15 among D3-S14-P01..P09) that is defined nowhere
 *
 * Each result is exact and points at one cell, so it passes through the finding filters untouched, like any code finding.
 */

export interface SweepFinding {
  kind: 'empty_cell' | 'duplicate_id' | 'dangling_reference' | 'wrong_count' | 'vague_words' | 'missing_target' | 'stated_count' | 'conditional_empty' | 'invalid_value' | 'tally_mismatch'
    // Deep checks (sweepDeep.ts): counted into exact scores only, never listed as report issues.
    | 'bad_id_format' | 'cross_reference' | 'orphan_row' | 'near_miss_value' | 'too_wide' | 'restated_reason';
  location: CellRef;
  title: string;
  detail: string;
  fix: string;
  severity: Severity;
  /** Words from the column or question this is about, used to attach it to the scorecard question it belongs to. */
  topic: string;
}

/**
 * How much the sweep looked at, for the exact scores: the share of what was looked at that was clean. `all` lifts the per-column display
 * limit so every defect is counted, not just the first few that are listed in the report.
 */
export interface SweepStats {
  /** Data rows of the sheets the sweep ran over (sheets with too few rows to say what is usual are not counted). */
  rows: number;
  /** Id cells looked at for repeats. */
  ids: number;
  /** Cells looked at in reference columns, plus the distinct ids cited in running text. */
  references: number;
  /** Rows that state a children count. */
  childCounts: number;
  /** Cells looked at in required/optional columns. */
  obligations: number;
  /** Tallies the file states about itself that were recounted (right or wrong). */
  tallies: number;
}
export interface SweepOptions {
  all?: boolean;
  stats?: SweepStats;
}
export const emptyStats = (): SweepStats => ({ rows: 0, ids: 0, references: 0, childCounts: 0, obligations: 0, tallies: 0 });

/** Sheets smaller than this have too few rows to say what is "usual" in a column. */
export const MIN_ROWS = 12;
/** A column counts as always-filled at or above this share, and at most this many cells (or 3% of rows) may be empty. */
const FILLED_AT = 0.95;
const MAX_EMPTY = 3;
const MAX_PER_COLUMN = 3;
const VAGUE_WORDS = /\b(?:various|etc\.?|and so on|as needed|stuff|things|somehow|appropriate(?:ly)?|as required|and more|miscellaneous|tbd)\b/gi;
/** Columns whose emptiness is a real gap in a register: what it is, why, what type, where from. */
const ESSENTIAL = /definition|reason|description|name|type|required|source|owner|unit|id\b/i;
const SUMMARY_LABEL = /^(?:counts?|totals?|sum|subtotal|grand total|average|avg|summary)\s*:?$/i;

export const norm = (t: string) => t.trim();
/** Columns that say whether something is required, and the plain ways a register says it. A value outside these is a typo or an invention. */
const OBLIGATION_COLUMN = /^(?:required|mandatory|optional)\??$|^m\/o\/c$/i;
const OBLIGATION_VALUE = /^(?:required|optional|conditional|conditionally required|mandatory|recommended|yes|no|true|false|y|n|m|o|c|m\/o\/c|n\/a|not applicable|tbd|(?:required|conditional|optional)\b.*)$/i;
const address = (col: ColumnProfile, row: number): CellRef & { cell: string } => ({ sheet: '', cell: `${col.letter}${row}` });

export function dataRowsOf(wb: WorkbookModel, sheet: SheetProfile): number[] {
  const rows = new Set<number>();
  for (const [r] of wb.cells(sheet.name)) if (r > sheet.headerRow) rows.add(r);
  const firstCol = sheet.columns.find((c) => c.title);
  return [...rows].sort((a, b) => a - b).filter((r) => !firstCol || !SUMMARY_LABEL.test(norm(wb.cellText(sheet.name, `${firstCol.letter}${r}`) ?? '')));
}

// Nearly unique is enough: the whole point is to find the few that repeat.
export const idColumnOf = (s: SheetProfile) => s.columns.find((c) => c.title === s.idColumn) ?? s.columns.find((c) => c.title && /\bid\b|^path|^ref/i.test(c.title) && c.filled > 0 && c.distinct / c.filled >= 0.95);

export function sweepSheet(wb: WorkbookModel, sheet: SheetProfile, options: SweepOptions = {}): SweepFinding[] {
  const out: SweepFinding[] = [];
  const rows = dataRowsOf(wb, sheet);
  if (rows.length < MIN_ROWS) return out;
  const stats = options.stats;
  const perColumn = options.all ? Infinity : MAX_PER_COLUMN;
  if (stats) stats.rows += rows.length;
  const text = (col: ColumnProfile, row: number) => norm(wb.cellText(sheet.name, `${col.letter}${row}`) ?? '');
  const at = (col: ColumnProfile, row: number): CellRef => ({ ...address(col, row), sheet: sheet.name });
  const titled = sheet.columns.filter((c) => c.title && c.kind !== 'empty' && c.kind !== 'formula');
  const idCol = idColumnOf(sheet);

  // 1. Empty cells in an otherwise always-filled column.
  for (const col of titled) {
    const filled = rows.filter((r) => text(col, r) !== '');
    const empty = rows.filter((r) => text(col, r) === '');
    if (empty.length === 0 || filled.length / rows.length < FILLED_AT || empty.length > Math.max(MAX_EMPTY, Math.floor(rows.length * 0.03))) continue;
    if (col.kind === 'number' || col.kind === 'formula') continue;
    // A total or a heading row is not an entry with something missing: the columns that are filled in nearly every row must be filled in this one.
    const usual = titled.filter((c) => c !== col && c.fillRate >= FILLED_AT);
    const full = (r: number) => usual.length === 0 || usual.filter((c) => text(c, r) !== '').length / usual.length >= 0.8;
    // A row with no id is not an entry of the register (a total, a note, a blank line), so nothing is "missing" from it.
    const isEntry = (r: number) => !idCol || idCol === col || text(idCol, r) !== '';
    for (const r of empty.filter((x) => full(x) && isEntry(x)).slice(0, perColumn)) {
      const who = idCol ? ` (row ${text(idCol, r) || r})` : '';
      out.push({
        kind: 'empty_cell', location: at(col, r), severity: ESSENTIAL.test(col.title) ? 'MEDIUM' : 'LOW', topic: col.title,
        title: `Empty "${col.title}" in ${sheet.name}${who}`,
        detail: `${sheet.name}!${col.letter}${r}${who} is empty, but "${col.title}" is filled in ${filled.length} of the other ${rows.length - 1} rows.`,
        fix: `Fill ${col.letter}${r}, or say in the sheet why this row has no "${col.title}".`,
      });
    }
  }

  // 1b. A column filled on every row of one kind and empty on the rest (groups have no data type, leaves all do): an empty leaf is the gap.
  for (const col of titled.filter((c) => c.kind !== 'number' && c.fillRate >= 0.4 && c.fillRate < FILLED_AT)) {
    const rows1 = rows.map((r) => ({ r, filled: text(col, r) !== '' }));
    let best: { by: ColumnProfile; exceptions: number[] } | null = null;
    for (const by of titled.filter((c) => c !== col && c !== idCol && c.fillRate >= FILLED_AT && c.distinct >= 2 && c.distinct <= 8)) {
      const groups = new Map<string, { filled: number[]; empty: number[] }>();
      for (const x of rows1) {
        const key = text(by, x.r);
        const g = groups.get(key) ?? { filled: [], empty: [] };
        (x.filled ? g.filled : g.empty).push(x.r);
        groups.set(key, g);
      }
      const share = (g: { filled: number[]; empty: number[] }) => g.filled.length / (g.filled.length + g.empty.length);
      const big = [...groups.values()].filter((g) => g.filled.length + g.empty.length >= 5);
      const filledGroups = big.filter((g) => share(g) >= 0.9 && g.empty.length > 0);
      const cleanFilled = big.filter((g) => share(g) === 1);
      const emptyGroups = big.filter((g) => share(g) <= 0.1);
      // A clean split: some kinds of row are always filled (or nearly), others nearly always empty, and the few exceptions are in the "filled" kinds.
      if (emptyGroups.length === 0 || cleanFilled.length + filledGroups.length === 0 || filledGroups.length === 0) continue;
      if (big.some((g) => share(g) > 0.1 && share(g) < 0.9)) continue;
      const exceptions = filledGroups.flatMap((g) => g.empty);
      if (exceptions.length > 0 && exceptions.length <= MAX_EMPTY && (!best || exceptions.length < best.exceptions.length)) best = { by, exceptions };
    }
    if (!best) continue;
    for (const r of best.exceptions.slice(0, perColumn)) {
      const who = idCol ? ` (row ${text(idCol, r) || r})` : '';
      out.push({
        kind: 'conditional_empty', location: at(col, r), severity: ESSENTIAL.test(col.title) ? 'MEDIUM' : 'LOW', topic: col.title,
        title: `Empty "${col.title}" in ${sheet.name}${who}`,
        detail: `${sheet.name}!${col.letter}${r}${who} is empty, but every other row with "${best.by.title}" = "${text(best.by, r)}" has a "${col.title}".`,
        fix: `Fill ${col.letter}${r}, or say why this row has no "${col.title}".`,
      });
    }
  }

  // 1c. A value in a required/optional column that is neither.
  for (const col of titled.filter((c) => OBLIGATION_COLUMN.test(c.title.trim()) && c.kind !== 'number')) {
    const values = rows.map((r) => ({ r, v: text(col, r) })).filter((x) => x.v !== '');
    const fine = values.filter((x) => OBLIGATION_VALUE.test(x.v));
    // Only a column that is plainly an obligation column (most values are the usual words): "Maybe" in it is the odd one out.
    if (values.length < MIN_ROWS || fine.length / values.length < 0.8) continue;
    if (stats) stats.obligations += values.length;
    for (const x of values.filter((y) => !OBLIGATION_VALUE.test(y.v)).slice(0, perColumn)) {
      const who = idCol ? ` (row ${text(idCol, x.r) || x.r})` : '';
      out.push({
        kind: 'invalid_value', location: at(col, x.r), severity: 'MEDIUM', topic: col.title,
        title: `Invalid "${col.title}" value "${x.v}" in ${sheet.name}${who}`,
        detail: `${sheet.name}!${col.letter}${x.r}${who} says "${x.v}", which is not a way of saying required or optional; the other ${fine.length} rows use ${[...new Set(fine.map((y) => y.v))].slice(0, 4).map((v) => `"${v}"`).join(', ')}.`,
        fix: `Change ${col.letter}${x.r} to Required, Optional or Conditional, as the column's other rows do.`,
      });
    }
  }

  // 2. Duplicate ids.
  const idValues = idCol ? rows.map((r) => text(idCol, r)).filter(Boolean) : [];
  if (idCol && idValues.length >= MIN_ROWS && new Set(idValues).size / idValues.length >= 0.97) {
    if (stats) stats.ids += idValues.length;
    const first = new Map<string, number>();
    for (const r of rows) {
      const v = text(idCol, r);
      if (v === '' || v.toLowerCase() === idCol.title.toLowerCase()) continue;
      const seen = first.get(v);
      if (seen === undefined) first.set(v, r);
      else
        out.push({
          kind: 'duplicate_id', location: at(idCol, r), severity: 'MEDIUM', topic: idCol.title,
          title: `Duplicate id ${v} in ${sheet.name}`,
          detail: `The id "${v}" is on row ${seen} and again on row ${r} (${sheet.name}!${idCol.letter}${r}), so it no longer points at one entry.`,
          fix: `Give row ${r} its own id.`,
        });
    }
  }

  // 3. References to ids that do not exist.
  if (idCol) {
    const ids = new Set(rows.map((r) => text(idCol, r)).filter(Boolean));
    for (const col of titled.filter((c) => c !== idCol && /parent|reference|\bref\b|link|depends|belongs/i.test(c.title))) {
      const used = rows.map((r) => ({ r, v: text(col, r) })).filter((x) => x.v !== '');
      if (used.length < MIN_ROWS) continue;
      if (stats) stats.references += used.length;
      const bad = used.filter((x) => !x.v.split(/[,;|]/).map(norm).filter(Boolean).every((p) => ids.has(p)));
      // A reference column is one where nearly everything resolves; a column of free text mentions is left alone.
      if (bad.length === 0 || bad.length > MAX_EMPTY || (used.length - bad.length) / used.length < 0.9) continue;
      for (const x of bad.slice(0, perColumn)) {
        out.push({
          kind: 'dangling_reference', location: at(col, x.r), severity: 'MEDIUM', topic: col.title,
          title: `"${col.title}" ${x.v} does not exist (${sheet.name})`,
          detail: `${sheet.name}!${col.letter}${x.r} refers to "${x.v}", which is not an id in ${idCol.title}; the other ${used.length - bad.length} references in this column all resolve.`,
          fix: `Correct the reference at ${col.letter}${x.r}, or add the missing entry.`,
        });
      }
    }
  }

  // 4. Child counts that do not match the rows under an id such as 1.2.3.
  const countCol = titled.find((c) => /^children$|child count|number of children|# children/i.test(c.title));
  if (idCol && countCol) {
    const ids = rows.map((r) => ({ r, v: text(idCol, r) }));
    if (ids.filter((x) => /^\d+(\.\d+)+$/.test(x.v) || /^\d+$/.test(x.v)).length / Math.max(ids.length, 1) > 0.9) {
      if (stats) stats.childCounts += ids.filter((x) => /^\d+$/.test(text(countCol, x.r))).length;
      for (const x of ids) {
        const stated = text(countCol, x.r);
        if (!/^\d+$/.test(stated)) continue;
        const depth = x.v.split('.').length;
        const actual = ids.filter((y) => y.v.startsWith(`${x.v}.`) && y.v.split('.').length === depth + 1).length;
        if (actual !== Number(stated))
          out.push({
            kind: 'wrong_count', location: at(countCol, x.r), severity: 'MEDIUM', topic: countCol.title,
            title: `Child count ${stated} for ${x.v} is wrong (${sheet.name})`,
            detail: `${sheet.name}!${countCol.letter}${x.r} says ${x.v} has ${stated} children, but ${actual} rows sit directly under it.`,
            fix: `Change ${countCol.letter}${x.r} to ${actual}, or add the missing rows.`,
          });
      }
    }
  }

  // 5. Definitions and reasons that are mostly filler.
  for (const col of titled.filter((c) => /definition|reason|description/i.test(c.title) && c.kind === 'text')) {
    for (const r of rows) {
      const v = text(col, r);
      const hits = v.match(VAGUE_WORDS) ?? [];
      if (hits.length >= 2 && v.length <= 160) {
        out.push({
          kind: 'vague_words', location: at(col, r), severity: 'LOW', topic: col.title,
          title: `Vague "${col.title}" in ${sheet.name} row ${r}`,
          detail: `${sheet.name}!${col.letter}${r} reads "${v.slice(0, 120)}", which says nothing specific (${[...new Set(hits.map((h) => h.toLowerCase()))].join(', ')}).`,
          fix: `Say exactly what this is, in one concrete sentence.`,
        });
      }
    }
  }
  return out;
}

/** An id-like token: capital letters and digits in two or more dash-joined parts, such as D3-S14-P15, VR-26, TH-004. */
const ID_TOKEN = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b/g;
/** Words after which a made-up id is meant: a pattern, a failing example, a placeholder. */
const EXAMPLE_COLUMN = /example|pattern|passing|failing|sample/i;
/** A family of ids must be this big before a missing member means anything. */
const MIN_FAMILY = 8;
const MAX_MISSING_TARGETS = 6;

/** Where an id is defined: the id column of a register. An id that only appears in a "test" or "reference" column is a pointer to somewhere else. */
const DEFINING_COLUMN = /\bid\b|^rule$/i;
/** PER-000, RC-0000: a placeholder showing the pattern, not an id. */
const isPlaceholder = (token: string) => !/[1-9]/.test(token.replace(/^[A-Z][A-Z0-9]*(?=-)/, '').replace(/-[A-Z]+/g, ''));

const shapeOf = (token: string) => token.replace(/\d+/g, '#');
/** PER-01 and PER-001 are the same id written two ways; compare the numbers, not the zero padding. */
const canon = (token: string) => token.replace(/\d+/g, (n) => String(Number(n)));

/**
 * An id named in running text that is defined nowhere, when the file defines a whole family of ids of that shape. A cell that is just an
 * id counts as a definition; an id inside a sentence is a mention. Mentions in example and pattern columns are skipped (they invent ids on
 * purpose), and so are shapes with fewer than MIN_FAMILY defined ids (too few to say what exists). One result per missing id.
 */
export function sweepMissingTargets(wb: WorkbookModel, profile: WorkbookProfile, options: SweepOptions = {}): SweepFinding[] {
  const defined = new Set<string>();
  const mentions: Array<{ token: string; sheet: string; cell: string }> = [];
  for (const sheet of profile.sheets) {
    const skip = new Set(sheet.columns.filter((c) => EXAMPLE_COLUMN.test(c.title ?? '')).map((c) => c.letter));
    const defining = new Set(sheet.columns.filter((c) => DEFINING_COLUMN.test(c.title ?? '')).map((c) => c.letter));
    for (const [row, col, raw] of wb.cells(sheet.name)) {
      const text = raw.trim();
      const letter = columnLetters(col);
      if (defining.has(letter) && row > sheet.headerRow && /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/.test(text)) {
        defined.add(canon(text));
        continue;
      }
      if (skip.has(letter) || row < 1) continue;
      for (const token of text.match(ID_TOKEN) ?? []) mentions.push({ token, sheet: sheet.name, cell: `${letter}${row}` });
    }
  }
  const family = new Map<string, number>();
  for (const id of defined) family.set(shapeOf(id), (family.get(shapeOf(id)) ?? 0) + 1);
  const seen = new Set<string>();
  const looked = new Set<string>();
  const out: SweepFinding[] = [];
  for (const m of mentions) {
    if (isPlaceholder(m.token) || (family.get(shapeOf(m.token)) ?? 0) < MIN_FAMILY) continue;
    looked.add(canon(m.token));
    if (defined.has(canon(m.token)) || seen.has(m.token)) continue;
    seen.add(m.token);
    out.push({
      kind: 'missing_target', location: { sheet: m.sheet, cell: m.cell }, severity: 'MEDIUM', topic: 'reference id link',
      title: `${m.token} is cited but defined nowhere (${m.sheet})`,
      detail: `${m.sheet}!${m.cell} cites "${m.token}", but no cell in the file defines it, although ${family.get(shapeOf(m.token))} other ids of the same form are defined.`,
      fix: `Point ${m.sheet}!${m.cell} at the id that exists, or add ${m.token}.`,
    });
    if (!options.all && out.length >= MAX_MISSING_TARGETS) break;
  }
  if (options.stats) options.stats.references += looked.size;
  return out;
}

/** Word stems with nothing left out (unlike keyStems, which drops generic words such as "parameters"): the noun of a count is exactly such a word. */
const plainStems = (text: string): string[] =>
  (text.toLowerCase().match(/[a-z]{4,}/g) ?? []).map((w) => w.replace(/ies$/, 'y').replace(/(?<=[a-z]{3})s$/, '').slice(0, 5));

/** A number and the words after it: "278 parameters", "116 value sets with 591 codes". */
const STATED_COUNT = /(?<![\w.-])(\d{1,3}(?:,\d{3})+|\d{2,6})\s+((?:[A-Za-z][A-Za-z-]*\s+){0,2}[A-Za-z][A-Za-z-]*)/g;

/**
 * A file that says "278 parameters" next to a sheet called L2_Parameters is making a claim code can check: count the rows. Examiners tend to
 * accept such a figure (a perfect score for a tally the file wrote about itself), so each one is compared with the sheet it names. Only a noun
 * whose every word is in exactly one sheet's name counts, so "85 leaves" or "12 weeks" never matches a sheet by accident.
 */
export function sweepStatedCounts(wb: WorkbookModel, profile: WorkbookProfile, options: SweepOptions = {}): SweepFinding[] {
  // Rows are counted the way the sweep counts them: a TOTAL or COUNT row under the table is not an entry.
  const sheets = profile.sheets.map((s) => ({ s, rows: dataRowsOf(wb, s).length, words: new Set(plainStems(s.name.replace(/_/g, ' '))) })).filter((x) => x.rows >= 5);
  const out: SweepFinding[] = [];
  const seen = new Set<string>();
  for (const sheet of profile.sheets) {
    for (const [row, col, text] of wb.cells(sheet.name)) {
      if (text.length < 8 || text.length > 700) continue;
      for (const m of text.matchAll(STATED_COUNT)) {
        const stated = Number(m[1]!.replace(/,/g, ''));
        const nounWords = plainStems(m[2]!);
        if (nounWords.length === 0) continue;
        // The noun must be the sheet's own name ("parameters" for L2_Parameters), not a word it merely contains ("hooks" in Links_Hooks).
        const matches = sheets.filter((x) => x.s.name !== sheet.name && x.words.size === new Set(nounWords).size && nounWords.every((w) => x.words.has(w)));
        if (matches.length !== 1) continue;
        const target = { name: matches[0]!.s.name, dataRows: matches[0]!.rows };
        // A tally that is slightly off is a slip. A figure far from the row count is about something else ("14 attributes" per record), not this sheet.
        if (stated < 10 || Math.abs(target.dataRows - stated) > Math.max(3, Math.round(target.dataRows * 0.15))) continue;
        if (seen.has(`${target.name}:${stated}`)) continue;
        seen.add(`${target.name}:${stated}`);
        if (options.stats) options.stats.tallies += 1;
        if (target.dataRows === stated) continue;
        // Only the words that name the sheet: "parameters", not "parameters in all".
        const noun = m[2]!.trim().split(/\s+/).filter((w) => plainStems(w).some((s) => matches[0]!.words.has(s))).join(' ') || m[2]!.trim();
        out.push({
          kind: 'stated_count', location: { sheet: sheet.name, cell: `${columnLetters(col)}${row}` }, severity: 'LOW', topic: `${noun} count total`,
          title: `"${stated} ${noun}" does not match ${target.name} (${target.dataRows} rows)`,
          detail: `${sheet.name}!${columnLetters(col)}${row} says there are ${stated} ${noun}, but ${target.name} has ${target.dataRows} data rows.`,
          fix: `Correct the figure at ${sheet.name}!${columnLetters(col)}${row}, or add or remove the missing rows in ${target.name}.`,
        });
      }
    }
  }
  return options.all ? out : out.slice(0, 6);
}

export function sweepWorkbook(wb: WorkbookModel, profile: WorkbookProfile = profileWorkbook(wb), options: SweepOptions = {}): SweepFinding[] {
  return [...profile.sheets.flatMap((sheet) => sweepSheet(wb, sheet, options)), ...sweepMissingTargets(wb, profile, options), ...sweepStatedCounts(wb, profile, options)];
}


/** The sweep over the whole file: every real sheet row by row, plus the tallies the file states about itself (a PDF's field dictionary, "283 of 426 (66%)"). */
export function sweepAll(wb: WorkbookModel, options: SweepOptions = {}): SweepFinding[] {
  const profile = profileWorkbook(wb);
  const real = { sheets: profile.sheets.filter((s) => !isPdfPage(s.name)) };
  return [...sweepWorkbook(wb, real, options), ...recountTallies(wb, profile, options)];
}

/** Pages of a PDF are "sheets" with one column; a sweep by column means nothing there. */
const isPdfPage = (name: string) => /^Page \d+$/.test(name);

const MAX_SWEEP_FINDINGS = 40;
const SEVERITY_RANK: Record<Severity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/** The question a sweep finding belongs to: the one whose words overlap most with the finding's topic and title; else the most heavily weighted. */
function questionFor(finding: SweepFinding, questions: DimensionSpec[]): DimensionSpec | undefined {
  const words = stems(`${finding.topic} ${finding.title}`);
  const scored = questions
    .map((q) => ({ q, hits: [...stems(`${q.name} ${q.measure ?? ''} ${q.description ?? ''}`)].filter((w) => words.has(w)).length }))
    .sort((a, b) => b.hits - a.hits || b.q.weight - a.q.weight);
  return scored[0]?.hits ? scored[0].q : [...questions].sort((a, b) => b.weight - a.weight)[0];
}

/**
 * The sweep's results as code findings, each attached to the scorecard question it is about. They are exact, so the finding filters leave
 * them alone, and they are listed in the report like any other code finding. `questions` are the working questions of the run.
 */
export function sweepFindings(scorecard: Scorecard, questions: DimensionSpec[], wb: WorkbookModel, returnTo: ReturnTo): DraftFinding[] {
  if (questions.length === 0) return [];
  const found = sweepAll(wb).sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]).slice(0, MAX_SWEEP_FINDINGS);
  return found.flatMap((f): DraftFinding[] => {
    const q = questionFor(f, questions);
    if (!q) return [];
    return [{ source: 'code', dimensionId: q.id, severity: f.severity, title: f.title, detail: f.detail, fix: f.fix, returnTo: q.returnTo ?? returnTo, location: f.location, reportedBy: ['code'] }];
  });
}


/** The highest score a question may keep when the sweep found this many mistakes under it. */
export function capFor(mistakes: number): number {
  return mistakes >= 6 ? 2 : mistakes >= 3 ? 3 : mistakes >= 1 ? 4 : 5;
}

/**
 * The score follows the evidence. The examiners read a sheet and may still give a clean 5 to a question with a blank definition or a repeated id
 * under it; the sweep read every row and found them. So a question cannot keep a score above what the exact findings allow: 4 for one or two
 * mistakes, 3 for three to five, 2 for six or more. Only MEDIUM findings count (the sweep marks a filler definition or an empty note LOW), and a
 * cap only ever lowers a score. `parentOf` maps a criterion id to its dimension.
 */
export function capByExactFindings(
  dimensions: DimensionResult[],
  findings: Array<Pick<DraftFinding, 'dimensionId' | 'severity'>>,
  parentOf: ReadonlyMap<string, string>,
): { dimensions: DimensionResult[]; notes: string[] } {
  const count = new Map<string, number>();
  for (const f of findings) {
    if (f.severity === 'LOW') continue;
    const id = parentOf.get(f.dimensionId) ?? f.dimensionId;
    count.set(id, (count.get(id) ?? 0) + 1);
  }
  const notes: string[] = [];
  const capped = dimensions.map((d) => {
    const mistakes = count.get(d.id) ?? 0;
    const cap = capFor(mistakes);
    if (mistakes === 0 || d.measuredBy !== 'raters' || d.status !== 'scored' || d.consolidated === null || d.consolidated <= cap) return d;
    notes.push(`${d.id} was capped at ${cap} (from ${d.consolidated}): the row-by-row sweep found ${mistakes} mistake${mistakes === 1 ? '' : 's'} under this question.`);
    return { ...d, consolidated: cap, rationale: `${d.rationale} Capped at ${cap}: the row-by-row sweep found ${mistakes} mistake${mistakes === 1 ? '' : 's'} under this question, which the examiners' reading had not.` };
  });
  return { dimensions: capped, notes };
}
