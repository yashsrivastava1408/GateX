import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bandOf, type ConfigResponse, type ProjectHistory, type ProjectSummary, type RunDetail } from '@ddd/shared';
import { createApp } from '../src/api/app.js';
import { EvaluationService } from '../src/api/service.js';
import type { AppConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createDb, type Db } from '../src/db/pool.js';
import { Store } from '../src/db/store.js';
import { createProviderFactory } from '../src/llm/registry.js';
import { CLEAN_SCORECARD_YAML, CLEAN_TREE, TALENTRA_SCORECARD, TALENTRA_XLSX, makeWorkbook, mockModels, patchCells, tempDir } from './helpers.js';
import type { Server } from 'node:http';

interface Harness {
  base: string;
  dataDir: string;
  store: Store;
  service: EvaluationService;
  db: Db;
  close(): Promise<void>;
}

/**
 * In-memory Postgres by default. Set TEST_DATABASE_URL to run the same tests against a
 * real Postgres; each harness then gets its own schema so they cannot disturb each other.
 */
async function testDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return createDb({ dbMode: 'memory', databaseUrl: undefined });
  const schema = `t_${Math.random().toString(36).slice(2, 10)}`;
  const admin = await createDb({ dbMode: 'postgres', databaseUrl: url });
  await admin.query(`create schema ${schema}`);
  await admin.close();
  return createDb({ dbMode: 'postgres', databaseUrl: `${url}${url.includes('?') ? '&' : '?'}options=-c%20search_path%3D${schema}` });
}

async function start(models = mockModels()): Promise<Harness> {
  const db = await testDb();
  await migrate(db);
  const store = new Store(db);
  const config: AppConfig = { port: 0, dataDir: await tempDir(), dbMode: process.env.TEST_DATABASE_URL ? 'postgres' : 'memory', databaseUrl: process.env.TEST_DATABASE_URL, mock: true, mockDelayMs: 0, models };
  const providers = createProviderFactory(models, { mockDelayMs: 0 });
  const service = new EvaluationService({ store, config, providers, env: {} });
  const server: Server = createApp({ store, service, config, env: {} }).listen(0);
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`, dataDir: config.dataDir, store, service, db,
    close: async () => { await service.idle(); await new Promise((r) => server.close(r)); await db.close(); },
  };
}

async function submit(h: Harness, files: { workbook?: Buffer; scorecard?: string | Buffer; name?: string; scorecardName?: string; projectName?: string; instructions?: string; runTwice?: boolean }) {
  const form = new FormData();
  if (files.workbook) form.append('workbook', new Blob([new Uint8Array(files.workbook)]), files.name ?? 'schema.xlsx');
  if (files.scorecard !== undefined) form.append('scorecard', new Blob([typeof files.scorecard === 'string' ? files.scorecard : new Uint8Array(files.scorecard)]), files.scorecardName ?? 'scorecard.yaml');
  if (files.instructions !== undefined) form.append('instructions', files.instructions);
  if (files.projectName) form.append('projectName', files.projectName);
  if (files.runTwice) form.append('runTwice', '1');
  const res = await fetch(`${h.base}/api/runs`, { method: 'POST', body: form });
  return { status: res.status, body: (await res.json()) as { runId?: string; iteration?: number; projectId?: string; error?: string } };
}

async function done(h: Harness, runId: string): Promise<RunDetail> {
  await h.service.idle();
  return (await (await fetch(`${h.base}/api/runs/${runId}`)).json()) as RunDetail;
}

const json = async <T>(res: Response) => (await res.json()) as T & { error?: string };
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

let h: Harness;
let talentra: Buffer;
let scorecard: string;

beforeAll(async () => {
  h = await start();
  talentra = await readFile(TALENTRA_XLSX);
  scorecard = await readFile(TALENTRA_SCORECARD, 'utf8');
});
afterAll(() => h.close());

describe('API', () => {
  it('reports health and a ready roster, and never exposes a key', async () => {
    expect((await (await fetch(`${h.base}/api/health`)).json())).toMatchObject({ ok: true });
    const config = await json<ConfigResponse>(await fetch(`${h.base}/api/config`));
    expect(config.ready).toBe(true);
    expect(config.raters).toHaveLength(3);
    expect(config.consolidator.id).toBe('K');
    expect(JSON.stringify(config)).not.toMatch(/api[_-]?key"\s*:\s*"[^"]{8,}/i);
  });

  it('accepts a submission, runs it in the background and serves the finished report', async () => {
    const res = await submit(h, { workbook: talentra, scorecard, name: 'Talentra.xlsx', projectName: 'Talentra' });
    expect(res.status).toBe(202);
    expect(res.body.iteration).toBe(1);
    const run = await done(h, res.body.runId!);
    expect(run).toMatchObject({ status: 'done', stage: 'done', projectName: 'Talentra', iteration: 1, gate: 'D1', agentDecision: bandOf(run.report!.verdict.weightedScore) });
    expect(run.report!.header.artifactName).toBe('Talentra.xlsx');
    expect(Object.keys(run.report!)).toEqual(expect.arrayContaining(['header', 'verdict', 'dimensions', 'strengths', 'findings', 'agreement', 'notMeasurable', 'pathToGreen']));
    expect(run.progress!.participants.map((p) => p.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(run.runLog!.participants).toHaveLength(4);
  });

  type Rejection = [string, { workbook?: Buffer | 'tree'; name?: string; scorecard?: string }, RegExp];
  const rejections: Rejection[] = [
    ['no workbook', { scorecard: CLEAN_SCORECARD_YAML }, /Attach the file to evaluate/],
    ['no scorecard', { workbook: Buffer.from('x') }, /Attach the scorecard \(any layout/],
    ['a workbook that is not .xlsx', { workbook: Buffer.from('x'), name: 'notes.txt', scorecard: CLEAN_SCORECARD_YAML }, /must be an \.xlsx/],
    ['a file that is not a real workbook', { workbook: Buffer.from('not a zip'), scorecard: CLEAN_SCORECARD_YAML }, /not a valid \.xlsx/],
    ['a scorecard in the wrong format', { workbook: 'tree', scorecard: 'scorecard: { id: x }' }, /does not match the scorecard format/],
    ['a scorecard naming a column that is missing', { workbook: 'tree', scorecard: CLEAN_SCORECARD_YAML.replace('sheets: [{ name: Tree, header_row: 1 }]', 'sheets: [{ name: Tree, header_row: 1, columns: [Nope] }]') }, /Column "Nope" named by the scorecard was not found in sheet "Tree"/],
    ['a scorecard naming a sheet that is missing', { workbook: 'tree', scorecard: CLEAN_SCORECARD_YAML.replace('name: Tree', 'name: Nope') }, /sheet "Nope" that this workbook does not have/],
  ];
  it.each(rejections)('rejects %s straight away with a clear message', async (_name, input, message) => {
    const workbook = input.workbook === 'tree' ? await makeWorkbook({ Tree: CLEAN_TREE }) : input.workbook;
    const res = await submit(h, { ...input, workbook });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
    expect(res.body.runId).toBeUndefined();
  });

  it('refuses to start when the roster is not ready, and says what to fix', async () => {
    const models = mockModels();
    models.approved = [];
    const closed = await start(models);
    const res = await submit(closed, { workbook: await makeWorkbook({ Tree: CLEAN_TREE }), scorecard: CLEAN_SCORECARD_YAML });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/roster is not ready.*not on the approved list/s);
    await closed.close();
  });

  it('shows a failed evaluation with its reason instead of hanging', async () => {
    const broken = await start(mockModels(['mock-down', 'mock-down', 'mock-down']));
    const res = await submit(broken, { workbook: await makeWorkbook({ Tree: CLEAN_TREE }), scorecard: CLEAN_SCORECARD_YAML });
    const run = await done(broken, res.body.runId!);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/All three raters failed/);
    expect(run.report).toBeNull();
    await broken.close();
  });

  it('refuses the same file as both the file to check and the scorecard, before anything is stored', async () => {
    const book = await makeWorkbook({ Tree: CLEAN_TREE });
    const res = await submit(h, { workbook: book, scorecard: book, scorecardName: 'same.xlsx', projectName: 'Same file' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/same file/);
    expect(res.body.runId).toBeUndefined();
  });

  it('scores a scorecard marked frozen: false straight away, with no approval step', async () => {
    const res = await submit(h, { workbook: await makeWorkbook({ Tree: CLEAN_TREE }), scorecard: CLEAN_SCORECARD_YAML.replace('frozen: true', 'frozen: false'), projectName: 'Not frozen' });
    expect(res.status).toBe(202);
    expect((await done(h, res.body.runId!)).status).toBe('done');
  });

  it('never waits for a person: the interview question is scored by the examiners, and there is no evidence endpoint', async () => {
    const res = await submit(h, { workbook: await makeWorkbook({ Tree: CLEAN_TREE }), scorecard: CLEAN_SCORECARD_YAML, projectName: 'Clean' });
    const run = await done(h, res.body.runId!);
    expect(run.report!.notMeasurable).toEqual([]);
    expect(run.report!.dimensions.find((d) => d.id === 'H01')).toMatchObject({ measuredBy: 'raters', status: 'scored' });
    expect(run.report!.verdict.reasons.join(' ')).not.toMatch(/person|must supply/i);
    expect(run).not.toHaveProperty('evidence');
    const evidence = await post(`${h.base}/api/runs/${res.body.runId}/evidence`, { dimensionId: 'H01', note: 'Interview', by: 'Mentor', score: 5 });
    expect(evidence.status).toBe(404);
  });

  it('keeps the optional override: recomputes the verdict and keeps the agent verdict visible', async () => {
    const res = await submit(h, { workbook: await makeWorkbook({ Tree: CLEAN_TREE }), scorecard: CLEAN_SCORECARD_YAML, projectName: 'Overridden' });
    const before = await done(h, res.body.runId!);
    const noReason = await post(`${h.base}/api/runs/${res.body.runId}/override`, { decision: 'green', reason: '', by: 'Lead' });
    expect((await json(noReason)).error).toMatch(/written reason is required/);
    const overridden = await json<RunDetail>(await post(`${h.base}/api/runs/${res.body.runId}/override`, { decision: 'red', reason: 'Schema is being replaced', by: 'Lead' }));
    expect(overridden.report!.verdict).toMatchObject({ decision: 'red', override: { by: 'Lead', reason: 'Schema is being replaced' } });
    expect(overridden.agentDecision).toBe(before.report!.verdict.agentDecision);
    expect(overridden.finalDecision).toBe('red');
  });

  it('downloads the report as a real workbook (seven plainly named sheets), a PDF, Markdown and JSON', async () => {
    const list = await json<ProjectSummary[]>(await fetch(`${h.base}/api/projects`));
    const run = list.find((p) => p.name === 'Talentra')!.latest!;

    const xlsx = await fetch(`${h.base}/api/runs/${run.id}/report.xlsx`);
    expect(xlsx.headers.get('content-disposition')).toMatch(/Talentra-iteration-1\.xlsx/);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await xlsx.arrayBuffer()) as ArrayBuffer);
    expect(book.worksheets.map((s) => s.name)).toEqual(['Summary', 'Areas', 'Issues', 'Strengths', 'Examiners', 'Path to green', 'Not checked']);
    expect(String(book.getWorksheet('Summary')!.getRow(2).getCell(2).value)).toMatch(/^(RED|AMBER|GREEN) - /);

    const pdf = await fetch(`${h.base}/api/runs/${run.id}/report.pdf`);
    expect(pdf.headers.get('content-type')).toMatch(/application\/pdf/);
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');

    const md = await (await fetch(`${h.base}/api/runs/${run.id}/report.md`)).text();
    for (const heading of ['## What this means', '## What to fix first', '## How each area scored', '## Your path to green', '## What is already good', '## How the examiners compared', '## Not checked from the file', '## About this check']) {
      expect(md).toContain(heading);
    }
    const exported = JSON.parse(await (await fetch(`${h.base}/api/runs/${run.id}/report.json`)).text()).verdict;
    expect(exported.decision).toBe(bandOf(exported.weightedScore));
    expect((await fetch(`${h.base}/api/runs/${run.id}/report.docx`)).status).toBe(404);
  });

  it('answers 404 for an unknown run, project or endpoint', async () => {
    expect((await fetch(`${h.base}/api/runs/nope`)).status).toBe(404);
    expect((await fetch(`${h.base}/api/projects/nope`)).status).toBe(404);
    expect((await fetch(`${h.base}/api/nope`)).status).toBe(404);
  });
});

describe('keeping a copy of every result as files', () => {
  it('writes the report in all four formats when a run finishes, and again after an override', async () => {
    const h3 = await start();
    const created = await submit(h3, { workbook: talentra, scorecard, projectName: 'Saved copy' });
    await h3.service.idle();
    const folder = path.join(h3.dataDir, 'reports', 'Saved_copy', 'iteration-1');
    for (const name of ['report.json', 'report.md', 'report.xlsx', 'report.pdf']) {
      expect((await stat(path.join(folder, name))).size).toBeGreaterThan(100);
    }
    expect((await readFile(path.join(folder, 'report.pdf'))).subarray(0, 5).toString()).toBe('%PDF-');
    expect(JSON.parse(await readFile(path.join(folder, 'report.json'), 'utf8')).verdict.override).toBeNull();

    await fetch(`${h3.base}/api/runs/${created.body.runId}/override`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'red', reason: 'Replaced next week', by: 'Lead' }),
    });
    const after = JSON.parse(await readFile(path.join(folder, 'report.json'), 'utf8')) as { verdict: { decision: string; override: { by: string } } };
    expect(after.verdict).toMatchObject({ decision: 'red', override: { by: 'Lead' } });
    await h3.close();
  });
});

describe('importing a scorecard through the API', () => {
  it('converts a scorecard in any layout, frozen and ready, with no approval step', async () => {
    const h2 = await start();
    const form = new FormData();
    form.append('scorecard', new Blob(['a scorecard in some other layout']), 'theirs.csv');
    const res = await fetch(`${h2.base}/api/scorecards/import`, { method: 'POST', body: form });
    const body = (await res.json()) as { yaml: string; summary: Record<string, number>; sourceText: string; draft?: unknown; cached: boolean; questions: Array<{ id: string; by: string }> };
    expect(res.status).toBe(200);
    expect(body.summary).toEqual({ dimensions: 3, byExaminers: 4, byCode: 0, critical: 1, weightTotal: 100 }); // G03 has two criteria
    expect(body.sourceText).toContain('some other layout');
    expect(body.questions.map((q) => [q.id, q.by])).toEqual([['G01', 'examiners'], ['G02', 'examiners'], ['G03', 'examiners']]);
    expect(body.yaml).toMatch(/frozen: true/);
    expect(body.yaml).toMatch(/Converted automatically from theirs\.csv by mock\//);
    expect(body.yaml).not.toMatch(/human/);
    expect(body.draft).toBeUndefined();
    expect(body.cached).toBe(false);
    // The same file again reuses the conversion instead of calling the model.
    const again = (await (await fetch(`${h2.base}/api/scorecards/import`, { method: 'POST', body: form })).json()) as { yaml: string; cached: boolean };
    expect(again).toMatchObject({ cached: true, yaml: body.yaml });

    const post = (payload: object) => fetch(`${h2.base}/api/scorecards/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const checked = (await (await post({ yaml: body.yaml.replace('frozen: true', 'frozen: false') })).json()) as { yaml: string };
    expect(checked.yaml).toMatch(/frozen: true/);
    expect((await post({ yaml: 'scorecard: { id: x }' })).status).toBe(400);

    expect((await fetch(`${h2.base}/api/scorecards/import`, { method: 'POST', body: new FormData() })).status).toBe(400);
    const wrongType = new FormData();
    wrongType.append('scorecard', new Blob(['x']), 'theirs.exe');
    expect((await fetch(`${h2.base}/api/scorecards/import`, { method: 'POST', body: wrongType })).status).toBe(400);
    await h2.close();
  });

  it('evaluates straight away against a scorecard in another layout, and every iteration reuses the identical conversion', async () => {
    const h2 = await start();
    let importCalls = 0;
    const counting = new EvaluationService({
      store: h2.store,
      config: { port: 0, dataDir: h2.dataDir, dbMode: 'memory', databaseUrl: undefined, mock: true, mockDelayMs: 0, models: mockModels() },
      providers: (name) => {
        const real = createProviderFactory(mockModels(), { mockDelayMs: 0 })(name);
        return { name: real.name, complete: async (r) => { if (r.system.includes('SCORECARD_IMPORT')) importCalls += 1; return real.complete(r); } };
      },
      env: {},
    });
    const workbook = await makeWorkbook({ Tree: CLEAN_TREE });
    const csv = { name: 'GS1-scorecard.csv', buffer: Buffer.from('Dimension,Weight\nPurpose,40\nDefinitions,40\nAuthor,20') };
    const first = await counting.submit({ workbook: { name: 'w.xlsx', buffer: workbook }, scorecard: csv, sources: '', projectName: 'Any layout' });
    await counting.idle();
    const second = await counting.submit({ workbook: { name: 'w.xlsx', buffer: workbook }, scorecard: csv, sources: '', projectName: 'Any layout' });
    await counting.idle();
    expect(importCalls).toBe(1);
    const [a, b] = [await h2.store.getRunDetail(first.runId), await h2.store.getRunDetail(second.runId)];
    expect([a.status, b.status]).toEqual(['done', 'done']);
    expect(b.iteration).toBe(2);
    expect(a.report!.header.scorecardHash).toBe(b.report!.header.scorecardHash);
    expect(a.report!.header.scorecardApproval).toMatch(/^Converted automatically from GS1-scorecard\.csv by mock\//);
    expect(a.report!.notes[0]).toMatch(/not in this app's format, so it was converted automatically by mock\//);
    // The second iteration uses the scorecard the project pinned at iteration 1 (tests/pinning.test.ts covers the pin).
    expect(b.report!.notes[0]).toMatch(/pinned to iteration 1's scorecard \(converted from GS1-scorecard\.csv\)/);
    expect(a.report!.notMeasurable).toEqual([]);
    // The conversion is kept on disk, so a restart reuses it too.
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(path.join(h2.dataDir, 'scorecards'))).filter((f) => f.endsWith('.json'))).toHaveLength(1);
    await h2.close();
  });
});

describe('refusing an evaluation the raters cannot take', () => {
  it('says so at submit, in plain words, and stores nothing', async () => {
    const models = mockModels();
    models.raters[0]!.maxInputTokens = 100;
    models.raters[2]!.maxInputTokens = 100;
    const limited = await start(models);
    const res = await submit(limited, { workbook: talentra, scorecard, projectName: 'Too big' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/only 1 of 3 raters can take that/);
    expect(res.body.runId).toBeUndefined();
    expect(await json<ProjectSummary[]>(await fetch(`${limited.base}/api/projects`))).toEqual([]);
    await limited.close();
  });
});

describe('Excel scorecards and the instructions box', () => {
  it('accepts a scorecard written in Excel and runs it exactly like the same scorecard in YAML', async () => {
    const { parseScorecard } = await import('../src/scorecard/parse.js');
    const { scorecardToWorkbook } = await import('../src/scorecard/excel.js');
    const excel = await scorecardToWorkbook(parseScorecard(scorecard).scorecard);
    const viaYaml = await submit(h, { workbook: talentra, scorecard, projectName: 'Same card' });
    const viaExcel = await submit(h, { workbook: talentra, scorecard: excel, scorecardName: 'scorecard.xlsx', projectName: 'Same card' });
    expect(viaExcel.status).toBe(202);
    const [a, b] = [await done(h, viaYaml.body.runId!), await done(h, viaExcel.body.runId!)];
    expect(b.status).toBe('done');
    expect(b.report!.header.scorecardHash).toBe(a.report!.header.scorecardHash);
    expect(b.report!.verdict.weightedScore).toBe(a.report!.verdict.weightedScore);
  });

  it('tells the person which Excel row to fix', async () => {
    const bad = await makeWorkbook({
      Scorecard: [['Setting', 'Value'], ['id', 'X'], ['version', '1'], ['judges', 'D1'], ['frozen', 'yes']],
      Sheets: [['Sheet'], ['Tree']],
      Dimensions: [['ID', 'Name', 'Weight'], ['C01', 'Thing', 'lots']],
    });
    const res = await submit(h, { workbook: await makeWorkbook({ Tree: CLEAN_TREE }), scorecard: bad, scorecardName: 'bad.xlsx' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/bad\.xlsx does not match the scorecard format.*Dimensions sheet, row 2 \(C01\): Weight:/s);
  });

  it('serves a starter Excel scorecard that is valid as it stands', async () => {
    const response = await fetch(`${h.base}/api/scorecard-template.xlsx`);
    expect(response.headers.get('content-disposition')).toMatch(/scorecard-template\.xlsx/);
    const { parseScorecardFile } = await import('../src/scorecard/parse.js');
    const { scorecard: parsed } = await parseScorecardFile(Buffer.from(await response.arrayBuffer()), 'scorecard-template.xlsx');
    expect(parsed.frozen).toBe(true);
    expect(parsed.dimensions.map((d) => d.measuredBy)).toEqual(['code', 'raters', 'raters']);
    // and it really runs, against a workbook that has the sheet and column it names
    const res = await submit(h, { workbook: await makeWorkbook({ Tree: CLEAN_TREE }), scorecard: Buffer.from(await (await fetch(`${h.base}/api/scorecard-template.xlsx`)).arrayBuffer()), scorecardName: 'template.xlsx', projectName: 'From template' });
    expect(res.status).toBe(202);
    expect((await done(h, res.body.runId!)).status).toBe('done');
  });

  it('records the extra instructions with the run and shows them in the report header', async () => {
    const res = await submit(h, { workbook: await makeWorkbook({ Tree: CLEAN_TREE }), scorecard: CLEAN_SCORECARD_YAML, projectName: 'With notes', instructions: '  Focus on the Definition column.  ' });
    const run = await done(h, res.body.runId!);
    expect(run.report!.header.instructions).toBe('Focus on the Definition column.');
    expect(run.report!.header.instructionsHash).toMatch(/^[0-9a-f]{64}$/);
    const none = await done(h, (await submit(h, { workbook: await makeWorkbook({ Tree: CLEAN_TREE }), scorecard: CLEAN_SCORECARD_YAML, projectName: 'No notes' })).body.runId!);
    expect(none.report!.header.instructions).toBeUndefined();
    expect(none.report!.header.instructionsHash).toBeUndefined();
  });

  it('runs the check twice when asked, and records both scores and the average', async () => {
    const res = await submit(h, { workbook: await makeWorkbook({ Tree: CLEAN_TREE }), scorecard: CLEAN_SCORECARD_YAML, projectName: 'Twice', runTwice: true });
    const run = await done(h, res.body.runId!);
    expect(run.status).toBe('done');
    const two = run.report!.twoRuns!;
    expect(two.scores).toHaveLength(2);
    expect(run.report!.verdict.weightedScore).toBe(two.average);
    const single = await done(h, (await submit(h, { workbook: await makeWorkbook({ Tree: CLEAN_TREE }), scorecard: CLEAN_SCORECARD_YAML, projectName: 'Once' })).body.runId!);
    expect(single.report!.twoRuns).toBeUndefined();
  });

  it('refuses instructions that are too long, with the numbers', async () => {
    const res = await submit(h, { workbook: await makeWorkbook({ Tree: CLEAN_TREE }), scorecard: CLEAN_SCORECARD_YAML, instructions: 'x'.repeat(4001) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/4001 characters; the limit is 4000/);
  });
});

describe('history across iterations', () => {
  it('numbers the iterations, tracks the score and shows what was fixed, what stayed and what is new', async () => {
    const project = 'Iterating';
    const blank = (from: number, count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`H${from + i}`, null]));

    const v1 = await submit(h, { workbook: await patchCells(talentra, 'Tree', { ...blank(20, 12), E10: 4 }), scorecard, projectName: project });
    const v2 = await submit(h, { workbook: await patchCells(talentra, 'Tree', blank(20, 3)), scorecard, projectName: project });
    const v3 = await submit(h, { workbook: talentra, scorecard, projectName: project });
    expect([v1.body.iteration, v2.body.iteration, v3.body.iteration]).toEqual([1, 2, 3]);
    expect(new Set([v1.body.projectId, v2.body.projectId, v3.body.projectId]).size).toBe(1);
    await h.service.idle();

    const history = await json<ProjectHistory>(await fetch(`${h.base}/api/projects/${v1.body.projectId}`));
    expect(history.runs.map((r) => r.iteration)).toEqual([1, 2, 3]);
    const scores = history.trend.map((t) => t.score!);
    expect(scores[0]!).toBeLessThan(scores[1]!);
    expect(scores[1]!).toBeLessThan(scores[2]!);
    expect(history.thresholds).toEqual({ accept: 75, refine: 60 });

    expect(history.dimensions.map((d) => d.dimensionId)).toEqual(['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'J01', 'J02', 'J03', 'J04', 'J05', 'J06', 'H01']);
    const c01 = history.dimensions.find((d) => d.dimensionId === 'C01')!;
    expect(c01.scores).toEqual([1, 5, 5]);
    const diffs = history.findingDiffs;
    expect(diffs[0]).toMatchObject({ fixed: 0, stillOpen: 0 });
    expect(diffs[1]!.fixed).toBeGreaterThan(0);
    expect(diffs[1]!.stillOpen).toBeGreaterThan(0);
    expect(diffs[2]!.fixed).toBeGreaterThan(0);

    const projects = await json<ProjectSummary[]>(await fetch(`${h.base}/api/projects`));
    expect(projects.find((p) => p.name === project)).toMatchObject({ runCount: 3, scores });
  });

  it('marks runs left unfinished by a crashed server as failed on the next start', async () => {
    const created = await h.store.createRun({
      projectName: 'Orphan', gate: 'D1', scorecard: (await import('../src/scorecard/parse.js')).parseScorecard(CLEAN_SCORECARD_YAML).scorecard,
      scorecardHash: 'h', sources: '', instructions: '', artifactName: 'a.xlsx', artifactHash: 'h', artifactPath: '/x', progress: { participants: [] },
    });
    await h.store.setStage(created.runId, 'rating');
    expect(await h.store.failInterrupted()).toBeGreaterThanOrEqual(1);
    expect((await h.store.getRunDetail(created.runId)).error).toMatch(/server stopped/);
  });
});

describe('deleting', () => {
  it('removes a run with its rows and files, then the project once it is empty, and refuses unknown ids', async () => {
    const first = await submit(h, { workbook: talentra, scorecard, name: 'Gone.xlsx', projectName: 'Gone' });
    const second = await submit(h, { workbook: talentra, scorecard, name: 'Gone.xlsx', projectName: 'Gone' });
    await done(h, second.body.runId!);
    const upload = path.join(h.dataDir, 'uploads', first.body.runId!);
    await stat(upload);

    expect((await fetch(`${h.base}/api/runs/${first.body.runId}`, { method: 'DELETE' })).status).toBe(204);
    await expect(stat(upload)).rejects.toThrow();
    expect((await fetch(`${h.base}/api/runs/${first.body.runId}`)).status).toBe(404);
    expect((await fetch(`${h.base}/api/runs/${second.body.runId}`)).status).toBe(200);

    expect((await fetch(`${h.base}/api/projects/${first.body.projectId}`, { method: 'DELETE' })).status).toBe(204);
    await expect(stat(path.join(h.dataDir, 'reports', 'Gone'))).rejects.toThrow();
    expect((await fetch(`${h.base}/api/projects/${first.body.projectId}`)).status).toBe(404);
    expect((await fetch(`${h.base}/api/runs/${second.body.runId}`)).status).toBe(404);
    const names = (await json<ProjectSummary[]>(await fetch(`${h.base}/api/projects`))).map((p) => p.name);
    expect(names).not.toContain('Gone');

    expect((await fetch(`${h.base}/api/runs/nope`, { method: 'DELETE' })).status).toBe(404);
    expect((await fetch(`${h.base}/api/projects/nope`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('keeping saved results in line with the rule', () => {
  it('rewrites a result that an older rule saved, and leaves the others alone', async () => {
    const res = await submit(h, { workbook: talentra, scorecard, name: 'Stale.xlsx', projectName: 'Stale' });
    const run = await done(h, res.body.runId!);
    await h.db.query("update runs set final_decision = 'green', weighted_score = 100 where id = $1", [res.body.runId]);
    expect(await h.store.refreshVerdicts()).toBeGreaterThanOrEqual(1);
    const after = await json<RunDetail>(await fetch(`${h.base}/api/runs/${res.body.runId}`));
    expect(after.finalDecision).toBe(run.finalDecision);
    expect(await h.store.refreshVerdicts()).toBe(0);
    await fetch(`${h.base}/api/projects/${res.body.projectId}`, { method: 'DELETE' });
  });
});
