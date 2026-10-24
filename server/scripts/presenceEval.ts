import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import '../src/env.js';
import { loadAppConfig } from '../src/config.js';
import { createProviderFactory } from '../src/llm/registry.js';
import { WorkbookModel } from '../src/excel/workbook.js';
import { checkPresence } from '../src/agent/presence.js';
import type { DraftFinding } from '../src/agent/types.js';

/**
 * Runs the "the file already has it" check with live models on hand-labelled findings and scores it. A finding labelled `present` should be
 * dropped; one labelled `keep` (a real gap) must never be. Costs one or two small model calls.
 *   npm run presence:eval -- [--labels data/presence/step2-labels.json]
 */
const { values } = parseArgs({ options: { labels: { type: 'string' } } });
const repo = path.resolve(import.meta.dirname, '..', '..');
const file = path.resolve(process.env.INIT_CWD ?? process.cwd(), values.labels ?? path.join(repo, 'data/presence/step2-labels.json'));
const set = JSON.parse(await readFile(file, 'utf8')) as { workbook: string; findings: Array<DraftFinding & { id: string; run: string; expect: 'present' | 'keep' | 'either' }> };
const wb = await WorkbookModel.load(path.resolve(repo, set.workbook));
const config = loadAppConfig();
const providers = createProviderFactory(config.models, { env: process.env, mockDelayMs: 0 });
const c = config.models.consolidator;
const findings = set.findings.map((f) => ({ ...f, source: 'raters' as const, returnTo: 'Define' as never }));
const result = await checkPresence({ findings, wb, models: [{ model: c.model, provider: providers(c.provider) }], settings: { temperature: 0, maxOutputTokens: config.models.settings.maxOutputTokens } });
const droppedKeys = new Set(result.dropped.map((d) => `${d.dimensionId}|${d.title}`));
let right = 0;
let wrongDrops = 0;
for (const f of set.findings) {
  const dropped = droppedKeys.has(`${f.dimensionId}|${f.title}`);
  const ok = f.expect === 'either' ? true : f.expect === 'present' ? dropped : !dropped;
  if (ok) right++;
  if (f.expect === 'keep' && dropped) wrongDrops++;
  console.log(`${ok ? 'ok  ' : 'MISS'} [${f.run} ${f.id}] expect ${f.expect.padEnd(7)} ${dropped ? 'dropped' : 'kept   '} ${f.title.slice(0, 60)}${dropped ? ` :: ${result.dropped.find((d) => `${d.dimensionId}|${d.title}` === `${f.dimensionId}|${f.title}`)!.reason.slice(0, 110)}` : ''}`);
}
const present = set.findings.filter((f) => f.expect === 'present');
console.log(`\n${right}/${set.findings.length} as labelled; dropped ${present.filter((f) => droppedKeys.has(`${f.dimensionId}|${f.title}`)).length}/${present.length} that the file already answers; real gaps wrongly dropped: ${wrongDrops}`);
console.log(`model ${result.model}, tokens in ${result.inputTokens} out ${result.outputTokens}`, result.notes);
process.exit(wrongDrops === 0 ? 0 : 1);
