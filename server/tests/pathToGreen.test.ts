import { describe, expect, it } from 'vitest';
import type { Finding } from '@ddd/shared';
import { buildPathToGreen } from '../src/agent/pathToGreen.js';
import { build } from './factories.js';

const finding = (id: string, dimensionId: string): Finding => ({
  id, severity: 'HIGH', dimensionId, location: null, title: 't', detail: '', fix: 'f', returnTo: 'Define', source: 'code', reportedBy: ['code'],
});

describe('path to green', () => {
  it('names the high-risk findings that must be fixed even when the score and gates are already enough', () => {
    const { scorecard, dimensions } = build([{ id: 'A', weight: 100, score: 5 }]);
    const path = buildPathToGreen(scorecard, dimensions, [finding('F-01', 'A')]);
    expect(path.steps).toEqual([]);
    expect(path.blockingFindingIds).toEqual(['F-01']);
    expect(path.resultingDecision).toBe('green');
    expect(path.note).toMatch(/score and gates are already enough.*high-risk finding must also be fixed/);
  });

  it('keeps blocking findings empty when there are none', () => {
    const { scorecard, dimensions } = build([{ id: 'A', weight: 100, score: 5 }]);
    expect(buildPathToGreen(scorecard, dimensions, []).blockingFindingIds).toEqual([]);
  });

  it('is empty when already green', () => {
    const { scorecard, dimensions } = build([{ id: 'A', weight: 100, score: 5 }]);
    const path = buildPathToGreen(scorecard, dimensions, []);
    expect(path.steps).toEqual([]);
    expect(path.resultingDecision).toBe('green');
  });

  it('lifts a failing critical gate first, then the biggest weighted gain', () => {
    const { scorecard, dimensions } = build([
      { id: 'CRIT', weight: 10, score: 2, critical: true },
      { id: 'BIG', weight: 50, score: 2 },
      { id: 'SMALL', weight: 40, score: 5 },
    ]);
    const path = buildPathToGreen(scorecard, dimensions, [finding('F-01', 'CRIT'), finding('F-02', 'BIG')]);
    expect(path.steps[0]).toMatchObject({ dimensionId: 'CRIT', reason: 'critical gate', from: 2 });
    expect(path.steps.map((s) => s.dimensionId)).toContain('BIG');
    expect(path.steps[0]!.findingIds).toEqual(['F-01']);
    expect(path.resultingDecision).toBe('green');
    expect(path.resultingScore).toBeGreaterThanOrEqual(75);
  });

  it('stops as soon as the target is reached (the smallest set)', () => {
    const { scorecard, dimensions } = build([
      { id: 'A', weight: 50, score: 3 },
      { id: 'B', weight: 30, score: 3 },
      { id: 'C', weight: 20, score: 3 },
    ]);
    const path = buildPathToGreen(scorecard, dimensions, []);
    expect(path.steps).toHaveLength(1);
    expect(path.steps[0]).toMatchObject({ dimensionId: 'A', from: 3, to: 5 });
  });

  it('never waits for a person: a question the file cannot show is left out, and the path reaches green on its own', () => {
    const { scorecard, dimensions } = build([
      { id: 'A', weight: 100, score: 5 },
      { id: 'H', weight: 10, score: null, critical: true, measuredBy: 'human' },
    ]);
    const path = buildPathToGreen(scorecard, dimensions, []);
    expect(path.steps).toEqual([]);
    expect(path.resultingDecision).toBe('green');
    expect(path).not.toHaveProperty('needsPerson');
    expect(path.note).not.toMatch(/person/i);
  });

  it('lifts a question counted as 0 (unmeasured: zero) like any other low score', () => {
    const { scorecard, dimensions } = build([
      { id: 'A', weight: 60, score: 5 },
      { id: 'U', weight: 40, score: null, measuredBy: 'raters', status: 'not_measurable' },
    ]);
    scorecard.unmeasured = 'zero';
    const path = buildPathToGreen(scorecard, dimensions, []);
    expect(path.steps).toEqual([expect.objectContaining({ dimensionId: 'U', from: 0, to: 5 })]);
    expect(path.resultingDecision).toBe('green');
  });
});
