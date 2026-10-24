import { columnIndex, WorkbookModel } from '../excel/workbook.js';
import { looksLikeCsv, parseCsvRows, pickDelimiter } from '../excel/csvReader.js';
import { patchCells } from '../excel/patchXlsx.js';
import { profileWorkbook, type SheetProfile } from '../excel/profile.js';

/**
 * Breaks a good register on purpose, in known ways, so a test can tell how many of them the evaluator finds. Every change is
 * recorded with its cell and the text before and after. Deterministic: the same file and seed always give the same changes.
 * Works on a register-like sheet (one row per entry, with an id and a definition column) in an .xlsx or a .csv.
 */

export type DefectKind = 'blank_definition' | 'blank_reason' | 'blank_type' | 'duplicate_id' | 'broken_parent' | 'invalid_required' | 'vague_definition' | 'wrong_count';

export interface PlantedDefect {
  id: string;
  kind: DefectKind;
  sheet: string;
  cell: string;
  row: number;
  /** The register id of the entry that was changed (for a duplicate, the id that now appears twice). */
  recordId: string;
  before: string;
  after: string;
  description: string;
}

export interface PlantResult {
  bytes: Buffer;
  defects: PlantedDefect[];
  /** Defects that could not be planted, with the reason (for example the sheet has no "Required" column). */
  skipped: string[];
  sheet: string;
}

const VAGUE = 'Handles various things as needed, etc., and so on.';
const BROKEN_PARENT = '99.99.99';
const INVALID_REQUIRED = 'Maybe';

/** The kinds in the order they are planted; each takes a different row. */
export const DEFECT_KINDS: DefectKind[] = ['blank_definition', 'blank_reason', 'blank_type', 'duplicate_id', 'broken_parent', 'invalid_required', 'vague_definition', 'wrong_count'];

const find = (sheet: SheetProfile, pattern: RegExp) => sheet.columns.find((c) => c.title && pattern.test(c.title));
/** The id column: the profile's, or else a column titled like an id whose every value is different (ids such as 1.1 read as numbers). */
const idColumnOf = (sheet: SheetProfile) =>
  sheet.columns.find((c) => c.title === sheet.idColumn) ?? sheet.columns.find((c) => c.title && /\bid\b|^path|^ref/i.test(c.title) && c.filled > 0 && c.distinct === c.filled);

interface Plan {
  kind: DefectKind;
  column: string;
  describe: (id: string) => string;
}

/** Row numbers spread evenly through the candidates, one per defect, so no two defects share a row and none sits at the very top or bottom. */
function spread(rows: number[], count: number, seed: number): number[] {
  if (rows.length === 0) return [];
  const out: number[] = [];
  for (let k = 0; k < count; k++) {
    const shift = ((seed * 0.6180339887) % 1) * 0.8; // a different seed moves every defect by up to most of a step
    const at = Math.min(rows.length - 1, Math.floor(((k + 0.1 + shift) * rows.length) / count));
    out.push(rows[at]!);
  }
  return out;
}

function toCsv(rows: string[][], delimiter: string): string {
  const quote = (v: string) => (v.includes(delimiter) || /["\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map(quote).join(delimiter)).join('\n') + '\n';
}

export async function plantDefects(source: Buffer, options: { seed?: number; kinds?: DefectKind[] } = {}): Promise<PlantResult> {
  const seed = options.seed ?? 1;
  const kinds = options.kinds ?? DEFECT_KINDS;
  const isCsv = looksLikeCsv(source);
  const wb = await WorkbookModel.load(source);
  const profile = profileWorkbook(wb);
  // The register is the sheet with the most data rows that has an id column and a definition column.
  const sheet = [...profile.sheets].filter((s) => idColumnOf(s) && find(s, /definition/i)).sort((a, b) => b.dataRows - a.dataRows)[0];
  if (!sheet) throw new Error('No register-like sheet (an id column and a definition column) was found, so nothing can be planted.');

  const col = {
    id: idColumnOf(sheet)!,
    definition: find(sheet, /definition/i)!,
    reason: find(sheet, /reason/i),
    type: find(sheet, /^data type$|^type$/i),
    required: find(sheet, /^required$|obligation/i),
    parent: find(sheet, /^parent/i),
    children: find(sheet, /^children|child count/i),
  };
  const text = (letter: string, row: number) => wb.cellText(sheet.name, `${letter}${row}`) ?? '';
  const dataRows = wb.cells(sheet.name).map(([r]) => r).filter((r, i, a) => r > sheet.headerRow && a.indexOf(r) === i);
  const filled = (letter: string) => dataRows.filter((r) => text(letter, r).trim() !== '');

  const plans = new Map<DefectKind, { column: string; rows: number[] } | string>();
  const need = (kind: DefectKind, column: { letter: string } | undefined, label: string, rows?: number[]) =>
    plans.set(kind, column ? { column: column.letter, rows: rows ?? filled(column.letter) } : `no ${label} column`);
  need('blank_definition', col.definition, 'definition');
  need('blank_reason', col.reason, 'reason');
  need('blank_type', col.type, 'data type');
  need('duplicate_id', col.id, 'id', filled(col.id.letter).slice(1));
  need('broken_parent', col.parent, 'parent');
  need('invalid_required', col.required, 'required');
  need('vague_definition', col.definition, 'definition');
  need('wrong_count', col.children, 'children', col.children ? filled(col.children.letter).filter((r) => /^\d+$/.test(text(col.children!.letter, r).trim())) : []);

  const chosenRows = spread(dataRows.filter((r) => text(col.definition.letter, r).trim() !== ''), kinds.length, seed);
  const used = new Set<number>();
  const defects: PlantedDefect[] = [];
  const skipped: string[] = [];
  const edits = new Map<string, { value: string; numeric: boolean }>();
  kinds.forEach((kind, k) => {
    const plan = plans.get(kind);
    if (typeof plan === 'string' || !plan) return void skipped.push(`${kind}: ${plan ?? 'unknown kind'}`);
    const candidates = plan.rows.filter((r) => !used.has(r) && text(col.definition.letter, r).trim() !== '');
    // Start from the row chosen for this defect and take the nearest unused candidate at or after it.
    const wanted = chosenRows[k] ?? candidates[0];
    const row = candidates.find((r) => r >= (wanted ?? 0)) ?? candidates[candidates.length - 1];
    if (row === undefined) return void skipped.push(`${kind}: no suitable row`);
    used.add(row);
    const before = text(plan.column, row);
    const recordId = kind === 'duplicate_id' ? text(col.id.letter, row - 1) || before : text(col.id.letter, row);
    let after = '';
    let description = '';
    if (kind === 'blank_definition') { after = ''; description = 'The definition was emptied.'; }
    else if (kind === 'blank_reason') { after = ''; description = 'The "reason it exists" was emptied.'; }
    else if (kind === 'blank_type') { after = ''; description = 'The data type was emptied.'; }
    else if (kind === 'duplicate_id') { after = recordId; description = `The id was changed to ${recordId}, which the row above already has.`; }
    else if (kind === 'broken_parent') { after = BROKEN_PARENT; description = `The parent id was set to ${BROKEN_PARENT}, which does not exist.`; }
    else if (kind === 'invalid_required') { after = INVALID_REQUIRED; description = `"Required" was set to "${INVALID_REQUIRED}", which is not a valid value.`; }
    else if (kind === 'vague_definition') { after = VAGUE; description = 'The definition was replaced with vague words.'; }
    else { after = String(Number(before) + 7); description = `The child count was changed from ${before} to ${after}, which no longer matches the rows.`; }
    edits.set(`${plan.column}${row}`, { value: after, numeric: kind === 'wrong_count' });
    defects.push({ id: `P-${String(defects.length + 1).padStart(2, '0')}`, kind, sheet: sheet.name, cell: `${plan.column}${row}`, row, recordId, before, after, description });
  });

  let bytes: Buffer;
  if (isCsv) {
    const raw = Buffer.from(source).toString('utf8').replace(/^﻿/, '');
    const delimiter = pickDelimiter(raw);
    const rows = parseCsvRows(raw, delimiter);
    for (const [address, { value }] of edits) {
      const m = /^([A-Z]+)(\d+)$/.exec(address)!;
      const r = Number(m[2]) - 1;
      const c = columnIndex(m[1]!) - 1;
      while ((rows[r] ?? []).length <= c) (rows[r] ??= []).push('');
      rows[r]![c] = value;
    }
    bytes = Buffer.from(toCsv(rows, delimiter), 'utf8');
  } else {
    const patch: Record<string, string | number | null> = {};
    for (const [address, { value, numeric }] of edits) patch[address] = value === '' ? null : numeric ? Number(value) : value;
    bytes = await patchCells(source, sheet.name, patch);
  }
  return { bytes, defects, skipped, sheet: sheet.name };
}
