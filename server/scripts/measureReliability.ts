import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import '../src/env.js';
import { loadAppConfig } from '../src/config.js';
import { measureReliability } from '../src/library/library.js';

/**
 * Measures how often each model family's findings were right, from the verdicts in the test library, and saves the table the
 * agent reads (data/library/reliability.json). Run it again after reviewing more runs. No model is called.
 *   npm run reliability
 */
const config = loadAppConfig(process.env);
const table = await measureReliability(config.dataDir);
const file = path.join(config.dataDir, 'library', 'reliability.json');
await mkdir(path.dirname(file), { recursive: true });
await writeFile(file, JSON.stringify(table, null, 2));
const pct = (t: { n: number; useful: number }) => (t.n === 0 ? '   -' : `${String(Math.round((100 * t.useful) / t.n)).padStart(3)}%`);
console.log(`Saved ${file}\n`);
console.log('family      alone (useful/checked)     with others too');
for (const [family, r] of Object.entries(table.families)) {
  const filtered = r.solo.n >= table.thresholds.minSamples && r.solo.useful / r.solo.n < table.thresholds.dropBelow;
  console.log(`${family.padEnd(10)}  ${pct(r.solo)} (${r.solo.useful}/${r.solo.n})`.padEnd(40) + `${pct(r.any)} (${r.any.useful}/${r.any.n})${filtered ? '   <- lone findings are set aside' : ''}`);
}
