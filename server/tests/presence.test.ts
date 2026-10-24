import { describe, expect, it } from 'vitest';
import { checkPresence, candidateRows, indexRows, proofOfPresence } from '../src/agent/presence.js';
import { WorkbookModel } from '../src/excel/workbook.js';
import { MockProvider } from '../src/llm/mock.js';
import type { LlmProvider } from '../src/llm/types.js';
import type { DraftFinding } from '../src/agent/types.js';
import { makeWorkbook } from './helpers.js';

const finding = (title: string, extra: Partial<DraftFinding> = {}): DraftFinding => ({
  source: 'raters', dimensionId: 'G09', severity: 'HIGH', title, detail: `The file has no ${title.toLowerCase()}.`, fix: 'Add a purpose field.',
  returnTo: 'Define' as never, location: { sheet: 'Params', cell: 'A1' }, reportedBy: ['A'], ...extra,
});

const load = async () =>
  WorkbookModel.load(await makeWorkbook({
    Params: [['Id', 'Name', 'Meaning'], ['P-01', 'Access purpose', 'Why the data is accessed.'], ['P-02', 'Owner', 'Who is accountable.']],
    Decisions: [['Id', 'Decision'], ['DEC-1', 'A purpose register will be generated later']],
  }));

/** A provider that answers with a fixed reply, to test the proof without a real model. */
const says = (reply: unknown): LlmProvider => ({ name: 'fixed', complete: async () => ({ text: JSON.stringify(reply), inputTokens: 10, outputTokens: 5 }) });
const settings = { temperature: 0, maxOutputTokens: 1000 };

describe('proof that a "missing" thing is already in the file', () => {
  it('accepts a quote that is in the cited cell, or in another cell of the same row', async () => {
    const wb = await load();
    const claim = finding('No purpose field');
    expect(proofOfPresence(wb, claim, { cell: 'Params!B2', quote: 'Access purpose' })).toMatchObject({ ok: true, cell: 'Params!B2' });
    // The model named the id cell; the words sit two columns over, in the same row.
    expect(proofOfPresence(wb, claim, { cell: 'Params!A2', quote: 'Access purpose' })).toMatchObject({ ok: true, cell: 'Params!B2' });
  });

  it('rejects a made-up quote, a missing sheet, a short quote, a quote unrelated to the claim, and a discussion sheet', async () => {
    const wb = await load();
    const claim = finding('No purpose field');
    expect(proofOfPresence(wb, claim, { cell: 'Params!B2', quote: 'Lawful basis for access' }).ok).toBe(false);
    expect(proofOfPresence(wb, claim, { cell: 'Nope!B2', quote: 'Access purpose' }).ok).toBe(false);
    expect(proofOfPresence(wb, claim, { cell: 'Params!B2', quote: 'Acc' }).ok).toBe(false);
    expect(proofOfPresence(wb, claim, { cell: 'Params!B3', quote: 'Owner' }).ok).toBe(false);
    expect(proofOfPresence(wb, claim, { cell: 'Decisions!B2', quote: 'A purpose register will be generated' }).ok).toBe(false);
  });
});

describe('the "already in the file" check', () => {
  it('finds the row that holds the thing by its rare words, and never offers a discussion sheet', async () => {
    const wb = await load();
    const docs = indexRows(wb);
    const rows = candidateRows(docs, 'No purpose field. Add a purpose field.');
    expect(rows[0]).toMatchObject({ sheet: 'Params', row: 2 });
    expect(rows.every((r) => r.sheet !== 'Decisions')).toBe(true);
    expect(candidateRows(docs, 'the of and')).toEqual([]);
  });

  it('drops a finding only when the model cites a real cell, and names that cell in the reason', async () => {
    const wb = await load();
    const claim = finding('No purpose field');
    const kept = finding('No signature column', { detail: 'The file has no signature column.', fix: 'Add a signature column.' });
    const result = await checkPresence({
      findings: [claim, kept], wb, settings,
      models: [{ model: 'x', provider: says({ results: [{ id: 'C1', present: true, cell: 'Params!B2', quote: 'Access purpose' }, { id: 'C2', present: false }] }) }],
    });
    expect(result.findings).toEqual([kept]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]!.reason).toBe('The file already has what it says is missing: Params!B2 says "Access purpose".');
  });

  it('keeps a finding when the model says present but its quote is not in the file', async () => {
    const wb = await load();
    const claim = finding('No purpose field');
    const result = await checkPresence({ findings: [claim], wb, settings, models: [{ model: 'x', provider: says({ results: [{ id: 'C1', present: true, cell: 'Params!B2', quote: 'Purpose of processing' }] }) }] });
    expect(result.findings).toEqual([claim]);
    expect(result.dropped).toEqual([]);
  });

  it('keeps everything, and says so, when the model call fails', async () => {
    const wb = await load();
    const claim = finding('No purpose field');
    const result = await checkPresence({ findings: [claim], wb, settings, models: [{ model: 'x', provider: { name: 'down', complete: async () => { throw new Error('boom'); } } }] });
    expect(result.findings).toEqual([claim]);
    expect(result.notes.join(' ')).toMatch(/could not run for 1 finding.*kept/);
  });

  it('leaves findings that do not claim absence, and code findings, alone, and makes no call for them', async () => {
    const wb = await load();
    let calls = 0;
    const counting: LlmProvider = { name: 'count', complete: async () => { calls++; return { text: '{"results":[]}', inputTokens: 1, outputTokens: 1 }; } };
    const wrong = finding('Definitions are inconsistent', { detail: 'Some definitions contradict each other at row 5.' });
    const code = finding('Empty cell', { source: 'code', detail: 'The file has no value at D5.' });
    const result = await checkPresence({ findings: [wrong, code], wb, settings, models: [{ model: 'x', provider: counting }] });
    expect(result.findings).toEqual([wrong, code]);
    expect(calls).toBe(0);
  });

  it('works with the mock provider used by the pipeline tests (everything is "not present")', async () => {
    const wb = await load();
    const claim = finding('No purpose field');
    const result = await checkPresence({ findings: [claim], wb, settings, models: [{ model: 'mock-consolidator', provider: new MockProvider() }] });
    expect(result.findings).toEqual([claim]);
    expect(result.notes).toEqual([]);
  });
});
