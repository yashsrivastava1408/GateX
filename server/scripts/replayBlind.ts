import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkbookModel } from '../src/excel/workbook.js';
import { CLAIM_RULES, claimVerdicts, type ClaimRule } from '../src/agent/claimCheck.js';
import type { DraftFinding } from '../src/agent/types.js';
import { parseCsv } from '../src/library/spotCheck.js';

/**
 * Scores the claim rules (agent/claimCheck.ts) against the blind spot-check labels: the 40 findings in data/review-sheet/spot-check-filled-agent.csv,
 * which a fresh agent labelled without seeing our labels. Each row is mapped to its finding through answer-key.json (run + finding id). Prints, for
 * every rule alone and for all together, which of the 40 it drops or flags, with our label and the blind label, and the useful / wrong shares of what
 * is kept, before and after. The labels are AI-made and the rules were written while looking at these rows, so expect smaller gains on new runs.
 * Usage: npm run replay:blind [-- --file <filled csv>]
 */
const root = path.resolve(import.meta.dirname, '../..');
const fileArg = process.argv.indexOf('--file');
const csvPath = fileArg > 0 ? path.resolve(process.env.INIT_CWD ?? process.cwd(), process.argv[fileArg + 1]!) : path.join(root, 'data/review-sheet/spot-check-filled-agent.csv');
const key = (JSON.parse(await readFile(path.join(root, 'data/review-sheet/answer-key.json'), 'utf8')) as { rows: Array<{ id: string; run: string; findingId: string; ourLabel: string }> }).rows;
const table = parseCsv((await readFile(csvPath, 'utf8')).replace(/^﻿/, '')).filter((r) => r.length > 1);
const head = table[0]!;
const blind = new Map<string, string>();
for (const r of table.slice(1)) {
  const row = Object.fromEntries(head.map((h, i) => [h, r[i] ?? '']));
  const label = (['real', 'partly', 'wrong', 'vague'] as const).find((l) => (row[l] ?? '').trim() !== '');
  if (label) blind.set(row.id!, label);
}
const runs: Array<[string, string, string]> = JSON.parse(await readFile(path.join(root, 'data/replay-runs.json'), 'utf8'));
type Row = { id: string; f: DraftFinding; wb: WorkbookModel; ours: string; blind: string };
const rows: Row[] = [];
for (const k of key) {
  const b = blind.get(k.id);
  if (!b) continue;
  const run = runs.find((r) => r[0] === k.run)!;
  const report = JSON.parse(await readFile(path.join(root, 'data', k.run, 'report.json'), 'utf8')) as { findings: Array<DraftFinding & { id: string }> };
  const f = report.findings.find((x) => x.id === k.findingId)!;
  rows.push({ id: k.id, f, wb: await WorkbookModel.load(path.join(root, 'data/inputs', run[1])), ours: k.ourLabel, blind: b });
}
const share = (rs: Row[], pick: (r: Row) => string) => {
  const n = rs.length;
  const useful = rs.filter((r) => ['real', 'partly'].includes(pick(r))).length;
  const wrong = rs.filter((r) => pick(r) === 'wrong').length;
  return `${n} kept, useful ${useful} (${((100 * useful) / n).toFixed(0)}%), wrong ${wrong} (${((100 * wrong) / n).toFixed(0)}%)`;
};
console.log(`${rows.length} blind-labelled findings (all were kept by the finding filter before the claim rules)`);
console.log(`BEFORE  blind labels: ${share(rows, (r) => r.blind)} | our labels: ${share(rows, (r) => r.ours)}`);
const run = (rules: ClaimRule[]) => {
  const gone: Row[] = [];
  const flagged: Row[] = [];
  const kept: Row[] = [];
  for (const r of rows) {
    const vs = claimVerdicts(r.f, r.wb, rules);
    if (vs.some((v) => v.action === 'drop')) gone.push(r);
    else {
      kept.push(r);
      if (vs.length > 0) flagged.push(r);
    }
  }
  return { gone, flagged, kept };
};
for (const rule of [...CLAIM_RULES, 'ALL' as const]) {
  const { gone, flagged, kept } = run(rule === 'ALL' ? [...CLAIM_RULES] : [rule]);
  console.log(`\n${rule}: drops ${gone.length}${gone.length ? ` (${gone.map((r) => `${r.id} ours=${r.ours} blind=${r.blind}`).join('; ')})` : ''}; flags ${flagged.length}${flagged.length ? ` (${flagged.map((r) => `${r.id} ours=${r.ours} blind=${r.blind}`).join('; ')})` : ''}`);
  console.log(`  AFTER blind labels: ${share(kept, (r) => r.blind)} | our labels: ${share(kept, (r) => r.ours)}`);
}

