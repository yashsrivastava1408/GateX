import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { WorkbookModel } from '../src/excel/workbook.js';
import { checkFindings } from '../src/agent/findingCheck.js';
import type { DraftFinding } from '../src/agent/types.js';
import { ANSWERS, pct, scoreSheet, toCsv } from '../src/library/spotCheck.js';

/**
 * The human spot-check of our labels.
 *
 *   npm run spotcheck:make               writes data/review-sheet/spot-check.csv (what the teammate sees, no labels) and
 *                                        data/review-sheet/answer-key.json (our label for each row; the teammate must not open it)
 *   npm run spotcheck:read -- [--file <filled csv>]
 *                                        reads the filled sheet back and reports agreement with our labels and the useful / wrong rates
 *
 * The sample is drawn from the findings the app would actually show (after the finding filter) in the labelled runs listed in data/replay-runs.json,
 * spread over the test pairs, balanced across our labels, with the same finding wording from several runs counted once. The order is shuffled with a
 * fixed seed, so the order says nothing about the label. "Our labels" were written by an AI agent, not by a person; the point of this sheet is to
 * check them.
 */
const { positionals, values } = parseArgs({ allowPositionals: true, options: { file: { type: 'string' }, size: { type: 'string' }, seed: { type: 'string' } } });
const base = process.env.INIT_CWD ?? process.cwd();
const root = path.resolve(import.meta.dirname, '../..');
const sheetDir = path.join(root, 'data/review-sheet');

/* ------------------------------ sampling ------------------------------ */

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(items: T[], next: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

interface Candidate {
  pair: string;
  runDir: string;
  findingId: string;
  severity: string;
  title: string;
  detail: string;
  where: string;
  cellText: string;
  file: string;
  ourLabel: string;
  ourNote: string;
}

const pairOf = (inputDir: string) => (inputDir.startsWith('step2') ? 'step2' : inputDir);
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function candidates(): Promise<Candidate[]> {
  const runs: Array<[string, string, string]> = JSON.parse(await readFile(path.join(root, 'data/replay-runs.json'), 'utf8'));
  const out: Candidate[] = [];
  for (const [runDir, input, labelFile] of runs) {
    const report = JSON.parse(await readFile(path.join(root, 'data', runDir, 'report.json'), 'utf8')) as { findings: Array<DraftFinding & { id: string }> };
    const labels = new Map((JSON.parse(await readFile(path.join(root, 'data', labelFile), 'utf8')) as { labels: Array<{ id: string; verdict: string; note: string }> }).labels.map((l) => [l.id, l]));
    const wb = await WorkbookModel.load(path.join(root, 'data/inputs', input));
    const byKey = new Map(report.findings.map((f) => [`${f.dimensionId}|${f.title}`, f.id]));
    const kept = new Set(checkFindings(report.findings.filter((f) => f.source === 'raters'), wb).findings.map((f) => byKey.get(`${f.dimensionId}|${f.title}`)));
    for (const f of report.findings) {
      const label = labels.get(f.id);
      if (!label || !(ANSWERS as readonly string[]).includes(label.verdict)) continue; // duplicate / unchecked / unlabelled are not asked
      if (f.source === 'raters' && !kept.has(f.id)) continue; // the app would not show it
      const loc = f.location;
      out.push({
        pair: pairOf(input.split('/')[0]!),
        runDir,
        findingId: f.id,
        severity: f.severity,
        title: f.title,
        detail: f.detail.replace(/\s*\[(?:Also reported as|Fact check):.*$/s, '').replace(/\s+/g, ' ').trim(),
        where: loc ? `${loc.sheet} ! ${loc.cell}` : '(no cell cited)',
        cellText: loc ? (wb.cellText(loc.sheet, loc.cell) ?? '').replace(/\s+/g, ' ').slice(0, 200) : '',
        file: `data/inputs/${input}`,
        ourLabel: label.verdict,
        ourNote: label.note,
      });
    }
  }
  return out;
}

function sample(all: Candidate[], size: number, next: () => number): Candidate[] {
  // One entry per wording, so three runs of the same finding are not three rows.
  const seen = new Set<string>();
  const unique = shuffle(all, next).filter((c) => (seen.has(`${c.pair}|${norm(c.title)}`) ? false : (seen.add(`${c.pair}|${norm(c.title)}`), true)));
  const pairs = [...new Set(unique.map((c) => c.pair))].sort();
  // Round robin over pairs; inside a pair, round robin over our labels, so a pair with few findings still counts and no label dominates.
  const queues = new Map(pairs.map((p) => [p, ANSWERS.map((a) => unique.filter((c) => c.pair === p && c.ourLabel === a))]));
  const chosen: Candidate[] = [];
  let progress = true;
  while (chosen.length < size && progress) {
    progress = false;
    for (const p of pairs) {
      if (chosen.length >= size) break;
      const buckets = queues.get(p)!;
      // Take from the label this pair has contributed least so far.
      const counts = ANSWERS.map((a) => chosen.filter((c) => c.pair === p && c.ourLabel === a).length);
      const order = ANSWERS.map((_, i) => i).sort((x, y) => counts[x]! - counts[y]! || x - y);
      const pick = order.find((i) => buckets[i]!.length > 0);
      if (pick === undefined) continue;
      chosen.push(buckets[pick]!.shift()!);
      progress = true;
    }
  }
  return shuffle(chosen, next);
}

/* ------------------------------ make ------------------------------ */

async function make() {
  const size = Number(values.size ?? 40);
  const next = rng(Number(values.seed ?? 20261024));
  const picked = sample(await candidates(), size, next);
  await mkdir(sheetDir, { recursive: true });
  const header = ['id', 'pair', 'severity', 'finding', 'cited cell', 'text in that cell', 'file to open', 'real', 'partly', 'wrong', 'vague', 'notes'];
  const rows = picked.map((c, i) => [`S${String(i + 1).padStart(2, '0')}`, c.pair, c.severity, `${c.title}. ${c.detail}`, c.where, c.cellText, c.file, '', '', '', '', '']);
  await writeFile(path.join(sheetDir, 'spot-check.csv'), '﻿' + toCsv([header, ...rows]));
  const key = picked.map((c, i) => ({ id: `S${String(i + 1).padStart(2, '0')}`, pair: c.pair, run: c.runDir, findingId: c.findingId, ourLabel: c.ourLabel, ourNote: c.ourNote }));
  await writeFile(path.join(sheetDir, 'answer-key.json'), JSON.stringify({ note: 'OUR labels (written by an AI agent). Do not open this before filling the sheet.', rows: key }, null, 1));
  const byPair = picked.reduce<Record<string, number>>((m, c) => ((m[c.pair] = (m[c.pair] ?? 0) + 1), m), {});
  const byLabel = picked.reduce<Record<string, number>>((m, c) => ((m[c.ourLabel] = (m[c.ourLabel] ?? 0) + 1), m), {});
  console.log(`Wrote ${picked.length} rows to data/review-sheet/spot-check.csv and the key to data/review-sheet/answer-key.json`);
  console.log('by pair', byPair, '| by our label (hidden from the sheet)', byLabel);
}

/* ------------------------------ read ------------------------------ */


async function read() {
  const file = path.resolve(base, values.file ?? 'data/review-sheet/spot-check.csv');
  const key = JSON.parse(await readFile(path.join(sheetDir, 'answer-key.json'), 'utf8')) as { rows: Array<{ id: string; pair: string; ourLabel: string }> };
  const r = scoreSheet(await readFile(file, 'utf8'), key.rows);
  console.log(`Rows asked ${r.asked}; answered ${r.answered}; left out ${r.skipped.length}${r.skipped.length ? ` (${r.skipped.map((s) => `${s.id}: ${s.why}`).join('; ')})` : ''}`);
  if (r.answered === 0) { console.log('Nothing to score yet.'); return; }
  console.log(`\nAgreement with our labels`);
  console.log(`  exactly the same label:            ${r.exact} of ${r.answered} = ${pct(r.exact, r.answered)}`);
  console.log(`  same on useful (real/partly) or not: ${r.usefulAgree} of ${r.answered} = ${pct(r.usefulAgree, r.answered)}`);
  console.log(`\nOn these ${r.answered} findings (the sample is balanced across our labels, so these rates are not the rates of a normal run)`);
  console.log(`  useful: ours ${pct(r.ours.useful, r.answered)}, the teammate's ${pct(r.theirs.useful, r.answered)}`);
  console.log(`  wrong:  ours ${pct(r.ours.wrong, r.answered)}, the teammate's ${pct(r.theirs.wrong, r.answered)}`);
  console.log(`\nOur label (rows) against the teammate's (columns)`);
  console.log('           ' + ANSWERS.map((a) => a.padStart(7)).join(''));
  for (const o of ANSWERS) console.log(`  ${o.padEnd(8)} ` + ANSWERS.map((t) => String(r.matrix[o]![t]).padStart(7)).join(''));
  console.log(`\nBy pair`);
  for (const [p, v] of Object.entries(r.byPair)) console.log(`  ${p.padEnd(10)} ${v.n} rows, exact ${pct(v.exact, v.n)}, useful-or-not ${pct(v.usefulAgree, v.n)}`);
  if (r.disagreements.length > 0) {
    console.log(`\nWhere the teammate and our label differ on useful/not or on wrong`);
    for (const d of r.disagreements) console.log(`  ${d.id} (${d.pair}) ours ${d.ours}, theirs ${d.theirs}${d.note ? ` - ${d.note}` : ''}`);
  }
  console.log("\nOur labels were written by an AI agent. The teammate's answers are the first human check of them.");
}

const command = positionals[0];
if (command === 'make') await make();
else if (command === 'read') await read();
else { console.error('Usage: spotCheck.ts make | read [--file <csv>]'); process.exit(1); }
