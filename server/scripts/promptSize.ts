/**
 * Shows how many tokens each rater would be sent, before and after sectioning, and whether each model of the REAL roster
 * can take it. It makes no API calls.
 *
 *   npm run prompt:size -- <workbook.xlsx|pdf> <scorecard (any layout)>
 *
 * The roster is the one the app uses: MODELS_CONFIG from .env, else server/config/models.json. A scorecard in another
 * layout is read from the conversion cache (data/scorecards) only; if it has not been converted yet, it says so and stops,
 * rather than spending a model call. "Whole workbook" ignores any `reads` lists, which is what every rater was sent
 * before sectioning existed.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Scorecard } from '@ddd/shared';
import '../src/env.js';
import { loadAppConfig, modelsFileFor, type ModelsConfig } from '../src/config.js';
import { WorkbookModel } from '../src/excel/workbook.js';
import { resolvePageRanges } from '../src/excel/pageRanges.js';
import { serializeSheet } from '../src/excel/serialize.js';
import { buildAllRaterPrompts } from '../src/agent/prompt.js';
import { RATER_SYSTEM } from '../src/agent/prompts/rater.js';
import { estimateTokens } from '../src/agent/rater.js';
import { ScorecardResolver } from '../src/scorecard/resolve.js';

const n = (v: number) => v.toLocaleString('en-US').padStart(7);

/** The whole report as lines of text, so it can be tested without a terminal. */
export function promptSizeReport(input: { wb: WorkbookModel; scorecard: Scorecard; roster: ModelsConfig; configFile: string }): string[] {
  const { wb, roster } = input;
  const scorecard = resolvePageRanges(input.scorecard, wb);
  const system = estimateTokens(RATER_SYSTEM);
  const out: string[] = [`\n${scorecard.id}: tokens per sheet (estimate, chars / 2.7)`];
  for (const sheet of [...scorecard.artifact.sheets, ...scorecard.artifact.context]) {
    out.push(`  ${n(estimateTokens(serializeSheet(wb, sheet)))}  ${sheet.name}`);
  }

  const whole = { ...scorecard, dimensions: scorecard.dimensions.map(({ reads: _reads, ...d }) => d) };
  const before = buildAllRaterPrompts({ scorecard: whole, wb, sources: '' }).map((p) => system + estimateTokens(p.prompt.user));
  const after = buildAllRaterPrompts({ scorecard, wb, sources: '' });
  const sizes = after.map((p) => system + estimateTokens(p.prompt.user));

  out.push('\nEach rater is sent:', `  ${n(Math.max(...before, 0))}  whole workbook, one prompt (before sectioning)`);
  after.forEach(({ label, prompt }, i) => out.push(`  ${n(sizes[i]!)}  ${label}  (${prompt.rated.map((d) => d.id).join(', ')})`));
  out.push(`  ${n(sizes.reduce((sum, s) => sum + s, 0))}  all sections together (per rater)`);

  out.push(`\nCan each model take it? (limits from ${input.configFile})`);
  const fits = (limit: number | undefined) => (size: number) => (limit === undefined || size <= limit ? 'fits' : 'too big');
  for (const r of roster.raters) {
    const ok = fits(r.maxInputTokens);
    out.push(`  ${r.id} ${r.model} (limit ${r.maxInputTokens ? n(r.maxInputTokens).trim() : 'none'}):  whole workbook ${ok(Math.max(...before, 0))}  |  ${sizes.map((s, i) => `section ${i + 1} ${ok(s)}`).join('  ')}`);
    for (const f of r.fallbacks ?? []) {
      const fok = fits(f.maxInputTokens);
      out.push(`    backup ${f.model} (limit ${f.maxInputTokens ? n(f.maxInputTokens).trim() : 'none'}):  ${sizes.map((s, i) => `section ${i + 1} ${fok(s)}`).join('  ')}`);
    }
  }
  out.push('\nEstimates use chars / 2.7 and are only approximate; real counts show in a finished run under Technical details.');
  return out;
}

async function main(): Promise<void> {
  const [workbookArg, scorecardArg] = process.argv.slice(2);
  if (!workbookArg || !scorecardArg) {
    console.error('Usage: npm run prompt:size -- <workbook.xlsx|pdf> <scorecard (any layout)>');
    process.exit(1);
  }
  const resolve = (f: string) => path.resolve(process.env.INIT_CWD ?? process.cwd(), f);
  // The live roster, even if MOCK_LLM is set in the shell: this is about what the real models can take.
  const env = { ...process.env, MOCK_LLM: '' };
  const config = loadAppConfig(env);
  const configFile = path.relative(path.resolve(process.env.INIT_CWD ?? process.cwd()), modelsFileFor(env)) || modelsFileFor(env);
  console.log(`Roster: ${configFile}`);

  const workbookBytes = await readFile(resolve(workbookArg));
  const wb = await WorkbookModel.load(workbookBytes);
  const resolver = new ScorecardResolver({ cacheDir: path.join(config.dataDir, 'scorecards'), candidates: () => [] });
  const found = await resolver.lookup(
    { name: path.basename(scorecardArg), bytes: await readFile(resolve(scorecardArg)) },
    { name: path.basename(workbookArg), bytes: workbookBytes },
  );
  if (!found) {
    console.error(
      `${path.basename(scorecardArg)} is not in this app's format and has not been converted for this workbook yet, so its size cannot be measured without a model call.\n` +
        `Convert it once (npm run scorecard:import -- ${scorecardArg} ${workbookArg}, or submit it), then run this again.`,
    );
    process.exit(2);
  }
  if (found.conversion) console.log(`Scorecard: the cached conversion of ${found.conversion.from} (${found.conversion.model.provider}/${found.conversion.model.model}, ${found.conversion.convertedAt.slice(0, 10)})`);
  for (const line of promptSizeReport({ wb, scorecard: found.scorecard, roster: config.models, configFile })) console.log(line);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
