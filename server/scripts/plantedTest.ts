import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { PlantedResult } from '@ddd/shared';
import { plantDefects } from '../src/planted/plant.js';
import { scorePlanted, type ScoredFinding } from '../src/planted/score.js';

/**
 * The planted-defect test: breaks a copy of a good register in known ways, runs the app on it with live models, and scores how many of the
 * planted defects the report found, per examiner. Nothing needs a reviewer's opinion: the answer key is what was planted.
 *
 *   npm run planted -- --workbook <good file> --scorecard <scorecard> --label <name> [--models <models.json>] [--seed 1]
 *
 * Writes data/planted/<label>/{planted file, defects.json, run/, result.json}; the Test library page shows result.json.
 */
const { values } = parseArgs({ options: { workbook: { type: 'string' }, scorecard: { type: 'string' }, label: { type: 'string' }, models: { type: 'string' }, seed: { type: 'string' }, out: { type: 'string' } } });
if (!values.workbook || !values.scorecard || !values.label) {
  console.log('Usage: npm run planted -- --workbook <good file> --scorecard <scorecard> --label <name> [--models <models.json>] [--seed 1]');
  process.exit(1);
}
const base = process.env.INIT_CWD ?? process.cwd();
const abs = (p: string) => path.resolve(base, p);
const repo = path.resolve(import.meta.dirname, '..', '..');
const seed = Number(values.seed ?? 1);
const out = abs(values.out ?? path.join('data', 'planted', values.label));
const source = await readFile(abs(values.workbook));
const plantedFile = path.join(out, `planted${path.extname(values.workbook)}`);

const planted = await plantDefects(source, { seed });
await mkdir(out, { recursive: true });
await writeFile(plantedFile, planted.bytes);
await writeFile(path.join(out, 'defects.json'), JSON.stringify({ sheet: planted.sheet, defects: planted.defects, skipped: planted.skipped }, null, 2));
console.log(`Planted ${planted.defects.length} defects in ${planted.sheet}${planted.skipped.length ? ` (skipped: ${planted.skipped.join('; ')})` : ''}`);
for (const d of planted.defects) console.log(`  ${d.id} ${d.kind.padEnd(17)} ${d.cell.padEnd(6)} ${d.description}`);

const args = ['src/cli.ts', '--workbook', plantedFile, '--scorecard', abs(values.scorecard), '--out', path.join(out, 'run'), ...(values.models ? ['--models', abs(values.models)] : [])];
console.log(`\nRunning the app (live models)...`);
const code: number = await new Promise((resolve) => {
  const child = spawn(path.join(repo, 'node_modules', '.bin', 'tsx'), args, { cwd: path.join(repo, 'server'), stdio: ['ignore', 'pipe', 'pipe'] });
  const log: string[] = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  child.on('close', async (c) => {
    await writeFile(path.join(out, 'run.log'), log.join(''));
    resolve(c ?? 1);
  });
});
if (code !== 0) {
  console.log(`The run failed (exit ${code}); see ${path.join(out, 'run.log')}`);
  process.exit(code);
}

const report = JSON.parse(await readFile(path.join(out, 'run', 'report.json'), 'utf8')) as {
  header: { raters: Array<{ id: string; family: string; model: string }> };
  verdict: { weightedScore: number | null; decision: string };
  findings: Array<{ id: string; source: string; title: string; detail: string; location: ScoredFinding['location']; reportedBy?: string[] }>;
  droppedFindings?: Array<{ title: string; location: ScoredFinding['location']; reportedBy: string[]; reason: string }>;
};
const kept: ScoredFinding[] = report.findings.map((f) => ({ id: f.id, title: f.title, detail: f.detail, location: f.location, reportedBy: f.reportedBy ?? [], kept: true }));
const set_aside: ScoredFinding[] = (report.droppedFindings ?? []).map((d, i) => ({ id: `D-${i + 1}`, title: d.title, detail: d.reason, location: d.location, reportedBy: d.reportedBy, kept: false }));
const examiners = [...report.header.raters.map((r) => r.id), 'code'];
const score = scorePlanted(planted.defects, [...kept, ...set_aside], examiners);
const modelOf = new Map(report.header.raters.map((r) => [r.id, r]));

const result: PlantedResult = {
  label: values.label,
  runAt: new Date().toISOString(),
  workbook: path.basename(values.workbook),
  scorecard: path.basename(values.scorecard),
  seed,
  models: report.header.raters,
  planted: score.planted,
  caught: score.caught,
  caughtRaw: score.caughtRaw,
  caughtByExaminers: score.caughtByExaminers,
  caughtByCode: score.caughtByCode,
  otherInReport: score.otherInReport,
  perExaminer: Object.fromEntries(Object.entries(score.perExaminer).map(([id, v]) => [id, { family: modelOf.get(id)?.family ?? (id === 'code' ? 'code' : '?'), model: modelOf.get(id)?.model ?? (id === 'code' ? 'row-by-row sweep' : '?'), ...v }])),
  weightedScore: report.verdict.weightedScore,
  decision: report.verdict.decision,
  defects: score.results.map((r) => ({ id: r.defect.id, kind: r.defect.kind, cell: r.defect.cell, description: r.defect.description, caught: r.inReport, caughtRaw: r.caughtBy.length > 0, examiners: r.examiners })),
  skipped: planted.skipped,
};
await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));

console.log(`\nResult for ${values.label}: in the report ${score.caught} of ${score.planted}; by the AI examiners alone ${score.caughtByExaminers}; by the code sweep ${score.caughtByCode}. Score ${report.verdict.weightedScore} ${report.verdict.decision}. Other findings in the report: ${score.otherInReport}`);
for (const [id, v] of Object.entries(result.perExaminer)) console.log(`  ${id} ${v.family.padEnd(10)} ${v.model.padEnd(44)} caught ${v.caught}/${score.planted}   findings elsewhere ${v.otherFindings}`);
for (const d of result.defects) console.log(`  ${d.caught ? 'caught ' : d.caughtRaw ? 'set aside' : 'MISSED '} ${d.id} ${d.kind} ${d.cell}  by ${d.examiners.join(',') || '-'}`);
