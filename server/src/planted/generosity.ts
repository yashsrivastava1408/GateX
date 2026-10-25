import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { evaluate } from '../agent/index.js';
import { modelsConfigSchema } from '../config.js';
import { createProviderFactory } from '../llm/registry.js';
import { ScorecardResolver } from '../scorecard/resolve.js';
import { assembleReport } from '../report/assemble.js';

/**
 * The generosity check: how much does a file with known mistakes lose, when every examiner is perfectly generous (a clean 5 for every question,
 * citing a real cell)? The only things that can pull the score down are the checks done in code, so this measures exactly that part of the
 * evaluator, with no model call and no cost. A false green is the most expensive error, so the gap must never shrink.
 *
 * Each pair is a clean file and a copy of it with mistakes planted on purpose (see data/planted). Both are scored against the same cached
 * scorecard conversion from data/inputs.
 */
export interface GenerosityPair {
  id: string;
  /** Where the clean file and its scorecard live, under data/inputs. */
  inputs: string;
  scorecard: string;
  clean: string;
  /** The same file with mistakes planted in it, relative to data/. */
  planted: string;
  /** How many mistakes were planted (for the table). */
  mistakes: number;
  /** The score the planted file must lose at least, against the clean one. Measured 25 Oct 2026 (13.6, 9.7, 17.2) and set a little below; a change that shrinks it fails the guard. */
  minGap: number;
}

export const GENEROSITY_PAIRS: GenerosityPair[] = [
  { id: 'step4-register', inputs: 'step4', scorecard: 'scorecard.csv', clean: 'schema.csv', planted: 'planted/final-production-with-sweep/planted.csv', mistakes: 8, minGap: 12 },
  { id: 'docket-pdf', inputs: 'docket', scorecard: 'scorecard.xlsx', clean: 'schema.pdf', planted: 'planted/docket-pdf-planted.pdf', mistakes: 11, minGap: 8.5 },
  { id: 'step5-pdf', inputs: 'step5', scorecard: 'Step5_D2_Scorecards.xlsx', clean: 'Step5_D1_Schema_Definition.pdf', planted: 'planted/step5-pdf-planted.pdf', mistakes: 5, minGap: 15 },
];

export interface GenerosityResult {
  id: string;
  clean: number;
  planted: number;
  gap: number;
  cleanDecision: string;
  plantedDecision: string;
  /** Issues found by code (not by an examiner) in the planted file / the clean one. */
  codeFindingsPlanted: number;
  codeFindingsClean: number;
}

const generous = () =>
  modelsConfigSchema.parse({
    approved: ['mock:*'],
    providers: { mock: { type: 'mock' } },
    raters: ['A', 'B', 'C'].map((id, i) => ({ id, provider: 'mock', model: 'mock-lenient', family: `family-${i}` })),
    consolidator: { id: 'K', provider: 'mock', model: 'mock-consolidator', family: 'family-k' },
    settings: { temperature: 0, maxOutputTokens: 4096, timeoutMs: 5000, retries: 0 },
  });

export const dataRoot = () => path.resolve(import.meta.dirname, '../../../data');

export function pairAvailable(pair: GenerosityPair, root = dataRoot()): boolean {
  return [path.join(root, 'inputs', pair.inputs, pair.clean), path.join(root, 'inputs', pair.inputs, pair.scorecard), path.join(root, pair.planted)].every(existsSync);
}

/** Scores both files of one pair with perfect-generous examiners. Returns null when the cached scorecard conversion is missing. */
export async function measurePair(pair: GenerosityPair, root = dataRoot()): Promise<GenerosityResult | null> {
  const dir = path.join(root, 'inputs', pair.inputs);
  const read = async (name: string) => ({ name, bytes: await readFile(path.join(dir, name)) });
  const resolver = new ScorecardResolver({ cacheDir: path.join(root, 'scorecards'), candidates: () => [] as never });
  const resolved = await resolver.lookup(await read(pair.scorecard), await read(pair.clean));
  if (!resolved) return null;
  const models = generous();
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'generosity-'));
  const run = async (file: string, bytes: Buffer) => {
    const target = path.join(tmp, `${path.basename(file)}`);
    await writeFile(target, bytes);
    const out = await evaluate({
      runId: 'generosity', projectName: pair.id, iteration: 1, workbookPath: target, artifactName: path.basename(file), scorecard: resolved.scorecard,
      scorecardHash: resolved.hash, sources: '', models, providers: createProviderFactory(models, { mockDelayMs: 0 }), env: {},
    });
    const report = assembleReport(out.core, null);
    return { score: report.verdict.weightedScore, decision: report.verdict.decision, code: report.findings.filter((f) => f.source === 'code').length };
  };
  const clean = await run(pair.clean, await readFile(path.join(dir, pair.clean)));
  const planted = await run(pair.planted, await readFile(path.join(root, pair.planted)));
  return {
    id: pair.id, clean: clean.score, planted: planted.score, gap: Math.round((clean.score - planted.score) * 10) / 10,
    cleanDecision: clean.decision, plantedDecision: planted.decision, codeFindingsPlanted: planted.code, codeFindingsClean: clean.code,
  };
}
