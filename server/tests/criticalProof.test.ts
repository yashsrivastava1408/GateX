import { describe, expect, it } from 'vitest';
import type { DimensionResult } from '@ddd/shared';
import { WorkbookModel } from '../src/excel/workbook.js';
import { applyCriticalProof } from '../src/agent/criticalProof.js';
import { makeWorkbook } from './helpers.js';

const mark = (over: Partial<DimensionResult>): DimensionResult => ({
  id: 'Q1', name: 'Traceability', weight: 1, critical: true, measuredBy: 'raters', status: 'scored', raterScores: { A: 5, B: 5, C: 5 }, consolidated: 5, spread: 0,
  resolution: 'agreement', flagged: false, rationale: 'r.', evidence: [], ...over,
});

describe('a high mark on a must-pass question needs a quoted cell', () => {
  it('lowers it to 3 when the cells are only named, and keeps it when a cell is quoted', async () => {
    const wb = await WorkbookModel.load(await makeWorkbook({ S: [['Field', 'Source'], ['id', 'Docket section 2.1 states the rule']] }));
    const named = applyCriticalProof([mark({ evidence: [{ sheet: 'S', cell: 'B2' }] })], wb);
    expect(named.results[0]!.consolidated).toBe(3);
    expect(named.notes[0]).toMatch(/must-pass question/);
    const quoted = applyCriticalProof([mark({ evidence: [{ sheet: 'S', cell: 'B2', quote: 'Docket section 2.1' }] })], wb);
    expect(quoted.results[0]!.consolidated).toBe(5);
    expect(quoted.notes).toEqual([]);
  });
  it('counts a short cell quoted whole, and never touches a low mark, an ordinary question, or one scored by code', async () => {
    const wb = await WorkbookModel.load(await makeWorkbook({ S: [['Field', 'Kind'], ['id', 'text']] }));
    expect(applyCriticalProof([mark({ evidence: [{ sheet: 'S', cell: 'B2', quote: 'text' }] })], wb).results[0]!.consolidated).toBe(5);
    expect(applyCriticalProof([mark({ consolidated: 2 })], wb).results[0]!.consolidated).toBe(2);
    expect(applyCriticalProof([mark({ critical: false })], wb).results[0]!.consolidated).toBe(5);
    expect(applyCriticalProof([mark({ measuredBy: 'code' })], wb).results[0]!.consolidated).toBe(5);
  });
});
