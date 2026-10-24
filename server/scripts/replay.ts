import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { WorkbookModel } from '../src/excel/workbook.js';
import { checkFindings } from '../src/agent/findingCheck.js';
import type { DraftFinding } from '../src/agent/types.js';

/**
 * Replays the finding filter on a finished run's findings and scores it against a review file (my labels).
 * No model is called. A good filter drops findings labelled wrong/vague/duplicate and never one labelled real/partly.
 * Usage: npm run replay -- --run <dir with report.json> --workbook <file> --labels <review.json>
 */
const { values } = parseArgs({ options: { run: { type: 'string' }, workbook: { type: 'string' }, labels: { type: 'string' }, show: { type: 'boolean' } } });
const base = process.env.INIT_CWD ?? process.cwd();
const rel = (p: string) => path.resolve(base, p);
const report = JSON.parse(await readFile(path.join(rel(values.run!), 'report.json'), 'utf8')) as { findings: Array<DraftFinding & { id: string }> };
const review = JSON.parse(await readFile(rel(values.labels!), 'utf8')) as { labels: Array<{ id: string; verdict: string }> };
const verdictOf = new Map(review.labels.map((l) => [l.id, l.verdict]));
const wb = await WorkbookModel.load(rel(values.workbook!));
const byKey = new Map(report.findings.map((f) => [`${f.dimensionId}|${f.title}`, f.id]));
const result = checkFindings(report.findings.filter((f) => f.source === 'raters'), wb);
const dropped = result.dropped.map((d) => ({ id: byKey.get(`${d.dimensionId}|${d.title}`) ?? '?', reason: d.reason }));
const keptIds = new Set(result.findings.map((f) => byKey.get(`${f.dimensionId}|${f.title}`) ?? '?'));
const tally = (ids: string[]) => ids.reduce<Record<string, number>>((m, id) => ((m[verdictOf.get(id) ?? 'unlabelled'] = (m[verdictOf.get(id) ?? 'unlabelled'] ?? 0) + 1), m), {});
console.log('dropped', dropped.length, tally(dropped.map((d) => d.id)));
console.log('merged away', result.merged);
const bad = dropped.filter((d) => ['real', 'partly'].includes(verdictOf.get(d.id) ?? ''));
console.log(bad.length === 0 ? 'OK: no real or partly-right finding was dropped' : 'BAD drops:', bad.map((d) => `${d.id} (${verdictOf.get(d.id)}): ${d.reason}`));
const kept = [...keptIds];
const usable = kept.filter((id) => ['real', 'partly'].includes(verdictOf.get(id) ?? '')).length;
console.log(`kept ${kept.length}; real+partly ${usable}; precision ${(usable / Math.max(kept.length, 1) * 100).toFixed(0)}%; kept-by-label`, tally(kept));
if (values.show) for (const d of dropped) console.log(' -', d.id, verdictOf.get(d.id), d.reason.slice(0, 140));
if (values.show) {
  console.log('\nSTILL KEPT BUT NOT USEFUL:');
  for (const f of report.findings) {
    const id = f.id; const v = verdictOf.get(id);
    if (keptIds.has(id) && v && !['real', 'partly'].includes(v)) console.log(` ${id} ${v.padEnd(9)} ${f.title} :: ${f.detail.replace(/\s+/g, ' ').slice(0, 170)}`);
  }
}

if (values.show) {
  const droppedIds = new Set(dropped.map((d) => d.id));
  console.log('\nMERGED AWAY (kept as part of another finding):');
  for (const f of report.findings) if (!keptIds.has(f.id) && !droppedIds.has(f.id)) console.log(` ${f.id} ${verdictOf.get(f.id)} ${f.title}`);
}
