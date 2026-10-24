import { describe, expect, it } from 'vitest';
import type { DimensionResult, Scorecard } from '@ddd/shared';
import { medianOutcome } from '../src/agent/repeats.js';
import { decide, effectiveDimensions } from '../src/agent/verdict.js';
import type { RaterDimension, RaterFinding, RaterOutcome } from '../src/agent/types.js';
import { parseScorecard } from '../src/scorecard/parse.js';
import { TALENTRA_XLSX, mockModels, runEvaluation } from './helpers.js';

const dim = (id: string, score: number | null, rationale = `score ${score}`): RaterDimension => ({ id, score, notMeasurable: false, rationale, evidence: [] });
const finding = (ref: string, title: string): RaterFinding => ({ ref, raterId: 'A', dimensionId: 'D1', severity: 'MEDIUM', title, detail: '', fix: '', returnTo: 'Define', location: null });
const run = (dimensions: RaterDimension[], over: Partial<RaterOutcome> = {}): RaterOutcome => ({
  model: { id: 'A', provider: 'mock', model: 'm', family: 'f' }, role: 'rater', status: 'ok', prompt: 'p', promptHash: 'h', rawResponse: 'r',
  attempts: 1, latencyMs: 10, inputTokens: 5, outputTokens: 2, dimensions, findings: [], strengths: [], discarded: [], ...over,
});

describe('keeping the median of repeated runs', () => {
  it('takes the middle score, notes how far the runs differed, and keeps that run\'s reasoning', () => {
    const merged = medianOutcome([run([dim('D1', 2, 'low run')]), run([dim('D1', 5, 'high run')]), run([dim('D1', 4, 'middle run')])]);
    expect(merged.dimensions).toEqual([expect.objectContaining({ id: 'D1', score: 4, rationale: 'middle run', repeatSpread: 3 })]);
  });

  it('takes the lower score of two, so a tie never rounds up', () => {
    const merged = medianOutcome([run([dim('D1', 3)]), run([dim('D1', 5)])]);
    expect(merged.dimensions[0]).toMatchObject({ score: 3, repeatSpread: 2 });
  });

  it('ignores a failed run, returns a single run untouched, and fails only when every run failed', () => {
    const good = run([dim('D1', 4)]);
    const failed = run([], { status: 'failed', error: 'down' });
    expect(medianOutcome([failed, good]).dimensions[0]).toMatchObject({ score: 4 });
    expect(medianOutcome([good])).toBe(good);
    expect(medianOutcome([failed, run([], { status: 'failed', error: 'down' })]).status).toBe('failed');
  });

  it('pools findings without duplicates and gives each a unique reference', () => {
    const merged = medianOutcome([
      run([dim('D1', 4)], { findings: [finding('A1', 'Vague term'), finding('A2', 'Missing unit')] }),
      run([dim('D1', 4)], { findings: [finding('A1', 'vague term'), finding('A2', 'Overlap')] }),
    ]);
    expect(merged.findings.map((f) => [f.ref, f.title])).toEqual([['A1', 'Vague term'], ['A2', 'Missing unit'], ['A3', 'Overlap']]);
  });
});

describe('how far to trust a judged score', () => {
  const confidences = async (raters: [string, string, string]) => {
    const out = await runEvaluation({ workbook: TALENTRA_XLSX, models: mockModels(raters) });
    return new Map(out.core.dimensions.filter((d) => d.measuredBy === 'raters').map((d) => [d.id, d.confidence]));
  };

  it('is steady when the examiners are within a point, shaky when they are further apart, single when only one scored', async () => {
    expect([...(await confidences(['mock-mid', 'mock-lenient', 'mock-strict'])).values()].every((c) => c === 'shaky')).toBe(true);
    expect([...(await confidences(['mock-mid', 'mock-mid', 'mock-lenient'])).values()].every((c) => c === 'steady')).toBe(true);
    expect([...(await confidences(['mock-mid', 'mock-abstain', 'mock-abstain'])).values()].every((c) => c === 'single')).toBe(true);
  });
});

describe('the colour follows the score, not the red line or the examiners\' agreement', () => {
  const card = (): Scorecard =>
    parseScorecard(`
scorecard:
  id: SC-R
  version: "1"
  judges: D1 schema design
  frozen: true
  thresholds: { accept: 90, refine: 75 }
  red_at_or_below: 2
  artifact: { sheets: [Tree] }
  dimensions:
    - { id: A, name: a, weight: 90, measured_by: raters, measure: m, anchors: { 0: a, 1: b, 2: c, 3: d, 4: e, 5: f } }
    - { id: B, name: b, weight: 10, critical: true, measured_by: raters, measure: m, anchors: { 0: a, 1: b, 2: c, 3: d, 4: e, 5: f } }
`).scorecard;
  const results = (resolution: DimensionResult['resolution']) => [
    { id: 'A', name: 'a', weight: 90, critical: false, measuredBy: 'raters', status: 'scored', raterScores: {}, consolidated: 5, spread: 0, resolution: 'agreement', flagged: false, rationale: '', evidence: [] },
    { id: 'B', name: 'b', weight: 10, critical: true, measuredBy: 'raters', status: 'scored', raterScores: {}, consolidated: 2, spread: 0, resolution, flagged: resolution !== 'agreement', rationale: '', evidence: [] },
  ] as DimensionResult[];

  it('does not let a scorecard\'s red line change the colour; a shaky or single-examiner score is only noted', () => {
    const sc = card();
    // The score is 90 + 10 x 2 / 5 = 94, which is green whatever the examiners' agreement.
    expect(decide(sc, effectiveDimensions(sc, results('agreement'))).decision).toBe('green');
    for (const resolution of ['single_rater', 'lower_stands'] as const) {
      const verdict = decide(sc, effectiveDimensions(sc, results(resolution)));
      expect(verdict.decision).toBe('green');
      expect(verdict.reasons.join(' ')).toMatch(/only one examiner could back the score/);
    }
  });
});
