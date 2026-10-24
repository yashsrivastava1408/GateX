import ExcelJS from 'exceljs';
import { scorecardFileSchema, type Scorecard } from '@ddd/shared';
import { WorkbookModel, type Table, type TableRow } from '../excel/workbook.js';
import { UserError } from '../util/errors.js';

/**
 * A scorecard written in Excel instead of YAML. It has three sheets, and is turned into exactly
 * the object the YAML format produces, so the same validation, hashing and agent apply.
 *
 *   Scorecard    Setting | Value          id, name, version, judges, step, approval, accept, refine (frozen is optional)
 *   Sheets       Sheet | Header row | Columns | Role        which sheets of the evaluated workbook to read
 *   Dimensions   one row per dimension: ID, Name, Weight, Critical, Measured by, Measure, Description,
 *                Anchor 5 ... Anchor 0, Check, Params, Bands, Fix, Needs, Return to
 *
 * Extra sheets (such as "How to fill") are ignored. Column titles are matched ignoring case.
 */

export const BAND_PRESETS: Record<string, string> = {
  strict: '1:5, 0.97:4, 0.9:3, 0.75:2, 0.01:1',
  exact: '1:5, 0.01:1',
};

const ANCHOR_LEVELS = [5, 4, 3, 2, 1, 0] as const;
const MEASURED_BY = ['code', 'raters', 'human'];
const ROLES = ['judged', 'context'];
const RETURN_TO = ['Discover', 'Define', 'Generate', 'Analyse', 'Validate', 'Refine'];

const DIMENSION_COLUMNS = [
  'ID', 'Name', 'Weight', 'Critical', 'Measured by', 'Measure', 'Description',
  ...ANCHOR_LEVELS.map((n) => `Anchor ${n}`),
  'Check', 'Params', 'Bands', 'Fix', 'Needs', 'Return to', 'Reads',
] as const;

/* ------------------------------ reading ------------------------------ */

const norm = (text: string) => text.toLowerCase().replace(/[\s_]+/g, ' ').trim();

function cell(row: TableRow, column: string): string {
  for (const [title, value] of row.values) if (norm(title) === norm(column)) return value.trim();
  return '';
}

function requireSheet(wb: WorkbookModel, name: string): Table {
  const real = wb.resolveSheet(name);
  if (!real) {
    throw new UserError(
      `The Excel scorecard needs a sheet called "${name}". Sheets found: ${wb.sheetNames().join(', ') || '(none)'}. ` +
        'Download the template from the New evaluation page to see the layout.',
    );
  }
  return wb.table(real, 1);
}

function requireColumns(table: Table, columns: string[]): void {
  const have = new Set(table.headers.map((h) => norm(h.title)));
  const missing = columns.filter((c) => !have.has(norm(c)));
  if (missing.length > 0) {
    throw new UserError(
      `Sheet "${table.sheet}" needs a column titled "${missing[0]}" in row 1. Columns found: ${table.headers.map((h) => h.title).join(', ') || '(none)'}. If this scorecard is in another layout, rename its sheets so it is not taken for this layout, and it will be converted automatically.`,
    );
  }
}

function yesNo(text: string): boolean {
  return ['yes', 'y', 'true', '1', 'x'].includes(text.trim().toLowerCase());
}

function parseBands(text: string, where: string): Array<{ min: number; score: number }> {
  const spec = BAND_PRESETS[text.trim().toLowerCase()] ?? text;
  const bands = spec
    .split(/[,;\n]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [min, score] = part.split(':').map((n) => Number(n.trim()));
      if (!Number.isFinite(min) || !Number.isFinite(score)) {
        throw new UserError(`${where}: Bands must be "strict", "exact", or pairs like 1:5, 0.9:3, 0.01:1 (got "${part}").`);
      }
      return { min: min!, score: score! };
    });
  if (bands.length === 0) {
    throw new UserError(`${where}: a code dimension needs Bands: "strict", "exact", or pairs like 1:5, 0.9:3, 0.01:1.`);
  }
  return bands;
}

function parseParams(text: string, where: string): Record<string, unknown> {
  if (text === '') return {};
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value as Record<string, unknown>;
  } catch (error) {
    throw new UserError(
      `${where}: Params must be a JSON object such as {"sheet": "Tree", "column": "Definition"} (${(error as Error).message}).`,
    );
  }
}

const FIELD_LABEL: Record<string, string> = {
  id: 'ID', name: 'Name', weight: 'Weight', critical: 'Critical', measured_by: 'Measured by', measure: 'Measure',
  description: 'Description', anchors: 'the Anchor columns', check: 'Check / Params / Bands', needs: 'Needs', return_to: 'Return to',
};

/** Reads an Excel scorecard into the raw object the YAML format would have produced. */
export async function readExcelScorecard(buffer: Buffer, filename: string): Promise<unknown> {
  const wb = await WorkbookModel.load(buffer);

  const settingsTable = requireSheet(wb, 'Scorecard');
  requireColumns(settingsTable, ['Setting', 'Value']);
  const settings = new Map(settingsTable.rows.map((r) => [norm(cell(r, 'Setting')), cell(r, 'Value')]));
  const setting = (key: string) => settings.get(norm(key)) ?? '';

  const sheetsTable = requireSheet(wb, 'Sheets');
  requireColumns(sheetsTable, ['Sheet']);
  const sheets: Array<Record<string, unknown>> = [];
  const context: Array<Record<string, unknown>> = [];
  for (const row of sheetsTable.rows) {
    const name = cell(row, 'Sheet');
    if (!name) continue;
    const role = (cell(row, 'Role') || 'judged').toLowerCase();
    if (!ROLES.includes(role)) {
      throw new UserError(`${filename}, Sheets sheet, row ${row.row}: Role must be "judged" or "context" (got "${role}").`);
    }
    const header = cell(row, 'Header row');
    const columns = cell(row, 'Columns').split(',').map((c) => c.trim()).filter(Boolean);
    const spec: Record<string, unknown> = { name, header_row: header ? Number(header) : 1 };
    if (columns.length > 0) spec.columns = columns;
    if (Number.isNaN(spec.header_row)) {
      throw new UserError(`${filename}, Sheets sheet, row ${row.row}: Header row must be a number.`);
    }
    (role === 'context' ? context : sheets).push(spec);
  }

  const dimensionsTable = requireSheet(wb, 'Dimensions');
  requireColumns(dimensionsTable, ['ID', 'Name', 'Weight']);
  const dimensions: Array<Record<string, unknown>> = [];
  const rowOf: number[] = [];
  for (const row of dimensionsTable.rows) {
    const id = cell(row, 'ID');
    if (!id && !cell(row, 'Name')) continue;
    const where = `${filename}, Dimensions sheet, row ${row.row} (${id || 'no ID'})`;

    const weight = Number(cell(row, 'Weight'));
    const dimension: Record<string, unknown> = {
      id,
      name: cell(row, 'Name'),
      weight: cell(row, 'Weight') === '' || Number.isNaN(weight) ? cell(row, 'Weight') : weight,
      critical: yesNo(cell(row, 'Critical')),
    };

    const measuredBy = cell(row, 'Measured by').toLowerCase();
    if (measuredBy) {
      if (!MEASURED_BY.includes(measuredBy)) throw new UserError(`${where}: Measured by must be code, raters or human (got "${measuredBy}").`);
      dimension.measured_by = measuredBy;
    }
    for (const [column, key] of [['Measure', 'measure'], ['Description', 'description'], ['Needs', 'needs']] as const) {
      if (cell(row, column)) dimension[key] = cell(row, column);
    }
    const returnTo = cell(row, 'Return to');
    if (returnTo) {
      const match = RETURN_TO.find((r) => r.toLowerCase() === returnTo.toLowerCase());
      if (!match) throw new UserError(`${where}: Return to must be one of ${RETURN_TO.join(', ')} (got "${returnTo}").`);
      dimension.return_to = match;
    }
    const reads = cell(row, 'Reads');
    if (reads) {
      // Commas inside [brackets] belong to the entry, so only split on the ones outside them.
      dimension.reads = reads.split(/[,;\n](?![^[]*\])/).map((s) => s.trim()).filter(Boolean);
    }

    const anchors: Record<number, string> = {};
    for (const level of ANCHOR_LEVELS) {
      const text = cell(row, `Anchor ${level}`);
      if (text) anchors[level] = text;
    }
    if (Object.keys(anchors).length > 0) dimension.anchors = anchors;

    const checkId = cell(row, 'Check');
    if (checkId) {
      dimension.check = {
        id: checkId,
        params: parseParams(cell(row, 'Params'), where),
        bands: parseBands(cell(row, 'Bands'), where),
        ...(cell(row, 'Fix') ? { fix: cell(row, 'Fix') } : {}),
      };
    }
    dimensions.push(dimension);
    rowOf.push(row.row);
  }

  const raw = {
    scorecard: {
      id: setting('id'),
      ...(setting('name') ? { name: setting('name') } : {}),
      version: setting('version'),
      judges: setting('judges'),
      ...(setting('step') ? { step: setting('step') } : {}),
      frozen: yesNo(setting('frozen')),
      ...(setting('approval') ? { approval: setting('approval') } : {}),
      thresholds: {
        accept: setting('accept') === '' ? 75 : Number(setting('accept')),
        refine: setting('refine') === '' ? 60 : Number(setting('refine')),
      },
      ...(setting('red_at_or_below') !== '' ? { red_at_or_below: Number(setting('red_at_or_below')) } : {}),
      ...(setting('unmeasured') !== '' ? { unmeasured: setting('unmeasured').toLowerCase() } : {}),
      artifact: { sheets, context_sheets: context },
      dimensions,
    },
  };

  const result = scorecardFileSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.slice(0, 12).map((issue) => {
      const [, group, index, field] = issue.path as [string, string, number, string];
      if (group === 'dimensions' && typeof index === 'number') {
        const label = FIELD_LABEL[String(field)] ?? String(field ?? '');
        return `  • Dimensions sheet, row ${rowOf[index] ?? '?'} (${String(dimensions[index]?.id ?? '')}): ${label ? `${label}: ` : ''}${issue.message}`;
      }
      if (group === 'artifact') return `  • Sheets sheet: ${issue.message}`;
      return `  • Scorecard sheet, setting "${String(group)}": ${issue.message}`;
    });
    throw new UserError(`${filename} does not match the scorecard format:\n${lines.join('\n')}`);
  }
  return raw;
}

/* ------------------------------ writing ------------------------------ */

const HOW_TO_FILL = [
  'How to fill in this scorecard',
  '',
  'This workbook is a scorecard: it tells the evaluator what to judge and how. People write it and freeze it before the work it judges exists.',
  'Keep the three sheets Scorecard, Sheets and Dimensions. Keep the titles in row 1 of each. This sheet is ignored.',
  '',
  'SCORECARD sheet (Setting | Value)',
  '  id, version, judges are required. "judges" must start with D1 (a schema design) or D3 (an output document).',
  '  frozen is optional: the app freezes every scorecard by its hash when work is submitted, so the target cannot move mid-evaluation.',
  '  accept and refine are the green and amber thresholds (default 75 and 60). approval (optional) is shown in the report header as where the scorecard came from.',
  '  unmeasured (optional) = skip (default: a question the file holds nothing for is left out of the score) or zero (it counts as 0).',
  '  Format the version cell as Text, or Excel turns 1.0 into 1.',
  '',
  'SHEETS sheet (which sheets of the evaluated workbook to read)',
  '  Sheet = the sheet name, Header row = the row holding column titles (default 1).',
  '  Columns (optional) = comma-separated column titles the examiners should see. Leave blank for all. Use it to keep prompts small.',
  '  Role = judged (examiners score it) or context (reference material they may read, such as a playbook).',
  '',
  'DIMENSIONS sheet (one row per thing to measure)',
  '  Weight = importance (any positive number; they need not add to 100). Critical = yes marks a key question: below 4 it is listed as needing attention, but the colour comes from the score alone.',
  '  Measured by = code (counted exactly) or raters (the AI examiners score 0-5 against your anchors). Nothing waits for a person:',
  '        human is still accepted, and such a row is scored by the examiners from what the file shows (standard anchors if none are given).',
  '  raters: fill all six Anchor columns, saying what a 0, 1, 2, 3, 4 and 5 mean.',
  '  code: fill Check, Params and Bands. Check is one of: max_value, column_filled, unique, any_filled, list_refs_resolve, lists_referenced, values_in_list, value_not_in, row_count_at_least.',
  '        Params is a JSON object, for example {"sheet": "Tree", "column": "Definition"}.',
  '        Bands turns the pass ratio into 0-5: strict, exact, or pairs like 1:5, 0.97:4, 0.9:3, 0.01:1 (ratio at least the first number gives the score).',
  '        strict = 1:5, 0.97:4, 0.9:3, 0.75:2, 0.01:1     exact = 1:5, 0.01:1 (one mistake fails it)',
  '  Fix = what to do when a code check fails. Return to = which stage the author goes back to (Discover, Define, Generate, Analyse, Validate, Refine).',
  '',
  'Full reference: docs/scorecard-reference.md',
];

function styleHeader(ws: ExcelJS.Worksheet): void {
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B1B1F' } };
  header.alignment = { vertical: 'middle' };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

function listValidation(ws: ExcelJS.Worksheet, column: number, values: string[], rows = 200): void {
  for (let r = 2; r <= rows + 1; r++) {
    ws.getCell(r, column).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${values.join(',')}"`] };
  }
}

/** Writes a scorecard as an Excel workbook in the layout `readExcelScorecard` reads. */
export async function scorecardToWorkbook(scorecard: Scorecard): Promise<Buffer> {
  // The Excel layout has no place for criteria or a combination rule yet; writing it would silently drop them.
  if (scorecard.dimensions.some((d) => d.criteria?.length) || scorecard.aggregate) {
    throw new UserError('This scorecard scores dimensions criterion by criterion, which the Excel layout cannot hold yet. Keep it as YAML.');
  }
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'GateX';

  const how = workbook.addWorksheet('How to fill');
  how.getColumn(1).width = 150;
  HOW_TO_FILL.forEach((line, i) => {
    const row = how.addRow([line]);
    if (i === 0 || /^[A-Z]+ sheet/.test(line)) row.font = { bold: true };
  });

  const settings = workbook.addWorksheet('Scorecard');
  settings.columns = [{ header: 'Setting', width: 18 }, { header: 'Value', width: 70 }];
  const rows: Array<[string, string | number]> = [
    ['id', scorecard.id],
    ['name', scorecard.name],
    ['version', scorecard.version],
    ['judges', scorecard.gate === 'D3' ? 'D3 output document' : 'D1 schema design'],
    ['step', scorecard.step ?? ''],
    ['frozen', scorecard.frozen ? 'yes' : 'no'],
    ['approval', scorecard.approval ?? ''],
    ['accept', scorecard.thresholds.accept],
    ['refine', scorecard.thresholds.refine],
    ...(scorecard.redAtOrBelow !== undefined ? ([['red_at_or_below', scorecard.redAtOrBelow]] as Array<[string, string | number]>) : []),
    ...(scorecard.unmeasured === 'zero' ? ([['unmeasured', 'zero']] as Array<[string, string | number]>) : []),
  ];
  rows.forEach(([key, value]) => {
    const row = settings.addRow([key, value]);
    if (key === 'version') row.getCell(2).numFmt = '@';
  });
  styleHeader(settings);

  const sheets = workbook.addWorksheet('Sheets');
  sheets.columns = [
    { header: 'Sheet', width: 24 }, { header: 'Header row', width: 12 }, { header: 'Columns', width: 70 }, { header: 'Role', width: 12 },
  ];
  for (const s of scorecard.artifact.sheets) sheets.addRow([s.name, s.headerRow, (s.columns ?? []).join(', '), 'judged']);
  for (const s of scorecard.artifact.context) sheets.addRow([s.name, s.headerRow, (s.columns ?? []).join(', '), 'context']);
  styleHeader(sheets);
  listValidation(sheets, 4, ROLES);

  const dims = workbook.addWorksheet('Dimensions');
  const widths = [8, 34, 9, 9, 13, 36, 36, 30, 30, 30, 30, 30, 30, 20, 60, 26, 40, 40, 12];
  dims.columns = DIMENSION_COLUMNS.map((header, i) => ({ header, width: widths[i] ?? 20 }));
  for (const d of scorecard.dimensions) {
    dims.addRow([
      d.id, d.name, d.weight, d.critical ? 'yes' : '', d.measuredBy, d.measure ?? '', d.description ?? '',
      ...ANCHOR_LEVELS.map((n) => d.anchors?.[n] ?? ''),
      d.check?.id ?? '',
      d.check ? JSON.stringify(d.check.params) : '',
      d.check ? d.check.bands.map((b) => `${b.min}:${b.score}`).join(', ') : '',
      d.check?.fix ?? '', d.needs ?? '', d.returnTo ?? '', (d.reads ?? []).join('; '),
    ]);
  }
  styleHeader(dims);
  listValidation(dims, 4, ['yes', 'no']);
  listValidation(dims, 5, MEASURED_BY);
  listValidation(dims, 19, RETURN_TO);
  dims.eachRow((row) => row.eachCell((c) => { c.alignment = { vertical: 'top', wrapText: true }; }));

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
