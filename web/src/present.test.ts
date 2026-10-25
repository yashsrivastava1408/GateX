import { describe, expect, it } from 'vitest';
import type { Report } from '@ddd/shared';
import { hideModels, tidy } from './present';

const report = {
  findings: [{ id: 'F-01', source: 'code', reportedBy: ['code'] }, { id: 'F-02', source: 'code', reportedBy: ['code'] }],
  dimensions: [{ id: 'G09', name: 'Privacy', criteria: [{ id: 'G09-C01', name: 'Consent' }] }],
} as unknown as Report;

describe('plain display text', () => {
  it('hides model names and providers', () => {
    expect(hideModels('bedrock/anthropic.claude-3 failed')).not.toMatch(/bedrock|claude|anthropic/i);
    expect(hideModels('Groq said no')).not.toMatch(/groq/i);
    expect(hideModels('Nothing to hide')).toBe('Nothing to hide');
  });
  it('turns codes into names and issue numbers', () => {
    expect(tidy('See F-02 and G09-C01 under G09.', report)).toBe('See issue 2 and Consent under Privacy.');
    expect(tidy('The rater found it', report)).toBe('The examiner found it');
    expect(tidy('7 high-risk issues should be fixed', report)).toBe('7 must-fix issues should be fixed');
  });
});
