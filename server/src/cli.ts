import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import './env.js';
import { loadAppConfig, loadModelsConfig } from './config.js';
import { evaluate, evaluateTwice } from './agent/index.js';
import { createProviderFactory } from './llm/registry.js';
import { assembleReport } from './report/assemble.js';
import { renderMarkdown } from './report/markdown.js';
import { renderPdf } from './report/pdf.js';
import { renderXlsx } from './report/xlsx.js';
import { loadReliability } from './library/library.js';
import { importCandidates } from './scorecard/importer.js';
import { ScorecardResolver, conversionNote } from './scorecard/resolve.js';
import { UserError } from './util/errors.js';

/** npm runs workspace scripts from server/, so paths are resolved from where the command was typed. */
export const resolveFromUser = (file: string, env: NodeJS.ProcessEnv = process.env): string =>
  path.resolve(env.INIT_CWD ?? process.cwd(), file);

const USAGE = `Usage: npm run evaluate -- --workbook <file.xlsx|file.csv|file.pdf> --scorecard <scorecard file> [options]

  --workbook   the schema or output workbook to evaluate
  --scorecard  the scorecard, in any layout (.xlsx, .csv, .pdf, .yaml, .json, .txt, .md); one in another
               layout is converted automatically (once, then reused from data/scorecards)
  --sources    optional text file with the problem statement or docket
  --instructions  optional extra instructions for the examiners (text, or @file to read a file)
  --out        folder for report.xlsx, report.md and report.json (default ./data/cli/<run id>)
  --twice      run the whole check twice and report the average score and the gap between the runs (about double the time and cost)
  --quick      score every question once and skip the double-check of findings (faster, a little less steady)
  --mock       use the scripted mock models instead of live APIs
  --models     path to a models config (default server/config/models.json)`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      workbook: { type: 'string' },
      scorecard: { type: 'string' },
      sources: { type: 'string' },
      instructions: { type: 'string' },
      out: { type: 'string' },
      twice: { type: 'boolean', default: false },
      quick: { type: 'boolean', default: false },
      mock: { type: 'boolean', default: false },
      models: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help || !values.workbook || !values.scorecard) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }

  const env = { ...process.env, ...(values.mock ? { MOCK_LLM: '1' } : {}) };
  const config = loadAppConfig(env);
  const chosen = values.models ? loadModelsConfig(resolveFromUser(values.models)) : config.models;
  const models = values.quick ? { ...chosen, settings: { ...chosen.settings, repeats: 1, verifyFindings: false } } : chosen;
  const workbookPath = resolveFromUser(values.workbook);
  const scorecardPath = resolveFromUser(values.scorecard);
  const providers = createProviderFactory(models, { env, mockDelayMs: 0 });
  const resolver = new ScorecardResolver({ cacheDir: path.join(config.dataDir, 'scorecards'), candidates: () => importCandidates(models, providers) });
  const parsed = await resolver.resolve(
    { name: path.basename(scorecardPath), bytes: await readFile(scorecardPath) },
    { name: path.basename(workbookPath), bytes: await readFile(workbookPath) },
  );
  if (parsed.conversion) console.log(conversionNote(parsed.conversion));
  const sources = values.sources ? await readFile(resolveFromUser(values.sources), 'utf8') : '';
  const instructions = values.instructions?.startsWith('@')
    ? await readFile(resolveFromUser(values.instructions.slice(1)), 'utf8')
    : (values.instructions ?? '');

  const runId = randomUUID();
  const out = values.out ? resolveFromUser(values.out) : path.join(config.dataDir, 'cli', runId);
  console.log(`Evaluating ${path.basename(workbookPath)} against ${parsed.scorecard.id} (${config.mock || values.mock ? 'mock models' : 'live models'})`);

  const result = await (values.twice ? evaluateTwice : evaluate)({
    runId,
    projectName: path.basename(workbookPath, path.extname(workbookPath)),
    iteration: 1,
    workbookPath,
    artifactName: path.basename(workbookPath),
    scorecard: parsed.scorecard,
    scorecardHash: parsed.hash,
    sources,
    instructions,
    models,
    scorecardNotes: parsed.conversion ? [conversionNote(parsed.conversion)] : [],
    reliability: await loadReliability(config.dataDir),
    providers,
    env,
    onProgress: (event) => {
      if (event.type === 'stage') console.log(`  · ${event.stage}`);
      else if (event.status !== 'running' && event.status !== 'waiting') console.log(`    ${event.id}: ${event.status}${event.error ? ` (${event.error})` : ''}`);
    },
  });

  const report = assembleReport(result.core, null);
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(out, 'run-log.json'), JSON.stringify(result.runLog, null, 2));
  await writeFile(path.join(out, 'report.md'), renderMarkdown(report));
  await writeFile(path.join(out, 'report.xlsx'), await renderXlsx(report));
  await writeFile(path.join(out, 'report.pdf'), await renderPdf(report));

  const { verdict } = report;
  console.log(`\nVerdict: ${verdict.decision.toUpperCase()}  score ${verdict.weightedScore}`);
  for (const reason of verdict.reasons) console.log(`  - ${reason}`);
  console.log(`Findings: ${report.findings.length}   Report and run-log.json (models, tokens, timings) written to ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof UserError ? error.message : error);
    process.exit(1);
  });
}
