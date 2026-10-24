import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { WorkbookModel } from '../src/excel/workbook.js';
import { checkFindings } from '../src/agent/findingCheck.js';
import type { DraftFinding } from '../src/agent/types.js';

/**
 * Lists the findings labelled "wrong" in one run, with what the filter does to each and the text of the cell it cites.
 * Used to group wrong findings into repeated patterns. Usage: npm run wrongs -- --run <dir> --workbook <file> --labels <review.json>
 */
const { values } = parseArgs({ options: { run: { type: 'string' }, workbook: { type: 'string' }, labels: { type: 'string' }, verdict: { type: 'string' } } });
const base = process.env.INIT_CWD ?? process.cwd();
const rel = (p: string) => path.resolve(base, p);
const report = JSON.parse(await readFile(path.join(rel(values.run!), 'report.json'), 'utf8')) as { findings: Array<DraftFinding & { id: string; reportedBy?: string[] }> };
const review = JSON.parse(await readFile(rel(values.labels!), 'utf8')) as { labels: Array<{ id: string; verdict: string; note: string }> };
const label = new Map(review.labels.map((l) => [l.id, l]));
const wb = await WorkbookModel.load(rel(values.workbook!));
const byKey = new Map(report.findings.map((f) => [`${f.dimensionId}|${f.title}`, f.id]));
const result = checkFindings(report.findings.filter((f) => f.source === 'raters'), wb);
const gone = new Set(result.dropped.map((d) => byKey.get(`${d.dimensionId}|${d.title}`)));
const want = values.verdict ?? 'wrong';
for (const f of report.findings) {
  const l = label.get(f.id);
  if (l?.verdict !== want) continue;
  const loc = f.location;
  const cell = loc?.sheet && loc.cell ? wb.cellText(loc.sheet, loc.cell) : undefined;
  console.log(`--- ${path.basename(rel(values.run!))} ${f.id} [${f.source}] ${gone.has(f.id) ? 'DROPPED' : 'KEPT'} ${f.severity} ${f.dimensionId} by=${(f.reportedBy ?? []).join('')}\nTITLE: ${f.title}\nDETAIL: ${f.detail.replace(/\s+/g, ' ')}\nCELL ${loc?.sheet}!${loc?.cell} = ${JSON.stringify((cell ?? '').slice(0, 160))}\nWHY WRONG: ${l.note}`);
}
