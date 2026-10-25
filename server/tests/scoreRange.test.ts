import { describe, expect, it } from 'vitest';
import { CLOSE_TO_LINE, SCORE_NOISE, type CloseLook } from '@ddd/shared';
import { buildVerdictSection, closeToLineReasons, nearestLine, scoreRangeOf } from '../src/agent/verdict.js';
import { build } from './factories.js';

describe('the range to read a score near a colour line as', () => {
  it('is close to a line within 5 points of 75 or of 60, and not beyond', () => {
    expect(CLOSE_TO_LINE).toBe(5);
    expect(nearestLine(78)).toBe(75);
    expect(nearestLine(63)).toBe(60);
    expect(nearestLine(69)).toBe(75);
    expect(scoreRangeOf(80)).toMatchObject({ line: 75 });
    expect(scoreRangeOf(70)).toMatchObject({ line: 75 });
    expect(scoreRangeOf(80.1)).toBeUndefined();
    expect(scoreRangeOf(55)).toMatchObject({ line: 60 });
    expect(scoreRangeOf(54.9)).toBeUndefined();
    expect(scoreRangeOf(90)).toBeUndefined();
  });

  it('is the score plus and minus the run-to-run noise, widened to the second look when that is wider', () => {
    const plain = scoreRangeOf(76)!;
    expect(plain.low).toBe(Math.round((76 - SCORE_NOISE) * 10) / 10);
    expect(plain.high).toBe(Math.round((76 + SCORE_NOISE) * 10) / 10);
    const look: CloseLook = { line: 75, first: 76, final: 76, low: 71.5, high: 77, questions: ['Q1'], calls: 7, stillDisputed: ['Q1'] };
    expect(scoreRangeOf(76, look)).toMatchObject({ low: 71.5, high: 78.2 });
    const narrow: CloseLook = { ...look, low: 75.5, high: 76.5 };
    expect(scoreRangeOf(76, narrow)).toMatchObject({ low: plain.low, high: plain.high });
  });

  it('is the two scores for a check that was run twice', () => {
    expect(scoreRangeOf(61, undefined, { scores: [58, 64], decisions: ['red', 'amber'], average: 61, gap: 6, unstable: false })).toMatchObject({ low: 58, high: 64 });
  });

  it('never leaves 0 to 100', () => {
    expect(scoreRangeOf(99.9)).toBeUndefined();
    expect(scoreRangeOf(1)).toBeUndefined();
  });

  it('is in the verdict, in plain words, even when no second look was made, and never changes the colour', () => {
    const { scorecard, dimensions } = build([{ id: 'A', weight: 100, score: 3.8 }]); // 76
    const v = buildVerdictSection(scorecard, dimensions, null);
    expect(v.decision).toBe('green');
    expect(v.scoreRange).toMatchObject({ line: 75, low: 73.8, high: 78.2 });
    expect(v.reasons[1]).toBe(closeToLineReasons(76, v.scoreRange!)[0]);
    expect(v.reasons[1]).toMatch(/Close to the line: the score is 76.0 and green starts at 75, so another run could land on the other side\. Read this result as about 73\.8 to 78\.2, not as one exact number/);
    expect(v.reasons[1]).toMatch(/The colour comes from the score alone\./);
  });

  it('is absent from a verdict far from a line', () => {
    const { scorecard, dimensions } = build([{ id: 'A', weight: 100, score: 5 }]);
    const v = buildVerdictSection(scorecard, dimensions, null);
    expect(v.scoreRange).toBeUndefined();
    expect(v.reasons.join(' ')).not.toMatch(/Close to the line/);
  });

  it('uses the second look\'s own words when it ran, with the widened span', () => {
    const { scorecard, dimensions } = build([{ id: 'A', weight: 100, score: 3.8 }]);
    const look: CloseLook = { line: 75, first: 76, final: 76, low: 71, high: 77, questions: ['A'], calls: 7, stillDisputed: ['A'] };
    const v = buildVerdictSection(scorecard, dimensions, null, [], undefined, look);
    expect(v.scoreRange).toMatchObject({ low: 71, high: 78.2 });
    expect(v.reasons[1]).toMatch(/We looked again/);
    expect(v.reasons[1]).toMatch(/Read this result as about 71\.0 to 78\.2/);
  });
});
