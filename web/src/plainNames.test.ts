import { describe, expect, it } from 'vitest';
import type { DimensionResult, Report } from '@ddd/shared';
import { statusOf } from './copy';
import { plainName, simplifyReport } from './plainNames';

describe('plain names', () => {
  it('drops the gate tag and says what a counted part is', () => {
    expect(plainName('Field-definition quality · GATE')).toBe('Field-definition quality');
    expect(plainName('Purpose, scope and clarity (counted)')).toBe('Purpose, scope and clarity (numbers to check)');
    expect(plainName('Tree depth')).toBe('Tree depth');
  });

  it('rewrites sentences so they name the question and not its code', () => {
    const dim = (id: string, name: string) => ({ id, name });
    const report = {
      dimensions: [dim('G09', 'Privacy and regulatory compliance'), dim('G01-counted', 'Purpose (counted)'), dim('H01', 'Author understanding')],
      agreement: [],
      notMeasurable: [],
      verdict: {
        reasons: ['Must-pass check G09 (Privacy and regulatory compliance) scored 3, below 4.', 'The file holds nothing to measure these, so they are left out of the score: G01-counted (Purpose (counted)), H01 (Author understanding).'],
        criticalGates: [],
      },
      pathToGreen: { steps: [], note: 'Done.' },
    } as unknown as Report;
    const out = simplifyReport(report);
    expect(out.verdict.reasons[0]).toBe('Must-pass check Privacy and regulatory compliance scored 3, below 4.');
    expect(out.verdict.reasons[1]).toBe('The file holds nothing to measure these, so they are left out of the score: Purpose (numbers to check), Author understanding.');
    expect(out.dimensions[1]!.name).toBe('Purpose (numbers to check)');
    expect(out.dimensions[1]!.id).toBe('G01-counted');
  });
});

describe('how a judged score is described', () => {
  const base = { id: 'D', name: 'n', weight: 1, critical: false, measuredBy: 'raters', status: 'scored', raterScores: {}, consolidated: 4, spread: 0, resolution: 'agreement', flagged: false, rationale: '', evidence: [] } as unknown as DimensionResult;
  it('says when the scores differ, and when they agree', () => {
    expect(statusOf({ ...base, confidence: 'steady' }).label).toBe('Examiners agreed');
    expect(statusOf({ ...base, confidence: 'shaky' }).label).toBe('Scores differ');
    expect(statusOf({ ...base, confidence: 'single', flagged: true, resolution: 'single_rater' }).label).toBe('Uncertain');
  });

  it('never tells the reader a person has to act', () => {
    const statuses = (['scored', 'unscored', 'not_measurable'] as const).flatMap((status) =>
      [true, false].map((flagged) => statusOf({ ...base, status, flagged, resolution: flagged ? 'lower_stands' : 'agreement' })),
    );
    for (const s of statuses) expect(`${s.label} ${s.help}`).not.toMatch(/a person|your input|take a look/i);
    expect(statusOf({ ...base, status: 'not_measurable' }).label).toBe('Not in the file');
  });
});
