import { describe, expect, it } from 'vitest';
import { SCORE_BANDS, bandOf, type Finding } from '@ddd/shared';
import { buildVerdictSection } from '../src/agent/verdict.js';
import { build } from './factories.js';

const decide = (inputs: Parameters<typeof build>[0]) => {
  const { scorecard, dimensions } = build(inputs);
  return buildVerdictSection(scorecard, dimensions, null);
};

describe('the colour of a score: below 60 red, 60 to 74 amber, 75 and above green', () => {
  it('has one fixed rule for the whole app', () => {
    expect(SCORE_BANDS).toEqual({ accept: 75, refine: 60 });
    expect([0, 59.9, 60, 74.9, 75, 99, 100].map(bandOf)).toEqual(['red', 'red', 'amber', 'amber', 'green', 'green', 'green']);
  });

  it('is red below 60, amber from 60 up to 75, and green from 75, by the score alone', () => {
    expect(decide([{ id: 'A', weight: 59, score: 5 }, { id: 'B', weight: 41, score: 0 }]).decision).toBe('red');
    expect(decide([{ id: 'A', weight: 60, score: 5 }, { id: 'B', weight: 40, score: 0 }]).decision).toBe('amber');
    expect(decide([{ id: 'A', weight: 74, score: 5 }, { id: 'B', weight: 26, score: 0 }]).decision).toBe('amber');
    expect(decide([{ id: 'A', weight: 75, score: 5 }, { id: 'B', weight: 25, score: 0 }]).decision).toBe('green');
    expect(decide([{ id: 'A', weight: 100, score: 5 }]).decision).toBe('green');
  });

  it('shows the score rounded down, so 74.96 never reads as 75', () => {
    const v = decide([{ id: 'A', weight: 7496, score: 5 }, { id: 'B', weight: 2504, score: 0 }]);
    expect(v.weightedScore).toBe(74.9);
    expect(v.decision).toBe('amber');
  });

  it('reports the same fixed bands whatever the scorecard says', () => {
    const { scorecard, dimensions } = build([{ id: 'A', weight: 100, score: 4 }], { accept: 90, refine: 75 });
    const v = buildVerdictSection(scorecard, dimensions, null);
    expect(v.weightedScore).toBe(80);
    expect(v.thresholds).toEqual({ accept: 75, refine: 60 });
    expect(v.decision).toBe('green');
    expect(v.reasons[0]).toBe('Score 80 is in the green band (75 and above).');
  });

  it('says which band the score is in, and where the next one starts', () => {
    expect(decide([{ id: 'A', weight: 100, score: 3 }]).reasons[0]).toBe('Score 60 is in the amber band (60 to 74). Green starts at 75.');
    expect(decide([{ id: 'A', weight: 100, score: 2 }]).reasons[0]).toBe('Score 40 is in the red band (below 60). Amber starts at 60.');
  });

  it('counts an unscored dimension as 0, which can pull the colour down', () => {
    const v = decide([{ id: 'A', weight: 50, score: null, critical: true }, { id: 'B', weight: 50, score: 5 }]);
    expect(v.weightedScore).toBe(50);
    expect(v.decision).toBe('red');
    expect(v.criticalGates[0]!.status).toBe('failed');
  });

  it('records an override with its reason and keeps the agent verdict visible', () => {
    const { scorecard, dimensions } = build([{ id: 'A', weight: 100, score: 2 }]);
    const v = buildVerdictSection(scorecard, dimensions, {
      id: 'o', runId: 'r', decision: 'amber', reason: 'Lead accepts the risk', by: 'Lead', createdAt: '2026-10-22T10:00:00Z',
    });
    expect(v.agentDecision).toBe('red');
    expect(v.decision).toBe('amber');
    expect(v.reasons.join(' ')).toMatch(/overrode the verdict to AMBER: Lead accepts the risk/);
  });
});

describe('things that need attention, which do not change the colour', () => {
  const finding = (id: string, severity: Finding['severity']): Finding => ({
    id, severity, dimensionId: 'A', location: null, title: 'x', detail: '', fix: 'f', returnTo: 'Define', source: 'raters', reportedBy: ['A'],
  });

  it('keeps the colour green when a critical question is below 4, and says so as a note', () => {
    const v = decide([{ id: 'A', weight: 10, score: 3, critical: true }, { id: 'B', weight: 90, score: 5 }]);
    expect(v.weightedScore).toBeGreaterThan(90);
    expect(v.decision).toBe('green');
    expect(v.criticalGates[0]).toMatchObject({ dimensionId: 'A', status: 'failed' });
    expect(v.reasons.join(' ')).toMatch(/Needs attention: critical question A \(Dim A\) scored 3, below 4/);
  });

  it('does not force red when a critical question is at the scorecard\'s old red line', () => {
    const { scorecard, dimensions } = build([{ id: 'A', weight: 10, score: 2, critical: true }, { id: 'B', weight: 90, score: 5 }]);
    scorecard.redAtOrBelow = 2;
    const v = buildVerdictSection(scorecard, dimensions, null);
    expect(v.decision).toBe('green');
    expect(v.reasons.join(' ')).toMatch(/Needs attention: critical question A/);
  });

  it('keeps a perfect score green with an open HIGH finding, and lists it as needing a fix', () => {
    const { scorecard, dimensions } = build([{ id: 'A', weight: 100, score: 5 }]);
    const v = buildVerdictSection(scorecard, dimensions, null, [finding('F-01', 'HIGH'), finding('F-02', 'MEDIUM')]);
    expect(v.weightedScore).toBe(100);
    expect(v.decision).toBe('green');
    expect(v.blockingFindings).toEqual(['F-01']);
    expect(v.reasons.join(' ')).toMatch(/Needs attention: 1 high-risk finding \(F-01\) should be fixed before sign-off/);
  });

  it('lists every high-risk finding', () => {
    const { scorecard, dimensions } = build([{ id: 'A', weight: 100, score: 4 }]);
    const v = buildVerdictSection(scorecard, dimensions, null, [finding('F-01', 'HIGH'), finding('F-02', 'HIGH')]);
    expect(v.blockingFindings).toEqual(['F-01', 'F-02']);
    expect(v.reasons.join(' ')).toMatch(/2 high-risk findings \(F-01, F-02\)/);
  });

  it('notes a score only one examiner could back, or the examiners could not agree on, without changing the colour', () => {
    const { scorecard, dimensions } = build([{ id: 'A', weight: 50, score: 5, critical: true, measuredBy: 'raters' }, { id: 'B', weight: 50, score: 5, measuredBy: 'raters' }]);
    dimensions[0]!.resolution = 'single_rater';
    const v = buildVerdictSection(scorecard, dimensions, null);
    expect(v.decision).toBe('green');
    expect(v.reasons.join(' ')).toMatch(/only one examiner could back the score, or the examiners could not agree, on A \(Dim A\)\. Run it again/);
    dimensions[0]!.resolution = 'lower_stands';
    expect(buildVerdictSection(scorecard, dimensions, null).reasons.join(' ')).toMatch(/only one examiner/);
    dimensions[0]!.resolution = 'agreement';
    expect(buildVerdictSection(scorecard, dimensions, null).reasons.join(' ')).not.toMatch(/only one examiner/);
  });

  it('notes a score built on a small part of the scorecard', () => {
    const { scorecard, dimensions } = build([
      { id: 'A', weight: 20, score: 5, measuredBy: 'code' },
      { id: 'B', weight: 80, score: null, measuredBy: 'human', status: 'not_measurable' },
    ]);
    const v = buildVerdictSection(scorecard, dimensions, null);
    expect(v.weightedScore).toBe(100);
    expect(v.decision).toBe('green');
    expect(v.reasons.join(' ')).toMatch(/Needs attention: only 20% of the scorecard could be scored/);
  });
});

describe('nothing ever waits for a person', () => {
  const unmeasurable = (critical = false) => ({ id: 'U', weight: 20, score: null, critical, measuredBy: 'raters' as const, status: 'not_measurable' as const });

  it('leaves a question the file cannot show out of the score by default', () => {
    const v = decide([{ id: 'A', weight: 80, score: 5 }, unmeasurable(true)]);
    expect(v.weightedScore).toBe(100);
    expect(v.decision).toBe('green');
    expect(v.skipped).toEqual(['U']);
    expect(v.criticalGates.find((g) => g.dimensionId === 'U')!.status).toBe('skipped');
    expect(v.reasons.join(' ')).toMatch(/The file holds nothing to measure these, so they are left out of the score: U \(Dim U\)/);
  });

  it('counts such a question as 0 when the scorecard says unmeasured: zero', () => {
    const { scorecard, dimensions } = build([{ id: 'A', weight: 80, score: 5 }, unmeasurable(true)]);
    scorecard.unmeasured = 'zero';
    const v = buildVerdictSection(scorecard, dimensions, null);
    expect(v.weightedScore).toBe(80);
    expect(v.decision).toBe('green');
    expect(v.skipped).toEqual([]);
    expect(v.criticalGates.find((g) => g.dimensionId === 'U')).toMatchObject({ score: 0, status: 'failed' });
    expect(v.reasons.join(' ')).toMatch(/so they count as 0: U \(Dim U\)/);
  });

  it('treats a question an older run kept for a person like any unmeasurable one', () => {
    const v = decide([{ id: 'A', weight: 90, score: 5 }, { id: 'H', weight: 10, score: null, critical: true, measuredBy: 'human' }]);
    expect(v.decision).toBe('green');
    expect(v.skipped).toEqual(['H']);
  });

  it('never asks a person for anything, in any verdict', () => {
    const cases = [
      decide([{ id: 'A', weight: 100, score: 5 }]),
      decide([{ id: 'A', weight: 50, score: 2, critical: true }, unmeasurable()]),
      decide([{ id: 'A', weight: 80, score: 4 }, { id: 'H', weight: 20, score: null, measuredBy: 'human' }]),
    ];
    for (const v of cases) expect(v.reasons.join(' ')).not.toMatch(/a person|must supply|human/i);
  });
});
