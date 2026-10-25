import { describe, expect, it } from 'vitest';
import { buildBoard, stepNumber, type BoardRun } from '@ddd/shared';

let n = 0;
const run = (over: Partial<BoardRun>): BoardRun => ({
  runId: `r${++n}`, projectId: 'p1', projectName: 'Project one', step: '2', gate: 'D1', status: 'done', score: 80,
  createdAt: `2026-10-25T10:${String(n).padStart(2, '0')}:00.000Z`, ...over,
});

describe('the status board', () => {
  it('reads a step from the usual labels and nothing else', () => {
    expect(stepNumber('3')).toBe(3);
    expect(stepNumber('Step 03')).toBe(3);
    expect(stepNumber('S5')).toBe(5);
    expect(stepNumber('0')).toBeNull();
    expect(stepNumber('6')).toBeNull();
    expect(stepNumber('Docket')).toBeNull();
    expect(stepNumber(null)).toBeNull();
  });

  it('shows five steps, all not started, when nothing has been checked', () => {
    const board = buildBoard([]);
    expect(board.steps).toHaveLength(5);
    expect(board.steps.every((s) => s.status === 'not_started' && s.d1.state === 'not_started' && s.d2.state === 'not_started')).toBe(true);
  });

  it('colours a box by the score alone, with the one colour rule', () => {
    const board = buildBoard([run({ score: 74.9 }), run({ step: '3', score: 75 }), run({ step: '4', score: 59 })]);
    expect(board.steps[1]!.d1.state).toBe('amber');
    expect(board.steps[2]!.d1.state).toBe('green');
    expect(board.steps[3]!.d1.state).toBe('red');
  });

  it('uses the newest finished check, and puts D1 and D3 in their own boxes', () => {
    const board = buildBoard([
      run({ score: 50, createdAt: '2026-10-25T09:00:00.000Z' }),
      run({ score: 90, createdAt: '2026-10-25T11:00:00.000Z' }),
      run({ gate: 'D3', score: 40 }),
      run({ score: 10, status: 'failed', createdAt: '2026-10-25T12:00:00.000Z' }),
    ]);
    const step = board.steps[1]!;
    expect(step.d1.state).toBe('green');
    expect(step.d3.state).toBe('red');
  });

  it('shows a check still going only when nothing has finished', () => {
    const running = buildBoard([run({ status: 'running', score: null })]).steps[1]!;
    expect(running.d1.state).toBe('in_progress');
    const both = buildBoard([run({ status: 'running', score: null }), run({ score: 80 })]).steps[1]!;
    expect(both.d1.state).toBe('green');
  });

  it('freezes a scorecard box once a check used it, and a cancelled check does not count', () => {
    const board = buildBoard([run({ gate: 'D3', status: 'cancelled', score: null }), run({ step: '4', gate: 'D3', status: 'failed', score: null })]);
    expect(board.steps[1]!.d4.state).toBe('not_started');
    expect(board.steps[3]!.d4.state).toBe('frozen');
    expect(board.steps[3]!.d2.state).toBe('not_started');
  });

  it('calls a step Complete only when both results are green and both scorecards are frozen', () => {
    const both = [run({ gate: 'D1', score: 88 }), run({ gate: 'D3', score: 92 })];
    expect(buildBoard(both).steps[1]!.status).toBe('complete');
    expect(buildBoard([run({ gate: 'D1', score: 88 }), run({ gate: 'D3', score: 70 })]).steps[1]!.status).toBe('open');
    expect(buildBoard([run({ gate: 'D1', score: 88 })]).steps[1]!.status).toBe('open');
  });

  it('counts projects with no usable step instead of guessing', () => {
    const board = buildBoard([run({ step: null, projectId: 'a' }), run({ step: 'Docket', projectId: 'b' }), run({ step: null, projectId: 'a' })]);
    expect(board.unplaced).toBe(2);
    expect(board.steps.every((s) => s.status === 'not_started')).toBe(true);
  });
});
