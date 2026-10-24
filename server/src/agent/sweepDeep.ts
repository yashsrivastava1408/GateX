import type { CellRef } from '@ddd/shared';
import type { ColumnProfile, SheetProfile, WorkbookProfile } from '../excel/profile.js';
import type { WorkbookModel } from '../excel/workbook.js';
import { dataRowsOf, idColumnOf, MIN_ROWS, norm, type SweepFinding, type SweepOptions } from './sweep.js';

/**
 * Deep checks: more row-by-row counts with one deterministic answer. They are used ONLY to count a scorecard criterion whose own words ask
 * for that count (an id pattern, an orphan row, a reference that must resolve, a value from the allowed ones), so they are not listed as
 * report issues: a rule that is wrong about one unseen layout can lower one criterion's ceiling, but never adds an issue the author has to
 * chase. Each one stays silent unless the column plainly follows the rule almost everywhere.
 *
 *   bad_id_format    an id that breaks the pattern the criterion states ("NFR-nnn"), or that differs from the pattern all the others share
 *   cross_reference  a value in a column of one sheet that is not an id of the sheet whose ids nearly all its other values are
 *   orphan_row       a path id such as 1.2.3 whose parent 1.2 is not a row of the same sheet
 *   near_miss_value  a value that is a case or one-letter variant of the value that nearly every other row uses ("high" among "High")
 *   too_wide         a parent with more children than the limit the criterion states ("no section has more than 10 children")
 *   restated_reason  a "reason" cell that is the definition of the same row copied over
 */

const MAX_BAD = 5;
const cellOf = (col: ColumnProfile, row: number) => `${col.letter}${row}`;
const at = (sheet: string, col: ColumnProfile, row: number): CellRef => ({ sheet, cell: cellOf(col, row) });

/** A pattern the criterion's own words state: "NFR-nnn", "ID-####", "WF-00". Returns the prefix and the number of digits. */
export function statedIdPattern(text: string): { prefix: string; digits: number; regex: RegExp } | null {
  const m = /(?<![A-Za-z0-9-])([A-Z][A-Z0-9]{1,7})-(n{2,}|N{2,}|#{2,}|0{2,}|X{2,})(?![A-Za-z0-9])/.exec(text);
  if (!m) return null;
  const prefix = `${m[1]}-`;
  const digits = m[2]!.length;
  return { prefix, digits, regex: new RegExp(`^${m[1]}-\\d{${digits}}$`) };
}

/** letters and separators kept, each run of digits replaced by # and its length: "NFR-001" -> "NFR-#3". */
const shapeOf = (v: string) => v.replace(/\d+/g, (d) => `#${d.length}`);
const looseShape = (v: string) => v.replace(/\d+/g, '#');

/**
 * Ids that break the id pattern. `stated` is the pattern the criterion names; without one, the pattern nearly all the ids of the column share.
 * Only an id column of a sheet is looked at, and only when the column is plainly governed by the pattern: with a stated one, 90% of the ids
 * must start with its prefix; without, 97% must share one shape that has a letter in it (path ids such as 1.2.3 vary in depth by design).
 */
export function sweepIdFormats(wb: WorkbookModel, profile: WorkbookProfile, stated: ReturnType<typeof statedIdPattern>, options: SweepOptions = {}): { found: SweepFinding[]; looked: number } {
  const found: SweepFinding[] = [];
  let looked = 0;
  for (const sheet of profile.sheets) {
    const idCol = idColumnOf(sheet);
    if (!idCol) continue;
    const rows = dataRowsOf(wb, sheet);
    if (rows.length < MIN_ROWS) continue;
    const ids = rows.map((r) => ({ r, v: norm(wb.cellText(sheet.name, cellOf(idCol, r)) ?? '') })).filter((x) => x.v !== '');
    if (ids.length < MIN_ROWS) continue;
    let bad: Array<{ r: number; v: string; why: string }> = [];
    if (stated) {
      if (ids.filter((x) => x.v.startsWith(stated.prefix)).length / ids.length < 0.9) continue;
      bad = ids.filter((x) => !stated.regex.test(x.v)).map((x) => ({ ...x, why: `does not follow ${stated.prefix}${'n'.repeat(stated.digits)}` }));
    } else {
      const counts = new Map<string, number>();
      for (const x of ids) counts.set(shapeOf(x.v), (counts.get(shapeOf(x.v)) ?? 0) + 1);
      const [top, topCount] = [...counts].sort((a, b) => b[1] - a[1])[0]!;
      if (!/[A-Za-z]/.test(top) || topCount / ids.length < 0.97 || topCount < 30) continue;
      // PER-999 followed by PER-1000 is the count growing, not a slip: a longer number under a zero-padded pattern.
      const sample = ids.find((y) => shapeOf(y.v) === top)!.v;
      const padded = /\d/.test(sample) && /(?<=\D)0\d*$/.test(sample);
      bad = ids
        .filter((x) => shapeOf(x.v) !== top)
        .filter((x) => !(padded && looseShape(x.v) === looseShape(sample) && x.v.length > sample.length))
        .map((x) => ({ ...x, why: `has a different form from the other ${topCount} ids (${sample})` }));
      if (bad.length > Math.max(3, Math.floor(ids.length * 0.03))) continue;
    }
    looked += ids.length;
    for (const x of bad.slice(0, options.all ? Infinity : MAX_BAD))
      found.push({
        kind: 'bad_id_format', location: at(sheet.name, idCol, x.r), severity: 'MEDIUM', topic: idCol.title,
        title: `Id ${x.v} breaks the id pattern (${sheet.name})`,
        detail: `${sheet.name}!${cellOf(idCol, x.r)} holds "${x.v}", which ${x.why}.`,
        fix: `Correct the id at ${cellOf(idCol, x.r)}.`,
      });
  }
  return { found, looked };
}

const splitRefs = (v: string) => v.split(/[,;|]/).map(norm).filter(Boolean);
const hasLetter = (v: string) => /[A-Za-z]/.test(v);
const stemWords = (t: string) => new Set((t.toLowerCase().match(/[a-z]{3,}/g) ?? []).map((w) => w.replace(/s$/, '')));

/**
 * A column of one sheet whose values are, almost all, ids of ANOTHER sheet (role -> the roles sheet): the few values that are not ids there are
 * dangling. The sheet it points to must be named for it (the column title and the sheet name or its id column share a word) or the match must
 * be near total, so a column that merely reuses short codes never counts.
 */
export function sweepCrossReferences(wb: WorkbookModel, profile: WorkbookProfile, options: SweepOptions = {}): SweepFinding[] {
  const out: SweepFinding[] = [];
  const targets = profile.sheets
    .map((s) => ({ s, idCol: idColumnOf(s) }))
    .filter((x): x is { s: SheetProfile; idCol: ColumnProfile } => !!x.idCol && x.s.dataRows >= MIN_ROWS)
    .map(({ s, idCol }) => ({ s, idCol, ids: new Set(dataRowsOf(wb, s).map((r) => norm(wb.cellText(s.name, cellOf(idCol, r)) ?? '')).filter(Boolean)) }))
    .filter((t) => t.ids.size >= MIN_ROWS && [...t.ids].every(hasLetter));
  for (const sheet of profile.sheets) {
    const rows = dataRowsOf(wb, sheet);
    if (rows.length < MIN_ROWS) continue;
    const own = idColumnOf(sheet);
    for (const col of sheet.columns.filter((c) => c.title && c !== own && (c.kind === 'code' || c.kind === 'id' || c.kind === 'text') && c.avgLength <= 40)) {
      const used = rows.map((r) => ({ r, vs: splitRefs(norm(wb.cellText(sheet.name, cellOf(col, r)) ?? '')) })).filter((x) => x.vs.length > 0);
      const values = used.flatMap((x) => x.vs);
      if (used.length < MIN_ROWS || !values.every((v) => v.length <= 40)) continue;
      let best: { t: (typeof targets)[number]; share: number } | null = null;
      for (const t of targets) {
        if (t.s.name === sheet.name) continue;
        const share = values.filter((v) => t.ids.has(v)).length / values.length;
        if (!best || share > best.share) best = { t, share };
      }
      if (!best) continue;
      if (options.stats && best.share >= 0.9) options.stats.references += used.length;
      const named = [...stemWords(col.title)].some((w) => stemWords(`${best!.t.s.name.replace(/_/g, ' ')} ${best!.t.idCol.title}`).has(w));
      const badRows = used.filter((x) => !x.vs.every((v) => best!.t.ids.has(v)));
      if (badRows.length === 0 || badRows.length > Math.max(3, Math.floor(used.length * 0.02))) continue;
      if (best.share < (named ? 0.9 : 0.98)) continue;
      for (const x of badRows.slice(0, options.all ? Infinity : MAX_BAD)) {
        const missing = x.vs.filter((v) => !best!.t.ids.has(v));
        out.push({
          kind: 'cross_reference', location: at(sheet.name, col, x.r), severity: 'MEDIUM', topic: `${col.title} reference link`,
          title: `"${col.title}" ${missing.join(', ')} is not in ${best.t.s.name}`,
          detail: `${sheet.name}!${cellOf(col, x.r)} holds "${missing.join(', ')}", which is not an id in ${best.t.s.name}!${best.t.idCol.letter}; the other ${used.length - badRows.length} values of this column all are.`,
          fix: `Correct the value at ${cellOf(col, x.r)}, or add the missing row to ${best.t.s.name}.`,
        });
      }
    }
  }
  return out;
}

/** A row of a path-id register (1, 1.1, 1.1.2) whose parent (1.1) is not a row of the sheet. */
export function sweepOrphanRows(wb: WorkbookModel, profile: WorkbookProfile, options: SweepOptions = {}): SweepFinding[] {
  const out: SweepFinding[] = [];
  for (const sheet of profile.sheets) {
    const idCol = idColumnOf(sheet);
    if (!idCol) continue;
    const rows = dataRowsOf(wb, sheet);
    const ids = rows.map((r) => ({ r, v: norm(wb.cellText(sheet.name, cellOf(idCol, r)) ?? '') })).filter((x) => x.v !== '');
    if (ids.length < MIN_ROWS || ids.filter((x) => /^\d+(?:\.\d+)*$/.test(x.v)).length / ids.length < 0.95) continue;
    const have = new Set(ids.map((x) => x.v));
    const children = ids.filter((x) => x.v.includes('.'));
    if (children.length < MIN_ROWS) continue;
    const orphans = children.filter((x) => !have.has(x.v.slice(0, x.v.lastIndexOf('.'))));
    // The parents must be in this sheet for nearly every child, or the register keeps its levels on other sheets.
    if (options.stats) options.stats.references += children.length;
    if (orphans.length === 0 || orphans.length > Math.max(3, Math.floor(children.length * 0.03))) continue;
    for (const x of orphans.slice(0, options.all ? Infinity : MAX_BAD))
      out.push({
        kind: 'orphan_row', location: at(sheet.name, idCol, x.r), severity: 'MEDIUM', topic: `${idCol.title} parent`,
        title: `Row ${x.v} has no parent row (${sheet.name})`,
        detail: `${sheet.name}!${cellOf(idCol, x.r)} is ${x.v}, but its parent ${x.v.slice(0, x.v.lastIndexOf('.'))} is not a row of ${sheet.name}.`,
        fix: `Add the parent row ${x.v.slice(0, x.v.lastIndexOf('.'))}, or correct the id.`,
      });
  }
  return out;
}

const oneLetterApart = (a: string, b: string): boolean => {
  if (a.length !== b.length) {
    const [s, l] = a.length < b.length ? [a, b] : [b, a];
    if (l.length - s.length !== 1) return false;
    for (let i = 0; i < l.length; i++) if (l.slice(0, i) + l.slice(i + 1) === s) return true;
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff += 1;
  return diff === 1;
};

/** In a column that holds a few values over and over, a value used once or twice that is only a case or one-letter slip of one of them. */
export function sweepNearMissValues(wb: WorkbookModel, profile: WorkbookProfile, options: SweepOptions = {}): SweepFinding[] {
  const out: SweepFinding[] = [];
  for (const sheet of profile.sheets) {
    const rows = dataRowsOf(wb, sheet);
    if (rows.length < 30) continue;
    for (const col of sheet.columns.filter((c) => c.title && c.kind === 'code' && c.distinct >= 2 && c.distinct <= 14)) {
      const cells = rows.map((r) => ({ r, v: norm(wb.cellText(sheet.name, cellOf(col, r)) ?? '') })).filter((x) => x.v !== '');
      const counts = new Map<string, number>();
      for (const x of cells) counts.set(x.v, (counts.get(x.v) ?? 0) + 1);
      const counted = new Set<ColumnProfile>();
      const usual = [...counts].filter(([, n]) => n >= 10 && n / cells.length >= 0.05).map(([v]) => v);
      if (usual.length < 2) continue;
      for (const [v, n] of counts) {
        if (n > 2 || usual.includes(v)) continue;
        const twin = usual.find((u) => u.toLowerCase() === v.toLowerCase() || (v.length >= 6 && !/\d/.test(v + u) && oneLetterApart(u.toLowerCase(), v.toLowerCase())));
        if (!twin) continue;
        if (options.stats && !counted.has(col)) {
          counted.add(col);
          options.stats.obligations += cells.length;
        }
        for (const x of cells.filter((y) => y.v === v).slice(0, options.all ? Infinity : MAX_BAD))
          out.push({
            kind: 'near_miss_value', location: at(sheet.name, col, x.r), severity: 'LOW', topic: col.title,
            title: `"${v}" looks like a slip for "${twin}" in "${col.title}" (${sheet.name})`,
            detail: `${sheet.name}!${cellOf(col, x.r)} holds "${v}", while every other row of "${col.title}" uses one of ${usual.slice(0, 6).map((u) => `"${u}"`).join(', ')}.`,
            fix: `Change ${cellOf(col, x.r)} to "${twin}", or add "${v}" to the allowed values.`,
          });
      }
    }
  }
  return out;
}

/** Every deep check except the id pattern (which depends on the question's words). */
export function sweepDeep(wb: WorkbookModel, profile: WorkbookProfile, options: SweepOptions = {}): SweepFinding[] {
  return [...sweepCrossReferences(wb, profile, options), ...sweepOrphanRows(wb, profile, options), ...sweepNearMissValues(wb, profile, options), ...sweepRestatedReasons(wb, profile, options)];
}

/** The most children a parent may have, when the criterion says it: "no more than 10 children", "15 children or fewer", "<= 15 children". */
export function statedChildLimit(text: string): number | null {
  const m =
    /\b(?:more than|over|above|exceeds?|exceeding)\s+(\d{1,3})\s+children\b/i.exec(text) ??
    /(?:≤|<=|\bat most|\bno more than|\bup to|\bmax(?:imum)?(?: of)?)\s*(\d{1,3})\s+children\b/i.exec(text) ??
    /\b(\d{1,3})\s+children\s+or\s+(?:fewer|less)\b/i.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * Parents with more children than the stated limit. A sheet is read as a tree only when its structure is plain: ids that are all path ids
 * (1, 1.1, 1.1.2) or a Parent column whose values nearly all resolve to ids of the sheet.
 */
export function sweepWidth(wb: WorkbookModel, profile: WorkbookProfile, limit: number | null, options: SweepOptions = {}): { found: SweepFinding[]; looked: number } {
  const found: SweepFinding[] = [];
  let looked = 0;
  if (limit === null) return { found, looked };
  for (const sheet of profile.sheets) {
    const idCol = idColumnOf(sheet);
    if (!idCol) continue;
    const rows = dataRowsOf(wb, sheet);
    const ids = rows.map((r) => ({ r, v: norm(wb.cellText(sheet.name, cellOf(idCol, r)) ?? '') })).filter((x) => x.v !== '');
    if (ids.length < MIN_ROWS) continue;
    const have = new Map(ids.map((x) => [x.v, x.r]));
    const children = new Map<string, number>();
    const parentCol = sheet.columns.find((c) => /^parent(?:\s*id)?$/i.test(c.title.trim()));
    if (ids.filter((x) => /^\d+(?:\.\d+)*$/.test(x.v)).length / ids.length >= 0.95) {
      for (const x of ids) if (x.v.includes('.')) {
        const parent = x.v.slice(0, x.v.lastIndexOf('.'));
        children.set(parent, (children.get(parent) ?? 0) + 1);
      }
    } else if (parentCol) {
      const refs = rows.map((r) => norm(wb.cellText(sheet.name, cellOf(parentCol, r)) ?? '')).filter(Boolean);
      if (refs.length < MIN_ROWS || refs.filter((v) => have.has(v)).length / refs.length < 0.9) continue;
      for (const v of refs) if (have.has(v)) children.set(v, (children.get(v) ?? 0) + 1);
    } else continue;
    looked += children.size;
    for (const [parent, n] of children) {
      if (n <= limit || !have.has(parent)) continue;
      found.push({
        kind: 'too_wide', location: at(sheet.name, idCol, have.get(parent)!), severity: 'LOW', topic: `${idCol.title} children`,
        title: `${parent} has ${n} children, over the limit of ${limit} (${sheet.name})`,
        detail: `${sheet.name}!${cellOf(idCol, have.get(parent)!)}: ${parent} has ${n} children; the limit is ${limit}.`,
        fix: `Split ${parent} so that no parent has more than ${limit} children.`,
      });
    }
  }
  return { found: options.all ? found : found.slice(0, MAX_BAD), looked };
}

const plain = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** A "reason" or "why" cell that is the definition of the same row copied over (equal after case and punctuation, or the whole definition inside it). */
export function sweepRestatedReasons(wb: WorkbookModel, profile: WorkbookProfile, options: SweepOptions = {}): SweepFinding[] {
  const out: SweepFinding[] = [];
  for (const sheet of profile.sheets) {
    const rows = dataRowsOf(wb, sheet);
    if (rows.length < MIN_ROWS) continue;
    const reasonCol = sheet.columns.find((c) => /^(?:reason(?: it exists)?|why(?: it exists)?|rationale)\b/i.test(c.title.trim()) && c.kind === 'text');
    const defCol = sheet.columns.find((c) => /^(?:definition|what to write|description)\b/i.test(c.title.trim()) && c.kind === 'text');
    if (!reasonCol || !defCol) continue;
    for (const r of rows) {
      const reason = plain(wb.cellText(sheet.name, cellOf(reasonCol, r)) ?? '');
      const def = plain(wb.cellText(sheet.name, cellOf(defCol, r)) ?? '');
      if (reason.length < 25 || def.length < 25) continue;
      if (reason === def || reason.includes(def) || def.includes(reason))
        out.push({
          kind: 'restated_reason', location: at(sheet.name, reasonCol, r), severity: 'LOW', topic: `${reasonCol.title} ${defCol.title}`,
          title: `"${reasonCol.title}" only repeats the definition (${sheet.name} row ${r})`,
          detail: `${sheet.name}!${cellOf(reasonCol, r)} says the same as ${cellOf(defCol, r)}, so it gives no reason.`,
          fix: `Say why this exists, not what it is.`,
        });
    }
  }
  return options.all ? out : out.slice(0, MAX_BAD);
}
