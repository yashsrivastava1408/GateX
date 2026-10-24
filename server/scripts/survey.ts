import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { WorkbookModel } from '../src/excel/workbook.js';
import { profileWorkbook } from '../src/excel/profile.js';
import { isAppFormat } from '../src/scorecard/resolve.js';
import { errorMessage } from '../src/util/errors.js';

/**
 * Read-only survey of a folder: can the app read every file, and what does it see in it?
 * No model is called. Usage: npm run survey -- --folder <dir> --out <file.json>
 */

const { values } = parseArgs({ options: { folder: { type: 'string' }, out: { type: 'string' } } });
if (!values.folder) {
  console.log('Usage: npm run survey -- --folder <dir> [--out survey.json]');
  process.exit(1);
}
const root = path.resolve(process.env.INIT_CWD ?? process.cwd(), values.folder);
const SKIP = /\.(png|jpe?g|gif|pem|html|md|txt|zip|docx?)$/i;

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (!SKIP.test(entry.name)) out.push(full);
  }
  return out;
}

/** A guess from the name and the sheets only; a person confirms the pairing. */
function guessRole(file: string, sheets: string[]): 'scorecard' | 'schema' | 'output' | 'unknown' {
  const hay = `${file} ${sheets.join(' ')}`.toLowerCase();
  if (/scorecard|rubric|dimension|weight/.test(hay)) return 'scorecard';
  if (/output[_ ]?(document|docket)|d3/.test(hay)) return 'output';
  if (/schema/.test(hay)) return 'schema';
  return 'unknown';
}

interface FileReport {
  file: string;
  bytes: number;
  kind: string;
  readable: boolean;
  error?: string;
  guessedRole?: string;
  appFormatScorecard?: boolean;
  sheets?: Array<{ name: string; headerRow: number; dataRows: number; idColumn: string | null; columns: number; tokens: number }>;
  totalTokens?: number;
}

const files = (await walk(root)).sort();
const reports: FileReport[] = [];
for (const full of files) {
  const rel = path.relative(root, full);
  const ext = path.extname(full).toLowerCase().slice(1);
  const bytes = (await stat(full)).size;
  const report: FileReport = { file: rel, bytes, kind: ext, readable: false };
  try {
    const data = await readFile(full);
    if (ext === 'csv' || ext === 'yaml' || ext === 'yml' || ext === 'json') {
      // These are read as plain text by the scorecard importer; the workbook reader does not take them.
      report.readable = true;
      report.guessedRole = guessRole(rel, []);
      if (ext !== 'csv') report.appFormatScorecard = await isAppFormat({ name: path.basename(full), bytes: data });
    } else {
      const wb = await WorkbookModel.load(data);
      const profile = profileWorkbook(wb);
      report.readable = true;
      report.sheets = profile.sheets.map((s) => ({ name: s.name, headerRow: s.headerRow, dataRows: s.dataRows, idColumn: s.idColumn, columns: s.columns.length, tokens: s.tokens }));
      report.totalTokens = profile.sheets.reduce((sum, s) => sum + s.tokens, 0);
      report.guessedRole = guessRole(rel, profile.sheets.map((s) => s.name));
      if (ext === 'xlsx') report.appFormatScorecard = await isAppFormat({ name: path.basename(full), bytes: data });
    }
  } catch (error) {
    report.error = errorMessage(error);
  }
  reports.push(report);
}

const outPath = path.resolve(process.env.INIT_CWD ?? process.cwd(), values.out ?? 'data/survey/survey.json');
await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify({ surveyedAt: new Date().toISOString(), folder: root, files: reports }, null, 2));

for (const r of reports) {
  const mark = r.readable ? 'ok ' : 'ERR';
  const detail = r.sheets ? `${r.sheets.length} sheets, ~${r.totalTokens} tokens` : r.error ?? '';
  console.log(`${mark} ${r.guessedRole?.padEnd(9) ?? '         '} ${r.file}  ${detail}`);
}
console.log(`\n${reports.filter((r) => r.readable).length}/${reports.length} readable. Saved ${outPath}`);
