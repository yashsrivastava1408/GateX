import { describe, expect, it } from 'vitest';
import type { DimensionSpec, Scorecard } from '@ddd/shared';
import { AUTO_READS_BUDGET, withAutoReads } from '../src/agent/autoReads.js';
import { planSections } from '../src/agent/sectionPlanner.js';
import { WorkbookModel } from '../src/excel/workbook.js';
import { makeWorkbook, loadTalentraScorecard } from './helpers.js';

const long = (word: string, n: number) => Array.from({ length: n }, () => `${word} `).join('').trim();

/** A workbook too big to send whole: two large sheets, one about permissions and one about threats, and a small one. */
async function bigWorkbook() {
  const rows = (topic: string) => [['Id', 'Title', 'Description'], ...Array.from({ length: 400 }, (_, i) => [`${topic}-${i}`, `${topic} item ${i}`, long(`${topic} detail`, 40)])];
  return WorkbookModel.load(await makeWorkbook({ Permissions: rows('permission'), Threats: rows('threat'), Notes: [['Id', 'Text'], ['n1', 'A short note.']] }));
}

async function scorecardOver(wb: WorkbookModel, dims: Array<Partial<DimensionSpec> & { id: string; name: string }>): Promise<Scorecard> {
  const { scorecard } = await loadTalentraScorecard();
  const sheets = wb.sheetNames().map((name) => ({ name, headerRow: 1 }));
  return {
    ...scorecard,
    artifact: { ...scorecard.artifact, sheets, context: [] },
    dimensions: dims.map((d) => ({ weight: 10, critical: false, measuredBy: 'raters', anchors: scorecard.dimensions[0]!.anchors, ...d }) as DimensionSpec),
  };
}

describe('giving a question that names no sheets the sheets that match it', () => {
  it('leaves a small workbook, and a question that already names its sheets, alone', async () => {
    const small = await WorkbookModel.load(await makeWorkbook({ A: [['Id'], ['1']] }));
    const sc = await scorecardOver(small, [{ id: 'Q1', name: 'Anything' }]);
    expect(withAutoReads(sc, small)).toEqual({ scorecard: sc, notes: [], summary: '' });

    const wb = await bigWorkbook();
    const named = await scorecardOver(wb, [{ id: 'Q1', name: 'Threats', reads: ['Notes'] }]);
    expect(withAutoReads(named, wb).scorecard.dimensions[0]!.reads).toEqual(['Notes']);
  });

  it('picks the sheet whose title and contents match the question, cut to the budget, and says so', async () => {
    const wb = await bigWorkbook();
    const sc = await scorecardOver(wb, [{ id: 'Q1', name: 'Are threats listed?', measure: 'Every threat has a title and a description' }]);
    const out = withAutoReads(sc, wb);
    const reads = out.scorecard.dimensions[0]!.reads!;
    expect(reads[0]).toMatch(/^Threats/);
    expect(reads.some((r) => r.startsWith('Permissions'))).toBe(false);
    expect(out.notes[0]).toMatch(/Q1 named no sheets/);
    expect(out.summary).toMatch(/The file is large \(about [\d,]+ tokens\), so code chose which sheets 1 question that named none should read \(Q1\)/);
    // The plan is smaller than the budget and becomes an ordinary section.
    const section = planSections(out.scorecard).find((s) => s.dimensions.some((d) => d.id === 'Q1'))!;
    expect(section.sheets.map((s) => s.name)).toContain('Threats');
    expect(AUTO_READS_BUDGET).toBe(30_000);
  });

  it('is deterministic, and falls back to the smallest sheets when nothing matches', async () => {
    const wb = await bigWorkbook();
    const sc = await scorecardOver(wb, [{ id: 'Q1', name: 'Zzzz qqqq', measure: 'Wwww' }]);
    const a = withAutoReads(sc, wb);
    expect(withAutoReads(sc, wb)).toEqual(a);
    expect(a.scorecard.dimensions[0]!.reads).toContain('Notes');
  });

  it('never touches a question measured by code', async () => {
    const wb = await bigWorkbook();
    const sc = await scorecardOver(wb, [{ id: 'C1', name: 'Counted', measuredBy: 'code' }]);
    expect(withAutoReads(sc, wb).notes).toEqual([]);
  });
});
