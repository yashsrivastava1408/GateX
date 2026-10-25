import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MINIMUMS, bandOf, computeAccuracy, verdictFromScores,
  type AccuracyInput, type AccuracyReport, type AccuracySlice, type FindingLabel, type HumanReview, type MeasureResult, type RerunGroup, type RunDetail, type ScorePair, type VerdictPair,
} from '@ddd/shared';
import { createApp } from '../src/api/app.js';
import { EvaluationService } from '../src/api/service.js';
import type { AppConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createDb, type Db } from '../src/db/pool.js';
import { Store } from '../src/db/store.js';
import { createProviderFactory } from '../src/llm/registry.js';
import { loadAccuracy, loadAccuracyInput, readCalibrationForm, readSpotSheet, rerunGroups, scanReports, type RunFacts } from '../src/library/accuracyData.js';
import { CLEAN_SCORECARD_YAML, CLEAN_TREE, makeWorkbook, mockModels, tempDir } from './helpers.js';

const empty = (): AccuracySlice => ({ scores: [], verdicts: [], labels: [] });
const input = (over: Partial<AccuracyInput> = {}): AccuracyInput => ({ human: empty(), aiStandin: empty(), reruns: [], ...over });
const find = (rows: MeasureResult[], id: string, origin?: string) => rows.find((r) => r.id === id && (origin === undefined || r.origin === origin))!;

/** `count` different questions across `files` files, the first `off` of them two points away from the reference. */
function scorePairs(count: number, files: number, off = 0, step = 'Step 2'): ScorePair[] {
  return Array.from({ length: count }, (_, i) => ({
    step, file: `file-${i % files}`, item: `Q${i}`, critical: false, gatex: i < off ? 5 : 3, reference: 3,
  }));
}

describe('the accuracy figures', () => {
  it('counts a score as close when it is within 1 point, and says what the share is of', () => {
    const report = computeAccuracy(input({ human: { ...empty(), scores: scorePairs(40, 4, 4) } }));
    const m = find(report.human, 'scoreWithin1');
    expect(m.n).toBe(40);
    expect(m.value).toBeCloseTo(36 / 40);
    expect(m.counted).toContain('36 of 40');
    expect(m.status).toBe('pass'); // 36 of 40 is exactly the 90% target
  });

  it('passes exactly at the target and fails just below it', () => {
    const at = find(computeAccuracy(input({ human: { ...empty(), scores: scorePairs(40, 4, 4) } })).human, 'scoreWithin1');
    expect(at.value).toBe(0.9);
    expect(at.status).toBe('pass');
    const below = find(computeAccuracy(input({ human: { ...empty(), scores: scorePairs(40, 4, 5) } })).human, 'scoreWithin1');
    expect(below.status).toBe('fail');
  });

  it('refuses to judge a figure with too little data, or data from too few files', () => {
    const few = find(computeAccuracy(input({ human: { ...empty(), scores: scorePairs(10, 3) } })).human, 'scoreWithin1');
    expect(few.status).toBe('not_enough_data');
    expect(few.value).toBe(1);
    const oneFile = find(computeAccuracy(input({ human: { ...empty(), scores: scorePairs(60, 1) } })).human, 'scoreWithin1');
    expect(oneFile.status).toBe('not_enough_data');
    expect(oneFile.files).toBe(1);
    expect(MINIMUMS.scoreWithin1).toEqual({ n: 30, files: 3 });
  });

  it('does not let repeated checks of the same question make the sample look bigger', () => {
    const once = scorePairs(12, 3);
    const repeated = [...once, ...once, ...once, ...once]; // 48 pairs, 12 different questions
    const m = find(computeAccuracy(input({ human: { ...empty(), scores: repeated } })).human, 'scoreWithin1');
    expect(m.n).toBe(48);
    expect(m.status).toBe('not_enough_data');
    expect(m.counted).toContain('12 different questions');
  });

  it('computes verdict match, false green, false red and the critical false green from the right denominators', () => {
    const v = (gatex: VerdictPair['gatex'], reference: VerdictPair['reference'], file: string, criticalFail?: boolean): VerdictPair => ({
      step: 'Step 3', file, gatex, reference, ...(criticalFail === undefined ? {} : { criticalFail }),
    });
    const verdicts = [
      v('green', 'green', 'a', false), v('green', 'amber', 'b', true), v('green', 'green', 'c', false), v('green', 'green', 'd', false), v('green', 'red', 'e', true),
      v('amber', 'amber', 'a'), v('amber', 'green', 'b'),
      v('red', 'red', 'c'), v('red', 'green', 'd'), v('red', 'amber', 'e'),
    ];
    const r = computeAccuracy(input({ human: { ...empty(), verdicts } })).human;
    expect(find(r, 'verdictMatch').value).toBeCloseTo(5 / 10);
    const fg = find(r, 'falseGreen');
    expect(fg.n).toBe(5); // only GateX's greens
    expect(fg.value).toBeCloseTo(2 / 5);
    expect(fg.status).toBe('fail');
    const cfg = find(r, 'criticalFalseGreen');
    expect(cfg.n).toBe(5);
    expect(cfg.value).toBeCloseTo(2 / 5);
    const fr = find(r, 'falseRed');
    expect(fr.n).toBe(3); // only GateX's reds
    expect(fr.value).toBeCloseTo(1 / 3);
  });

  it('leaves a check out of the critical false green when nobody judged a must-pass question', () => {
    const verdicts: VerdictPair[] = Array.from({ length: 6 }, (_, i) => ({ step: 'Step 1', file: `f${i}`, gatex: 'green', reference: 'green' }));
    const m = find(computeAccuracy(input({ human: { ...empty(), verdicts } })).human, 'criticalFalseGreen');
    expect(m.n).toBe(0);
    expect(m.value).toBeNull();
    expect(m.status).toBe('not_enough_data');
  });

  it('passes a clean false green only with enough greens from enough files', () => {
    const verdicts: VerdictPair[] = Array.from({ length: 6 }, (_, i) => ({ step: 'Step 1', file: `f${i % 3}`, gatex: 'green', reference: 'green' }));
    expect(find(computeAccuracy(input({ human: { ...empty(), verdicts } })).human, 'falseGreen').status).toBe('pass');
    const oneFile = verdicts.map((x) => ({ ...x, file: 'only' }));
    expect(find(computeAccuracy(input({ human: { ...empty(), verdicts: oneFile } })).human, 'falseGreen').status).toBe('not_enough_data');
  });

  it('measures how often a re-run keeps the colour, per set of checks of the same file', () => {
    const reruns: RerunGroup[] = [
      { step: 'Step 2', file: 'a', verdicts: ['green', 'green', 'amber'] },
      { step: 'Step 2', file: 'b', verdicts: ['amber', 'amber'] },
      { step: 'Step 4', file: 'c', verdicts: ['green', 'green', 'green'] },
      { step: 'Step 5', file: 'd', verdicts: ['red'] }, // one check is not a re-run
    ];
    const m = computeAccuracy(input({ reruns })).self[0]!;
    expect(m.source).toBe('self');
    expect(m.n).toBe(8);
    expect(m.value).toBeCloseTo(7 / 8);
    expect(m.status).toBe('fail');
    expect(m.byStep.map((s) => s.step)).toEqual(['Step 2', 'Step 4']);
  });

  it('keeps people and AI stand-ins in separate figures, and each label set apart', () => {
    const labels = (origin: string, wrong: number, total: number): FindingLabel[] => Array.from({ length: total }, (_, i) => ({ step: 'Step 2', file: `f${i % 4}`, label: i < wrong ? 'wrong' : 'real', origin }));
    const report = computeAccuracy(input({
      human: { ...empty(), labels: labels('spot-check sheet', 2, 40) },
      aiStandin: { ...empty(), labels: [...labels('our labels', 12, 40), ...labels('blind AI reader', 16, 40)], scores: scorePairs(40, 4) },
    }));
    expect(find(report.human, 'wrongFindings').value).toBeCloseTo(0.05);
    expect(find(report.human, 'wrongFindings').status).toBe('pass');
    expect(find(report.aiStandin, 'wrongFindings', 'our labels').value).toBeCloseTo(0.3);
    expect(find(report.aiStandin, 'wrongFindings', 'blind AI reader').value).toBeCloseTo(0.4);
    // The person's rows never see the AI's data, and the reverse.
    expect(find(report.human, 'scoreWithin1').n).toBe(0);
    expect(report.humanTotals).toEqual({ scores: 0, verdicts: 0, labels: 40, reviews: 0 });
    expect(report.human.every((m) => m.source === 'human')).toBe(true);
    expect(report.aiStandin.every((m) => m.source === 'ai-standin')).toBe(true);
  });

  it('shows an empty figure as "not enough data", never as zero or as passing', () => {
    const report = computeAccuracy(input());
    for (const m of [...report.human, ...report.aiStandin, ...report.self]) {
      expect(m.status).toBe('not_enough_data');
      expect(m.value).toBeNull();
      expect(m.n).toBe(0);
    }
  });

  it('judges each step with the same bar as the whole, so a single file cannot pass a step', () => {
    const m = find(computeAccuracy(input({ human: { ...empty(), scores: scorePairs(60, 1, 0, 'Step 4') } })).human, 'scoreWithin1');
    expect(m.byStep).toHaveLength(1);
    expect(m.byStep[0]!.step).toBe('Step 4');
    expect(m.byStep[0]!.status).toBe('not_enough_data');
  });

  it('works out a colour from a person\'s marks with the one colour rule, weighted', () => {
    expect(verdictFromScores([{ weight: 50, score: 5 }, { weight: 50, score: 4 }])).toBe('green'); // 90
    expect(verdictFromScores([{ weight: 50, score: 3 }, { weight: 50, score: 3 }])).toBe('amber'); // 60
    expect(verdictFromScores([{ weight: 50, score: 2 }, { weight: 50, score: 2 }])).toBe('red'); // 40
    expect(verdictFromScores([{ weight: 80, score: 5 }, { weight: 20, score: 0 }])).toBe('green'); // 80
    expect(verdictFromScores([{ weight: 50, score: 5 }, { weight: 50, score: null }])).toBeNull(); // scored too little
    expect(bandOf(74.99)).toBe('amber');
  });
});

/* -------------------------------- the saved files -------------------------------- */

const header = (over: Record<string, unknown>) => ({
  runId: 'r', projectName: 'p', iteration: 1, gate: 'D1', artifactName: 'a.xlsx', artifactHash: 'file-1', scorecardId: 's', scorecardName: 's', scorecardVersion: '1',
  scorecardHash: 'sc-1', raters: [{ id: 'A', family: 'x', provider: 'bedrock', model: 'm1' }, { id: 'B', family: 'y', provider: 'bedrock', model: 'm2' }, { id: 'C', family: 'z', provider: 'bedrock', model: 'm3' }],
  consolidator: { id: 'K', family: 'k', provider: 'bedrock', model: 'm4' }, promptVersion: 'l1-prompts/1.8', startedAt: '2026-10-25T10:00:00.000Z', finishedAt: '2026-10-25T10:10:00.000Z', step: 'Step 2', ...over,
});
const report = (h: Record<string, unknown>, score: number, criteria: Array<[string, number, boolean?]> = []) => ({
  header: header(h),
  verdict: { weightedScore: score, decision: 'green' },
  dimensions: criteria.length === 0 ? [] : [{ id: 'G01', critical: criteria.some((c) => c[2]), status: 'scored', criteria: criteria.map(([id, mark]) => ({ id, status: 'scored', consolidated: mark })) }],
  findings: [],
});

async function put(dataDir: string, folder: string, body: unknown) {
  await mkdir(path.join(dataDir, folder), { recursive: true });
  await writeFile(path.join(dataDir, folder, 'report.json'), JSON.stringify(body));
}

describe('reading the saved checks', () => {
  it('skips demo-model checks, reads each run once, and works the colour out from the score', async () => {
    const dir = await tempDir();
    await put(dir, 'live-a', report({ runId: 'one' }, 80, [['G01-C01', 4]]));
    await put(dir, 'live-a-copy', report({ runId: 'one' }, 80, [['G01-C01', 4]])); // same run, copied to another folder
    await put(dir, 'demo', report({ runId: 'demo', raters: [{ id: 'A', family: 'x', provider: 'mock', model: 'mock-mid' }] }, 90));
    await put(dir, 'reports/p/iteration-1', report({ runId: 'two' }, 70));
    const runs = await scanReports(dir);
    expect(runs.map((r) => r.runId).sort()).toEqual(['one', 'two']);
    expect(runs.find((r) => r.runId === 'one')!.criteria).toEqual([{ id: 'G01-C01', critical: false, mark: 4 }]);
    expect((await scanReports(dir, true)).map((r) => r.runId).sort()).toEqual(['demo', 'one', 'two']);
  });

  it('groups re-runs by file, scorecard, prompt version, examiners and day, and keeps only the newest prompt version', () => {
    const run = (id: string, over: Partial<RunFacts>): RunFacts => ({
      runId: id, step: 'Step 2', file: 'f1', scorecardHash: 's1', promptVersion: 'l1-prompts/1.8', roster: 'a,b,c,k', day: '2026-10-25', score: 80, twice: false, criteria: [], folder: id, ...over,
    });
    const groups = rerunGroups([
      run('a', {}), run('b', { score: 70 }), // same set: green, amber
      run('c', { day: '2026-10-24' }), // another day: alone
      run('d', { roster: 'x,y,z,k' }), // other examiners: alone
      run('e', { file: 'f2' }), run('f', { file: 'f2' }),
      run('g', { promptVersion: 'l1-prompts/1.5' }), run('h', { promptVersion: 'l1-prompts/1.5' }), // older prompt version: left out
      run('i', { file: 'f3', twice: true }), run('j', { file: 'f3', twice: true }), // "run twice" averages are not ordinary checks
      run('k', { file: 'f4', score: null }), run('l', { file: 'f4', score: null }),
    ]);
    expect(groups).toEqual([
      { step: 'Step 2', file: 'f1', verdicts: ['green', 'amber'] },
      { step: 'Step 2', file: 'f2', verdicts: ['green', 'green'] },
    ]);
  });
});

describe('reading the sheets a person fills in', () => {
  const spotKey = { rows: [{ id: 'S01', pair: 'docket', ourLabel: 'wrong' }, { id: 'S02', pair: 'step2', ourLabel: 'real' }, { id: 'S03', pair: 'step3', ourLabel: 'partly' }] };

  it('takes one label per row, and skips blank rows, two ticks and unknown ids', () => {
    const csv = 'id,real,partly,wrong,vague,notes\r\nS01,,,x,,\r\nS02,x,x,,,\r\nS03,,,,,\r\nS99,x,,,,\r\n';
    expect(readSpotSheet(csv, spotKey, 'spot-check sheet')).toEqual([{ step: 'Step 1', file: 'docket', label: 'wrong', origin: 'spot-check sheet' }]);
    expect(readSpotSheet('nothing,here\r\n1,2\r\n', spotKey, 'x')).toEqual([]);
  });

  it('reads a calibration form: a score against the tool\'s score, and a label per issue', () => {
    const key = { criteria: [{ id: 'STEP2-C01', pair: 'STEP2', name: 'n', toolScore: 4 }, { id: 'STEP2-C02', pair: 'STEP2', name: 'n', toolScore: 5 }], findings: [{ id: 'STEP2-F01', pair: 'STEP2' }] };
    const csv = 'id,part,score,real,partly,wrong,vague\r\nSTEP2-C01,CRITERION,2,,,,\r\nSTEP2-C02,CRITERION,NM,,,,\r\nSTEP2-F01,FINDING,,,x,,\r\n';
    const out = readCalibrationForm(csv, key, 'calibration form');
    expect(out.scores).toEqual([{ step: 'Step 2', file: 'STEP2', item: 'STEP2-C01', critical: false, gatex: 4, reference: 2 }]);
    expect(out.labels).toEqual([{ step: 'Step 2', file: 'STEP2', label: 'partly', origin: 'calibration form' }]);
  });

  it('counts a filled sheet as human and an AI-filled one as a stand-in, and a blank one as nothing', async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, 'review-sheet'), { recursive: true });
    await writeFile(path.join(dir, 'review-sheet', 'answer-key.json'), JSON.stringify(spotKey));
    const head = 'id,real,partly,wrong,vague\r\n';
    await writeFile(path.join(dir, 'review-sheet', 'spot-check.csv'), `${head}S01,,,,\r\nS02,,,,\r\nS03,,,,\r\n`);
    let loaded = await loadAccuracyInput(dir);
    expect(loaded.input.human.labels).toEqual([]);
    expect(loaded.sources.find((s) => s.id === 'spot-check')!.note).toContain('Blank so far');

    await writeFile(path.join(dir, 'review-sheet', 'spot-check-filled-human-sam.csv'), `${head}S01,,,x,\r\nS02,x,,,\r\nS03,,x,,\r\n`);
    await writeFile(path.join(dir, 'review-sheet', 'spot-check-filled-agent.csv'), `${head}S01,x,,,\r\nS02,x,,,\r\n`);
    loaded = await loadAccuracyInput(dir);
    expect(loaded.input.human.labels.map((l) => l.label)).toEqual(['wrong', 'real', 'partly']);
    expect(loaded.input.aiStandin.labels.map((l) => l.origin)).toEqual(['blind AI reader (agent)', 'blind AI reader (agent)']);
    expect(loaded.input.human.labels.every((l) => l.origin === 'spot-check sheet')).toBe(true);
  });

  it('compares the checks with a scorecard workbook\'s reference marks, as an AI stand-in that says who made them', async () => {
    const dir = await tempDir();
    const schema = await makeWorkbook({ Tree: CLEAN_TREE });
    const { createHash } = await import('node:crypto');
    const fileHash = createHash('sha256').update(schema).digest('hex');
    const scorecard = await makeWorkbook({
      Scorecard: [['x'], [], [], ['ID', 'Dim', 'Type', 'M', 'N', 'F', 'R', 'H', 'I', 'Final'], [], [], [], [],
        ['G01-C01', 'a', 'Anchored', null, null, null, null, null, null, 4], ['G01-C02', 'b', 'Anchored', null, null, null, null, null, null, 2], ['G01-C03', 'c', 'Anchored', null, null, null, null, null, null, 'NM']],
      Summary: [[], [], [], ['Design score / 100', null, null, null, 69.4], [], [], ['Lowest GATE', null, null, null, 3]],
      'Master Scorecard': [[], ['Subject: x. Assessor: Claude, single reader. Not blind raters, no author interview.']],
    });
    await mkdir(path.join(dir, 'inputs/step2-v32'), { recursive: true });
    await writeFile(path.join(dir, 'inputs/step2-v32/Talentra_Step2_Master_Schema_v3.2_Reconciled.xlsx'), schema);
    await writeFile(path.join(dir, 'inputs/step2-v32/Talentra_Step2_Master_Scorecard_v3.2_Reconciled.xlsx'), scorecard);
    await put(dir, 'live-new', report({ runId: 'new', artifactHash: fileHash, promptVersion: 'l1-prompts/1.8' }, 82, [['G01-C01', 5, true], ['G01-C02', 1], ['G01-C03', 3]]));
    await put(dir, 'live-old', report({ runId: 'old', artifactHash: fileHash, promptVersion: 'l1-prompts/1.5' }, 60, [['G01-C01', 0]]));
    const loaded = await loadAccuracyInput(dir);
    expect(loaded.input.human.scores).toEqual([]);
    // the older prompt version is left out, and the "NM" question has no reference mark
    expect(loaded.input.aiStandin.scores).toEqual([
      { step: 'Step 2', file: fileHash, item: 'G01-C01', critical: true, gatex: 5, reference: 4 },
      { step: 'Step 2', file: fileHash, item: 'G01-C02', critical: true, gatex: 1, reference: 2 },
    ]);
    expect(loaded.input.aiStandin.verdicts).toEqual([{ step: 'Step 2', file: fileHash, gatex: 'green', reference: 'amber', derived: true, criticalFail: true }]);
    const note = loaded.sources.find((s) => s.id === 'reference-step2-v32')!;
    expect(note.kind).toBe('ai-standin');
    expect(note.note).toContain('Assessor: an AI assistant');
    expect(note.note).not.toContain('Claude');
    expect(note.note).toContain('not a person');
  });
});

/* -------------------------------- people in the app -------------------------------- */

interface Harness { base: string; dataDir: string; store: Store; service: EvaluationService; db: Db; close(): Promise<void> }

async function start(): Promise<Harness> {
  const models = mockModels();
  const db = await createDb({ dbMode: 'memory', databaseUrl: undefined });
  await migrate(db);
  const store = new Store(db);
  const config: AppConfig = { port: 0, dataDir: await tempDir(), dbMode: 'memory', databaseUrl: undefined, mock: true, mockDelayMs: 0, models };
  const service = new EvaluationService({ store, config, providers: createProviderFactory(models, { mockDelayMs: 0 }), env: {} });
  const server: Server = createApp({ store, service, config, env: {} }).listen(0);
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, dataDir: config.dataDir, store, service, db, close: async () => { await service.idle(); await new Promise((r) => server.close(r)); await db.close(); } };
}

async function submitOne(h: Harness, projectName: string, step?: string): Promise<RunDetail> {
  const form = new FormData();
  form.append('workbook', new Blob([new Uint8Array(await makeWorkbook({ Tree: CLEAN_TREE }))]), 'schema.xlsx');
  form.append('scorecard', new Blob([CLEAN_SCORECARD_YAML]), 'scorecard.yaml');
  form.append('projectName', projectName);
  if (step) form.append('step', step);
  const res = await fetch(`${h.base}/api/runs`, { method: 'POST', body: form });
  const created = (await res.json()) as { runId: string };
  await h.service.idle();
  return (await (await fetch(`${h.base}/api/runs/${created.runId}`)).json()) as RunDetail;
}

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('a person\'s review and issue marks in the app', () => {
  let h: Harness;
  let run: RunDetail;
  beforeAll(async () => {
    h = await start();
    run = await submitOne(h, 'Review me', '2');
  });
  afterAll(async () => h.close());

  it('stores a review next to GateX\'s marks and lists it back', async () => {
    expect(run.status).toBe('done');
    const dims = run.report!.dimensions.filter((d) => d.status === 'scored');
    expect(dims.length).toBeGreaterThan(0);
    const scores = Object.fromEntries(dims.map((d) => [d.id, 4]));
    const res = await post(`${h.base}/api/runs/${run.id}/human-review`, { reviewer: 'Sam', scores, verdict: 'amber', note: 'looks fine' });
    expect(res.status).toBe(201);
    const saved = (await res.json()) as HumanReview;
    expect(saved).toMatchObject({ reviewer: 'Sam', verdict: 'amber', note: 'looks fine', scores });
    const listed = (await (await fetch(`${h.base}/api/runs/${run.id}/human-review`)).json()) as HumanReview[];
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(saved.id);
  });

  it('refuses a review with no marks, a mark outside 0 to 5, an area the report does not have, no name or an unfinished check', async () => {
    const id = run.report!.dimensions[0]!.id;
    const bad = async (body: unknown, status: number, text: RegExp) => {
      const res = await post(`${h.base}/api/runs/${run.id}/human-review`, body);
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: string }).error).toMatch(text);
    };
    await bad({ reviewer: 'Sam', scores: {} }, 400, /at least one mark/);
    await bad({ reviewer: 'Sam', scores: { [id]: 7 } }, 400, /0 to 5/);
    await bad({ reviewer: 'Sam', scores: { NOPE: 3 } }, 400, /not in this report/);
    await bad({ reviewer: '  ', scores: { [id]: 3 } }, 400, /who you are/);
    const none = await post(`${h.base}/api/runs/00000000-0000-0000-0000-000000000000/human-review`, { reviewer: 'Sam', scores: { [id]: 3 } });
    expect(none.status).toBe(404);
  });

  it('stores one right / wrong / unclear mark per person per issue, replacing their earlier one', async () => {
    // A mock check may raise no issue, so give the run one to mark.
    await h.db.query(
      `insert into findings (run_id, finding_id, fingerprint, severity, dimension_id, title, source) values ($1,'F-901','fp901','HIGH','D01','An issue','raters')`,
      [run.id],
    );
    const url = `${h.base}/api/runs/${run.id}/findings/F-901/feedback`;
    expect((await post(url, { label: 'wrong', who: 'Sam' })).status).toBe(201);
    expect((await post(url, { label: 'right', who: 'Sam', note: 'on second look it is right' })).status).toBe(201);
    expect((await post(url, { label: 'unclear', who: 'Ana' })).status).toBe(201);
    const list = (await (await fetch(`${h.base}/api/runs/${run.id}/feedback`)).json()) as Array<{ who: string; label: string; note: string }>;
    expect(list.map((f) => `${f.who}:${f.label}`).sort()).toEqual(['Ana:unclear', 'Sam:right']);
    expect((await post(url, { label: 'maybe', who: 'Sam' })).status).toBe(400);
    expect((await post(`${h.base}/api/runs/${run.id}/findings/F-99/feedback`, { label: 'right', who: 'Sam' })).status).toBe(404);
  });

  it('reads the review as human evidence: scores, a derived or chosen colour, and issue labels, apart from the AI stand-ins', async () => {
    const loaded = await loadAccuracyInput(h.dataDir, h.store, { includeMock: true });
    const dims = run.report!.dimensions.filter((d) => d.status === 'scored');
    expect(loaded.reviews).toBe(1);
    expect(loaded.input.human.scores).toHaveLength(dims.length);
    expect(loaded.input.human.scores.every((p) => p.reference === 4 && p.step === 'Step 2' && p.file === run.report!.header.artifactHash)).toBe(true);
    expect(loaded.input.human.verdicts).toHaveLength(1);
    expect(loaded.input.human.verdicts[0]).toMatchObject({ reference: 'amber', gatex: run.report!.verdict.agentDecision ?? bandOf(run.report!.verdict.weightedScore!) });
    expect(loaded.input.human.labels.map((l) => l.label).sort()).toEqual(['real', 'vague']);
    expect(loaded.input.aiStandin.labels).toEqual([]);
    const full = await loadAccuracy(h.dataDir, h.store, { includeMock: true });
    expect(full.humanTotals.reviews).toBe(1);
    expect(full.human.find((m) => m.id === 'scoreWithin1')!.status).toBe('not_enough_data');
  });

  it('works the colour out from the person\'s marks when they give none, and notes a failed must-pass question', async () => {
    const run2 = await submitOne(h, 'Derive me', '3');
    const dims = run2.report!.dimensions.filter((d) => d.status === 'scored');
    const low = Object.fromEntries(dims.map((d) => [d.id, 1]));
    expect((await post(`${h.base}/api/runs/${run2.id}/human-review`, { reviewer: 'Sam', scores: low })).status).toBe(201);
    const loaded = await loadAccuracyInput(h.dataDir, h.store, { includeMock: true });
    const v = loaded.input.human.verdicts.find((x) => x.step === 'Step 3')!;
    expect(v.reference).toBe('red');
    expect(v.derived).toBe(true);
    if (dims.some((d) => d.critical)) expect(v.criticalFail).toBe(true);
  });

  it('never counts a demo-model check in the accuracy figures the page shows', async () => {
    const res = await fetch(`${h.base}/api/accuracy`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AccuracyReport;
    expect(body.humanTotals).toEqual({ scores: 0, verdicts: 0, labels: 0, reviews: 0 });
    expect(body.human.every((m) => m.n === 0)).toBe(true);
    expect(body.sources.find((s) => s.id === 'app-reviews')!.note).toContain('of 2 review(s) are of real');
  });

  it('removes a run\'s reviews and issue marks with the run', async () => {
    const run3 = await submitOne(h, 'Delete me');
    await post(`${h.base}/api/runs/${run3.id}/human-review`, { reviewer: 'Sam', scores: { [run3.report!.dimensions[0]!.id]: 3 } });
    expect((await h.store.human.listReviews(run3.id))).toHaveLength(1);
    expect((await fetch(`${h.base}/api/runs/${run3.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(await h.store.human.listReviews(run3.id)).toHaveLength(0);
  });
});
