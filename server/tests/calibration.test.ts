import { describe, expect, it } from 'vitest';
import { toCsv } from '../src/library/spotCheck.js';
import { parseScore, scoreForm, type CalibrationKey } from '../scripts/calibrationLib.js';

const key: CalibrationKey = {
  criteria: [
    { id: 'A-C01', pair: 'A', criterionId: 'X1', name: 'one', toolScore: 4 },
    { id: 'A-C02', pair: 'A', criterionId: 'X2', name: 'two', toolScore: 5 },
    { id: 'B-C01', pair: 'B', criterionId: 'Y1', name: 'three', toolScore: 2 },
    { id: 'B-C02', pair: 'B', criterionId: 'Y2', name: 'four', toolScore: 3 },
  ],
  findings: [
    { id: 'A-F01', pair: 'A', ourLabel: 'wrong', shownByTool: true },
    { id: 'A-F02', pair: 'A', ourLabel: 'real', shownByTool: true },
    { id: 'B-F01', pair: 'B', ourLabel: 'vague', shownByTool: true },
    { id: 'B-F02', pair: 'B', ourLabel: null, shownByTool: false },
  ],
};
const HEAD = ['id', 'part', 'score', 'real', 'partly', 'wrong', 'vague', 'cell evidence', 'notes'];
const form = (rows: string[][]) => toCsv([HEAD, ...rows]);

describe('parseScore', () => {
  it('accepts 0 to 5 and nothing else', () => {
    expect(parseScore(' 3 ')).toBe(3);
    expect(parseScore('4.0')).toBe(4);
    expect(parseScore('0')).toBe(0);
    for (const bad of ['', 'NM', '6', '-1', 'three', '3/5']) expect(parseScore(bad)).toBeNull();
  });
});

describe('scoring a filled calibration form', () => {
  it('reports mean absolute difference, share within 1, exact share and bias (tool minus person)', () => {
    const r = scoreForm(
      form([
        ['A-C01', 'CRITERION', '4', '', '', '', '', 'Page 1', ''], // 0
        ['A-C02', 'CRITERION', '2', '', '', '', '', 'Page 2', ''], // tool 5 vs 2: +3
        ['B-C01', 'CRITERION', '3', '', '', '', '', '', ''], // tool 2 vs 3: -1, no evidence
        ['B-C02', 'CRITERION', '3', '', '', '', '', 'Page 3', ''], // 0
      ]),
      key,
    );
    expect(r.criteriaScored).toBe(4);
    expect(r.scores!.meanAbsDiff).toBeCloseTo((0 + 3 + 1 + 0) / 4);
    expect(r.scores!.within1).toBeCloseTo(3 / 4);
    expect(r.scores!.exact).toBeCloseTo(2 / 4);
    expect(r.scores!.bias).toBeCloseTo((0 + 3 - 1 + 0) / 4);
    expect([r.scores!.toolHigher, r.scores!.toolLower]).toEqual([1, 1]);
    expect(r.scoresByPair.A!.meanAbsDiff).toBeCloseTo(1.5);
    expect(r.scoresByPair.B!.bias).toBeCloseTo(-0.5);
    expect(r.noEvidence).toBe(1);
    expect(r.bigMisses).toEqual([{ id: 'A-C02', pair: 'A', criterion: 'two', tool: 5, human: 2 }]);
  });

  it('shows a tool that scores lower than the person as a negative bias', () => {
    const r = scoreForm(form([['A-C01', 'CRITERION', '5', '', '', '', '', 'x', ''], ['B-C01', 'CRITERION', '4', '', '', '', '', 'x', '']]), key);
    expect(r.scores!.bias).toBeCloseTo(-1.5);
  });

  it('compares finding labels with ours and keeps findings we never labelled apart', () => {
    const r = scoreForm(
      form([
        ['A-F01', 'FINDING', '', '', '', 'x', '', '', ''], // wrong = wrong
        ['A-F02', 'FINDING', '', '', 'x', '', '', '', ''], // real vs partly: different label, both useful
        ['B-F01', 'FINDING', '', '', '', 'x', '', '', 'it is there'], // vague vs wrong: disagrees on useful? no, both not useful
        ['B-F02', 'FINDING', '', 'x', '', '', '', '', ''], // never labelled by us
      ]),
      key,
    );
    expect(r.labels.n).toBe(3);
    expect(r.labels.exact).toBe(1);
    expect(r.labels.usefulAgree).toBe(3);
    expect(r.labels.matrix.real!.partly).toBe(1);
    expect(r.labelDisagreements.map((d) => d.id)).toEqual(['A-F02', 'B-F01']);
    expect(r.unlabelled).toEqual({ n: 1, useful: 1, wrong: 0 });
  });

  it('leaves out blank, bad, doubled and unknown rows and says why', () => {
    const r = scoreForm(
      form([
        ['A-C01', 'CRITERION', '', '', '', '', '', '', ''],
        ['A-C02', 'CRITERION', 'NM', '', '', '', '', '', ''],
        ['B-C01', 'CRITERION', '2', '', '', '', '', 'x', ''],
        ['B-C01', 'CRITERION', '3', '', '', '', '', 'x', ''],
        ['A-F01', 'FINDING', '', 'x', 'x', '', '', '', ''],
        ['ZZZ', 'CRITERION', '3', '', '', '', '', '', ''],
      ]),
      key,
    );
    const why = Object.fromEntries(r.skipped.map((s) => [s.id, s.why]));
    expect(why['A-C01']).toBe('no score given');
    expect(why['A-C02']).toContain('not a number from 0 to 5');
    expect(why['B-C01']).toBe('row appears twice');
    expect(why['A-F01']).toContain('more than one column');
    expect(why['ZZZ']).toBe('not in the answer key');
    expect(why['B-C02']).toBe('row missing from the form');
    expect(r.criteriaScored).toBe(1);
  });

  it('refuses a form whose headings were changed', () => {
    expect(() => scoreForm(toCsv([['id', 'points'], ['A-C01', '3']]), key)).toThrow(/needs the columns/);
  });
});
