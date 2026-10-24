import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkbookModel } from '../src/excel/workbook.js';
import { checkFindings } from '../src/agent/findingCheck.js';
import { CLAIM_RULES, checkClaims, claimVerdicts, type ClaimRule } from '../src/agent/claimCheck.js';
import type { DraftFinding } from '../src/agent/types.js';

/**
 * Replays the finding filter on EVERY labelled run listed in data/replay-runs.json ([runDir, file under data/inputs, review file under data])
 * and prints one table: what the filter drops by label, whether it ever dropped a real or partly-right finding, and the useful and wrong
 * shares of what is kept. No model is called. The labels are ours (an agent's), not a human's.
 * Usage: npm run replay:all [-- --reasons] [--schema-design]
 */
const root = path.resolve(import.meta.dirname, '../..');
const runs: Array<[string, string, string]> = JSON.parse(await readFile(path.join(root, 'data/replay-runs.json'), 'utf8'));
const reasons = process.argv.includes('--reasons');
// --rules=a,b picks the claim rules (default all); --rules=none shows the filter without them. --blind also scores the kept findings against the blind spot-check labels.
const rulesArg = process.argv.find((a) => a.startsWith('--rules='))?.slice(8);
const claimRules = (rulesArg === undefined ? [...CLAIM_RULES] : rulesArg === 'none' ? [] : rulesArg.split(',')) as ClaimRule[];
const schemaDesign = process.argv.includes('--schema-design'); // also apply the rule the app uses for schema-design scorecards
type F = DraftFinding & { id: string };
const kinds = ['real', 'partly', 'wrong', 'vague', 'duplicate', 'unchecked', 'unlabelled'] as const;
const zero = () => Object.fromEntries(kinds.map((k) => [k, 0])) as Record<(typeof kinds)[number], number>;
const kept = zero();
const dropped = zero();
const reasonCount = new Map<string, Record<string, number>>();
const flagCount = new Map<string, Record<string, number>>();
let badDrops = 0;
console.log('run'.padEnd(20), 'kept', 'real', 'part', 'wrong', 'vague', 'dup', 'unlab', '| dropped (wrong/real+partly)');
for (const [runDir, wbPath, labelFile] of runs) {
  const report = JSON.parse(await readFile(path.join(root, 'data', runDir, 'report.json'), 'utf8')) as { findings: F[] };
  const labels = new Map((JSON.parse(await readFile(path.join(root, 'data', labelFile), 'utf8')) as { labels: Array<{ id: string; verdict: string }> }).labels.map((l) => [l.id, l.verdict]));
  const wb = await WorkbookModel.load(path.join(root, 'data/inputs', wbPath));
  const byKey = new Map(report.findings.map((f) => [`${f.dimensionId}|${f.title}`, f.id]));
  const res = checkFindings(report.findings.filter((f) => f.source === 'raters'), wb, { schemaDesign });
  const claims = checkClaims(res.findings, wb, { rules: claimRules });
  const goneIds = new Map([...res.dropped, ...claims.dropped].map((d) => [byKey.get(`${d.dimensionId}|${d.title}`) ?? '?', d.reason]));
  const keptIds = new Set(claims.findings.map((f) => byKey.get(`${f.dimensionId}|${f.title}`) ?? '?'));
  for (const f of res.findings) for (const v of claimVerdicts(f, wb, claimRules)) if (v.action === 'flag') { const k = `flag:${v.rule}`; flagCount.set(k, { ...(flagCount.get(k) ?? {}), [labels.get(byKey.get(`${f.dimensionId}|${f.title}`) ?? '?') ?? 'unlabelled']: (flagCount.get(k)?.[labels.get(byKey.get(`${f.dimensionId}|${f.title}`) ?? '?') ?? 'unlabelled'] ?? 0) + 1 }); }
  const here = zero();
  let dw = 0;
  let dbad = 0;
  for (const f of report.findings) {
    const v = (labels.get(f.id) ?? 'unlabelled') as (typeof kinds)[number];
    if (goneIds.has(f.id)) {
      dropped[v]++;
      if (v === 'wrong') dw++;
      if (v === 'real' || v === 'partly') { dbad++; badDrops++; console.log('  BAD DROP', runDir, f.id, v, goneIds.get(f.id)); }
      const key = goneIds.get(f.id)!.slice(0, 60);
      const r = reasonCount.get(key) ?? {};
      r[v] = (r[v] ?? 0) + 1;
      reasonCount.set(key, r);
    } else if (keptIds.has(f.id) || f.source === 'code') { kept[v]++; here[v]++; }
  }
  const n = Object.values(here).reduce((a, b) => a + b, 0);
  console.log(runDir.padEnd(20), String(n).padStart(4), ...(['real', 'partly', 'wrong', 'vague', 'duplicate', 'unlabelled'] as const).map((k) => String(here[k]).padStart(4)), `| ${dw}/${dbad}`);
}
const labelled = kept.real + kept.partly + kept.wrong + kept.vague + kept.duplicate;
console.log(`\nKEPT with a label: ${labelled}. useful (real+partly) ${kept.real + kept.partly} = ${((100 * (kept.real + kept.partly)) / labelled).toFixed(1)}%; wrong ${kept.wrong} = ${((100 * kept.wrong) / labelled).toFixed(1)}%; vague ${kept.vague}; duplicate ${kept.duplicate}. Unlabelled/unchecked kept: ${kept.unlabelled + kept.unchecked}`);
console.log(`DROPPED by labels: ${JSON.stringify(dropped)}; real or partly dropped: ${badDrops}`);
for (const [k, v] of flagCount) console.log(`FLAGGED ${k}: ${JSON.stringify(v)}`);
if (reasons) for (const [k, v] of reasonCount) console.log(' ', JSON.stringify(v), k);
process.exit(badDrops === 0 ? 0 : 1);
