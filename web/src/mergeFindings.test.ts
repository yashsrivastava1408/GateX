import { describe, expect, it } from 'vitest';
import type { Finding } from '@ddd/shared';
import { mergeFindings } from './mergeFindings';

const f = (id: string, title: string, fix: string, over: Partial<Finding> = {}): Finding => ({
  id,
  severity: 'HIGH',
  dimensionId: 'D8',
  location: { sheet: 'Page 36', cell: 'A5' },
  title,
  detail: '',
  fix,
  returnTo: 'Define',
  source: 'raters',
  reportedBy: ['C'],
  ...over,
});

describe('mergeFindings', () => {
  it('folds the same problem worded differently into one', () => {
    const groups = mergeFindings([
      f('1', 'Missing filled pilot card', 'Add a filled pilot card traced to WF-, KPI- and UAT IDs.', { reportedBy: ['A'] }),
      f('2', 'No filled pilot card with WF-, KPI- and UAT IDs', 'Create a filled pilot card that is traced to WF-, KPI- and UAT IDs.', { reportedBy: ['B'] }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.also).toHaveLength(1);
    expect(groups[0]!.reportedBy).toEqual(['A', 'B']);
  });

  it('keeps different problems, criteria and pages apart', () => {
    const groups = mergeFindings([
      f('1', 'Missing filled pilot card', 'Add a filled pilot card.'),
      f('2', 'Critical data tiering not implemented', 'Add tier values to the tiering column.'),
      f('3', 'Missing filled pilot card', 'Add a filled pilot card.', { dimensionId: 'D2' }),
      f('4', 'Missing filled pilot card', 'Add a filled pilot card.', { location: { sheet: 'Page 40', cell: 'A1' } }),
    ]);
    expect(groups).toHaveLength(4);
  });

  it('shows the most serious wording first', () => {
    const groups = mergeFindings([f('1', 'Missing filled pilot card', 'Add a filled pilot card.', { severity: 'MEDIUM' }), f('2', 'Missing filled pilot card', 'Add a filled pilot card.')]);
    expect(groups[0]!.main.id).toBe('2');
  });
});
