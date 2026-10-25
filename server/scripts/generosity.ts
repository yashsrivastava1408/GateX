import { GENEROSITY_PAIRS, measurePair, pairAvailable } from '../src/planted/generosity.js';

/**
 * No model, no cost. Scores each clean file and its planted copy with perfectly generous examiners (a clean 5 everywhere, citing real cells), so only the
 * checks done in code can lower the score. The gap is what the evaluator catches by itself. Usage: npm run generosity
 */
let failed = false;
console.log('pair | mistakes planted | clean score | planted score | gap | code issues found (planted / clean) | guard (min gap)');
for (const pair of GENEROSITY_PAIRS) {
  if (!pairAvailable(pair)) {
    console.log(`${pair.id} | skipped: a file is missing under data/`);
    continue;
  }
  const r = await measurePair(pair);
  if (!r) {
    console.log(`${pair.id} | skipped: the scorecard conversion is not cached`);
    continue;
  }
  if (r.gap < pair.minGap || r.clean !== 100 || r.codeFindingsClean > 0) failed = true;
  console.log(`${pair.id} | ${pair.mistakes} | ${r.clean} (${r.cleanDecision}) | ${r.planted} (${r.plantedDecision}) | ${r.gap} | ${r.codeFindingsPlanted} / ${r.codeFindingsClean} | ${r.gap >= pair.minGap && r.clean === 100 && r.codeFindingsClean === 0 ? 'ok' : 'FAILED'} (${pair.minGap})`);
}
process.exit(failed ? 1 : 0);
