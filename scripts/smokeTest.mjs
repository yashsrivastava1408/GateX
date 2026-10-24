#!/usr/bin/env node
/**
 * Proves a running GateX works end to end, with no model call when it was started with MOCK_LLM=1: it waits for the health check, submits a real
 * file and scorecard, waits for the check to finish, and downloads the three reports. It fails if any step breaks or a report is empty or malformed.
 *
 *   node scripts/smokeTest.mjs [baseUrl] [outFolder]        (defaults: http://localhost:4000 and ./smoke-out)
 *
 * CI runs it against the freshly built Docker image and keeps the PDF it downloads, so the real report can be looked at after any change.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = (process.argv[2] ?? 'http://localhost:4000').replace(/\/$/, '');
const out = path.resolve(process.argv[3] ?? 'smoke-out');
const root = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => {
  console.error(`SMOKE TEST FAILED: ${message}`);
  process.exit(1);
};
const step = (message) => console.log(`- ${message}`);

async function json(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) fail(`${init?.method ?? 'GET'} ${url} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}
async function bytes(url) {
  const res = await fetch(url);
  if (!res.ok) fail(`GET ${url} answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

step(`waiting for ${base}/api/health`);
for (let i = 0; ; i++) {
  try {
    const health = await fetch(`${base}/api/health`);
    if (health.ok) break;
  } catch {
    /* not up yet */
  }
  if (i >= 60) fail('the app did not become healthy within 60 seconds');
  await sleep(1000);
}

step('submitting a check');
const form = new FormData();
const sample = (name) => path.join(root, 'samples', 'talentra', name);
form.append('workbook', new Blob([await readFile(sample('Talentra-Feature-Discovery-Dashboard.xlsx'))]), 'Talentra-Feature-Discovery-Dashboard.xlsx');
form.append('scorecard', new Blob([await readFile(sample('talentra-schema-d2.yaml'))]), 'talentra-schema-d2.yaml');
form.append('projectName', `smoke test ${new Date().toISOString()}`);
const created = await json(`${base}/api/runs`, { method: 'POST', body: form });

step(`waiting for run ${created.runId}`);
let run;
for (let i = 0; ; i++) {
  run = await json(`${base}/api/runs/${created.runId}`);
  if (run.status === 'done' || run.status === 'failed') break;
  if (i >= 180) fail(`the check did not finish within 3 minutes (status ${run.status}, stage ${run.stage})`);
  await sleep(1000);
}
if (run.status !== 'done') fail(`the check ended as "${run.status}": ${run.error ?? 'no reason given'}`);
if (typeof run.weightedScore !== 'number') fail('the finished check has no score');
if (!run.report || run.report.dimensions.length === 0) fail('the finished check has no report');
step(`finished: score ${run.weightedScore}, ${run.report.findings.length} issue(s)`);

await mkdir(out, { recursive: true });
const pdf = await bytes(`${base}/api/runs/${created.runId}/report.pdf`);
const xlsx = await bytes(`${base}/api/runs/${created.runId}/report.xlsx`);
const md = (await bytes(`${base}/api/runs/${created.runId}/report.md`)).toString('utf8');
await writeFile(path.join(out, 'report.pdf'), pdf);
await writeFile(path.join(out, 'report.xlsx'), xlsx);
await writeFile(path.join(out, 'report.md'), md);

if (pdf.subarray(0, 5).toString() !== '%PDF-' || pdf.length < 10_000) fail(`report.pdf is not a real report (${pdf.length} bytes)`);
if (xlsx.subarray(0, 2).toString() !== 'PK' || xlsx.length < 4_000) fail(`report.xlsx is not a real workbook (${xlsx.length} bytes)`);
if (!md.includes('GateX')) fail('report.md does not carry the GateX name');
if (/\b(?:bedrock|groq|gemini|mock-[a-z]+)\b/i.test(md)) fail('report.md shows a model or provider name');
if (/\bG\d{2}\b|\bF-\d+\b/.test(md)) fail('report.md shows an area or issue code instead of a name');
console.log(`SMOKE TEST PASSED: pdf ${pdf.length} bytes, xlsx ${xlsx.length} bytes, md ${md.length} chars -> ${out}`);
