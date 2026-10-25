import { readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunDetail, RunStatus } from '@ddd/shared';
import { createApp } from '../src/api/app.js';
import { EvaluationService } from '../src/api/service.js';
import { loadAppConfig, parseMaxConcurrentRuns, type AppConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createDb, type Db } from '../src/db/pool.js';
import { Store } from '../src/db/store.js';
import type { ProviderFactory } from '../src/llm/registry.js';
import { createProviderFactory } from '../src/llm/registry.js';
import { TALENTRA_SCORECARD, TALENTRA_XLSX, makeWorkbook, mockModels, tempDir } from './helpers.js';

/** Scripted models: the normal mock ones, but every call can be held back until the test lets it through, and the number of live runs is sampled on each call. */
class Gate {
  private open = true;
  private waiters: Array<{ go: () => void; stop: (e: Error) => void }> = [];
  calls = 0;
  peakLive = 0;
  constructor(private readonly db: () => Db) {}
  hold() { this.open = false; }
  release() { this.open = true; for (const w of this.waiters.splice(0)) w.go(); }
  /** Makes held calls fail, as a model outage would (used to let a leftover worker of a "crashed" server end). */
  breakAll() { this.open = true; for (const w of this.waiters.splice(0)) w.stop(new Error('gate closed')); }
  wrap(factory: ProviderFactory): ProviderFactory {
    return (name) => {
      const real = factory(name);
      return {
        name: real.name,
        complete: async (request) => {
          this.calls += 1;
          const [live] = await this.db().query<{ n: number | string }>(`select count(*) as n from runs where status in ('queued', 'running')`);
          this.peakLive = Math.max(this.peakLive, Number(live?.n ?? 0));
          if (!this.open) await new Promise<void>((go, stop) => this.waiters.push({ go, stop }));
          return real.complete(request);
        },
      };
    };
  }
}

interface Harness {
  base: string; db: Db; store: Store; service: EvaluationService; gate: Gate; dataDir: string; config: AppConfig; claimed: string[];
  close(): Promise<void>;
}
const open: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of open.splice(0)) await close(); });

async function testDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return createDb({ dbMode: 'memory', databaseUrl: undefined });
  const schema = `t_${Math.random().toString(36).slice(2, 10)}`;
  const admin = await createDb({ dbMode: 'postgres', databaseUrl: url });
  await admin.query(`create schema ${schema}`);
  await admin.close();
  return createDb({ dbMode: 'postgres', databaseUrl: `${url}${url.includes('?') ? '&' : '?'}options=-c%20search_path%3D${schema}` });
}

async function start(maxConcurrentRuns?: number): Promise<Harness> {
  const models = mockModels();
  const db = await testDb();
  await migrate(db);
  const store = new Store(db);
  const claimed: string[] = [];
  const claim = store.claimNext.bind(store);
  store.claimNext = async () => { const job = await claim(); if (job) claimed.push(job.runId); return job; };
  const config: AppConfig = { port: 0, dataDir: await tempDir(), dbMode: 'memory', databaseUrl: undefined, mock: true, mockDelayMs: 0, models, ...(maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns }) };
  const gate = new Gate(() => db);
  const service = new EvaluationService({ store, config, providers: gate.wrap(createProviderFactory(models, { mockDelayMs: 0 })), env: {} });
  const server: Server = createApp({ store, service, config, env: {} }).listen(0);
  const { port } = server.address() as AddressInfo;
  const h: Harness = {
    base: `http://127.0.0.1:${port}`, db, store, service, gate, dataDir: config.dataDir, config, claimed,
    close: async () => { gate.breakAll(); await service.idle(); await new Promise((r) => server.close(r)); await db.close(); },
  };
  open.push(h.close);
  return h;
}

let workbook: Buffer;
let scorecard: Buffer;
const files = async () => {
  workbook ??= await readFile(TALENTRA_XLSX);
  scorecard ??= await readFile(TALENTRA_SCORECARD);
  return { workbook, scorecard };
};
const send = async (h: Harness, project: string, extra: { quick?: boolean; runTwice?: boolean } = {}) => {
  const f = await files();
  return h.service.submit({ workbook: { name: `${project}.xlsx`, buffer: f.workbook }, scorecard: { name: 'sc.yaml', buffer: f.scorecard }, sources: '', projectName: project, ...extra });
};
const detail = (h: Harness, id: string) => h.store.getRunDetail(id);
const statuses = async (h: Harness, ids: string[]): Promise<RunStatus[]> => Promise.all(ids.map(async (id) => (await detail(h, id)).status));
const post = (h: Harness, id: string, action: string) => fetch(`${h.base}/api/runs/${id}/${action}`, { method: 'POST' });
const untilStatus = async (h: Harness, id: string, status: RunStatus) => {
  for (let i = 0; i < 400; i++) { if ((await detail(h, id)).status === status) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error(`run ${id} never became ${status}`);
};

describe('the setting', () => {
  it('reads MAX_CONCURRENT_RUNS: on with 1 by default, off with 0 or "off", a number for more, a clear error for nonsense', () => {
    expect(parseMaxConcurrentRuns(undefined)).toBe(1);
    expect(parseMaxConcurrentRuns('')).toBe(1);
    expect(parseMaxConcurrentRuns('1')).toBe(1);
    expect(parseMaxConcurrentRuns('0')).toBe(0);
    expect(parseMaxConcurrentRuns('off')).toBe(0);
    expect(parseMaxConcurrentRuns(' OFF ')).toBe(0);
    expect(parseMaxConcurrentRuns('3')).toBe(3);
    expect(() => parseMaxConcurrentRuns('lots')).toThrow(/MAX_CONCURRENT_RUNS/);
    expect(() => parseMaxConcurrentRuns('-1')).toThrow(/MAX_CONCURRENT_RUNS/);
    expect(loadAppConfig({ MOCK_LLM: '1', MAX_CONCURRENT_RUNS: 'off' }).maxConcurrentRuns).toBe(0);
    expect(loadAppConfig({ MOCK_LLM: '1' }).maxConcurrentRuns).toBe(1);
  });
});

describe('one evaluation at a time', () => {
  it('starts the first, keeps the others waiting in order, never has two live, and starts each next one by itself', async () => {
    const h = await start();
    h.gate.hold();
    const a = await send(h, 'Line A');
    const b = await send(h, 'Line B');
    const c = await send(h, 'Line C');
    expect([a.status, b.status, c.status]).toEqual([a.status, 'waiting', 'waiting']);
    expect(a.status).not.toBe('waiting');
    expect([a.queuePosition, b.queuePosition, c.queuePosition]).toEqual([null, 1, 2]);

    // Shown to the person: place in line, saved uploads kept, uploads and viewing stay free.
    const waiting = await detail(h, c.runId);
    expect(waiting).toMatchObject({ status: 'waiting', stage: 'waiting', queuePosition: 2, finishedAt: null });
    const listed = await (await fetch(`${h.base}/api/projects/${b.projectId}`)).json() as { runs: Array<{ status: string; queuePosition: number | null }> };
    expect(listed.runs[0]).toMatchObject({ status: 'waiting', queuePosition: 1 });
    expect((await (await fetch(`${h.base}/api/projects`)).json() as Array<{ latest: { queuePosition: number | null } }>).map((p) => p.latest.queuePosition).filter((n) => n !== null).sort()).toEqual([1, 2]);

    h.gate.release();
    await h.service.idle();
    expect(await statuses(h, [a.runId, b.runId, c.runId])).toEqual(['done', 'done', 'done']);
    expect(h.claimed).toEqual([a.runId, b.runId, c.runId]);
    expect(h.gate.peakLive).toBe(1);
    // Nobody is left waiting and no one keeps a place in line.
    expect(await h.store.waitingIds()).toEqual([]);
    expect((await detail(h, c.runId)).queuePosition).toBeNull();
    // A run that waited really ran: its report is there.
    expect((await detail(h, c.runId)).report).not.toBeNull();
  });

  it('moves everyone up when the front of the line starts', async () => {
    const h = await start();
    h.gate.hold();
    const a = await send(h, 'Up A');
    const b = await send(h, 'Up B');
    const c = await send(h, 'Up C');
    await h.service.cancelRun(b.runId);
    expect((await detail(h, c.runId)).queuePosition).toBe(1);
    h.gate.release();
    await h.service.idle();
    expect(await statuses(h, [a.runId, b.runId, c.runId])).toEqual(['done', 'cancelled', 'done']);
  });

  it('lets a failed run go, and the next one starts', async () => {
    const h = await start();
    h.gate.hold();
    const a = await send(h, 'Fail A');
    const b = await send(h, 'Fail B');
    const c = await send(h, 'Fail C');
    // B loses its saved upload while it waits, so it cannot be read when its turn comes: it fails, and C must still run.
    const [row] = await h.db.query<{ artifact_path: string }>('select artifact_path from runs where id = $1', [b.runId]);
    await rm(row!.artifact_path);
    h.gate.release();
    await h.service.idle();
    expect(await statuses(h, [a.runId, b.runId, c.runId])).toEqual(['done', 'failed', 'done']);
    expect((await detail(h, b.runId)).error).toBeTruthy();
    expect(h.gate.peakLive).toBe(1);
  });

  it('is not blocked by a run whose result cannot be saved: the place is freed and the next one runs', async () => {
    const h = await start();
    h.gate.hold();
    const a = await send(h, 'Crash A');
    const b = await send(h, 'Crash B');
    const complete = h.store.completeRun.bind(h.store);
    let first = true;
    h.store.completeRun = async (...args) => { if (first) { first = false; throw new Error('disk full'); } return complete(...args); };
    h.gate.release();
    await h.service.idle();
    expect(await statuses(h, [a.runId, b.runId])).toEqual(['failed', 'done']);
    expect((await detail(h, a.runId)).error).toMatch(/disk full/);
  });

  it('keeps going when starting the next run itself hits a database error, and picks it up on the next trigger', async () => {
    const h = await start();
    const claim = h.store.claimNext.bind(h.store);
    let broken = true;
    h.store.claimNext = async () => { if (broken) throw new Error('db hiccup'); return claim(); };
    const a = await send(h, 'Hiccup A');
    expect((await detail(h, a.runId)).status).toBe('waiting');
    broken = false;
    expect(await h.service.resume()).toBe(1);
    await h.service.idle();
    expect((await detail(h, a.runId)).status).toBe('done');
  });

  it('puts Run twice and Quick check in the same line, and they keep their choices while they wait', async () => {
    const h = await start();
    h.gate.hold();
    const a = await send(h, 'Mix A');
    const twice = await send(h, 'Mix B', { runTwice: true });
    const quick = await send(h, 'Mix C', { quick: true });
    expect([twice.status, quick.status]).toEqual(['waiting', 'waiting']);
    const options = await h.db.query<{ run_options: unknown }>('select run_options from runs where id in ($1, $2) order by queue_no', [twice.runId, quick.runId]);
    const parsed = options.map((o) => (typeof o.run_options === 'string' ? JSON.parse(o.run_options) : o.run_options));
    expect(parsed[0]).toMatchObject({ runTwice: true, quick: false });
    expect(parsed[1]).toMatchObject({ runTwice: false, quick: true });
    h.gate.release();
    await h.service.idle();
    expect(await statuses(h, [a.runId, twice.runId, quick.runId])).toEqual(['done', 'done', 'done']);
    expect(h.gate.peakLive).toBe(1);
    // The extra passes (double-check, close look) are calls inside one run, so they never open a second place.
    const twiceRun = await detail(h, twice.runId);
    expect(twiceRun.report).not.toBeNull();
    expect(h.claimed).toHaveLength(3);
  });

  it('can be turned off: with 0 every run starts at once and none waits', async () => {
    const h = await start(0);
    h.gate.hold();
    const a = await send(h, 'Off A');
    const b = await send(h, 'Off B');
    const c = await send(h, 'Off C');
    expect([a, b, c].some((r) => r.status === 'waiting')).toBe(false);
    h.gate.release();
    await h.service.idle();
    expect(await statuses(h, [a.runId, b.runId, c.runId])).toEqual(['done', 'done', 'done']);
    expect(h.gate.peakLive).toBeGreaterThan(1);
  });

  it('allows a bigger number when asked (2 at a time)', async () => {
    const h = await start(2);
    h.gate.hold();
    const runs = [await send(h, 'Two A'), await send(h, 'Two B'), await send(h, 'Two C')];
    expect(runs.map((r) => r.status === 'waiting')).toEqual([false, false, true]);
    h.gate.release();
    await h.service.idle();
    expect(await statuses(h, runs.map((r) => r.runId))).toEqual(['done', 'done', 'done']);
    expect(h.gate.peakLive).toBe(2);
  });

  it('stays strictly in order when many are submitted at the same moment', async () => {
    const h = await start();
    h.gate.hold();
    const runs = await Promise.all(['P1', 'P2', 'P3', 'P4'].map((name) => send(h, `Burst ${name}`)));
    expect(runs.filter((r) => r.status !== 'waiting')).toHaveLength(1);
    const order = await h.store.waitingIds();
    expect(order).toHaveLength(3);
    const place = new Set(await Promise.all(order.map(async (id) => (await detail(h, id)).queuePosition)));
    expect([...place].sort()).toEqual([1, 2, 3]);
    h.gate.release();
    await h.service.idle();
    expect(await statuses(h, runs.map((r) => r.runId))).toEqual(['done', 'done', 'done', 'done']);
    expect(h.gate.peakLive).toBe(1);
  });
});

describe('cancelling', () => {
  it('takes a waiting run out of the line, over the API, and keeps its record', async () => {
    const h = await start();
    h.gate.hold();
    const a = await send(h, 'Cancel A');
    const b = await send(h, 'Cancel B');
    const res = await post(h, b.runId, 'cancel');
    expect(res.status).toBe(200);
    const body = (await res.json()) as RunDetail;
    expect(body).toMatchObject({ status: 'cancelled', stage: 'cancelled', queuePosition: null });
    expect(body.error).toMatch(/Cancelled/);
    expect(body.finishedAt).not.toBeNull();
    // Asking twice is harmless; the run never starts.
    expect((await post(h, b.runId, 'cancel')).status).toBe(200);
    h.gate.release();
    await h.service.idle();
    expect(h.claimed).toEqual([a.runId]);
    expect((await detail(h, b.runId)).status).toBe('cancelled');
    // It can then be deleted like any finished run.
    expect((await fetch(`${h.base}/api/runs/${b.runId}`, { method: 'DELETE' })).status).toBe(204);
  });

  it('says plainly that a run that already started cannot be stopped, and that a finished one needs nothing', async () => {
    const h = await start();
    h.gate.hold();
    const a = await send(h, 'Late A');
    const res = await post(h, a.runId, 'cancel');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/already started and cannot be stopped/);
    h.gate.release();
    await h.service.idle();
    const after = await post(h, a.runId, 'cancel');
    expect(after.status).toBe(409);
    expect(((await after.json()) as { error: string }).error).toMatch(/already finished/);
    expect((await post(h, 'nope', 'cancel')).status).toBe(404);
  });

  it('refuses to delete a waiting run or its project until it is cancelled', async () => {
    const h = await start();
    h.gate.hold();
    await send(h, 'Keep A');
    const b = await send(h, 'Keep B');
    const del = await fetch(`${h.base}/api/runs/${b.runId}`, { method: 'DELETE' });
    expect(del.status).toBe(409);
    expect(((await del.json()) as { error: string }).error).toMatch(/Cancel it first/);
    expect((await fetch(`${h.base}/api/projects/${b.projectId}`, { method: 'DELETE' })).status).toBe(409);
    await h.service.cancelRun(b.runId);
    expect((await fetch(`${h.base}/api/projects/${b.projectId}`, { method: 'DELETE' })).status).toBe(204);
  });
});

describe('restarting the server', () => {
  it('fails the run that was mid-way, keeps the waiting ones, and carries on with the line in order', async () => {
    const h = await start();
    h.gate.hold();
    const a = await send(h, 'Boot A');
    const b = await send(h, 'Boot B');
    const c = await send(h, 'Boot C');
    await untilStatus(h, a.runId, 'running').catch(() => undefined);

    // The server "dies": a new service starts on the same database and data folder.
    const failed = await h.store.failInterrupted();
    expect(failed).toBe(1);
    expect(await statuses(h, [a.runId, b.runId, c.runId])).toEqual(['failed', 'waiting', 'waiting']);
    expect((await detail(h, a.runId)).error).toMatch(/server stopped/);
    expect(await h.store.waitingIds()).toEqual([b.runId, c.runId]);

    const gate2 = new Gate(() => h.db);
    const second = new EvaluationService({ store: h.store, config: h.config, providers: gate2.wrap(createProviderFactory(h.config.models, { mockDelayMs: 0 })), env: {} });
    h.claimed.length = 0;
    expect(await second.resume()).toBe(2);
    await second.idle();
    expect(await statuses(h, [a.runId, b.runId, c.runId])).toEqual(['failed', 'done', 'done']);
    expect(h.claimed).toEqual([b.runId, c.runId]);
    expect(gate2.peakLive).toBe(1);
    // The old worker of the dead server ends without touching the line.
    h.gate.breakAll();
    await h.service.idle();
  });

  it('with nothing waiting, resuming does nothing', async () => {
    const h = await start();
    expect(await h.service.resume()).toBe(0);
  });
});

describe('the database', () => {
  it('treats runs saved before the line existed (no place, no saved choices) as ordinary finished runs', async () => {
    const db = await testDb();
    expect(await migrate(db)).toContain('004_waiting_line.sql');
    await db.query(`insert into projects (id, name) values ('p1', 'Old')`);
    await db.query(`insert into runs (id, project_id, iteration, status, stage) values ('r1', 'p1', 1, 'done', 'done')`);
    const store = new Store(db);
    expect(await store.waitingIds()).toEqual([]);
    expect(await store.getRunDetail('r1')).toMatchObject({ status: 'done', queuePosition: null });
    await db.close();
  });
});

void makeWorkbook;
