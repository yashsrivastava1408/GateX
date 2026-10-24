import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { checkDraft, checkScorecardYaml, importScorecard, importWithFallbacks, outlineDocument, readSourceText } from '../src/scorecard/importer.js';
import { parseScorecard } from '../src/scorecard/parse.js';
import { decide, effectiveDimensions } from '../src/agent/verdict.js';
import { LlmError, type LlmProvider } from '../src/llm/types.js';
import { MockProvider } from '../src/llm/mock.js';

const ANCHORS = { '0': 'a', '1': 'b', '2': 'c', '3': 'd', '4': 'e', '5': 'f' };
const reply = (extra: Record<string, unknown> = {}) => ({
  scorecard: {
    id: 'SC X!', name: 'X', version: 1, judges: 'D1 schema design', frozen: true, approval: 'Approved by someone',
    thresholds: { accept: 90, refine: 75 }, red_at_or_below: 2,
    artifact: { sheets: [{ name: 'Whatever' }] },
    dimensions: [
      { id: 'G01', name: 'Judged', weight: 60, critical: true, measured_by: 'raters', measure: 'm', anchors: ANCHORS, reads: ['Page 1-2', 'Page 90-99', 'Nope'] },
      { id: 'G02', name: 'Counted', weight: 40, measured_by: 'code', measure: 'Fields with a source out of 426' },
    ],
    ...extra,
  },
  uncertain: ['a guess'],
  adjustments: [],
});

async function makePdf(pages: string[]): Promise<Buffer> {
  const doc = new PDFDocument();
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  pages.forEach((text, i) => { if (i > 0) doc.addPage(); doc.text(text); });
  doc.end();
  return done;
}

const fake = (replies: string[]): { provider: LlmProvider; calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    provider: { name: 'fake', complete: async (r) => { calls.push(r.user); const text = replies.shift(); if (!text) throw new LlmError('no more'); return { text, inputTokens: 5, outputTokens: 5 }; } },
  };
};
const deps = (provider: LlmProvider) => ({ provider, model: { id: 'A', provider: 'fake', model: 'm' }, settings: { temperature: 0, maxOutputTokens: 100 } });

describe('importing a scorecard written in another layout', () => {
  it('turns the model reply into a frozen scorecard that is used straight away, with no approval step', async () => {
    const pdf = await makePdf(['Intro', 'More', 'Third']);
    const outline = await outlineDocument({ name: 'd.pdf', bytes: pdf });
    const { file, adjustments } = checkDraft(reply(), 'theirs.xlsx', outline);
    const sc = file.scorecard;
    expect(sc.frozen).toBe(true);
    expect(sc.approval).toBe('Converted automatically from theirs.xlsx');
    expect(sc.id).toBe('SC-X-');
    expect(sc.artifact.sheets).toEqual([{ name: 'Page 1-3', header_row: 1 }]);
    const judged = sc.dimensions.find((d) => d.id === 'G01')!;
    expect(judged.reads).toEqual(['Page 1-2']);
    expect(adjustments.join(' ')).toMatch(/G01: dropped 2 page or sheet name/);
    const counted = sc.dimensions.find((d) => d.id === 'G02')!;
    expect(counted.measured_by).toBe('raters');
    expect(counted.anchors).toBeDefined();
    expect(adjustments.join(' ')).toMatch(/G02: the app cannot count this itself/);
    expect(sc.unmeasured).toBe('skip');
  });

  it('gives the examiners any question the model still hands to a person, so nothing waits for anyone', () => {
    const human = (id: string) => ({ id, name: id, weight: 10, measured_by: 'human', needs: 'An interview with the author.' });
    const { file, adjustments } = checkDraft(reply({ dimensions: [human('A'), { id: 'B', name: 'B', weight: 10, measurable_by_agent: false }] }), 'x', null);
    for (const dim of file.scorecard.dimensions) {
      expect(dim.measured_by).toBe('raters');
      expect(Object.keys(dim.anchors!)).toHaveLength(6);
      expect(dim).not.toHaveProperty('needs');
    }
    expect(file.scorecard.dimensions[0]!.measure).toBe('An interview with the author. Score only what the file itself records about this.');
    expect(adjustments.join(' ')).toMatch(/A: it was meant for a person, so the examiners score what the file records about it/);
    expect(JSON.stringify(file)).not.toMatch(/"human"/);
  });

  it('keeps every criterion inside its dimension, with the source weight, and drops any hand-off to a person', () => {
    const crit = (kind: 'judged' | 'counted' | 'unmeasurable', n: number) => Array.from({ length: n }, (_, i) => ({ id: `${kind}${i}`, name: `${kind} ${i}`, kind }));
    const mixed = { id: 'G02', name: 'Traceability', weight: 10, critical: true, measured_by: 'human', measure: 'm', anchors: ANCHORS, reads: ['Page 1'], criteria: [...crit('judged', 1), ...crit('counted', 2), ...crit('unmeasurable', 1)] };
    const onlyCounted = { id: 'G04', name: 'Quality', weight: 10, critical: true, measured_by: 'raters', measure: 'm', anchors: ANCHORS, reads: ['Page 1'], criteria: crit('counted', 4) };
    const onlyJudged = { id: 'G11', name: 'Change', weight: 6, measured_by: 'human', needs: 'x', anchors: ANCHORS, criteria: crit('judged', 4) };
    const onlyUnmeasurable = { id: 'G12', name: 'Second run', weight: 4, measured_by: 'raters', criteria: crit('unmeasurable', 2) };
    const plain = { id: 'G01', name: 'Plain', weight: 5, measured_by: 'raters', anchors: ANCHORS };
    const { file, adjustments } = checkDraft(reply({ dimensions: [plain, mixed, onlyCounted, onlyJudged, onlyUnmeasurable] }), 'x', null);
    const dims = Object.fromEntries(file.scorecard.dimensions.map((d) => [d.id, d]));
    expect(Object.keys(dims)).toEqual(['G01', 'G02', 'G04', 'G11', 'G12']);
    expect(file.scorecard.dimensions.map((d) => d.weight)).toEqual([5, 10, 10, 6, 4]);
    expect(dims.G02!.criteria!.map((c) => [c.id, c.kind])).toEqual([['judged0', 'judged'], ['counted0', 'counted'], ['counted1', 'counted'], ['unmeasurable0', 'unmeasurable']]);
    expect(dims.G02).toMatchObject({ critical: true, measure: 'm' });
    expect(dims.G02).not.toHaveProperty('measured_by');
    expect(dims.G11).not.toHaveProperty('needs');
    // A dimension with no anchors of its own gets a scale its criteria can fall back on.
    expect(dims.G12!.anchors).toBeDefined();
    expect(adjustments.join(' ')).toMatch(/G02: unmeasurable 0 names evidence from outside the file, so the examiners score what the file records about it/);
    expect(adjustments.join(' ')).toMatch(/G04: counted 0; counted 1; counted 2; counted 3 cannot be counted exactly/);
    expect(JSON.stringify(file)).not.toMatch(/"human"/);
    // Read as a scorecard, every criterion of these dimensions is for the examiners (no exact count was proposed).
    const sc = parseScorecard(JSON.stringify({ scorecard: file.scorecard })).scorecard;
    expect(sc.dimensions.find((d) => d.id === 'G12')!.criteria!.every((c) => c.kind === 'judged' && /Judge only what the file itself records/.test(c.measure!))).toBe(true);
    expect(sc.dimensions.map((d) => d.measuredBy)).toEqual(['raters', 'raters', 'raters', 'raters', 'raters']);
  });

  it('copies the combination rule the source states, and leaves it out when it states none', () => {
    const withRule = checkDraft(reply({ aggregate: { rule: 'mean_floor', zero_caps_at: 2, unmeasured_caps_at: 3 } }), 'x', null);
    expect(withRule.file.scorecard.aggregate).toEqual({ rule: 'mean_floor', zero_caps_at: 2, unmeasured_caps_at: 3 });
    expect(withRule.adjustments.join(' ')).toMatch(/the mean rounded down, a 0 caps the dimension at 2, a criterion with nothing in the file caps it at 3/);
    const odd = checkDraft(reply({ aggregate: { rule: 'median', zero_caps_at: 9 } }), 'x', null);
    expect(odd.file.scorecard.aggregate).toEqual({ rule: 'mean' });
    expect(checkDraft(reply(), 'x', null).file.scorecard.aggregate).toBeUndefined();
  });

  it('gives each criterion a valid, unique id, even when the model repeats one or leaves it out', () => {
    const dims = [
      { id: 'G01', name: 'a', weight: 5, anchors: ANCHORS, criteria: [{ id: 'G01 C1!', name: 'x', kind: 'judged' }, { name: 'y', kind: 'judged' }] },
      { id: 'G02', name: 'b', weight: 5, anchors: ANCHORS, criteria: [{ id: 'G01-C1', name: 'z', kind: 'judged' }, { id: 'G02', name: 'w', kind: 'judged' }] },
    ];
    const ids = checkDraft(reply({ dimensions: dims }), 'x', null).file.scorecard.dimensions.flatMap((d) => d.criteria!.map((c) => c.id));
    expect(ids).toEqual(['G01-C1', 'G01-C02', 'G01-C1x', 'G02x']);
  });

  it('gives a judged question the source\'s general anchor when it has none', () => {
    const noAnchors = { id: 'G01', name: 'x', weight: 10, measured_by: 'raters', measure: 'm' };
    const withGeneral = { ...reply({ dimensions: [noAnchors] }), general_anchor: ANCHORS };
    const { file, adjustments } = checkDraft(withGeneral, 'x', null);
    expect(file.scorecard.dimensions[0]!.anchors).toBeDefined();
    expect(adjustments.join(' ')).toMatch(/G01: it had no anchors of its own/);
    // With no general anchor either, a standard 0 to 5 scale is used, so the examiners always have something to mark against.
    const standard = checkDraft(reply({ dimensions: [noAnchors] }), 'x', null);
    expect(standard.file.scorecard.dimensions[0]!.anchors).toBeDefined();
    expect(standard.adjustments.join(' ')).toMatch(/a standard 0 to 5 scale/);
  });

  it('cuts a question that reads too many PDF pages down to what a small model can take', async () => {
    const pdf = await makePdf(Array.from({ length: 30 }, (_, i) => `Page text ${i + 1}`));
    const outline = await outlineDocument({ name: 'd.pdf', bytes: pdf });
    const wide = { id: 'G05', name: 'w', weight: 10, measured_by: 'raters', measure: 'm', anchors: ANCHORS, reads: ['Page 10-25'] };
    const scattered = { id: 'G06', name: 's', weight: 10, measured_by: 'raters', measure: 'm', anchors: ANCHORS, reads: ['Page 2', 'Page 8-9', 'Page 20'] };
    const fine = { id: 'G07', name: 'f', weight: 10, measured_by: 'raters', measure: 'm', anchors: ANCHORS, reads: ['Page 3-5'] };
    const { file, adjustments } = checkDraft(reply({ dimensions: [wide, scattered, fine] }), 'x', outline);
    const reads = Object.fromEntries(file.scorecard.dimensions.map((d) => [d.id, d.reads]));
    expect(reads).toEqual({ G05: ['Page 10-12'], G06: ['Page 2', 'Page 8-9'], G07: ['Page 3-5'] });
    expect(adjustments.join(' ')).toMatch(/G05: it named 16 pages/);
    expect(adjustments.join(' ')).not.toMatch(/G07: it named/);
  });

  it('lets a roomier roster read more pages per question', async () => {
    const pdf = await makePdf(Array.from({ length: 30 }, (_, i) => `Page text ${i + 1}`));
    const outline = await outlineDocument({ name: 'd.pdf', bytes: pdf });
    const wide = { id: 'G05', name: 'w', weight: 10, measured_by: 'raters', measure: 'm', anchors: ANCHORS, reads: ['Page 10-25'] };
    const small = checkDraft(reply({ dimensions: [wide] }), 'x', outline, 3).file.scorecard.dimensions[0]!.reads;
    const roomy = checkDraft(reply({ dimensions: [wide] }), 'x', outline, 10).file.scorecard.dimensions[0]!.reads;
    expect(small).toEqual(['Page 10-12']);
    expect(roomy).toEqual(['Page 10-19']);
  });

  it('refuses a reply with no scorecard or the wrong shape, and asks the model once more with the reason', async () => {
    expect(() => checkDraft({}, 'x', null)).toThrow(/no "scorecard"/);
    const bad = JSON.stringify(reply({ dimensions: [{ id: 'G01', weight: 5, measured_by: 'raters', anchors: ANCHORS }] }));
    const { provider, calls } = fake(['not json at all', JSON.stringify(reply())]);
    const result = await importScorecard({ source: { name: 'a.yaml', bytes: Buffer.from('some scorecard text') } }, deps(provider));
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatch(/previous_reply_problem/);
    expect(result.draft.scorecard.frozen).toBe(true);
    const failing = fake([bad, bad]);
    await expect(importScorecard({ source: { name: 'a.yaml', bytes: Buffer.from('t') } }, deps(failing.provider))).rejects.toThrow(/could not turn this into a usable scorecard/);
  });

  it('shows the model the original text and the document outline, and reports weights and counts', async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Scorecard');
    sheet.addRow(['ID', 'Criterion']);
    sheet.addRow(['G01', 'Purpose is clear']);
    const bytes = Buffer.from(await book.xlsx.writeBuffer());
    const pdf = await makePdf(['Opening page', 'Second page']);
    const { provider, calls } = fake([JSON.stringify(reply())]);
    const result = await importScorecard({ source: { name: 'theirs.xlsx', bytes }, document: { name: 'd.pdf', bytes: pdf } }, deps(provider));
    expect(calls[0]).toContain('Purpose is clear');
    expect(calls[0]).toContain('Page 1: Opening page');
    expect(result.sourceText).toContain('G01');
    expect(result.summary).toEqual({ dimensions: 2, byExaminers: 2, byCode: 0, critical: 1, weightTotal: 100 });
    expect(result.yaml.startsWith('# Converted automatically from theirs.xlsx')).toBe(true);
    expect(await readSourceText({ name: 'n.txt', bytes: Buffer.from('plain text') })).toBe('plain text');
  });

  it('the YAML it writes is a frozen scorecard in the app\'s own format, recording which model converted it and when', async () => {
    const { provider } = fake([JSON.stringify(reply())]);
    const result = await importScorecard({ source: { name: 'a.yaml', bytes: Buffer.from('t') } }, deps(provider), null, new Date('2026-10-23T09:00:00Z'));
    const parsed = parseScorecard(result.yaml, 'draft.yaml');
    expect(parsed.scorecard.frozen).toBe(true);
    expect(parsed.scorecard.redAtOrBelow).toBe(2);
    expect(parsed.scorecard.approval).toBe('Converted automatically from a.yaml by fake/m on 2026-10-23, checked by code');
  });

  it('re-checks a hand-edited scorecard and freezes it, without asking anyone to approve it', () => {
    const draft = YAML.stringify(checkDraft(reply(), 'x.xlsx', null).file).replace('frozen: true', 'frozen: false');
    const checked = checkScorecardYaml(draft.replace('Judged', 'Judged (edited)'));
    expect(YAML.parse(checked.yaml).scorecard.frozen).toBe(true);
    expect(checked.yaml).toContain('Judged (edited)');
    expect(checked.summary.dimensions).toBe(2);
    expect(() => checkScorecardYaml('scorecard: { id: x }')).toThrow(/has problems/);
    expect(() => checkScorecardYaml('::: not yaml :::\n\t- [')).toThrow();
  });

  it('tries the backup model when the first one is overloaded, but not when the file itself is the problem', async () => {
    const down = fake([]).provider;
    const working = fake([JSON.stringify(reply())]);
    const busy: LlmProvider = { name: 'busy', complete: async () => { throw new LlmError('HTTP 503: high demand', 503); } };
    const input = { source: { name: 'a.yaml', bytes: Buffer.from('t') } };
    const result = await importWithFallbacks(input, [deps(busy), deps(working.provider)]);
    expect(result.summary.dimensions).toBe(2);
    expect(working.calls).toHaveLength(1);
    await expect(importWithFallbacks(input, [deps(busy), deps(down)])).rejects.toThrow(/could not turn this into a usable scorecard/);
    const empty = { source: { name: 'a.txt', bytes: Buffer.from('  ') } };
    await expect(importWithFallbacks(empty, [deps(working.provider)])).rejects.toThrow(/no readable text/);
  });

  it('the mock model gives a fixed sample so the screen works offline', async () => {
    const result = await importScorecard({ source: { name: 'a.yaml', bytes: Buffer.from('t') } }, deps(new MockProvider(0)));
    expect(result.summary.dimensions).toBe(3);
    // G03 is scored criterion by criterion: two questions for the examiners.
    expect(result.summary.byExaminers).toBe(4);
    expect(result.uncertain.join(' ')).toMatch(/mock model/);
  });
});

describe('a critical question\'s red line no longer changes the colour', () => {
  const card = (extra: string) => parseScorecard(`
scorecard:
  id: SC-G
  version: "1"
  judges: D1 schema design
  frozen: true
  thresholds: { accept: 90, refine: 75 }
  ${extra}
  artifact: { sheets: [Tree] }
  dimensions:
    - { id: A, name: a, weight: 90, measured_by: raters, measure: m, anchors: { 0: a, 1: b, 2: c, 3: d, 4: e, 5: f } }
    - { id: B, name: b, weight: 10, critical: true, measured_by: raters, measure: m, anchors: { 0: a, 1: b, 2: c, 3: d, 4: e, 5: f } }
`).scorecard;
  const results = (b: number) => [
    { id: 'A', name: 'a', weight: 90, critical: false, measuredBy: 'raters', status: 'scored', raterScores: {}, consolidated: 5, spread: 0, resolution: 'agreement', flagged: false, rationale: '', evidence: [] },
    { id: 'B', name: 'b', weight: 10, critical: true, measuredBy: 'raters', status: 'scored', raterScores: {}, consolidated: b, spread: 0, resolution: 'agreement', flagged: false, rationale: '', evidence: [] },
  ] as never;

  it('keeps a high total green whatever the line says, and notes the failed critical question', () => {
    const withLine = card('red_at_or_below: 2');
    for (const b of [2, 3, 4]) expect(decide(withLine, effectiveDimensions(withLine, results(b))).decision).toBe('green');
    expect(decide(withLine, effectiveDimensions(withLine, results(2))).reasons.join(' ')).toMatch(/Needs attention: critical question B/);
    const without = card('');
    expect(decide(without, effectiveDimensions(without, results(2))).decision).toBe('green');
  });
});

describe('a source that gives some questions no weight', () => {
  const withWeights = (weights: unknown[]) => {
    const r = reply();
    r.scorecard.dimensions = weights.map((weight, i) => ({ id: `Q${i + 1}`, name: `Question ${i + 1}`, weight, measured_by: 'raters', measure: 'm', anchors: ANCHORS })) as never;
    return r;
  };

  it('gives a question with a zero, blank or word weight the average of the others, and says so', () => {
    const draft = checkDraft(withWeights([10, 0, 20, '', 'n/a']), 's.xlsx', null);
    expect(draft.file.scorecard.dimensions.map((d) => d.weight)).toEqual([10, 15, 20, 15, 15]);
    expect(draft.adjustments.join(' ')).toMatch(/Q2, Q4, Q5 had no usable weight.*average weight of the others, 15/);
  });

  it('gives every question weight 1 when none has one', () => {
    const draft = checkDraft(withWeights([0, 0, null]), 's.xlsx', null);
    expect(draft.file.scorecard.dimensions.map((d) => d.weight)).toEqual([1, 1, 1]);
    expect(draft.adjustments.join(' ')).toMatch(/weight of 1/);
  });

  it('reads a weight written as a number in a string or with a percent sign, and adds no note when all are usable', () => {
    const draft = checkDraft(withWeights([10, '20', '30%']), 's.xlsx', null);
    expect(draft.file.scorecard.dimensions.map((d) => d.weight)).toEqual([10, 20, 30]);
    expect(draft.adjustments.join(' ')).not.toMatch(/no usable weight/);
  });
});
