import { describe, expect, it } from 'vitest';
import type { DimensionSpec, Evidence } from '@ddd/shared';
import { consolidateInBatches } from '../src/agent/consolidate.js';
import { decideMark, hasQuotedProof, medianMark, strayMarks } from '../src/agent/finalMark.js';
import type { LlmProvider } from '../src/llm/types.js';
import { WorkbookModel } from '../src/excel/workbook.js';
import type { RaterOutcome } from '../src/agent/types.js';
import { makeWorkbook } from './helpers.js';

const ev = (cell: string, quote?: string): Evidence => ({ sheet: 'T', cell, ...(quote ? { quote } : {}) });

describe('the median of the examiners\' marks', () => {
  it('is the middle mark, and the lower middle when two are left so a tie never rounds up', () => {
    expect(medianMark([5])).toBe(5);
    expect(medianMark([4, 5])).toBe(4);
    expect(medianMark([5, 0, 4])).toBe(4);
    expect(medianMark([1, 5, 3, 2])).toBe(2);
    expect(() => medianMark([])).toThrow();
  });
});

describe('which marks need proof', () => {
  it('a 0 against examiners who gave 2 or more is a stray; a 0 two examiners share is not', () => {
    expect([...strayMarks([0, 4, 4])]).toEqual([0]);
    expect([...strayMarks([4, 0])]).toEqual([1]);
    expect([...strayMarks([0, 5, 0])]).toEqual([1]); // the two 0s back each other; the lone 5 is the one that needs proof
    expect([...strayMarks([0, 1, 4])]).toEqual([2]); // the 1 is within a point of the 0, so the 0 is not alone
    expect([...strayMarks([0, 1, 1])]).toEqual([]);
  });

  it('a lone mark 2 or more from two examiners who agree is a stray; two examiners who simply differ are not', () => {
    expect([...strayMarks([5, 5, 2])]).toEqual([2]);
    expect([...strayMarks([1, 4, 4])]).toEqual([0]);
    expect([...strayMarks([1, 4])]).toEqual([]);
    expect([...strayMarks([2, 4, 5])]).toEqual([0]); // 2 is two or more from both of 4 and 5, which are a point apart
    expect([...strayMarks([1, 3, 5])]).toEqual([]); // all three differ: a dispute, nobody is singled out
  });

  it('never singles out a mark when fewer than two marks are given', () => {
    expect(strayMarks([0]).size).toBe(0);
    expect(strayMarks([]).size).toBe(0);
  });
});

describe('proof for a mark', () => {
  it('needs a quote; a short quote counts only when it is most of what the cell says', () => {
    expect(hasQuotedProof([ev('A1')])).toBe(false);
    expect(hasQuotedProof([ev('A1', 'the schema states its scope in the first line')])).toBe(true);
    expect(hasQuotedProof([ev('A1', 'Yes')])).toBe(false);
    expect(hasQuotedProof([ev('A1', 'Yes')], () => 'Yes')).toBe(true);
    expect(hasQuotedProof([ev('A1', 'Yes')], () => 'Yes, with a long explanation behind it')).toBe(false);
  });
});

describe('what the final reviewer may do to the median', () => {
  const given = [
    { score: 1, evidence: [ev('A1', 'x')] },
    { score: 4, evidence: [ev('B2', 'y')] },
    { score: 4, evidence: [ev('B3', 'z')] },
  ];

  it('changes nothing without a suggestion, or when the suggestion is the median', () => {
    expect(decideMark(given, null)).toEqual({ mark: 4, moved: false });
    expect(decideMark(given, { proposed: 4, cited: [ev('B9')] })).toEqual({ mark: 4, moved: false });
  });

  it('refuses a move that cites no cell code could confirm, and says so', () => {
    const d = decideMark(given, { proposed: 1, cited: [] });
    expect(d).toMatchObject({ mark: 4, moved: false });
    expect(d.note).toMatch(/cited no cell that code could confirm/);
  });

  it('moves all the way when an examiner who gave that mark cited the same cell', () => {
    const d = decideMark(given, { proposed: 1, cited: [ev('A1', 'x')] });
    expect(d).toMatchObject({ mark: 1, moved: true });
    expect(d.note).toMatch(/cited the same cell \(t!A1\)/i);
  });

  it('moves one point at most when the cells it cites were cited by nobody who gave that mark', () => {
    expect(decideMark(given, { proposed: 1, cited: [ev('Z9', 'q')] })).toMatchObject({ mark: 3, moved: true });
    const up = decideMark([{ score: 2, evidence: [ev('A1')] }, { score: 2, evidence: [ev('A2')] }, { score: 5, evidence: [ev('A3')] }], { proposed: 5, cited: [ev('Q1', 'q')] });
    expect(up).toMatchObject({ mark: 3, moved: true });
    expect(up.note).toMatch(/one point only/);
  });
});

/* ---- through the consolidation, as the orchestrator runs it ---- */

const spec = (id: string): DimensionSpec => ({ id, name: id, weight: 1, critical: false, measuredBy: 'raters', anchors: { 0: 'a', 1: 'b', 2: 'c', 3: 'd', 4: 'e', 5: 'f' } });
const rater = (id: string, score: number | null, evidence: Evidence[]): RaterOutcome =>
  ({
    model: { id, provider: 'fake', model: id, family: id }, role: 'rater', status: 'ok', prompt: 'p', promptHash: 'h', rawResponse: '', attempts: 1, latencyMs: 1, inputTokens: 1, outputTokens: 1,
    dimensions: [{ id: 'Q1', score, notMeasurable: false, anchor: '', rationale: `${id} says ${score}`, evidence }],
    findings: [], strengths: [], discarded: [],
  }) as unknown as RaterOutcome;

const SENTENCE = 'Every field has a definition in column C';
async function consolidateWith(marks: Array<[number, Evidence[]]>, reviewer: { score: number; evidence: Evidence[] }, outside = false) {
  const wb = await WorkbookModel.load(await makeWorkbook({ T: [[SENTENCE], ['The register lists every actor class once'], ['Other words in another cell']] }));
  const provider: LlmProvider = {
    name: 'fake',
    complete: async () => ({ text: JSON.stringify({ dimensions: [{ id: 'Q1', score: reviewer.score, resolved: true, basis: 'checked', rationale: `The reviewer says ${reviewer.score}`, evidence: reviewer.evidence }], findings: [], strengths: [] }), inputTokens: 1, outputTokens: 1 }),
  };
  const question = { ...spec('Q1'), ...(outside ? { criterionOf: { id: 'G', name: 'G', outside: true } } : {}) };
  const result = await consolidateInBatches({
    model: { id: 'K', provider: 'fake', model: 'k', family: 'k' }, provider, rated: [question], wb, allowedSheets: new Set(['t']), defaultReturnTo: 'Define',
    outcomes: marks.map(([score, evidence], i) => rater('ABC'[i]!, score, evidence)),
    settings: { temperature: 0, maxOutputTokens: 100 }, buildUser: () => 'x',
  });
  return result.dimensions[0]!;
}

describe('the final mark, through the consolidation', () => {
  const quoted = ev('A1', SENTENCE);
  const bare = ev('A2');
  const other = ev('A3', 'Other words in another cell');

  it('sets aside a stray 0 that quotes nothing, whatever the final reviewer says, and logs it', async () => {
    for (const reviewerScore of [4, 0]) {
      const d = await consolidateWith([[0, [bare]], [4, [other]], [4, [quoted]]], { score: reviewerScore, evidence: [quoted] });
      expect(d.consolidated).toBe(4); // the same marks give the same result, however the reviewer leans
      expect(d.markNotes?.[0]).toMatch(/Examiner A's mark 0 was set aside/);
    }
  });

  it('counts a stray 0 whose cell holds the quoted words: the median is still 4, and the reviewer cannot take it to 0 without a shared cell', async () => {
    const d = await consolidateWith([[0, [quoted]], [4, [other]], [4, [other]]], { score: 0, evidence: [ev('A2', 'The register lists every actor class once')] });
    // proposed 0, cites A2, which nobody who gave 0 cited: one point only
    expect(d.consolidated).toBe(3);
    expect(d.markNotes?.join(' ')).toMatch(/one point only/);
    expect(d.markNotes?.join(' ')).not.toMatch(/set aside/);
  });

  it('lets the reviewer take the mark to what an examiner showed when the reviewer cites that examiner\'s cell', async () => {
    const d = await consolidateWith([[0, [quoted]], [4, [other]], [4, [other]]], { score: 0, evidence: [quoted] });
    expect(d.consolidated).toBe(0);
    expect(d.markNotes?.join(' ')).toMatch(/cited the same cell/);
  });

  it('keeps the median when the reviewer cites nothing code can confirm, and logs the refusal', async () => {
    const d = await consolidateWith([[2, [other]], [3, [other]], [5, [other]]], { score: 5, evidence: [{ sheet: 'T', cell: 'A3', quote: 'words that are not in that cell at all' }] });
    expect(d.consolidated).toBe(3);
    expect(d.markNotes?.join(' ')).toMatch(/cited no cell that code could confirm/);
  });

  it('flags a disagreement nobody settled with evidence, and does not flag one the reviewer settled', async () => {
    const unsettled = await consolidateWith([[1, [other]], [3, [other]], [5, [other]]], { score: 2, evidence: [] });
    expect(unsettled).toMatchObject({ consolidated: 3, resolution: 'lower_stands', flagged: true });
    const settled = await consolidateWith([[1, [other]], [3, [other]], [5, [other]]], { score: 3, evidence: [other] });
    expect(settled).toMatchObject({ consolidated: 3, resolution: 'claims_checked', flagged: false });
  });

  it('does not treat a 0 as a stray on a question that needs evidence from outside the file', async () => {
    const d = await consolidateWith([[0, [bare]], [4, [other]], [4, [other]]], { score: 4, evidence: [other] }, true);
    expect(d.markNotes?.join(' ') ?? '').not.toMatch(/set aside/);
    expect(d.consolidated).toBe(4);
  });

  it('with two examiners left, the lower middle mark stands', async () => {
    const d = await consolidateWith([[4, [other]], [5, [other]]], { score: 5, evidence: [] });
    expect(d.consolidated).toBe(4);
  });
});
