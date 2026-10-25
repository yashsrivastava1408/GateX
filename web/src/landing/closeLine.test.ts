import { describe, expect, it } from 'vitest';
import { closeLineFor } from './Story';

describe('the close-to-the-line note on the landing page', () => {
  it('is close within 5 points of 75 or 60, and only then', () => {
    expect(closeLineFor(75)).toBe(75);
    expect(closeLineFor(70)).toBe(75);
    expect(closeLineFor(80)).toBe(75);
    expect(closeLineFor(55)).toBe(60);
    expect(closeLineFor(65)).toBe(60);
    expect(closeLineFor(81)).toBeNull();
    expect(closeLineFor(40)).toBeNull();
    expect(closeLineFor(100)).toBeNull();
  });
});
