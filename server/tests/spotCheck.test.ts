import { describe, expect, it } from 'vitest';
import { parseCsv, pct, scoreSheet, toCsv } from '../src/library/spotCheck.js';

const key = [
  { id: 'S01', pair: 'docket', ourLabel: 'wrong' },
  { id: 'S02', pair: 'docket', ourLabel: 'real' },
  { id: 'S03', pair: 'step2', ourLabel: 'partly' },
  { id: 'S04', pair: 'step2', ourLabel: 'vague' },
  { id: 'S05', pair: 'step3', ourLabel: 'real' },
];
const HEAD = ['id', 'pair', 'finding', 'real', 'partly', 'wrong', 'vague', 'notes'];

describe('the spot-check sheet as a CSV', () => {
  it('round-trips text with commas, quotes, line breaks and a byte-order mark', () => {
    const rows = [['id', 'finding'], ['S01', 'He said "no", then\nleft, twice'], ['S02', '']];
    expect(parseCsv('﻿' + toCsv(rows))).toEqual([['id', 'finding'], ['S01', 'He said "no", then\nleft, twice'], ['S02', '']]);
  });
});

describe('scoring a filled sheet against our labels', () => {
  const sheet = (rows: string[][]) => toCsv([HEAD, ...rows]);

  it('reports exact agreement, agreement on useful-or-not, both rates and the disagreements', () => {
    const report = scoreSheet(
      sheet([
        ['S01', 'docket', 'a', '', '', 'x', '', ''], // wrong = wrong
        ['S02', 'docket', 'b', '', 'x', '', '', ''], // real vs partly: different label, both useful
        ['S03', 'step2', 'c', '', '', 'x', '', 'file shows it is there'], // partly vs wrong: disagrees on useful
        ['S04', 'step2', 'd', '', '', '', 'x', ''], // vague = vague
        ['S05', 'step3', 'e', 'x', '', '', '', ''], // real = real
      ]),
      key,
    );
    expect(report).toMatchObject({ asked: 5, answered: 5, exact: 3, usefulAgree: 4 });
    expect(report.ours).toEqual({ useful: 3, wrong: 1 });
    expect(report.theirs).toEqual({ useful: 2, wrong: 2 });
    expect(report.matrix.real).toMatchObject({ real: 1, partly: 1 });
    expect(report.matrix.partly).toMatchObject({ wrong: 1 });
    expect(report.disagreements).toEqual([{ id: 'S03', pair: 'step2', ours: 'partly', theirs: 'wrong', note: 'file shows it is there' }]);
    expect(report.byPair.docket).toEqual({ n: 2, exact: 1, usefulAgree: 2 });
  });

  it('leaves out blank rows, rows with two marks, repeated rows, unknown ids and missing rows, and says why', () => {
    const report = scoreSheet(
      sheet([
        ['S01', 'docket', 'a', '', '', 'x', '', ''],
        ['S02', 'docket', 'b', '', '', '', '', ''],
        ['S03', 'step2', 'c', 'x', 'x', '', '', ''],
        ['S01', 'docket', 'a', 'x', '', '', '', ''],
        ['S99', 'step2', 'z', 'x', '', '', '', ''],
      ]),
      key,
    );
    expect(report.answered).toBe(1);
    const why = Object.fromEntries(report.skipped.map((s) => [s.id, s.why]));
    expect(why.S02).toMatch(/no answer/);
    expect(why.S03).toMatch(/more than one/);
    expect(why.S01).toMatch(/twice/);
    expect(why.S99).toMatch(/not in the answer key/);
    expect(why.S04).toMatch(/missing/);
  });

  it('refuses a sheet whose answer columns were renamed', () => {
    expect(() => scoreSheet(toCsv([['id', 'ok'], ['S01', 'x']]), key)).toThrow(/needs the columns/);
  });

  it('formats a share, and n/a for an empty sample', () => {
    expect(pct(1, 4)).toBe('25%');
    expect(pct(0, 0)).toBe('n/a');
  });
});
