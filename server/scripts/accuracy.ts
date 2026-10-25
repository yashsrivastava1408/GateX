import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import '../src/env.js';
import type { MeasureResult } from '@ddd/shared';
import { loadAppConfig } from '../src/config.js';
import { createDb } from '../src/db/pool.js';
import { Store } from '../src/db/store.js';
import { feedbackAsReview, loadAccuracy } from '../src/library/accuracyData.js';

/**
 * The accuracy figures of the Roadmap (page 14), from what is saved, with no model call.
 *   npm run accuracy                  prints them (people's marks in the database are included when DATABASE_URL is set)
 *   npm run accuracy -- --json        prints the report as JSON
 *   npm run accuracy -- --write-reviews
 *                                     also writes each run's right / wrong marks on issues to data/reviews/human-<run>.json, in the format the
 *                                     library tools read (npm run reliability, npm run replay), so a person's marks can be used as labels
 */
const { values } = parseArgs({ options: { json: { type: 'boolean' }, 'write-reviews': { type: 'boolean' } } });
const config = loadAppConfig(process.env);
// The database is read only when there is a real one (DATABASE_URL) and it answers; otherwise the figures come from the saved files alone.
let db: Awaited<ReturnType<typeof createDb>> | undefined;
let store: Store | undefined;
let dbNote = config.dbMode === 'postgres' ? '' : 'Set DATABASE_URL to include reviews and right / wrong marks saved in the app.';
if (config.dbMode === 'postgres') {
  try {
    db = await createDb(config);
    store = new Store(db);
    await store.human.allReviews();
  } catch (error) {
    dbNote = `The database could not be read, so people's marks saved in the app are left out (${error instanceof Error ? error.message || 'connection refused' : 'error'}). Start the app once so it can set up the database, then run this again.`;
    await db?.close().catch(() => undefined);
    db = undefined;
    store = undefined;
  }
}
const usingDb = store !== undefined;
const report = await loadAccuracy(config.dataDir, store);

const pct = (v: number | null) => (v === null ? 'n/a' : `${(100 * v).toFixed(1)}%`);
const WORD = { pass: 'PASS', fail: 'FAIL', not_enough_data: 'not enough data' } as const;
function print(title: string, rows: MeasureResult[]) {
  console.log(`\n${title}`);
  for (const m of rows) {
    const need = `needs ${m.needs.n}+ from ${m.needs.files}+ file(s)`;
    console.log(`  ${m.title}${m.origin ? ` [${m.origin}]` : ''}`);
    console.log(`    ${pct(m.value).padStart(7)}  target ${m.target}  ·  ${WORD[m.status]}  ·  n=${m.n}, ${m.files} file(s)${m.counted ? `, ${m.counted}` : ''}${m.status === 'not_enough_data' ? `  (${need})` : ''}`);
    for (const s of m.byStep) console.log(`      ${s.step.padEnd(8)} ${pct(s.value).padStart(7)}  n=${s.n}  ${WORD[s.status]}`);
  }
}

if (values.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('GateX accuracy (Roadmap page 14)');
  console.log(`\nPeople so far: ${report.humanTotals.scores} marks, ${report.humanTotals.verdicts} colours, ${report.humanTotals.labels} issue labels, ${report.humanTotals.reviews} review(s) in the app.`);
  if (dbNote) console.log(`(${dbNote})`);
  print('FROM PEOPLE', report.human);
  print('AI STAND-IN (not a human check)', report.aiStandin);
  print('NEEDS NO PERSON (GateX against itself)', report.self);
  console.log('\nSources');
  for (const s of report.sources) console.log(`  [${s.kind}] ${s.title}: ${s.count}\n      ${s.note}`);
}

if (values['write-reviews'] && store) {
  const byRun = new Map<string, Array<{ findingId: string; label: 'right' | 'wrong' | 'unclear'; note: string }>>();
  for (const f of await store!.human.allFeedback()) byRun.set(f.runId, [...(byRun.get(f.runId) ?? []), f]);
  const dir = path.join(config.dataDir, 'reviews');
  await mkdir(dir, { recursive: true });
  for (const [runId, list] of byRun) await writeFile(path.join(dir, `human-${runId}.json`), JSON.stringify(feedbackAsReview(list), null, 2));
  console.log(`\nWrote ${byRun.size} review file(s) to ${dir}`);
}
await db?.close();
