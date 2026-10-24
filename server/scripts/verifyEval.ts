import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import '../src/env.js';
import { loadAppConfig } from '../src/config.js';
import { createProviderFactory } from '../src/llm/registry.js';
import { verifierCandidates } from '../src/llm/roster.js';
import { WorkbookModel } from '../src/excel/workbook.js';
import { confirmContradictions, needsVerifying, proofOfContradiction, verifyFindings, type VerdictAnswer } from '../src/agent/verifyFindings.js';
import type { DraftFinding } from '../src/agent/types.js';
import { mapWithConcurrency } from '../src/util/concurrency.js';
import { parseCsv } from '../src/library/spotCheck.js';

/**
 * Measures the "double-check every finding" pass on the findings we have labelled (data/replay-runs.json + data/reviews, and the blind labels in
 * data/review-sheet). The model is called once per finding and its raw answers are saved in --cache; with --reuse the saved answers are
 * judged again by the current proof rules in code, which costs nothing. A finding is dropped only when the answer is "false" and code proves the quote.
 *   npm run verify:eval -- [--cache data/verify/answers.json] [--reuse] [--only <run-name>]
 * Real/partly findings dropped must be 0.
 */
const { values } = parseArgs({ options: { cache: { type: 'string' }, reuse: { type: 'boolean', default: false }, only: { type: 'string' }, finder: { type: 'string' }, confirmers: { type: 'string' }, confirm: { type: 'boolean', default: false }, dry: { type: 'boolean', default: false }, out: { type: 'string' } } });
const root = path.resolve(import.meta.dirname, '..', '..');
const base = process.env.INIT_CWD ?? process.cwd();
const cacheFile = path.resolve(base, values.cache ?? path.join(root, 'data/verify/answers.json'));
const outFile = path.resolve(base, values.out ?? path.join(root, 'data/verify/result.json'));

type Run = [string, string, string];
const runs: Run[] = (JSON.parse(await readFile(path.join(root, 'data/replay-runs.json'), 'utf8')) as Run[]).filter((r) => !values.only || r[0] === values.only);
type Item = { run: string; id: string; f: DraftFinding; label: string; wb: WorkbookModel };
const items: Item[] = [];
const byRun = new Map<string, { wb: WorkbookModel; items: Item[] }>();
for (const [run, input, review] of runs) {
  const report = JSON.parse(await readFile(path.join(root, 'data', run, 'report.json'), 'utf8')) as { findings: Array<DraftFinding & { id: string }> };
  const labels = new Map((JSON.parse(await readFile(path.join(root, 'data', review), 'utf8')) as { labels: Array<{ id: string; verdict: string }> }).labels.map((l) => [l.id, l.verdict]));
  const wb = await WorkbookModel.load(path.join(root, 'data/inputs', input));
  const mine: Item[] = [];
  for (const f of report.findings) {
    if (!labels.has(f.id)) continue;
    const item = { run, id: f.id, f, label: labels.get(f.id)!, wb };
    mine.push(item);
    items.push(item);
  }
  byRun.set(run, { wb, items: mine });
}

const config = loadAppConfig();
// Try other models without editing the config: --finder <model id> and --confirmers <id,id> (same provider as the configured verifier).
if (values.finder || values.confirmers) {
  const provider = config.models.verifier?.provider ?? config.models.consolidator.provider;
  config.models = {
    ...config.models,
    verifier: {
      provider,
      model: values.finder ?? config.models.verifier?.model ?? config.models.consolidator.model,
      fallbacks: [],
      confirmers: values.confirmers ? values.confirmers.split(',').map((model) => ({ provider, model })) : config.models.verifier?.confirmers,
    },
  };
}
const settings = { temperature: 0, maxOutputTokens: config.models.settings.maxOutputTokens };
const cache: Record<string, VerdictAnswer> = existsSync(cacheFile) && (values.reuse || values.confirm) ? JSON.parse(await readFile(cacheFile, 'utf8')) : {};
const tokens = { inputTokens: 0, outputTokens: 0, calls: 0, checked: 0, failed: 0 };
let model = '';
if (values.confirm) {
  // Second reading only: the saved first answers stay as they are; each proven "false" gets a confirmer's reading.
  const providers = createProviderFactory(config.models, { env: process.env, mockDelayMs: 0 });
  const confirmers = verifierCandidates(config.models, process.env, 'confirmers').map((c) => ({ model: c.model, provider: providers(c.provider) }));
  model = `confirm: ${confirmers.map((m) => m.model).join(' + ')}`;
  const todo = items.filter((i) => needsVerifying(i.f) && cache[`${i.run}|${i.id}`]?.verdict === 'false' && !cache[`${i.run}|${i.id}`]!.confirm).flatMap((i) => {
    const proof = proofOfContradiction(i.wb, i.f, cache[`${i.run}|${i.id}`]!);
    return proof.ok ? [{ id: `${i.run}|${i.id}`, f: i.f, wb: i.wb, cell: proof.cell, quote: proof.quote }] : [];
  });
  const stats = { stats: { checked: 0, skipped: 0, calls: 0, failed: 0, dropped: 0, inputTokens: 0, outputTokens: 0 }, notes: [] as string[] };
  const got = await confirmContradictions(todo, confirmers, settings, stats);
  for (const [k, v] of got) cache[k]!.confirm = v;
  Object.assign(tokens, { inputTokens: stats.stats.inputTokens, outputTokens: stats.stats.outputTokens, calls: stats.stats.calls });
  console.log(`confirm: ${todo.length} candidates, calls ${stats.stats.calls}`, stats.notes);
  await writeFile(cacheFile, JSON.stringify(cache, null, 1));
} else if (!values.reuse) {
  const providers = createProviderFactory(config.models, { env: process.env, mockDelayMs: 0 });
  // --dry: no model is called; every finding is answered "unsure" and the prompt sizes are counted, to estimate the cost.
  const dryProvider = { name: 'dry', complete: async (r: { user: string }) => ({ text: JSON.stringify({ results: [...r.user.matchAll(/<finding id="([^"]+)">/g)].map((m) => ({ id: m[1], verdict: 'unsure' })) }), inputTokens: Math.ceil(r.user.length / 2.7), outputTokens: 60 }) };
  const models = values.dry ? [{ model: 'dry', provider: dryProvider }] : verifierCandidates(config.models).map((c) => ({ model: c.model, provider: providers(c.provider) }));
  model = models.map((m) => m.model).join(' then ');
  await mapWithConcurrency([...byRun.entries()], 3, async ([run, { wb, items: mine }]) => {
    const res = await verifyFindings({ findings: mine.map((i) => i.f), wb, models, settings });
    for (const i of mine) {
      const a = res.answers.get(i.f);
      if (a) cache[`${run}|${i.id}`] = a;
    }
    tokens.inputTokens += res.stats.inputTokens;
    tokens.outputTokens += res.stats.outputTokens;
    tokens.calls += res.stats.calls;
    tokens.checked += res.stats.checked;
    tokens.failed += res.stats.failed;
    console.log(`${run}: checked ${res.stats.checked}, dropped ${res.stats.dropped}, calls ${res.stats.calls}`);
  });
  if (!values.dry) {
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify(cache, null, 1));
  }
}

// Judge every saved answer with the current proof rules.
const dropped = new Map<string, string>();
const verdictCounts: Record<string, number> = {};
const confirmCounts: Record<string, number> = {};
for (const i of items) {
  if (!needsVerifying(i.f)) continue;
  const a = cache[`${i.run}|${i.id}`];
  if (!a) continue;
  verdictCounts[a.verdict] = (verdictCounts[a.verdict] ?? 0) + 1;
  if (a.verdict !== 'false') continue;
  const proof = proofOfContradiction(i.wb, i.f, a);
  if (proof.ok && a.confirm) confirmCounts[a.confirm] = (confirmCounts[a.confirm] ?? 0) + 1;
  if (proof.ok && a.confirm === 'contradicts') dropped.set(`${i.run}|${i.id}`, `${proof.cell} says "${proof.quote.slice(0, 160)}" (${a.why ?? ''})`);
  else if (process.env.VERIFY_DEBUG) console.log(`kept despite false ${i.run} ${i.id} (${i.label}): ${proof.ok ? `second reading ${a.confirm ?? 'none'}` : proof.why}`);
}

const corrections: Record<string, { now: string; why: string }> = existsSync(path.join(root, 'data/verify/label-corrections.json')) ? JSON.parse(await readFile(path.join(root, 'data/verify/label-corrections.json'), 'utf8')) : {};
const share = (list: Array<{ label: string }>) => {
  const n = list.length || 1;
  const useful = list.filter((x) => ['real', 'partly'].includes(x.label)).length;
  const wrong = list.filter((x) => x.label === 'wrong').length;
  return { n: list.length, useful, usefulPct: Math.round((100 * useful) / n), wrong, wrongPct: Math.round((100 * wrong) / n) };
};
const tally = (list: Array<{ label: string }>) => list.reduce<Record<string, number>>((m, x) => ((m[x.label] = (m[x.label] ?? 0) + 1), m), {});
const report = (name: string, set: Array<{ run: string; id: string; label: string }>) => {
  const gone = set.filter((x) => dropped.has(`${x.run}|${x.id}`));
  const kept = set.filter((x) => !dropped.has(`${x.run}|${x.id}`));
  console.log(`\n== ${name}: ${set.length} findings`);
  console.log('before', share(set), tally(set));
  console.log('dropped', gone.length, tally(gone));
  console.log('after ', share(kept), tally(kept));
  const bad = gone.filter((x) => ['real', 'partly'].includes(x.label));
  console.log(bad.length === 0 ? 'OK: no real or partly-right finding dropped' : `BAD: ${bad.length} real/partly dropped: ${bad.map((b) => `${b.run}|${b.id}`).join(', ')}`);
  return { before: share(set), dropped: gone.length, droppedByLabel: tally(gone), after: share(kept), realOrPartlyDropped: bad.map((b) => `${b.run}|${b.id}`) };
};
const ours = items.map((i) => ({ run: i.run, id: i.id, label: i.label }));
const resultOurs = report('OUR LABELS (as written)', ours);
const resultOursCorrected = Object.keys(corrections).length > 0 ? report('OUR LABELS (with the corrections in data/verify/label-corrections.json)', ours.map((o) => ({ ...o, label: corrections[`${o.run}|${o.id}`]?.now ?? o.label }))) : null;

// Blind labels: map each row of the filled sheet to its finding through the answer key.
const key = (JSON.parse(await readFile(path.join(root, 'data/review-sheet/answer-key.json'), 'utf8')) as { rows: Array<{ id: string; run: string; findingId: string }> }).rows;
const table = parseCsv((await readFile(path.join(root, 'data/review-sheet/spot-check-filled-agent.csv'), 'utf8')).replace(/^﻿/, '')).filter((r) => r.length > 1);
const head = table[0]!;
const blindOf = new Map<string, string>();
for (const r of table.slice(1)) {
  const row = Object.fromEntries(head.map((h, i) => [h, r[i] ?? '']));
  const label = (['real', 'partly', 'wrong', 'vague'] as const).find((l) => (row[l] ?? '').trim() !== '');
  if (label) blindOf.set(row.id!, label);
}
const blind = key.filter((k) => blindOf.has(k.id) && byRun.has(k.run)).map((k) => ({ run: k.run, id: k.findingId, label: blindOf.get(k.id)! }));
const resultBlind = report('BLIND LABELS', blind);

console.log('\nanswers', verdictCounts, 'second reading of proven quotes', confirmCounts, values.reuse ? '(reused, no model call)' : `model ${model}, calls ${tokens.calls}, tokens in ${tokens.inputTokens} out ${tokens.outputTokens}, failed ${tokens.failed}`);
console.log('\nDROPPED (with our label and blind label):');
const blindMap = new Map(blind.map((b) => [`${b.run}|${b.id}`, b.label]));
const rows: Array<Record<string, string>> = [];
for (const i of items) {
  const k = `${i.run}|${i.id}`;
  if (!dropped.has(k)) continue;
  console.log(` ${k} ours=${i.label} blind=${blindMap.get(k) ?? '-'} :: ${i.f.title.slice(0, 70)} :: ${dropped.get(k)}`);
  rows.push({ key: k, ours: i.label, blind: blindMap.get(k) ?? '-', title: i.f.title, detail: i.f.detail.slice(0, 300), proof: dropped.get(k)! });
}
await mkdir(path.dirname(outFile), { recursive: true });
await writeFile(outFile, JSON.stringify({ model, tokens, verdictCounts, confirmCounts, ours: resultOurs, oursCorrected: resultOursCorrected, blind: resultBlind, dropped: rows }, null, 1));
process.exit((resultOursCorrected ?? resultOurs).realOrPartlyDropped.length + resultBlind.realOrPartlyDropped.length === 0 ? 0 : 1);
