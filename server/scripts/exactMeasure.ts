import { readFile } from 'node:fs/promises';

/**
 * Offline survey (no model): for every pair in data/inputs whose scorecard conversion is cached, how many of the questions are counted exactly
 * (measured by code) or have a ceiling from an exact count (the criterion's own words ask for one), and which ceilings fire on the file.
 * Usage: npm run exact:measure [-- -v]   (-v lists the exact questions and the family each belongs to)
 */
import path from 'node:path';
import { ScorecardResolver } from '../src/scorecard/resolve.js';
import { expandCriteria, retypeOutsideCriteria } from '../src/agent/aggregate.js';
import { ABOUT_A_MECHANISM, FAMILIES, exactCeilingsFor } from '../src/agent/exactScore.js';
import { WorkbookModel } from '../src/excel/workbook.js';
const root = path.resolve('../data/inputs');
const pairs: Record<string, [string, string]> = {
  'step2-v32': ['Talentra_Step2_Master_Scorecard_v3.2_Reconciled.xlsx', 'Talentra_Step2_Master_Schema_v3.2_Reconciled.xlsx'],
  step3: ['03_feature_discovery.xlsx', 'Feature_Discovery_Schema_3A.xlsx'],
  step4: ['scorecard.csv', 'schema.csv'],
  step5: ['Step5_D2_Scorecards.xlsx', 'Step5_D1_Schema_Definition.pdf'],
  docket: ['scorecard.xlsx', 'schema.pdf'],
};
for (let i = 1; i <= 5; i++) pairs[`raw-step${i}`] = ['scorecard.xlsx', 'schema.pdf'];
const resolver = new ScorecardResolver({ cacheDir: path.resolve('../data/scorecards'), candidates: () => [] as never });
const verbose = process.argv.includes('-v');
console.log('pair | questions | outside(unmeasurable) | code | judged-exact | judged-other | exact share | ceilings that fire on the file');
for (const [name, [s, d]] of Object.entries(pairs)) {
  const read = async (f: string) => ({ name: f, bytes: await readFile(path.join(root, name, f)) });
  const r = await resolver.lookup(await read(s), await read(d));
  if (!r) continue;
  const sc = expandCriteria(retypeOutsideCriteria(r.scorecard).scorecard);
  const qs = sc.dimensions;
  const outside = qs.filter((q) => q.criterionOf && retypeOutsideCriteria(r.scorecard).scorecard.dimensions.find((x) => x.id === q.criterionOf!.id)?.criteria?.find((c) => c.id === q.id)?.outside);
  const isOut = (q: (typeof qs)[number]) => outside.includes(q);
  const code = qs.filter((q) => q.measuredBy === 'code');
  const asked = (q: (typeof qs)[number]) => (ABOUT_A_MECHANISM.test(`${q.name} ${q.measure ?? ''}`) ? [] : FAMILIES.filter((f) => f.asks(`${q.name} ${q.measure ?? ''}`)));
  const ex = qs.filter((q) => q.measuredBy === 'raters' && !isOut(q) && asked(q).length > 0);
  const other = qs.filter((q) => q.measuredBy === 'raters' && !isOut(q) && !ex.includes(q));
  const wb = await WorkbookModel.load(path.join(root, name, d));
  const c = exactCeilingsFor(qs, wb);
  const measurable = qs.length - outside.length;
  console.log(`${name} | ${qs.length} | ${outside.length} | ${code.length} | ${ex.length} | ${other.length} | ${(((code.length + ex.length) / measurable) * 100).toFixed(0)}% | ${[...c].map(([id, v]) => `${id}:${v.family}<=${v.ceiling} (${v.summary})`).join('; ') || '-'}`);
  if (verbose) for (const q of ex) console.log('   EXACT', q.id, q.name, '=>', asked(q).map((f) => f.id).join(','));
}
