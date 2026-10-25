import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { tierOf, type TierRule, type Severity } from '@ddd/shared';
import { WorkbookModel } from '../src/excel/workbook.js';
import { checkFindings } from '../src/agent/findingCheck.js';
import { checkClaims } from '../src/agent/claimCheck.js';
import type { DraftFinding } from '../src/agent/types.js';
import { aboutAFullMarkQuestion } from '../src/agent/tierSupport.js';

/**
 * Measures the two-tier split (Confirmed / Worth a look) offline on every labelled run in data/replay-runs.json. The finding filter is replayed first
 * (as in replay:all), then the tier rule is applied to what is kept. Labels are ours (an agent's); with --consensus the 40 findings on
 * data/review-sheet/consensus.csv take the consensus label instead. No model is called.
 * Usage: npm run tiers:measure [-- --consensus] [-- --schema-design] [-- --full-mark]  (--full-mark: a finding about a question marked 5 in the end is Worth a look, as the app now does)
 */
const root = path.resolve(import.meta.dirname, '../..');
const runs: Array<[string, string, string]> = JSON.parse(await readFile(path.join(root, 'data/replay-runs.json'), 'utf8'));
const useConsensus = process.argv.includes('--consensus');
const schemaDesign = process.argv.includes('--schema-design');
type F = DraftFinding & { id: string };

const consensus = new Map<string, string>(); // "run|F-xx" -> label
if (useConsensus) {
  const key = JSON.parse(await readFile(path.join(root, 'data/review-sheet/answer-key.json'), 'utf8')) as { rows: Array<{ id: string; run: string; findingId: string }> };
  const csv = (await readFile(path.join(root, 'data/review-sheet/consensus.csv'), 'utf8')).trim().split('\n').slice(1).map((l) => l.split(','));
  const byId = new Map(csv.map((c) => [c[0]!, c[5]!]));
  for (const r of key.rows) if (byId.has(r.id)) consensus.set(`${r.run}|${r.findingId}`, byId.get(r.id)!);
}

interface Row { run: string; id: string; label: string; f: F; family: string; contradicted: boolean }
const rows: Row[] = [];
// Each family's record when it raised a finding alone, from every labelled run (in-sample) and from the other runs only (leave-one-run-out).
const solo = new Map<string, Map<string, { n: number; useful: number }>>(); // run -> family -> stats

for (const [runDir, wbPath, labelFile] of runs) {
  const report = JSON.parse(await readFile(path.join(root, 'data', runDir, 'report.json'), 'utf8')) as { findings: F[]; dimensions: import('@ddd/shared').DimensionResult[] };
  const labels = new Map((JSON.parse(await readFile(path.join(root, 'data', labelFile), 'utf8')) as { labels: Array<{ id: string; verdict: string }> }).labels.map((l) => [l.id, l.verdict]));
  const wb = await WorkbookModel.load(path.join(root, 'data/inputs', wbPath));
  const famOf = new Map((JSON.parse(await readFile(path.join(root, 'data', runDir, 'report.json'), 'utf8')) as { header: { raters: Array<{ id: string; family: string }> } }).header.raters.map((r) => [r.id, r.family]));
  const mine = new Map<string, { n: number; useful: number }>();
  for (const f of report.findings) {
    const l = labels.get(f.id);
    if (f.source !== 'raters' || f.reportedBy.length !== 1 || !l || !['real', 'partly', 'wrong', 'vague', 'duplicate'].includes(l)) continue;
    const e = mine.get(famOf.get(f.reportedBy[0]!) ?? '?') ?? { n: 0, useful: 0 };
    e.n++; if (l === 'real' || l === 'partly') e.useful++;
    mine.set(famOf.get(f.reportedBy[0]!) ?? '?', e);
  }
  solo.set(runDir, mine);
  const byKey = new Map(report.findings.map((f) => [`${f.dimensionId}|${f.title}`, f.id]));
  const res = checkFindings(report.findings.filter((f) => f.source === 'raters'), wb, { schemaDesign });
  const claims = checkClaims(res.findings, wb);
  for (const f of [...claims.findings, ...report.findings.filter((x) => x.source === 'code')]) {
    const id = byKey.get(`${f.dimensionId}|${f.title}`) ?? (f as F).id;
    rows.push({ run: runDir, id, family: f.reportedBy.length === 1 ? famOf.get(f.reportedBy[0]!) ?? '?' : '', label: consensus.get(`${runDir}|${id}`) ?? labels.get(id) ?? 'unlabelled', f: f as F, contradicted: aboutAFullMarkQuestion(f as F, report.dimensions) });
  }
}
const trustRate = Number(process.argv.find((a) => a.startsWith('--trust='))?.slice(8) ?? 0.5);
const soloStats = (family: string, exceptRun?: string) => {
  let n = 0, useful = 0;
  for (const [run, m] of solo) if (run !== exceptRun) { n += m.get(family)?.n ?? 0; useful += m.get(family)?.useful ?? 0; }
  return { n, useful };
};
const trusted = (r: Row, loro: boolean) => { if (r.family === '') return false; const s = soloStats(r.family, loro ? r.run : undefined); return s.n >= 20 && s.useful / s.n >= trustRate; };
const labelled = rows.filter((r) => ['real', 'partly', 'wrong', 'vague', 'duplicate'].includes(r.label));
const useful = (r: Row) => r.label === 'real' || r.label === 'partly';
const pct = (a: number, b: number) => (b === 0 ? '  n/a' : `${((100 * a) / b).toFixed(1)}%`.padStart(5));
const stat = (rs: Row[]) => `n=${String(rs.length).padStart(3)} useful ${pct(rs.filter(useful).length, rs.length)} wrong ${pct(rs.filter((r) => r.label === 'wrong').length, rs.length)} vague ${pct(rs.filter((r) => r.label === 'vague').length, rs.length)}`;

console.log(`labels: ${useConsensus ? 'ours, consensus where the 40 sheet rows apply' : 'ours'}; kept and labelled: ${labelled.length}`);
console.log('ALL KEPT        ', stat(labelled));
const rules: Array<[string, TierRule]> = [
  ['2+ or proof/code', { minExaminers: 2, stayConfirmed: [] }],
  ['+ single HIGH', { minExaminers: 2, stayConfirmed: ['HIGH'] }],
  ['+ single HIGH,MEDIUM', { minExaminers: 2, stayConfirmed: ['HIGH', 'MEDIUM'] }],
];
const sev = (s: string[]) => s as Severity[];
void sev;
for (const loro of [false, true]) for (const withTrust of [false, true]) for (const [name0, rule] of rules) {
  if (!withTrust && loro) continue;
  const name = `${name0}${withTrust ? ` + trusted lone examiner${loro ? ' (leave-one-run-out)' : ' (in-sample)'}` : ''}`;
  const tier = (r: Row) => tierOf(r.f, rule, withTrust && trusted(r, loro), process.argv.includes('--full-mark') && r.contradicted).tier;
  const conf = labelled.filter((r) => tier(r) === 'confirmed');
  const look = labelled.filter((r) => tier(r) !== 'confirmed');
  const real = labelled.filter((r) => r.label === 'real');
  const ru = labelled.filter(useful);
  console.log(`\n${name}`);
  console.log('  Confirmed   ', stat(conf));
  console.log('  Worth a look', stat(look));
  console.log(`  real kept in Confirmed ${conf.filter((r) => r.label === 'real').length}/${real.length}; real+partly ${conf.filter(useful).length}/${ru.length} (${pct(conf.filter(useful).length, ru.length)}); real+partly in Worth a look ${look.filter(useful).length} (real ${look.filter((r) => r.label === 'real').length})`);
  console.log(`  share of all findings in Confirmed ${pct(conf.length, labelled.length)}`);
  const bySev = (s: string) => look.filter((r) => r.f.severity === s);
  console.log('  Worth a look by severity:', ['HIGH', 'MEDIUM', 'LOW'].map((s) => `${s} ${stat(bySev(s))}`).join(' | '));
}
const proofs = labelled.filter((r) => r.f.proof);
console.log('\nwith code proof:', stat(proofs));
const examiners = (r: Row) => new Set(r.f.reportedBy.filter((x) => x !== 'code')).size;
for (const n of [0, 1, 2, 3]) console.log(`examiners ${n}:`, stat(labelled.filter((r) => examiners(r) === n)));
for (const sv of ['HIGH', 'MEDIUM', 'LOW']) console.log(`single-examiner ${sv}:`, stat(labelled.filter((r) => examiners(r) === 1 && !r.f.proof && r.f.severity === sv)));
if (process.argv.includes('--singles')) {
  const fam = new Map<string, Map<string, string>>();
  for (const [runDir] of runs) {
    const rep = JSON.parse(await readFile(path.join(root, 'data', runDir, 'report.json'), 'utf8')) as { header: { raters: Array<{ id: string; family: string }> } };
    fam.set(runDir, new Map(rep.header.raters.map((r) => [r.id, r.family])));
  }
  for (const r of labelled.filter((x) => examiners(x) === 1 && !x.f.proof)) {
    console.log(r.run.padEnd(16), r.id, r.label.padEnd(8), r.f.severity.padEnd(6), fam.get(r.run)?.get(r.f.reportedBy[0]!) ?? '?', r.f.location ? 'loc' : 'noloc', '|', r.f.title.slice(0, 70));
  }
}
