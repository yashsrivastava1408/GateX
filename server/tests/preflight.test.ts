import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { preflight, MIN_RATERS } from '../src/agent/index.js';
import { WorkbookModel } from '../src/excel/workbook.js';
import { parseScorecard } from '../src/scorecard/parse.js';
import { CLEAN_SCORECARD_YAML, CLEAN_TREE, TALENTRA_XLSX, loadTalentraScorecard, makeWorkbook } from './helpers.js';

const raters = (limits: Array<number | undefined>) => limits.map((maxInputTokens, i) => ({ id: 'ABC'[i]!, model: `model-${i}`, maxInputTokens }));

describe('the check before an evaluation is submitted', () => {
  it('rejects the Talentra schema scorecard when two of the three raters have the free-tier limits Groq reported', async () => {
    const wb = await WorkbookModel.load(TALENTRA_XLSX);
    const { scorecard } = await loadTalentraScorecard();
    const result = preflight({ scorecard, wb, sources: '', raters: raters([8000, undefined, 7000]) });
    expect(result.tokens).toBeGreaterThan(18_336);
    expect(result.ok).toBe(false);
    expect(result.fits.map((r) => r.fits)).toEqual([false, true, false]);
    expect(result.problem).toMatch(/only 1 of 3 raters can take that: A \(model-0, limit 8,000\), C \(model-2, limit 7,000\) cannot/);
    expect(result.problem).toMatch(/At least 2 are needed/);
    expect(result.problem).toMatch(/"columns"/);
  });

  it('accepts it when at least two raters can take the prompt, or have no known limit', async () => {
    const wb = await WorkbookModel.load(TALENTRA_XLSX);
    const { scorecard } = await loadTalentraScorecard();
    expect(preflight({ scorecard, wb, sources: '', raters: raters([8000, undefined, undefined]) }).ok).toBe(true);
    expect(preflight({ scorecard, wb, sources: '', raters: raters([undefined, undefined, undefined]) }).ok).toBe(true);
    expect(MIN_RATERS).toBe(2);
  });

  it('accepts the small Step 04 output scorecard on the same limits (this is the one to try on a free tier)', async () => {
    const wb = await WorkbookModel.load(TALENTRA_XLSX);
    const { scorecard } = parseScorecard(await readFile(new URL('../../samples/talentra/talentra-step04-d4.yaml', import.meta.url), 'utf8'));
    const result = preflight({ scorecard, wb, sources: '', raters: raters([8000, undefined, 7000]) });
    expect(result.tokens).toBeLessThan(8000);
    expect(result.ok).toBe(true);
  });

  it('passes a scorecard with no rater dimensions, because nothing is sent to a model', async () => {
    const yaml = CLEAN_SCORECARD_YAML.replace(/    - id: J01[\s\S]*$/, '');
    const wb = await WorkbookModel.load(await makeWorkbook({ Tree: CLEAN_TREE }));
    const result = preflight({ scorecard: parseScorecard(yaml).scorecard, wb, sources: '', raters: raters([100, 100, 100]) });
    expect(result).toMatchObject({ ok: true, tokens: 0 });
  });

  it('counts the instructions and the source documents, because they are sent too', async () => {
    const wb = await WorkbookModel.load(await makeWorkbook({ Tree: CLEAN_TREE }));
    const { scorecard } = parseScorecard(CLEAN_SCORECARD_YAML);
    const plain = preflight({ scorecard, wb, sources: '', raters: raters([undefined]) }).tokens;
    const heavier = preflight({ scorecard, wb, sources: 'x'.repeat(2700), instructions: 'y'.repeat(2700), raters: raters([undefined]) }).tokens;
    expect(heavier - plain).toBeGreaterThanOrEqual(1900);
  });
});
