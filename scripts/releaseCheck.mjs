#!/usr/bin/env node
/**
 * One command that says whether this build is safe to hand over. It makes no model call unless --live is given.
 *
 *   npm run release:check            typecheck, tests, docs, and the finding filter replayed on every labelled run
 *   npm run release:check -- --live  also runs the "file already has it" check with a live model on the labelled findings (costs cents)
 *
 * Passing means: the code type-checks; every test passes (including the planted-defect test: the code sweep must find all eight planted
 * defects and nothing in the clean register); the docs are consistent; and for every run in data/library, replaying the filter drops no finding
 * that was labelled real or partly right. With --live, the model-backed check must not drop a labelled real gap.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const live = process.argv.includes('--live');
const results = [];

function step(name, cmd, args, { cwd = root, must } = {}) {
  process.stdout.write(`\n== ${name}\n`);
  const run = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: false });
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const ok = run.status === 0 && (!must || must.test(out));
  const tail = out.trim().split('\n').slice(-3).join('\n');
  console.log(tail);
  results.push({ name, ok });
  return { ok, out };
}

step('typecheck', 'npm', ['run', 'typecheck', '--silent']);
step('tests (server and web)', 'npm', ['test', '--silent']);
step('docs', 'npm', ['run', 'docs:check', '--silent']);

// The finding filter, replayed with no model on every labelled run: nothing real or partly right may be dropped.
const libDir = path.join(root, 'data', 'library');
const cases = existsSync(libDir) ? readdirSync(libDir).filter((f) => f.endsWith('.json') && f !== 'reliability.json') : [];
for (const file of cases) {
  const lib = JSON.parse(readFileSync(path.join(libDir, file), 'utf8'));
  const inputs = path.join(root, 'data', 'inputs', lib.id);
  const workbook = existsSync(inputs) ? readdirSync(inputs).find((f) => f === lib.workbook) : undefined;
  for (const run of lib.runs ?? []) {
    const runDir = path.join(root, 'data', run.runDir);
    const labels = run.reviewFile ? path.join(root, 'data', run.reviewFile) : '';
    if (!workbook || !labels || !existsSync(path.join(runDir, 'report.json')) || !existsSync(labels)) {
      console.log(`\n== replay ${lib.id} / ${run.runDir}: skipped (missing run, labels or workbook)`);
      continue;
    }
    step(`replay ${lib.id} / ${run.runDir}`, 'npm', ['run', 'replay', '--silent', '-w', 'server', '--', '--run', runDir, '--workbook', path.join(inputs, workbook), '--labels', labels], { must: /OK: no real or partly-right finding was dropped/ });
  }
}

if (live) step('model check on labelled findings (live)', 'npm', ['run', 'presence:eval', '--silent', '-w', 'server']);

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? 'RELEASE CHECK PASSED' : 'RELEASE CHECK FAILED'}: ${results.length - failed.length} of ${results.length} steps ok${failed.length ? `; failed: ${failed.map((f) => f.name).join(', ')}` : ''}`);
process.exit(failed.length === 0 ? 0 : 1);
