import { describe, expect, it } from 'vitest';
import { LINE } from './copy';

describe('the waiting-line wording', () => {
  it('says plainly who is ahead, without repeating the number', () => {
    expect(LINE.place(null)).toBe('Your check is saved and waiting.');
    expect(LINE.place(1)).toBe('You are next in line.');
    expect(LINE.place(2)).toBe('You are number 2 in line: one check is running and 1 is waiting ahead of yours.');
    expect(LINE.place(4)).toBe('You are number 4 in line: one check is running and 3 are waiting ahead of yours.');
  });
});
