import { describe, expect, it } from 'vitest';
import { isActive, isStarted, pendingChip } from './runStatus';

describe('run status in plain words', () => {
  it('keeps refreshing while a run waits, starts or runs, and stops when it is over', () => {
    expect(['waiting', 'queued', 'running'].map((s) => isActive(s as never))).toEqual([true, true, true]);
    expect(['done', 'failed', 'cancelled'].map((s) => isActive(s as never))).toEqual([false, false, false]);
    expect(isStarted('waiting')).toBe(false);
    expect(isStarted('running')).toBe(true);
  });

  it('shows the place in line for a waiting run and Running for one that started', () => {
    expect(pendingChip({ status: 'waiting', queuePosition: 2 })).toEqual({ label: 'Waiting (2 in line)', tone: 'amber' });
    expect(pendingChip({ status: 'waiting', queuePosition: null })?.label).toBe('Waiting');
    expect(pendingChip({ status: 'running', queuePosition: null })?.label).toBe('Running');
    expect(pendingChip({ status: 'queued', queuePosition: null })?.label).toBe('Running');
    expect(pendingChip({ status: 'cancelled', queuePosition: null })?.label).toBe('Cancelled');
    expect(pendingChip({ status: 'failed', queuePosition: null })?.label).toBe('Failed');
    expect(pendingChip({ status: 'done', queuePosition: null })).toBeNull();
  });
});
