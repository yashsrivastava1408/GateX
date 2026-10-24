import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import '../src/env.js';
import { loadAppConfig } from '../src/config.js';
import { createProviderFactory } from '../src/llm/registry.js';
import { verifierCandidates } from '../src/llm/roster.js';
import { WorkbookModel } from '../src/excel/workbook.js';
import { verifyFindings } from '../src/agent/verifyFindings.js';
import type { DraftFinding } from '../src/agent/types.js';

/**
 * Runs the second look on one finished report's findings and prints what the model said for each, so a run's kept findings can be audited.
 *   npm run verify:report -- --run <dir with report.json> --workbook <file>
 */
const { values } = parseArgs({ options: { run: { type: 'string' }, workbook: { type: 'string' } } });
const base = process.env.INIT_CWD ?? process.cwd();
const report = JSON.parse(await readFile(path.join(path.resolve(base, values.run!), 'report.json'), 'utf8')) as { findings: Array<DraftFinding & { id: string }> };
const wb = await WorkbookModel.load(path.resolve(base, values.workbook!));
const config = loadAppConfig();
const providers = createProviderFactory(config.models, { env: process.env, mockDelayMs: 0 });
const models = verifierCandidates(config.models).map((c) => ({ model: c.model, provider: providers(c.provider) }));
const confirmers = verifierCandidates(config.models, process.env, 'confirmers').map((c) => ({ model: c.model, provider: providers(c.provider) }));
const result = await verifyFindings({ findings: report.findings, wb, models, confirmers, settings: { temperature: 0, maxOutputTokens: config.models.settings.maxOutputTokens } });
for (const f of report.findings) {
  const a = result.answers.get(f);
  console.log(`${f.id} ${f.source} ${a ? a.verdict.padEnd(6) : 'not sent'} ${a?.confirm ? `[second reading: ${a.confirm}] ` : ''}${f.title}${a?.verdict === 'false' ? ` :: ${a.cell} "${(a.quote ?? '').slice(0, 120)}" (${a.why})` : a?.why ? ` :: ${a.why.slice(0, 140)}` : ''}`);
}
console.log('\nset aside:', result.dropped.map((d) => `${d.title}: ${d.reason}`));
console.log(result.stats);
