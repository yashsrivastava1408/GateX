import { describe, expect, it } from 'vitest';
import type { DimensionResult } from '@ddd/shared';
import { combineCriteria, collapseCriteria, criterionParents, expandCriteria, findingsToDimensions, retypeOutsideCriteria } from '../src/agent/aggregate.js';
import { buildAllRaterPrompts } from '../src/agent/prompt.js';
import { preflight } from '../src/agent/preflight.js';
import { WorkbookModel } from '../src/excel/workbook.js';
import { assembleReport } from '../src/report/assemble.js';
import { renderMarkdown } from '../src/report/markdown.js';
import { renderXlsx } from '../src/report/xlsx.js';
import { renderPdf } from '../src/report/pdf.js';
import { scorecardToWorkbook } from '../src/scorecard/excel.js';
import { parseScorecard } from '../src/scorecard/parse.js';
import { CLEAN_SCORECARD_YAML, makeWorkbook, mockModels, runEvaluation } from './helpers.js';

const scored = (score: number, weight = 1) => ({ status: 'scored' as const, score, weight });
const nm = { status: 'not_measurable' as const, score: null, weight: 1 };
const unscored = { status: 'unscored' as const, score: null, weight: 1 };
/** A criterion the scorecard says needs evidence from outside the file, and the file has none. */
const outsideNm = { ...nm, outside: true };
const GS1 = { rule: 'mean_floor' as const, zeroCapsAt: 2, unmeasuredCapsAt: 3 };

describe('combining criteria with the scorecard rule', () => {
  it('takes the plain mean by default, to two decimals', () => {
    expect(combineCriteria([scored(4), scored(5), scored(4)])).toEqual({ score: 4.33, status: 'scored', capped: null });
  });

  it('rounds the mean down under mean_floor, as GS-1 does (INT of AVERAGE)', () => {
    expect(combineCriteria([scored(4), scored(5), scored(4)], { rule: 'mean_floor' }).score).toBe(4);
    expect(combineCriteria([scored(5), scored(5)], { rule: 'mean_floor' }).score).toBe(5);
  });

  it('weights criteria only under the weighted rule', () => {
    expect(combineCriteria([scored(5, 3), scored(1, 1)], { rule: 'weighted' }).score).toBe(4);
    expect(combineCriteria([scored(5, 3), scored(1, 1)], { rule: 'mean' }).score).toBe(3);
  });

  it('caps at 2 when any criterion scored 0, before the not-measurable cap (GS-1 order)', () => {
    expect(combineCriteria([scored(5), scored(5), scored(0)], GS1)).toEqual({ score: 2, status: 'scored', capped: 'zero' });
    expect(combineCriteria([scored(5), scored(5), scored(0), nm], GS1)).toEqual({ score: 2, status: 'scored', capped: 'zero' });
    // A low mean is not raised by a cap.
    expect(combineCriteria([scored(0), scored(1)], GS1)).toEqual({ score: 0, status: 'scored', capped: null });
  });

  it('caps the dimension at 3 only for a criterion the scorecard says needs evidence from outside the file', () => {
    expect(combineCriteria([scored(5), scored(5), outsideNm], GS1)).toEqual({ score: 3, status: 'scored', capped: 'unmeasured' });
    expect(combineCriteria([scored(5), scored(5), outsideNm], { rule: 'mean_floor' })).toEqual({ score: 5, status: 'scored', capped: null });
  });

  it('only leaves out, never caps, a criterion the examiners could not judge but the scorecard expects to be in the file', () => {
    expect(combineCriteria([scored(5), scored(5), nm], GS1)).toEqual({ score: 5, status: 'scored', capped: null });
  });

  it('is not measurable only when every criterion is, so the scorecard\'s unmeasured setting decides', () => {
    expect(combineCriteria([nm, nm], GS1)).toEqual({ score: null, status: 'not_measurable', capped: null });
  });

  it('leaves a criterion no examiner could score with evidence out of the mean instead of counting a false 0, and says so', () => {
    expect(combineCriteria([scored(5), scored(5), unscored], GS1)).toEqual({ score: 5, status: 'scored', capped: null, leftOut: 1 });
    expect(combineCriteria([scored(4), unscored], GS1)).toEqual({ score: 4, status: 'scored', capped: null, leftOut: 1 });
  });

  it('counts the dimension as unscored when fewer than half of its measurable criteria could be scored', () => {
    expect(combineCriteria([scored(5), unscored, unscored], GS1)).toEqual({ score: null, status: 'unscored', capped: null, leftOut: 2 });
    expect(combineCriteria([unscored, unscored], GS1)).toEqual({ score: null, status: 'unscored', capped: null, leftOut: 2 });
    expect(combineCriteria([scored(5), unscored, nm], GS1).status).toBe('scored');
  });

  it('a real 0 still caps, and a criterion left out does not hide it', () => {
    expect(combineCriteria([scored(5), scored(5), scored(0), unscored], GS1)).toEqual({ score: 2, status: 'scored', capped: 'zero', leftOut: 1 });
  });
});

const CRITERIA_YAML = `
scorecard:
  id: SC-GS1-LIKE
  version: "3.2"
  judges: D1 schema design
  thresholds: { accept: 90, refine: 75 }
  red_at_or_below: 2
  aggregate: { rule: mean_floor, zero_caps_at: 2, unmeasured_caps_at: 3 }
  artifact:
    sheets: [{ name: Fields, header_row: 1 }]
  dimensions:
    - id: G01
      name: Purpose and scope
      weight: 5
      anchors: { 5: all, 4: most, 3: some, 2: few, 1: one, 0: none }
      criteria:
        - { id: G01-C01, name: Executive so-what, kind: judged, measure: Does the opening say what it enables? }
        - { id: G01-C02, name: Alternatives considered, kind: counted }
    - id: G04
      name: Field-definition quality
      weight: 10
      critical: true
      criteria:
        - id: G04-C01
          name: Attribute completeness
          kind: counted
          check: { id: column_filled, params: { sheet: Fields, column: Definition } }
        - { id: G04-C02, name: Reason states purpose, kind: judged, anchors: { 5: a, 4: b, 3: c, 2: d, 1: e, 0: f } }
    - id: G12
      name: Verifiability
      weight: 5
      criteria:
        - { name: Second independent run agrees, kind: unmeasurable }
        - { name: Self-claim accuracy, kind: judged }
    - id: P01
      name: Plain dimension, scored as before
      weight: 5
      anchors: { 5: a, 4: b, 3: c, 2: d, 1: e, 0: f }
`;

const FIELDS: Array<Array<string | number | null>> = [
  ['Field ID', 'Name', 'Definition'],
  ['F-01', 'Register ID', 'Unique id of the register.'],
  ['F-02', 'Title', 'The register title.'],
  ['F-03', 'Owner', null],
  ['F-04', 'Status', 'Draft, review or final.'],
];

describe('the scorecard format', () => {
  it('reads criteria and the combination rule, filling in ids and the right kind of question', () => {
    const { scorecard } = parseScorecard(CRITERIA_YAML);
    expect(scorecard.aggregate).toEqual({ rule: 'mean_floor', zeroCapsAt: 2, unmeasuredCapsAt: 3 });
    const [g01, g04, g12, p01] = scorecard.dimensions;
    expect(g01!.criteria!.map((c) => [c.id, c.kind])).toEqual([['G01-C01', 'judged'], ['G01-C02', 'judged']]);
    // A "counted" criterion with no exact count is estimated by the examiners on the ratio bands.
    expect(g01!.criteria![1]!.measure).toMatch(/Estimate the share/);
    expect(g01!.criteria![1]!.anchors![5]).toMatch(/98%/);
    expect(g04!.criteria![0]).toMatchObject({ kind: 'counted', check: { id: 'column_filled', bands: [{ min: 0.98, score: 5 }, { min: 0.9, score: 4 }, { min: 0.75, score: 3 }, { min: 0.5, score: 2 }, { min: 0.0001, score: 1 }] } });
    expect(g12!.criteria!.map((c) => c.id)).toEqual(['G12-C01', 'G12-C02']);
    expect(g12!.criteria![0]!.measure).toMatch(/Judge only what the file itself records/);
    expect([g01, g04, g12, p01].map((d) => d!.measuredBy)).toEqual(['raters', 'raters', 'raters', 'raters']);
    expect(p01!.criteria).toBeUndefined();
  });

  it('refuses a criterion id that clashes with a dimension or another criterion', () => {
    expect(() => parseScorecard(CRITERIA_YAML.replace('id: G04-C01', 'id: G01-C01'))).toThrow(/duplicate id G01-C01/);
    expect(() => parseScorecard(CRITERIA_YAML.replace('{ id: G01-C01,', '{ id: P01,'))).toThrow(/duplicate id P01/);
  });

  it('leaves a scorecard without criteria exactly as before: same object through the agent, no aggregate', () => {
    const { scorecard } = parseScorecard(CLEAN_SCORECARD_YAML);
    expect(scorecard.aggregate).toBeUndefined();
    expect(expandCriteria(scorecard)).toBe(scorecard);
    expect(scorecard.dimensions.every((d) => d.criteria === undefined)).toBe(true);
  });

  it('will not write criteria to the Excel layout, rather than silently dropping them', async () => {
    await expect(scorecardToWorkbook(parseScorecard(CRITERIA_YAML).scorecard)).rejects.toThrow(/criterion by criterion.*Keep it as YAML/);
  });
});

describe('expanding criteria for the run', () => {
  it('makes each criterion a question of its own: judged ones for the examiners, counted ones for code', () => {
    const { scorecard } = parseScorecard(CRITERIA_YAML);
    const working = expandCriteria(scorecard);
    expect(working.dimensions.map((d) => [d.id, d.measuredBy, d.criterionOf?.id ?? null])).toEqual([
      ['G01-C01', 'raters', 'G01'],
      ['G01-C02', 'raters', 'G01'],
      ['G04-C01', 'code', 'G04'],
      ['G04-C02', 'raters', 'G04'],
      ['G12-C01', 'raters', 'G12'],
      ['G12-C02', 'raters', 'G12'],
      ['P01', 'raters', null],
    ]);
    // Anchors: the criterion's own, else the dimension's, else the standard scale.
    expect(working.dimensions.find((d) => d.id === 'G04-C02')!.anchors![5]).toBe('a');
    expect(working.dimensions.find((d) => d.id === 'G01-C01')!.anchors![5]).toBe('all');
    expect(Object.keys(working.dimensions.find((d) => d.id === 'G12-C02')!.anchors!)).toHaveLength(6);
    expect(working.dimensions.find((d) => d.id === 'G04-C01')!.critical).toBe(true);
    expect(expandCriteria(working)).toEqual(working);
    expect(criterionParents(scorecard).get('G12-C02')).toBe('G12');
  });

  it('shows the examiners which dimension each criterion is part of, and the size check measures those prompts', async () => {
    const { scorecard } = parseScorecard(CRITERIA_YAML);
    const wb = await WorkbookModel.load(await makeWorkbook({ Fields: FIELDS }));
    const [prompt] = buildAllRaterPrompts({ scorecard, wb, sources: '' });
    const card = JSON.parse(/<scorecard>\n([\s\S]*?)\n<\/scorecard>/.exec(prompt!.prompt.user)![1]!);
    expect(card.dimensions.map((d: { id: string }) => d.id)).toEqual(['G01-C01', 'G01-C02', 'G04-C02', 'G12-C01', 'G12-C02', 'P01']);
    expect(card.dimensions[0].part_of).toBe('G01 Purpose and scope');
    expect(card.dimensions.at(-1).part_of).toBeUndefined();
    const fit = preflight({ scorecard, wb, sources: '', raters: [{ id: 'A', model: 'm' }, { id: 'B', model: 'm' }, { id: 'C', model: 'm' }] });
    expect(fit.ok).toBe(true);
    expect(fit.tokens).toBeGreaterThan(0);
  });

  it('gives a finding raised on a criterion to its dimension', () => {
    const { scorecard } = parseScorecard(CRITERIA_YAML);
    const f = { source: 'raters' as const, dimensionId: 'G04-C02', severity: 'LOW' as const, title: 't', detail: '', fix: '', returnTo: 'Define' as const, location: null, reportedBy: ['A'] };
    expect(findingsToDimensions(scorecard, [f, { ...f, dimensionId: 'P01' }]).map((x) => x.dimensionId)).toEqual(['G04', 'P01']);
  });
});

describe('collapsing the results back into dimensions', () => {
  const result = (id: string, score: number | null, extra: Partial<DimensionResult> = {}): DimensionResult => ({
    id, name: id, weight: 1, critical: false, measuredBy: 'raters', status: score === null ? 'not_measurable' : 'scored',
    raterScores: { A: score, B: score }, consolidated: score, spread: 0, resolution: 'agreement', flagged: false, confidence: 'steady',
    rationale: `${id} rationale`, evidence: [{ sheet: 'Fields', cell: 'A2' }], ...extra,
  });

  it('applies the rule per dimension, keeps each criterion\'s result, and leaves plain dimensions untouched', () => {
    const { scorecard } = parseScorecard(CRITERIA_YAML);
    const dims = collapseCriteria(scorecard, [
      result('G01-C01', 4), result('G01-C02', 5),
      result('G04-C01', 3, { measuredBy: 'code', resolution: 'code', raterScores: {}, codeDetail: { passed: 3, total: 4, summary: '3 of 4' } }),
      result('G04-C02', 0, { resolution: 'single_rater', flagged: true, confidence: 'single' }),
      result('G12-C01', null), result('G12-C02', 5),
      result('P01', 2),
    ]);
    expect(dims.map((d) => [d.id, d.consolidated])).toEqual([['G01', 4], ['G04', 1], ['G12', 3], ['P01', 2]]);
    const g04 = dims[1]!;
    expect(g04).toMatchObject({ weight: 10, critical: true, resolution: 'single_rater', flagged: true, confidence: 'single', status: 'scored' });
    expect(g04.criteria!.map((c) => [c.id, c.kind, c.consolidated])).toEqual([['G04-C01', 'counted', 3], ['G04-C02', 'judged', 0]]);
    expect(g04.rationale).toMatch(/the mean of its criteria, rounded down; a criterion scored 0 caps it at 2/);
    expect(g04.rationale).toMatch(/G04-C01 Attribute completeness: 3 \(3 of 4\)/);
    // Each examiner's own view of the dimension, over the judged criteria it scored.
    expect(g04.raterScores).toEqual({ A: 0, B: 0 });
    expect(dims[2]!.rationale).toMatch(/Capped because a criterion that needs evidence from outside the file has none/);
    expect(dims[2]!.criteria![0]).toMatchObject({ status: 'not_measurable', consolidated: null });
    expect(dims[3]).toEqual(result('P01', 2));
  });

  it('marks a dimension not measurable when the file holds nothing for any of its criteria', () => {
    const { scorecard } = parseScorecard(CRITERIA_YAML);
    const dims = collapseCriteria(scorecard, [result('G12-C01', null), result('G12-C02', null)]);
    expect(dims.find((d) => d.id === 'G12')).toMatchObject({ status: 'not_measurable', consolidated: null, resolution: 'none' });
  });
});

describe('a full run, criterion by criterion (mock models)', () => {
  const same = mockModels(['mock-mid', 'mock-mid', 'mock-mid']);

  it('counts the counted criterion exactly, scores the judged ones, and combines them with the scorecard rule', async () => {
    const parsed = parseScorecard(CRITERIA_YAML);
    const run = await runEvaluation({ workbook: await makeWorkbook({ Fields: FIELDS }), scorecard: parsed, models: same });
    const byId = new Map(run.core.dimensions.map((d) => [d.id, d]));
    expect([...byId.keys()]).toEqual(['G01', 'G04', 'G12', 'P01']);
    // Three of four definitions filled = 75%, which the ratio bands make a 3; the examiners gave the judged criterion 4.
    const g04 = byId.get('G04')!;
    expect(g04.criteria!.find((c) => c.id === 'G04-C01')).toMatchObject({ kind: 'counted', consolidated: 3, codeDetail: { passed: 3, total: 4 } });
    expect(g04.criteria!.find((c) => c.id === 'G04-C02')).toMatchObject({ kind: 'judged', consolidated: 4 });
    expect(g04.consolidated).toBe(3); // floor((3 + 4) / 2)
    expect(byId.get('G01')!.consolidated).toBe(4);
    expect(byId.get('P01')!.consolidated).toBe(4);
    expect(byId.get('P01')!.criteria).toBeUndefined();
    // Findings belong to dimensions of the scorecard, never to a working criterion id.
    const known = new Set(parsed.scorecard.dimensions.map((d) => d.id));
    expect(run.core.findings.length).toBeGreaterThan(0);
    for (const f of run.core.findings) expect(known.has(f.dimensionId)).toBe(true);
    // The verdict reads the combined dimension scores: (5x4 + 10x3 + 5x4 + 5x4) / 25 / 5 = 72.
    const report = assembleReport(run.core, null);
    expect(report.verdict.weightedScore).toBe(72);
    expect(report.verdict.criticalGates).toEqual([expect.objectContaining({ dimensionId: 'G04', score: 3, status: 'failed' })]);
    expect(report.agreement.map((a) => a.dimensionId)).toEqual(['G01', 'G04', 'G12', 'P01']);
  });

  it('leaves out, without capping, a criterion the examiners decline when code counted the other', async () => {
    const parsed = parseScorecard(CRITERIA_YAML);
    const run = await runEvaluation({ workbook: await makeWorkbook({ Fields: FIELDS.map((r, i) => (i === 3 ? [r[0] ?? null, r[1] ?? null, 'Who owns it.'] : r)) }), scorecard: parsed, models: mockModels(['mock-abstain', 'mock-abstain', 'mock-abstain']) });
    const g04 = run.core.dimensions.find((d) => d.id === 'G04')!;
    expect(g04.criteria!.map((c) => [c.id, c.status, c.consolidated])).toEqual([['G04-C01', 'scored', 5], ['G04-C02', 'not_measurable', null]]);
    // The examiners declined a criterion the scorecard expects to be in the file: it is left out, not a reason to cap.
    expect(g04.consolidated).toBe(5);
    expect(g04.rationale).not.toMatch(/Capped/);
    expect(run.core.dimensions.find((d) => d.id === 'G01')).toMatchObject({ status: 'not_measurable', consolidated: null });
    const report = assembleReport(run.core, null);
    expect(report.verdict.skipped).toEqual(expect.arrayContaining(['G01', 'G12', 'P01']));
  });

  it('shows the area (not its criterion codes) in the Markdown, Excel and PDF reports', async () => {
    const run = await runEvaluation({ workbook: await makeWorkbook({ Fields: FIELDS }), scorecard: parseScorecard(CRITERIA_YAML), models: same });
    const report = assembleReport(run.core, null);
    const g04 = report.dimensions.find((d) => d.id === 'G04')!;
    const md = renderMarkdown(report);
    expect(md).toContain(`| ${g04.name.replace(/\s*·\s*GATE\s*$/i, '')} |`);
    expect(md).not.toMatch(/G04-C0\d/);
    const ExcelJS = (await import('exceljs')).default;
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await renderXlsx(report)) as unknown as ArrayBuffer);
    const names: string[] = [];
    book.getWorksheet('Areas')!.eachRow((row) => names.push(String(row.getCell(1).value)));
    expect(names).toHaveLength(report.dimensions.length + 1);
    const pdf = await renderPdf(report);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('a dimension some of whose criteria could not be scored', () => {
  it('is flagged uncertain, so it cannot make green, and says how many were left out', () => {
    const { scorecard } = parseScorecard(CRITERIA_YAML);
    const result = (id: string, score: number | null, extra: Partial<DimensionResult> = {}): DimensionResult => ({
      id, name: id, weight: 1, critical: false, measuredBy: 'raters', status: score === null ? 'unscored' : 'scored',
      raterScores: { A: score }, consolidated: score, spread: 0, resolution: 'agreement', flagged: false, confidence: 'steady',
      rationale: id, evidence: [], ...extra,
    });
    const g01 = collapseCriteria(scorecard, [result('G01-C01', 4), result('G01-C02', null), result('G04-C01', 5), result('G04-C02', 5), result('G12-C01', 3), result('G12-C02', 3), result('P01', 3)])[0]!;
    expect(g01).toMatchObject({ id: 'G01', status: 'scored', consolidated: 4, resolution: 'single_rater', flagged: true, confidence: 'single' });
    expect(g01.rationale).toMatch(/1 criterion\/criteria with no usable score were left out of the mean/);
  });
});

describe('criteria that need evidence from outside the file', () => {
  const part = (over: Partial<Parameters<typeof combineCriteria>[0][number]>) => ({ status: 'scored' as const, score: 4, weight: 1, ...over });

  it('does not let a 0 on an outside criterion force the zero cap; it counts as not in the file, which GS-1 caps at 3', () => {
    const rule = { rule: 'mean_floor' as const, zeroCapsAt: 2, unmeasuredCapsAt: 3 };
    const out = combineCriteria([part({ score: 5 }), part({ score: 5 }), part({ score: 5 }), part({ score: 0, outside: true })], rule);
    expect(out).toMatchObject({ status: 'scored', capped: 'unmeasured' });
    expect(out.score).toBe(3);
    // The same 0 on an ordinary criterion still caps at 2.
    expect(combineCriteria([part({ score: 5 }), part({ score: 5 }), part({ score: 0 })], rule)).toMatchObject({ score: 2, capped: 'zero' });
  });

  it('treats an outside criterion no examiner could score the same way, instead of counting it as an unscored zero', () => {
    const rule = { rule: 'mean_floor' as const, zeroCapsAt: 2, unmeasuredCapsAt: 3 };
    expect(combineCriteria([part({ status: 'unscored', score: null, outside: true }), part({ status: 'not_measurable', score: null, outside: true })], rule)).toMatchObject({ status: 'not_measurable' });
    // An ordinary criterion nobody could score still leaves the dimension unscored.
    expect(combineCriteria([part({ status: 'unscored', score: null })], rule)).toMatchObject({ status: 'unscored' });
  });

  it('leaves the whole dimension out when every criterion is outside and none has a usable score', () => {
    const rule = { rule: 'mean_floor' as const, zeroCapsAt: 2, unmeasuredCapsAt: 3 };
    expect(combineCriteria([part({ score: 0, outside: true }), part({ score: 0, outside: true })], rule)).toMatchObject({ status: 'not_measurable', score: null });
  });
});

describe('retyping a criterion whose wording needs outside evidence', () => {
  const card = (criteria: Array<Record<string, unknown>>) =>
    ({ id: 'S', name: 'S', version: '1', gate: 'D1', frozen: true, thresholds: { accept: 90, refine: 75 }, artifact: { sheets: [], context: [] }, dimensions: [{ id: 'D5', name: 'Runs', weight: 5, critical: false, measuredBy: 'raters', criteria }] }) as never;

  it('marks "agreed by at least 2 build runs", an interview and author answers as unmeasurable, with a note, and leaves others alone', () => {
    const { scorecard, notes } = retypeOutsideCriteria(
      card([
        { id: 'D5-C01', name: 'Design-point agreement', kind: 'counted', measure: 'Design points agreed by at least 2 build runs' },
        { id: 'D5-C02', name: 'Author interview score', kind: 'judged' },
        { id: 'D5-C03', name: 'Every field has a definition', kind: 'judged' },
        { id: 'D5-C04', name: 'Two independent runs agree', kind: 'counted', check: { id: 'row_count_at_least', params: {}, bands: [] } },
        { id: 'D5-C05', name: 'Second independent run', kind: 'judged', outside: true },
        { id: 'D5-C06', name: 'Defensibility (Verbal)', kind: 'judged' },
      ]),
    );
    const c = scorecard.dimensions[0]!.criteria!;
    expect(c.map((x) => [x.id, x.kind, Boolean(x.outside)])).toEqual([
      ['D5-C01', 'judged', true],
      ['D5-C02', 'judged', true],
      ['D5-C03', 'judged', false],
      ['D5-C04', 'counted', false],
      ['D5-C05', 'judged', true],
      ['D5-C06', 'judged', true],
    ]);
    expect(notes).toHaveLength(3);
    expect(notes[0]).toMatch(/D5-C01.*outside the file/);
  });

  it('wraps a question without criteria that needs outside evidence ("Visual / Format Quality") as one outside criterion', () => {
    const sc = {
      id: 'S', name: 'S', version: '1', gate: 'D1', frozen: true, thresholds: { accept: 90, refine: 75 }, artifact: { sheets: [], context: [] },
      dimensions: [
        { id: 'D8', name: 'Visual / Format Quality', weight: 8, critical: false, measuredBy: 'raters', anchors: { 0: 'a', 1: 'b', 2: 'c', 3: 'd', 4: 'e', 5: 'f' } },
        { id: 'D9', name: 'Definition clarity', weight: 8, critical: false, measuredBy: 'raters', anchors: { 0: 'a', 1: 'b', 2: 'c', 3: 'd', 4: 'e', 5: 'f' } },
      ],
    } as never;
    const { scorecard, notes } = retypeOutsideCriteria(sc);
    expect(scorecard.dimensions[0]!.criteria).toEqual([expect.objectContaining({ id: 'D8-C01', outside: true, kind: 'judged' })]);
    expect(scorecard.dimensions[1]!.criteria).toBeUndefined();
    expect(notes).toEqual(['D8 (Visual / Format Quality) needs evidence from outside the file, so it was treated as unmeasurable.']);
  });

  it('treats inter-rater agreement as outside evidence, but leaves a missing pilot (something a file can hold) as a real zero', () => {
    const { scorecard } = retypeOutsideCriteria(
      card([
        { id: 'D5-C01', name: 'Inter-rater agreement on scenarios', kind: 'judged' },
        { id: 'D5-C02', name: 'Pilot adequacy', kind: 'judged', measure: 'A filled pilot traced to workflow, KPI and UAT IDs' },
      ]),
    );
    expect(scorecard.dimensions[0]!.criteria!.map((x) => [x.id, Boolean(x.outside)])).toEqual([['D5-C01', true], ['D5-C02', false]]);
  });

  it('returns the same scorecard when nothing needs it', () => {
    const sc = card([{ id: 'D5-C03', name: 'Every field has a definition', kind: 'judged' }]);
    expect(retypeOutsideCriteria(sc)).toEqual({ scorecard: sc, notes: [] });
  });
});
