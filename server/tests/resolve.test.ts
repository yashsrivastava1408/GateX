import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LlmError, type LlmProvider } from '../src/llm/types.js';
import { MockProvider } from '../src/llm/mock.js';
import { outlineDocument } from '../src/scorecard/importer.js';
import { ScorecardResolver, conversionKey, conversionNote, documentShape, isAppFormat } from '../src/scorecard/resolve.js';
import { scorecardToWorkbook } from '../src/scorecard/excel.js';
import { parseScorecard } from '../src/scorecard/parse.js';
import { CLEAN_SCORECARD_YAML, CLEAN_TREE, makeWorkbook, tempDir } from './helpers.js';

const ANCHORS = { '0': 'a', '1': 'b', '2': 'c', '3': 'd', '4': 'e', '5': 'f' };
const REPLY = JSON.stringify({
  scorecard: {
    id: 'GS-1', name: 'GS-1', version: '3.2', judges: 'D1 schema design', thresholds: { accept: 90, refine: 75 },
    artifact: { sheets: [{ name: 'Tree' }] },
    dimensions: [
      { id: 'G01', name: 'Purpose', weight: 60, critical: true, measured_by: 'raters', measure: 'm', anchors: ANCHORS },
      { id: 'G02', name: 'Interview', weight: 40, measured_by: 'human', needs: 'An author interview.' },
    ],
  },
  uncertain: [],
  adjustments: [],
});

/** A provider that answers every scorecard conversion with REPLY, counting the calls. */
function counting(delayMs = 0): { provider: LlmProvider; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    provider: {
      name: 'fake',
      complete: async () => {
        calls += 1;
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        return { text: REPLY, inputTokens: 10, outputTokens: 10 };
      },
    },
  };
}

const deps = (provider: LlmProvider) => [{ provider, model: { id: 'A', provider: 'fake', model: 'm1' }, settings: { temperature: 0, maxOutputTokens: 100 } }];
const csv = (text = 'Dimension,Weight\nPurpose,60\nInterview,40') => ({ name: 'GS1.csv', bytes: Buffer.from(text) });
const tree = async () => ({ name: 'schema.xlsx', bytes: await makeWorkbook({ Tree: CLEAN_TREE }) });

describe('telling the app format apart from any other layout', () => {
  it('reads YAML or JSON with a scorecard key, and the three-sheet Excel layout, as the app format', async () => {
    expect(await isAppFormat({ name: 's.yaml', bytes: Buffer.from(CLEAN_SCORECARD_YAML) })).toBe(true);
    expect(await isAppFormat({ name: 's.json', bytes: Buffer.from(JSON.stringify({ scorecard: {} })) })).toBe(true);
    const excel = await scorecardToWorkbook(parseScorecard(CLEAN_SCORECARD_YAML).scorecard);
    expect(await isAppFormat({ name: 's.xlsx', bytes: excel })).toBe(true);
  });

  it('treats a GS-1 style workbook, a CSV, plain text, a PDF and other YAML as another layout', async () => {
    const gs1 = await makeWorkbook({ Summary: [['Dimension', 'Weight']], Scorecard: [['ID', 'Dimension']], 'Evidence Gates': [['E1']] });
    expect(await isAppFormat({ name: 'GS1.xlsx', bytes: gs1 })).toBe(false);
    expect(await isAppFormat(csv())).toBe(false);
    expect(await isAppFormat({ name: 'rubric.txt', bytes: Buffer.from('Score each 1-10') })).toBe(false);
    expect(await isAppFormat({ name: 'rubric.pdf', bytes: Buffer.from('%PDF-1.4') })).toBe(false);
    expect(await isAppFormat({ name: 'other.yaml', bytes: Buffer.from('rubric:\n  - clarity') })).toBe(false);
    expect(await isAppFormat({ name: 'broken.yaml', bytes: Buffer.from(':::\n\t- [') })).toBe(false);
    expect(await isAppFormat({ name: 'broken.xlsx', bytes: Buffer.from('not a zip') })).toBe(false);
  });
});

describe('the conversion key', () => {
  it('stays the same when the judged file only gains rows, so every iteration reuses the same scorecard', async () => {
    const small = await outlineDocument({ name: 'a.xlsx', bytes: await makeWorkbook({ Tree: CLEAN_TREE }) });
    const bigger = await outlineDocument({ name: 'a.xlsx', bytes: await makeWorkbook({ Tree: [...CLEAN_TREE, ['1.3', 'Owner', 'Who owns it']] }) });
    expect(documentShape(small)).toBe(documentShape(bigger));
    expect(conversionKey(csv(), small)).toBe(conversionKey(csv(), bigger));
  });

  it('changes with the scorecard bytes or the sheet names', async () => {
    const one = await outlineDocument({ name: 'a.xlsx', bytes: await makeWorkbook({ Tree: CLEAN_TREE }) });
    const two = await outlineDocument({ name: 'a.xlsx', bytes: await makeWorkbook({ Tree: CLEAN_TREE, Lists: [['x']] }) });
    expect(conversionKey(csv(), one)).not.toBe(conversionKey(csv(), two));
    expect(conversionKey(csv(), one)).not.toBe(conversionKey(csv('other'), one));
    expect(documentShape(null)).toBe('none');
  });
});

describe('resolving a scorecard', () => {
  it('uses a scorecard in the app format as it is, without calling a model', async () => {
    const model = counting();
    const resolver = new ScorecardResolver({ candidates: () => deps(model.provider) });
    const resolved = await resolver.resolve({ name: 's.yaml', bytes: Buffer.from(CLEAN_SCORECARD_YAML) }, await tree());
    expect(resolved.conversion).toBeNull();
    expect(resolved.hash).toBe(parseScorecard(CLEAN_SCORECARD_YAML).hash);
    expect(model.calls()).toBe(0);
  });

  it('reports the real mistakes of an app-format scorecard instead of converting it', async () => {
    const resolver = new ScorecardResolver({ candidates: () => deps(counting().provider) });
    await expect(resolver.resolve({ name: 's.yaml', bytes: Buffer.from('scorecard: { id: x }') })).rejects.toThrow(/does not match the scorecard format/);
  });

  it('converts any other layout into a frozen scorecard with no question left for a person', async () => {
    const model = counting();
    const resolver = new ScorecardResolver({ candidates: () => deps(model.provider), now: () => new Date('2026-10-23T08:00:00Z') });
    const { scorecard, conversion } = await resolver.resolve(csv(), await tree());
    expect(scorecard.frozen).toBe(true);
    expect(scorecard.dimensions.map((d) => d.measuredBy)).toEqual(['raters', 'raters']);
    expect(scorecard.approval).toMatch(/^Converted automatically from GS1\.csv by fake\/m1 on \d{4}-\d{2}-\d{2}, checked by code$/);
    expect(conversion).toMatchObject({ from: 'GS1.csv', cached: false, model: { provider: 'fake', model: 'm1' }, convertedAt: '2026-10-23T08:00:00.000Z' });
    expect(conversionNote(conversion!)).toMatch(/so it was converted automatically by fake\/m1 on 2026-10-23, checked by code/);
  });

  it('converts once and reuses it: in memory, from disk after a restart, and with the same hash', async () => {
    const dir = await tempDir();
    const model = counting();
    const first = await new ScorecardResolver({ cacheDir: dir, candidates: () => deps(model.provider) }).resolve(csv(), await tree());
    const again = await new ScorecardResolver({ cacheDir: dir, candidates: () => deps(model.provider) }).resolve(csv(), await tree());
    expect(model.calls()).toBe(1);
    expect(again.conversion!.cached).toBe(true);
    expect(again.hash).toBe(first.hash);
    expect(conversionNote(again.conversion!)).toMatch(/so the conversion made automatically by fake\/m1 on \d{4}-\d{2}-\d{2} was reused, checked by code/);
    // Only the finished file is left behind, never a half-written temporary one.
    expect(await readdir(dir)).toEqual([expect.stringMatching(/^[0-9a-f]{32}\.json$/)]);
  });

  it('shares one conversion between submissions of the same scorecard at the same moment', async () => {
    const model = counting(30);
    const resolver = new ScorecardResolver({ candidates: () => deps(model.provider) });
    const doc = await tree();
    const results = await Promise.all([resolver.resolve(csv(), doc), resolver.resolve(csv(), doc), resolver.resolve(csv(), doc)]);
    expect(model.calls()).toBe(1);
    expect(new Set(results.map((r) => r.hash)).size).toBe(1);
    expect(results.filter((r) => r.conversion!.cached)).toHaveLength(2);
  });

  it('converts again when the cached file is damaged or from an older version, and says so in the log', async () => {
    const dir = await tempDir();
    const model = counting();
    const logs: string[] = [];
    await new ScorecardResolver({ cacheDir: dir, candidates: () => deps(model.provider) }).resolve(csv(), await tree());
    const [file] = await readdir(dir);
    await writeFile(path.join(dir, file!), '{ broken');
    await new ScorecardResolver({ cacheDir: dir, candidates: () => deps(model.provider), log: (m) => logs.push(m) }).resolve(csv(), await tree());
    expect(model.calls()).toBe(2);
    expect(logs.join(' ')).toMatch(/ignoring cached scorecard/);

    const entry = JSON.parse(await readFile(path.join(dir, file!), 'utf8'));
    await writeFile(path.join(dir, file!), JSON.stringify({ ...entry, version: 'import/0.1' }));
    await new ScorecardResolver({ cacheDir: dir, candidates: () => deps(model.provider) }).resolve(csv(), await tree());
    expect(model.calls()).toBe(3);
  });

  it('still scores when the cache folder cannot be written; only the reuse is lost', async () => {
    const blocked = path.join(await tempDir(), 'file-not-folder');
    await writeFile(blocked, 'x');
    const logs: string[] = [];
    const resolved = await new ScorecardResolver({ cacheDir: path.join(blocked, 'sub'), candidates: () => deps(counting().provider), log: (m) => logs.push(m) }).resolve(csv());
    expect(resolved.scorecard.frozen).toBe(true);
    expect(logs.join(' ')).toMatch(/could not cache the converted scorecard/);
  });

  it('says plainly when no model is ready to read the scorecard', async () => {
    const resolver = new ScorecardResolver({ candidates: () => [] });
    await expect(resolver.resolve(csv())).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/No model is ready to read this scorecard/) });
  });

  it('does not cache a failed conversion, so the next try calls the model again', async () => {
    let calls = 0;
    const flaky: LlmProvider = {
      name: 'flaky',
      complete: async () => {
        calls += 1;
        if (calls === 1) throw new LlmError('HTTP 503: overloaded', 503);
        return { text: REPLY, inputTokens: 1, outputTokens: 1 };
      },
    };
    const resolver = new ScorecardResolver({ candidates: () => deps(flaky) });
    await expect(resolver.resolve(csv())).rejects.toThrow(/could not turn this into a usable scorecard/);
    const ok = await resolver.resolve(csv());
    expect(ok.conversion!.cached).toBe(false);
  });

  it('previews a conversion with the same content the evaluation will use', async () => {
    const resolver = new ScorecardResolver({ candidates: () => deps(new MockProvider(0)) });
    const doc = await tree();
    const preview = await resolver.preview(csv(), doc);
    const used = await resolver.resolve(csv(), doc);
    expect(preview.cached).toBe(false);
    expect(used.conversion!.cached).toBe(true);
    expect(used.conversion!.yaml).toBe(preview.yaml);
    expect(preview.draft.scorecard.frozen).toBe(true);
    expect(preview.questions.every((q) => q.by !== ('person' as string))).toBe(true);
  });
});
