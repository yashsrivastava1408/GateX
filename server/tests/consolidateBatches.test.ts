import { describe, expect, it } from 'vitest';
import { CONSOLIDATION_BATCH, consolidateInBatches } from '../src/agent/consolidate.js';
import { LlmError, type LlmProvider } from '../src/llm/types.js';
import { WorkbookModel } from '../src/excel/workbook.js';
import type { DimensionSpec } from '@ddd/shared';
import type { RaterOutcome } from '../src/agent/types.js';
import { makeWorkbook } from './helpers.js';

const spec = (id: string): DimensionSpec => ({ id, name: id, weight: 1, critical: false, measuredBy: 'raters', anchors: { 0: 'a', 1: 'b', 2: 'c', 3: 'd', 4: 'e', 5: 'f' } });
const ids = (n: number) => Array.from({ length: n }, (_, i) => `Q${String(i + 1).padStart(2, '0')}`);
const outcome = (id: string, rated: string[], score: number): RaterOutcome =>
  ({
    model: { id, provider: 'fake', model: id, family: id }, role: 'rater', status: 'ok', prompt: 'p', promptHash: 'h', rawResponse: '', attempts: 1, latencyMs: 1, inputTokens: 1, outputTokens: 1,
    dimensions: rated.map((d) => ({ id: d, score, notMeasurable: false, anchor: '', rationale: `${id} ${d}`, evidence: [{ sheet: 'T', cell: 'A1' }] })),
    findings: rated.map((d, i) => ({ ref: `${id}${d}`, raterId: id, dimensionId: d, severity: 'LOW' as const, title: `Finding ${d}`, detail: 'd', fix: 'f', returnTo: 'Define' as const, location: { sheet: 'T', cell: `A${i + 1}` } })),
    strengths: [], discarded: [],
  }) as unknown as RaterOutcome;

async function setup(count: number, reply: (asked: string[]) => string | Error) {
  const rated = ids(count).map(spec);
  const outcomes = [outcome('A', ids(count), 4), outcome('B', ids(count), 4)];
  const asked: string[][] = [];
  const provider: LlmProvider = {
    name: 'fake',
    complete: async (r) => {
      const batch = [...r.user.matchAll(/"id": "(Q\d+)"/g)].map((m) => m[1]!);
      asked.push([...new Set(batch)]);
      const out = reply(asked[asked.length - 1]!);
      if (out instanceof Error) throw out;
      return { text: out, inputTokens: 10, outputTokens: 10 };
    },
  };
  const wb = await WorkbookModel.load(await makeWorkbook({ T: [['a'], ['b']] }));
  const base = { model: { id: 'K', provider: 'fake', model: 'k', family: 'k' }, provider, rated, outcomes, wb, allowedSheets: new Set(['t']), defaultReturnTo: 'Define' as const, settings: { temperature: 0, maxOutputTokens: 100 } };
  return { base, asked, rated };
}
const buildUser = (rated: DimensionSpec[], outcomes: RaterOutcome[]) =>
  `<rater_results>\n${JSON.stringify({ dimensions: rated.map((d) => ({ id: d.id })), findings: outcomes.flatMap((o) => o.findings.map((f) => ({ ref: f.ref }))) }, null, 1)}\n</rater_results>`;
const okReply = (asked: string[]) => JSON.stringify({ dimensions: asked.map((id) => ({ id, score: 4, resolved: true, basis: 'agreement', rationale: 'ok', evidence: [] })), findings: [], strengths: [] });

describe('consolidating a big scorecard in batches', () => {
  it('splits 20 questions into batches of 8, asks about each question once, and puts the results back in order', async () => {
    const { base, asked, rated } = await setup(20, okReply);
    const result = await consolidateInBatches({ ...base, buildUser });
    expect(CONSOLIDATION_BATCH).toBe(8);
    expect(asked.map((a) => a.length)).toEqual([8, 8, 4]);
    expect(asked.flat()).toEqual(rated.map((d) => d.id));
    expect(result.dimensions.map((d) => d.id)).toEqual(rated.map((d) => d.id));
    expect(result.dimensions.every((d) => d.consolidated === 4 && d.resolution === 'agreement')).toBe(true);
    expect(result.call).toMatchObject({ status: 'ok', attempts: 3 });
    expect(result.consolidatorFailed).toBe(false);
  });

  it('keeps every finding exactly once: each follows its question into one batch only', async () => {
    const { base } = await setup(20, okReply);
    const result = await consolidateInBatches({ ...base, buildUser });
    // Two examiners reported the same title on each question and nothing was merged by the model, so the twin rule folds them.
    expect(result.findings).toHaveLength(20);
    expect(result.findings.every((f) => f.reportedBy.join() === 'A,B')).toBe(true);
  });

  it('makes a single call, as before, for a scorecard that fits in one batch', async () => {
    const { base, asked } = await setup(5, okReply);
    const result = await consolidateInBatches({ ...base, buildUser });
    expect(asked).toHaveLength(1);
    expect(result.dimensions).toHaveLength(5);
  });

  it('lets one failing batch spoil only its own questions: the lower score stands there, the rest are reviewed', async () => {
    const { base } = await setup(20, (asked) => (asked.includes('Q09') ? 'not json at all' : okReply(asked)));
    const result = await consolidateInBatches({ ...base, buildUser });
    const byId = new Map(result.dimensions.map((d) => [d.id, d]));
    expect(byId.get('Q09')).toMatchObject({ consolidated: 4, resolution: 'agreement' });
    expect(result.consolidatorFailed).toBe(true);
    expect(result.call.status).toBe('ok');
    expect(result.call.error).toMatch(/1 of \d+ review batches failed/);
    expect(result.dimensions).toHaveLength(20);
  });

  it('splits a batch whose reply was unusable in half and asks again, so only the question that keeps failing loses its review', async () => {
    const { base, asked } = await setup(8, (a) => (a.includes('Q03') ? 'not json at all' : okReply(a)));
    const result = await consolidateInBatches({ ...base, buildUser, batchSize: 8 });
    const byId = new Map(result.dimensions.map((d) => [d.id, d]));
    // 8 questions in one batch; a failing call is asked twice. Q03 poisons every group it is in: 8, 4, then 2 (fine), 2 (Q03+Q04), 1 (Q03), 1 (Q04, fine), then the other 4.
    expect(asked.map((a) => a.length)).toEqual([8, 8, 4, 4, 2, 2, 2, 1, 1, 1, 4]);
    expect(result.dimensions).toHaveLength(8);
    expect(result.call.error).toMatch(/1 of \d+ review batches failed/);
    expect(byId.get('Q04')).toMatchObject({ consolidated: 4, resolution: 'agreement' });
    expect(byId.get('Q08')).toMatchObject({ consolidated: 4, resolution: 'agreement' });
  });

  it('does not split when the service itself failed', async () => {
    const { base, asked } = await setup(8, () => new LlmError('HTTP 503: overloaded', 503));
    const result = await consolidateInBatches({ ...base, buildUser, batchSize: 8 });
    expect(asked).toHaveLength(1);
    expect(result.call.status).toBe('failed');
  });

  it('reports a failed review only when every batch failed', async () => {
    const { base } = await setup(20, () => new LlmError('HTTP 503: overloaded', 503));
    const result = await consolidateInBatches({ ...base, buildUser });
    expect(result.call.status).toBe('failed');
    expect(result.call.error).toMatch(/3 of 3 review batches failed/);
    expect(result.dimensions).toHaveLength(20);
    expect(result.dimensions.every((d) => d.consolidated === 4)).toBe(true);
  });

  it('honours a smaller batch size', async () => {
    const { base, asked } = await setup(10, okReply);
    await consolidateInBatches({ ...base, buildUser, batchSize: 3 });
    expect(asked.map((a) => a.length)).toEqual([3, 3, 3, 1]);
  });
});
