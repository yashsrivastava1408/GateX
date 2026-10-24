import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EvaluationService } from '../src/api/service.js';
import type { AppConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createDb } from '../src/db/pool.js';
import { Store } from '../src/db/store.js';
import { createProviderFactory } from '../src/llm/registry.js';
import { CLEAN_SCORECARD_YAML, CLEAN_TREE, makeWorkbook, mockModels, tempDir } from './helpers.js';

/** A service on an in-memory database whose model calls are counted, so a conversion can be seen happening (or not). */
async function harness() {
  const db = await createDb({ dbMode: 'memory', databaseUrl: undefined });
  await migrate(db);
  const store = new Store(db);
  const models = mockModels();
  const config: AppConfig = { port: 0, dataDir: await tempDir(), dbMode: 'memory', databaseUrl: undefined, mock: true, mockDelayMs: 0, models };
  const real = createProviderFactory(models, { mockDelayMs: 0 });
  let conversions = 0;
  const service = new EvaluationService({
    store, config, env: {},
    providers: (name) => {
      const provider = real(name);
      return { name: provider.name, complete: async (r) => { if (r.system.includes('SCORECARD_IMPORT')) conversions += 1; return provider.complete(r); } };
    },
  });
  const submit = async (workbook: Buffer, scorecard: { name: string; buffer: Buffer }, projectName = 'Pinned') => {
    const created = await service.submit({ workbook: { name: 'w.xlsx', buffer: workbook }, scorecard, sources: '', projectName });
    await service.idle();
    return store.getRunDetail(created.runId);
  };
  return { db, store, service, submit, conversions: () => conversions, dataDir: config.dataDir };
}

const gs1 = { name: 'GS1.csv', buffer: Buffer.from('Dimension,Weight\nPurpose,40\nDefinitions,40\nAuthor,20') };
const other = { name: 'Other.csv', buffer: Buffer.from('Dimension,Weight\nClarity,100') };

describe('pinning a converted scorecard to a project', () => {
  it('marks iteration 2 against iteration 1\'s scorecard even when a sheet was added, with no new conversion', async () => {
    const h = await harness();
    const first = await h.submit(await makeWorkbook({ Tree: CLEAN_TREE }), gs1);
    // A new sheet changes the file's shape, which without the pin would mean a fresh conversion and a moved target.
    const second = await h.submit(await makeWorkbook({ Tree: CLEAN_TREE, Notes: [['a', 'b'], ['1', '2']] }), gs1);
    expect([first.status, second.status]).toEqual(['done', 'done']);
    expect(h.conversions()).toBe(1);
    expect(second.iteration).toBe(2);
    expect(second.report!.header.scorecardHash).toBe(first.report!.header.scorecardHash);
    expect(second.report!.notes[0]).toBe("This project is pinned to iteration 1's scorecard (converted from GS1.csv), so every iteration is marked against the identical target.");
    expect(first.report!.notes[0]).not.toMatch(/pinned/);
    await h.db.close();
  });

  it('refuses, in plain words, an iteration that renamed a sheet the pinned scorecard reads', async () => {
    const h = await harness();
    await h.submit(await makeWorkbook({ Tree: CLEAN_TREE }), gs1);
    await expect(h.submit(await makeWorkbook({ Renamed: CLEAN_TREE }), gs1)).rejects.toThrow(
      /pinned to iteration 1's scorecard, which reads a sheet "Tree" that this workbook no longer has\. Restore that sheet name, or submit under a new project name/,
    );
    await h.db.close();
  });

  it('starts a new pin for a different scorecard file, and keeps each pin to its own project', async () => {
    const h = await harness();
    const tree = await makeWorkbook({ Tree: CLEAN_TREE });
    const a = await h.submit(tree, gs1);
    const b = await h.submit(tree, other);
    expect(h.conversions()).toBe(2);
    expect(b.report!.header.scorecardHash).not.toBe(a.report!.header.scorecardHash);
    expect(b.report!.notes[0]).not.toMatch(/pinned/);
    // Another project with the same file has no pin of its own yet; it reuses the cached conversion instead.
    const c = await h.submit(tree, gs1, 'Elsewhere');
    expect(h.conversions()).toBe(2);
    expect(c.report!.notes[0]).toMatch(/conversion made automatically .* was reused/);
    expect(c.report!.header.scorecardHash).toBe(a.report!.header.scorecardHash);
    await h.db.close();
  });

  it('does not pin a scorecard in the app\'s own format, which is the same whenever the same file is sent', async () => {
    const h = await harness();
    const yaml = { name: 'card.yaml', buffer: Buffer.from(CLEAN_SCORECARD_YAML) };
    await h.submit(await makeWorkbook({ Tree: CLEAN_TREE }), yaml);
    expect(await h.store.findPin('Pinned', (await import('../src/util/hash.js')).sha256(yaml.buffer))).toBeNull();
    const second = await h.submit(await makeWorkbook({ Tree: CLEAN_TREE }), yaml);
    expect(second.report!.notes.join(' ')).not.toMatch(/pinned/);
    await h.db.close();
  });

  it('keeps the first pin when two are written for the same file, and removes pins with the project', async () => {
    const h = await harness();
    const run = await h.submit(await makeWorkbook({ Tree: CLEAN_TREE }), gs1);
    const { sha256 } = await import('../src/util/hash.js');
    const pin = (await h.store.findPin('Pinned', sha256(gs1.buffer)))!;
    expect(pin).toMatchObject({ sourceName: 'GS1.csv', iteration: 1, scorecardHash: run.report!.header.scorecardHash });
    await h.store.addPin(run.projectId, sha256(gs1.buffer), { ...pin, scorecardHash: 'other', iteration: 9 });
    expect((await h.store.findPin('Pinned', sha256(gs1.buffer)))!.scorecardHash).toBe(pin.scorecardHash);

    await h.service.deleteProject(run.projectId);
    expect(await h.store.findPin('Pinned', sha256(gs1.buffer))).toBeNull();
    // A new project under the same name starts again, without the old pin.
    const fresh = await h.submit(await makeWorkbook({ Tree: CLEAN_TREE }), gs1);
    expect(fresh.iteration).toBe(1);
    expect(fresh.report!.notes[0]).not.toMatch(/pinned/);
    expect(path.isAbsolute(h.dataDir)).toBe(true);
    await h.db.close();
  });
});
