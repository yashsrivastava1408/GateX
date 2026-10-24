import { z } from 'zod';
import type { CellRef } from '@ddd/shared';
import type { Table, TableRow } from '../../excel/workbook.js';
import { UserError } from '../../util/errors.js';
import { TEXT_CHECKS } from './textChecks.js';
import type { CheckContext, CheckDefinition, CheckResult } from './types.js';

/**
 * The deterministic checks a scorecard can use for dimensions measured by code.
 * Each one answers "how many of these rows are right?" so the result is an exact
 * ratio that the scorecard's bands turn into a 0-5 score. No model is involved.
 */

const MAX_FAILURES = 25;

const whereSchema = z
  .object({
    column: z.string(),
    equals: z.union([z.string(), z.number()]).optional(),
    not_blank: z.boolean().optional(),
  })
  .optional();
type Where = z.infer<typeof whereSchema>;

/** A row whose first filled cell is a total label ("COUNT", "Total"): it summarises the rows above it and is not one of them. */
const SUMMARY_LABEL = /^(?:counts?|totals?|sum|subtotal|grand total|average|avg|summary)\s*:?$/i;

export function isSummaryRow(table: Table, row: TableRow): boolean {
  const first = table.headers.map((h) => row.values.get(h.title) ?? '').find((v) => v.trim() !== '');
  return first !== undefined && SUMMARY_LABEL.test(first.trim());
}

function load(ctx: CheckContext, sheet: string): Table {
  const header = ctx.headerRows.get(sheet.toLowerCase()) ?? 1;
  const table = ctx.wb.table(sheet, header);
  // The count of rows is not a row to be counted: leave summary rows out of every check.
  const rows = table.rows.filter((row) => !isSummaryRow(table, row));
  return rows.length === table.rows.length ? table : { ...table, rows };
}

function need(table: Table, column: string): void {
  if (!table.headers.some((h) => h.title === column)) {
    const known = table.headers.map((h) => h.title).join(', ');
    throw new UserError(`Column "${column}" was not found in sheet "${table.sheet}". Columns: ${known}`);
  }
}

function matches(row: TableRow, where: Where): boolean {
  if (!where) return true;
  const value = (row.values.get(where.column) ?? '').trim();
  if (where.equals !== undefined && value !== String(where.equals)) return false;
  if (where.not_blank && value === '') return false;
  return true;
}

function rowsWhere(table: Table, where: Where): TableRow[] {
  if (where) need(table, where.column);
  return table.rows.filter((row) => matches(row, where));
}

function cellOf(table: Table, column: string, row: number): CellRef {
  return { sheet: table.sheet, cell: table.address(column, row) ?? `A${row}` };
}

function result(passed: number, total: number, failures: CellRef[], summary: string): CheckResult {
  return { passed, total, failures: failures.slice(0, MAX_FAILURES), summary };
}

/** Every row that passes `ok` counts; the rest are listed as failures at `column`. */
function countRows(table: Table, rows: TableRow[], column: string, ok: (row: TableRow) => boolean) {
  const failures: CellRef[] = [];
  let passed = 0;
  for (const row of rows) {
    if (ok(row)) passed += 1;
    else failures.push(cellOf(table, column, row.row));
  }
  return { passed, failures, total: rows.length };
}

const maxValue: CheckDefinition = {
  describe: 'Numeric values in a column must not exceed a maximum (for example tree depth).',
  run(ctx, raw) {
    const p = z.object({ sheet: z.string(), column: z.string(), max: z.number(), where: whereSchema }).parse(raw);
    const table = load(ctx, p.sheet);
    need(table, p.column);
    const rows = rowsWhere(table, p.where);
    const { passed, failures, total } = countRows(table, rows, p.column, (row) => {
      const value = Number(row.values.get(p.column));
      return Number.isFinite(value) && value <= p.max;
    });
    return result(passed, total, failures, `${passed} of ${total} rows have ${p.column} ≤ ${p.max}`);
  },
};

const columnFilled: CheckDefinition = {
  describe: 'A column must be filled (and match a pattern when one is given).',
  run(ctx, raw) {
    const p = z
      .object({ sheet: z.string(), column: z.string(), pattern: z.string().optional(), where: whereSchema })
      .parse(raw);
    const table = load(ctx, p.sheet);
    need(table, p.column);
    const pattern = p.pattern ? new RegExp(p.pattern) : null;
    const rows = rowsWhere(table, p.where);
    const { passed, failures, total } = countRows(table, rows, p.column, (row) => {
      const value = (row.values.get(p.column) ?? '').trim();
      return value !== '' && (!pattern || pattern.test(value));
    });
    return result(passed, total, failures, `${passed} of ${total} rows have a valid ${p.column}`);
  },
};

const unique: CheckDefinition = {
  describe: 'Values in a column must be unique.',
  run(ctx, raw) {
    const p = z.object({ sheet: z.string(), column: z.string(), where: whereSchema }).parse(raw);
    const table = load(ctx, p.sheet);
    need(table, p.column);
    const rows = rowsWhere(table, p.where).filter((row) => (row.values.get(p.column) ?? '').trim() !== '');
    const counts = new Map<string, number>();
    for (const row of rows) {
      const value = row.values.get(p.column)!.trim();
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    const { passed, failures, total } = countRows(table, rows, p.column, (row) => {
      return counts.get(row.values.get(p.column)!.trim()) === 1;
    });
    return result(passed, total, failures, `${passed} of ${total} ${p.column} values are unique`);
  },
};

const anyFilled: CheckDefinition = {
  describe: 'Each row must have at least one of the listed columns filled.',
  run(ctx, raw) {
    const p = z.object({ sheet: z.string(), columns: z.array(z.string()).min(1), where: whereSchema }).parse(raw);
    const table = load(ctx, p.sheet);
    p.columns.forEach((column) => need(table, column));
    const rows = rowsWhere(table, p.where);
    const { passed, failures, total } = countRows(table, rows, p.columns[0]!, (row) =>
      p.columns.some((column) => (row.values.get(column) ?? '').trim() !== ''),
    );
    return result(passed, total, failures, `${passed} of ${total} rows have one of: ${p.columns.join(', ')}`);
  },
};

function listNames(table: Table, column: string): Set<string> {
  need(table, column);
  return new Set(table.rows.map((row) => (row.values.get(column) ?? '').trim()).filter(Boolean));
}

const listRefsResolve: CheckDefinition = {
  describe: 'Every "list: Name" reference must name a list that exists exactly.',
  run(ctx, raw) {
    const p = z
      .object({
        sheet: z.string(),
        column: z.string(),
        prefix: z.string().default('list:'),
        lists_sheet: z.string(),
        lists_column: z.string(),
        where: whereSchema,
      })
      .parse(raw);
    const table = load(ctx, p.sheet);
    need(table, p.column);
    const names = listNames(load(ctx, p.lists_sheet), p.lists_column);
    const rows = rowsWhere(table, p.where).filter((row) => (row.values.get(p.column) ?? '').trim().startsWith(p.prefix));
    const { passed, failures, total } = countRows(table, rows, p.column, (row) =>
      names.has((row.values.get(p.column) ?? '').trim().slice(p.prefix.length).trim()),
    );
    return result(passed, total, failures, `${passed} of ${total} list references name an existing list`);
  },
};

const listsReferenced: CheckDefinition = {
  describe: 'Every defined list must be used by at least one reference.',
  run(ctx, raw) {
    const p = z
      .object({
        sheet: z.string(),
        column: z.string(),
        prefix: z.string().default('list:'),
        lists_sheet: z.string(),
        lists_column: z.string(),
      })
      .parse(raw);
    const refs = load(ctx, p.sheet);
    need(refs, p.column);
    const lists = load(ctx, p.lists_sheet);
    need(lists, p.lists_column);
    const used = new Set(
      refs.rows
        .map((row) => (row.values.get(p.column) ?? '').trim())
        .filter((value) => value.startsWith(p.prefix))
        .map((value) => value.slice(p.prefix.length).trim()),
    );
    const firstRowOf = new Map<string, number>();
    for (const row of lists.rows) {
      const name = (row.values.get(p.lists_column) ?? '').trim();
      if (name && !firstRowOf.has(name)) firstRowOf.set(name, row.row);
    }
    const failures: CellRef[] = [];
    let passed = 0;
    for (const [name, row] of firstRowOf) {
      if (used.has(name)) passed += 1;
      else failures.push(cellOf(lists, p.lists_column, row));
    }
    return result(passed, firstRowOf.size, failures, `${passed} of ${firstRowOf.size} lists are referenced by a field`);
  },
};

const valuesInList: CheckDefinition = {
  describe: 'Values in a data column must all be values of an allowed list.',
  run(ctx, raw) {
    const p = z
      .object({
        sheet: z.string(),
        column: z.string(),
        lists_sheet: z.string(),
        lists_name_column: z.string(),
        lists_value_column: z.string(),
        list: z.string(),
        where: whereSchema,
      })
      .parse(raw);
    const table = load(ctx, p.sheet);
    need(table, p.column);
    const lists = load(ctx, p.lists_sheet);
    need(lists, p.lists_name_column);
    need(lists, p.lists_value_column);
    const allowed = new Set(
      lists.rows
        .filter((row) => (row.values.get(p.lists_name_column) ?? '').trim() === p.list)
        .map((row) => (row.values.get(p.lists_value_column) ?? '').trim()),
    );
    if (allowed.size === 0) {
      throw new UserError(`List "${p.list}" has no values in sheet "${p.lists_sheet}".`);
    }
    const rows = rowsWhere(table, p.where).filter((row) => (row.values.get(p.column) ?? '').trim() !== '');
    const { passed, failures, total } = countRows(table, rows, p.column, (row) =>
      allowed.has((row.values.get(p.column) ?? '').trim()),
    );
    return result(passed, total, failures, `${passed} of ${total} ${p.column} values are in list ${p.list}`);
  },
};

const valueNotIn: CheckDefinition = {
  describe: 'A column must not hold any of the forbidden values (blank counts as forbidden by default).',
  run(ctx, raw) {
    const p = z
      .object({
        sheet: z.string(),
        column: z.string(),
        forbidden: z.array(z.string()),
        blank_fails: z.boolean().default(true),
        where: whereSchema,
      })
      .parse(raw);
    const table = load(ctx, p.sheet);
    need(table, p.column);
    const forbidden = new Set(p.forbidden.map((v) => v.toLowerCase()));
    const rows = rowsWhere(table, p.where);
    const { passed, failures, total } = countRows(table, rows, p.column, (row) => {
      const value = (row.values.get(p.column) ?? '').trim();
      if (value === '') return !p.blank_fails;
      return !forbidden.has(value.toLowerCase());
    });
    return result(passed, total, failures, `${passed} of ${total} rows have a real ${p.column} value`);
  },
};

const rowCountAtLeast: CheckDefinition = {
  describe: 'A sheet must have at least a minimum number of rows.',
  run(ctx, raw) {
    const p = z.object({ sheet: z.string(), min: z.number().int().positive(), where: whereSchema }).parse(raw);
    const table = load(ctx, p.sheet);
    const count = rowsWhere(table, p.where).length;
    const passed = Math.min(count, p.min);
    return result(passed, p.min, [], `${count} rows found, ${p.min} needed`);
  },
};

export const CHECKS: Record<string, CheckDefinition> = {
  max_value: maxValue,
  column_filled: columnFilled,
  unique,
  any_filled: anyFilled,
  list_refs_resolve: listRefsResolve,
  lists_referenced: listsReferenced,
  values_in_list: valuesInList,
  value_not_in: valueNotIn,
  row_count_at_least: rowCountAtLeast,
  ...TEXT_CHECKS,
};
