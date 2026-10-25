import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { analyseStability, describeStability, type RunSummary } from '../src/agent/stability.js';

/**
 * How steady is a result when the same file is checked again?
 *
 *   npm run stability -- --from data/noise/live-run-1 data/noise/live-run-2     read saved runs of ONE file (no model call, no cost)
 *   npm run stability -- --workbook <file> --scorecard <scorecard> --runs 3      run it again N times first (live models; N is 2 or 3; about $2 each)
 *
 * It prints the share of runs with the same verdict (the PDF's target is 95% or more), the score range and which questions swing most, and whether the
 * examiners' marks moved or only the final mark did. Live runs are written to data/stability/<label>/run-<n> (override with --out).
 */
const { values, positionals } = parseArgs({ allowPositionals: true, options: { from: { type: 'boolean' }, workbook: { type: 'string' }, scorecard: { type: 'string' }, runs: { type: 'string' }, label: { type: 'string' }, out: { type: 'string' }, models: { type: 'string' } } });
const base = process.env.INIT_CWD ?? process.cwd();
const abs = (p: string) => path.resolve(base, p);
const repo = path.resolve(import.meta.dirname, '..', '..');

let dirs: string[] = [];
if (values.from) {
  dirs = positionals.map(abs);
} else if (values.workbook && values.scorecard) {
  const n = Number(values.runs ?? 2);
  if (!(n >= 2 && n <= 3)) {
    console.log('--runs must be 2 or 3: every run is a real evaluation with live models and costs about $2.');
    process.exit(1);
  }
  const out = abs(values.out ?? path.join('data', 'stability', values.label ?? path.basename(values.workbook).replace(/\.[^.]+$/, '')));
  await mkdir(out, { recursive: true });
  for (let i = 1; i <= n; i++) {
    const dir = path.join(out, `run-${i}`);
    console.log(`Run ${i} of ${n} (live models)...`);
    const args = ['src/cli.ts', '--workbook', abs(values.workbook), '--scorecard', abs(values.scorecard), '--out', dir, ...(values.models ? ['--models', abs(values.models)] : [])];
    const code: number = await new Promise((resolve) => {
      const child = spawn(path.join(repo, 'node_modules', '.bin', 'tsx'), args, { cwd: path.join(repo, 'server'), stdio: 'inherit' });
      child.on('close', (c) => resolve(c ?? 1));
    });
    if (code !== 0) {
      console.log(`Run ${i} failed (exit ${code}); stopping.`);
      process.exit(code);
    }
    dirs.push(dir);
  }
} else {
  console.log('Usage:\n  npm run stability -- --from <run dir> <run dir> ...\n  npm run stability -- --workbook <file> --scorecard <scorecard> --runs 3 [--label <name>]');
  process.exit(1);
}

const runs: RunSummary[] = [];
for (const dir of dirs) {
  const report = JSON.parse(await readFile(path.join(dir, 'report.json'), 'utf8')) as { verdict: { weightedScore: number; decision: RunSummary['decision'] }; dimensions: RunSummary['dimensions'] };
  runs.push({ label: path.basename(dir), score: report.verdict.weightedScore, decision: report.verdict.decision, dimensions: report.dimensions });
}
for (const line of describeStability(analyseStability(runs))) console.log(line);
