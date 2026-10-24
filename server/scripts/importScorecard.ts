/**
 * Converts a scorecard in any layout into this app's format, on the command line.
 *
 *   npm run scorecard:import -- <scorecard-file> [document.xlsx|pdf] [--out folder]
 *
 * Writes scorecard.yaml (frozen, ready to use) and notes.json (what the model was unsure about, what code changed, sizes).
 * The conversion goes into the same cache the server uses (data/scorecards), so the server reuses it without another model call.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import '../src/env.js';
import { loadAppConfig } from '../src/config.js';
import { createProviderFactory } from '../src/llm/registry.js';
import { importCandidates } from '../src/scorecard/importer.js';
import { ScorecardResolver } from '../src/scorecard/resolve.js';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? args.splice(outAt, 2)[1] : undefined;
const [scorecardArg, documentArg] = args;
if (!scorecardArg) {
  console.error('Usage: npm run scorecard:import -- <scorecard-file> [document.xlsx|pdf] [--out folder]');
  process.exit(1);
}
const resolve = (f: string) => path.resolve(process.env.INIT_CWD ?? process.cwd(), f);
const load = async (file: string) => ({ name: path.basename(file), bytes: await readFile(resolve(file)) });

const config = loadAppConfig();
const candidates = importCandidates(config.models, createProviderFactory(config.models));
if (candidates.length === 0) throw new Error('No model is ready. Check the keys with "npm run models:check".');
const resolver = new ScorecardResolver({ cacheDir: path.join(config.dataDir, 'scorecards'), candidates: () => candidates });
console.log(`Reading ${scorecardArg} with ${candidates[0]!.model.provider}/${candidates[0]!.model.model} (or a cached conversion) ...`);

const started = Date.now();
const result = await resolver.preview(await load(scorecardArg), documentArg ? await load(documentArg) : undefined);
const seconds = Math.round((Date.now() - started) / 1000);

const folder = resolve(out ?? path.join('data', 'import', path.basename(scorecardArg).replace(/\.[^.]+$/, '')));
await mkdir(folder, { recursive: true });
await writeFile(path.join(folder, 'scorecard.yaml'), result.yaml);
const { model, summary, uncertain, adjustments, inputTokens, outputTokens, cached } = result;
await writeFile(path.join(folder, 'notes.json'), JSON.stringify({ model, cached, summary, uncertain, adjustments, inputTokens, outputTokens, seconds }, null, 2));
console.log(`${summary.dimensions} questions (${summary.byExaminers} for the examiners, ${summary.byCode} counted by code, ${summary.critical} must-pass), weights add to ${summary.weightTotal}.`);
console.log(`${cached ? 'Reused the cached conversion' : `${seconds}s, ${inputTokens ?? '?'} tokens in, ${outputTokens ?? '?'} out`}. Written to ${folder}`);
