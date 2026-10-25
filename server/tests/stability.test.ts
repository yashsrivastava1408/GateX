import { describe, expect, it } from 'vitest';
import { analyseStability, describeStability, type RunSummary } from '../src/agent/stability.js';

type Q = RunSummary['dimensions'][number];
const dim = (id: string, weight: number, final: number, raters: Record<string, number>, criteria?: Q[]): Q => ({
  id, name: `Question ${id}`, weight, status: 'scored', raterScores: raters, consolidated: final, ...(criteria ? { criteria } : {}),
});
const run = (label: string, score: number, decision: RunSummary['decision'], dimensions: Q[]): RunSummary => ({ label, score, decision, dimensions });

describe('run stability', () => {
  const a = run('a', 76, 'green', [dim('G1', 50, 4, { A: 4, B: 4, C: 4 }), dim('G2', 50, 5, { A: 5, B: 5, C: 5 })]);
  const b = run('b', 73, 'amber', [dim('G1', 50, 3, { A: 4, B: 4, C: 4 }), dim('G2', 50, 2, { A: 5, B: 1, C: 1 })]);
  const c = run('c', 77, 'green', [dim('G1', 50, 4, { A: 4, B: 4, C: 4 }), dim('G2', 50, 5, { A: 5, B: 5, C: 5 })]);

  it('counts the runs on the most common colour, the score range and the spread', () => {
    const s = analyseStability([a, b, c]);
    expect(s.sameVerdict).toBeCloseTo(2 / 3);
    expect(s.range).toEqual({ low: 73, high: 77, width: 4 });
    expect(s.scores).toEqual([76, 73, 77]);
    expect(s.sd).toBeCloseTo(1.700, 2);
  });
  it('ranks the questions that moved by the points of the score they can move, and says whether the examiners or the final mark moved', () => {
    const s = analyseStability([a, b, c]);
    expect(s.swings.map((w) => w.id)).toEqual(['G2', 'G1']);
    expect(s.swings[0]).toMatchObject({ marks: [5, 2, 5], spread: 3, cause: 'examiners' });
    expect(s.swings[1]).toMatchObject({ marks: [4, 3, 4], spread: 1, cause: 'final reviewer or code' });
  });
  it('reads criteria of a dimension as questions of their own', () => {
    const withCriteria = (v: number) => dim('G1', 50, v, {}, [dim('G1-C1', 25, v, { A: v, B: v, C: v }), dim('G1-C2', 25, 4, { A: 4, B: 4, C: 4 })]);
    const s = analyseStability([run('a', 80, 'green', [withCriteria(5)]), run('b', 70, 'amber', [withCriteria(1)])]);
    expect(s.swings.map((w) => w.id)).toEqual(['G1-C1']);
    expect(s.swings[0]!.cause).toBe('examiners');
  });
  it('says plainly when nothing moved, and needs two runs', () => {
    const same = analyseStability([a, { ...a, label: 'a2' }]);
    expect(same.swings).toEqual([]);
    expect(describeStability(same).join(' ')).toMatch(/No question moved/);
    expect(describeStability(analyseStability([a, b, c])).join('\n')).toMatch(/Same verdict in 2 of 3 runs \(67%/);
    expect(() => analyseStability([a])).toThrow(/at least two runs/);
  });
});
