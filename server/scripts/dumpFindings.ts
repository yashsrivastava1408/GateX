import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { WorkbookModel } from '../src/excel/workbook.js';

/**
 * Prints each finding of a finished run next to the text of the cell it points at, so a reviewer can check it against the file.
 * Usage: npm run review:dump -- --run <dir with report.json> --workbook <file>
 */
const { values } = parseArgs({ options: { run: { type: 'string' }, workbook: { type: 'string' } } });
const base = process.env.INIT_CWD ?? process.cwd();
const wb = await WorkbookModel.load(path.resolve(base, values.workbook!));
const report = JSON.parse(await readFile(path.join(path.resolve(base, values.run!), 'report.json'), 'utf8'));
for (const f of report.findings) {
  const loc = f.location ?? {};
  const text = loc.sheet && loc.cell ? wb.cellText(loc.sheet, loc.cell) : undefined;
  console.log(`${f.id} ${f.severity[0]} ${f.dimensionId} [${(f.reportedBy ?? []).join('')}] ${f.title}\n    @ ${loc.sheet}!${loc.cell} = ${JSON.stringify((text ?? 'NO-SUCH-CELL').slice(0, 100))}\n    ${f.detail.replace(/\s+/g, ' ').slice(0, 320)}\n    fix: ${String(f.fix).slice(0, 160)}`);
}
