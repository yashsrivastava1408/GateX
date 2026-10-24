import { describe, expect, it } from 'vitest';
import { outputBudget } from '../src/agent/rater.js';

describe('how much a small-window model may answer', () => {
  it('leaves the wanted answer size alone when no limit is set or there is plenty of room', () => {
    expect(outputBudget(undefined, 50_000, 8192)).toBe(8192);
    expect(outputBudget(120_000, 60_000, 8192)).toBe(8192);
  });

  it('cuts the answer so prompt plus answer fit the window (the 32k Qwen fallback that was one token over)', () => {
    // 24,577 tokens in and 8,192 wanted made 32,769 against a 32,768 window.
    const room = outputBudget(32_768, 24_577, 8192)!;
    expect(room).toBeLessThan(8192);
    expect(24_577 + room).toBeLessThanOrEqual(32_768);
  });

  it('refuses when too little room is left for a usable answer', () => {
    expect(outputBudget(32_000, 30_500, 8192)).toBeNull();
  });
});
