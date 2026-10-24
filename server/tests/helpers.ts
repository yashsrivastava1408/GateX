import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import type { Scorecard } from '@ddd/shared';
import { modelsConfigSchema, type ModelsConfig } from '../src/config.js';
import { evaluate, type EvaluationOutput } from '../src/agent/orchestrator.js';
import { createProviderFactory } from '../src/llm/registry.js';
import { parseScorecard } from '../src/scorecard/parse.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SAMPLES = path.resolve(here, '../../samples/talentra');
export const TALENTRA_XLSX = path.join(SAMPLES, 'Talentra-Feature-Discovery-Dashboard.xlsx');
export const TALENTRA_SCORECARD = path.join(SAMPLES, 'talentra-schema-d2.yaml');

export async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'ddd-test-'));
}

/** Builds a small .xlsx from rows of text, one array of rows per sheet. */
export async function makeWorkbook(sheets: Record<string, Array<Array<string | number | null>>>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = workbook.addWorksheet(name);
    rows.forEach((row) => ws.addRow(row));
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function writeTemp(name: string, data: Buffer | string): Promise<string> {
  const file = path.join(await tempDir(), name);
  await writeFile(file, data);
  return file;
}

export { patchCells } from '../scripts/patchCells.js';

export function mockModels(
  raters: [string, string, string] = ['mock-mid', 'mock-lenient', 'mock-strict'],
  consolidator = 'mock-consolidator',
): ModelsConfig {
  return modelsConfigSchema.parse({
    approved: ['mock:*'],
    providers: { mock: { type: 'mock' } },
    raters: raters.map((model, i) => ({ id: 'ABC'[i], provider: 'mock', model, family: `family-${i}` })),
    consolidator: { id: 'K', provider: 'mock', model: consolidator, family: 'family-k' },
    settings: { temperature: 0, maxOutputTokens: 4096, timeoutMs: 5000, retries: 0 },
  });
}

export async function loadTalentraScorecard(): Promise<{ scorecard: Scorecard; hash: string }> {
  return parseScorecard(await readFile(TALENTRA_SCORECARD, 'utf8'), 'talentra-schema-d2.yaml');
}

export interface RunOptions {
  workbook: Buffer | string;
  scorecard?: { scorecard: Scorecard; hash: string };
  models?: ModelsConfig;
  sources?: string;
  env?: NodeJS.ProcessEnv;
}

export async function runEvaluation(options: RunOptions): Promise<EvaluationOutput & { workbookPath: string }> {
  const models = options.models ?? mockModels();
  const parsed = options.scorecard ?? (await loadTalentraScorecard());
  const workbookPath = typeof options.workbook === 'string' ? options.workbook : await writeTemp('input.xlsx', options.workbook);
  const output = await evaluate({
    runId: 'test-run',
    projectName: 'test',
    iteration: 1,
    workbookPath,
    artifactName: path.basename(workbookPath),
    scorecard: parsed.scorecard,
    scorecardHash: parsed.hash,
    sources: options.sources ?? '',
    models,
    providers: createProviderFactory(models, { mockDelayMs: 0 }),
    env: options.env ?? {},
  });
  return { ...output, workbookPath };
}

/** A tiny schema workbook and scorecard that pass everything, for positive tests. */
export const CLEAN_SCORECARD_YAML = `
scorecard:
  id: SC-CLEAN
  version: 1.0
  judges: D1 schema
  frozen: true
  artifact:
    sheets: [{ name: Tree, header_row: 1 }]
  dimensions:
    - id: C01
      name: Everything defined
      weight: 40
      critical: true
      check:
        id: column_filled
        params: { sheet: Tree, column: Definition }
        bands: [{ min: 1, score: 5 }, { min: 0.5, score: 3 }]
    - id: J01
      name: Readable
      weight: 40
      critical: true
      anchors: { 5: great, 4: good, 3: ok, 2: weak, 1: poor, 0: none }
    - id: H01
      name: Interview
      weight: 20
      critical: true
      measurable_by_agent: false
`;

export const CLEAN_TREE = [
  ['Path id', 'Name', 'Definition'],
  ['1', 'Study', 'What the study is about'],
  ['1.1', 'Product', 'The product being studied'],
  ['1.2', 'Date', 'When the study was done'],
];
