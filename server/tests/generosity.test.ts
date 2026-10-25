import { describe, expect, it } from 'vitest';
import { GENEROSITY_PAIRS, measurePair, pairAvailable } from '../src/planted/generosity.js';

/**
 * The standing guard against a false green. With every examiner perfectly generous (a clean 5 for every question, citing real cells), only the checks
 * done in code can pull a score down, so a file with planted mistakes must come out well below its clean original, and the clean original must come out
 * untouched. A change that makes the evaluator more generous (weaker caps, a sweep that finds less, a ceiling that stops firing) fails this test,
 * and `npm run release:check` runs it. No model is called.
 */
describe('perfect examiners cannot hide planted mistakes', () => {
  for (const pair of GENEROSITY_PAIRS) {
    it.skipIf(!pairAvailable(pair))(`${pair.id}: the planted copy scores at least ${pair.minGap} points below the clean file, and the clean file loses nothing`, async () => {
      const r = await measurePair(pair);
      if (!r) return; // the scorecard conversion is not cached on this machine
      expect(r.clean).toBe(100);
      expect(r.codeFindingsClean).toBe(0);
      expect(r.gap).toBeGreaterThanOrEqual(pair.minGap);
      expect(r.codeFindingsPlanted).toBeGreaterThan(0);
    }, 60_000);
  }
});
