import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { WorkbookModel } from '../src/excel/workbook.js';
import { runCodeChecks } from '../src/agent/checks/index.js';
import { checkDraft, outlineDocument } from '../src/scorecard/importer.js';
import { listQuestions, summarise } from '../src/scorecard/importDraft.js';
import { parseScorecard } from '../src/scorecard/parse.js';
import { decide, effectiveDimensions } from '../src/agent/verdict.js';

function makePdf(pages: string[][]): Promise<Buffer> {
  const doc = new PDFDocument();
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  pages.forEach((lines, i) => {
    if (i > 0) doc.addPage();
    for (const line of lines) doc.text(line);
  });
  doc.end();
  return done;
}

const BANDS = '[{ min: 0.98, score: 5 }, { min: 0.9, score: 4 }, { min: 0.75, score: 3 }, { min: 0.5, score: 2 }, { min: 0.0001, score: 1 }]';
const card = (dimensions: string) => `
scorecard:
  id: SC-TEXT
  name: text
  version: "1"
  judges: D1 schema design
  step: "1"
  frozen: true
  thresholds: { accept: 90, refine: 75 }
  artifact:
    sheets: [{ name: "Page 1-2", header_row: 1 }]
  dimensions:
${dimensions}`;

const dim = (id: string, check: string) => `
    - id: ${id}
      name: ${id}
      weight: 10
      measured_by: code
      check:
        id: ${check}
        bands: ${BANDS}`;

const PAGES = [
  ['Field ROLE-001 must be defined', 'Reviewed as appropriate, etc.', 'Owner ROLE-002 signs off'],
  ['Grant date and approver recorded', 'Field ROLE-3 is vague, TBD', 'Expiry is set'],
];

async function run(dimensions: string) {
  const wb = await WorkbookModel.load(await makePdf(PAGES));
  return runCodeChecks(parseScorecard(card(dimensions)).scorecard, wb);
}

describe('counting in the text of a PDF', () => {
  it('counts the lines free of the listed words and cites the page and line of each miss', async () => {
    const [out] = await run(`${dim('V1', 'text_terms_absent')}
        params: { terms: ["etc", "TBD", "as appropriate"] }`);
    expect(out!.result.codeDetail).toMatchObject({ passed: 4, total: 6 });
    expect(out!.result.consolidated).toBe(2);
    expect(out!.failures).toEqual([{ sheet: 'Page 1', cell: 'A2' }, { sheet: 'Page 2', cell: 'A2' }]);
    expect(out!.result.rationale).toBe('4 of 6 lines are free of: etc, TBD, as appropriate');
  });

  it('matches whole words only, ignoring case', async () => {
    const [out] = await run(`${dim('V1', 'text_terms_absent')}
        params: { terms: ["tbd", "set", "gran"] }`);
    // "TBD" matches in any case and "set" as a word, but "gran" does not match inside "Grant"
    expect(out!.result.codeDetail).toMatchObject({ passed: 4, total: 6 });
  });

  it('checks that every required term appears and names what is missing', async () => {
    const [out] = await run(`${dim('P1', 'text_terms_present')}
        params: { terms: ["grant date", "approver", "expiry", "last review date", "reason"] }`);
    expect(out!.result.codeDetail).toMatchObject({ passed: 3, total: 5 });
    expect(out!.result.rationale).toMatch(/missing: last review date, reason/);
    expect(out!.result.consolidated).toBe(2);
  });

  it('checks that identifiers fit the strict pattern', async () => {
    const [out] = await run(`${dim('I1', 'text_ids_valid')}
        params: { find: "ROLE-[0-9]+", valid: "ROLE-[0-9]{3}" }`);
    expect(out!.result.codeDetail).toMatchObject({ passed: 2, total: 3 });
    expect(out!.failures).toEqual([{ sheet: 'Page 2', cell: 'A2' }]);
  });

  it('leaves the dimension unscored and flagged rather than scoring nothing as perfect', async () => {
    const [none] = await run(`${dim('I1', 'text_ids_valid')}
        params: { find: "ZZZ-[0-9]+", valid: "ZZZ-[0-9]{3}" }`);
    expect(none!.result).toMatchObject({ status: 'unscored', flagged: true });
    expect(none!.result.error).toMatch(/Nothing in the text looks like an identifier/);
    const [bad] = await run(`${dim('S1', 'text_terms_absent')}
        params: { terms: ["x"], sheets: ["Page 99"] }`);
    expect(bad!.result.status).toBe('unscored');
    expect(bad!.result.error).toMatch(/Sheet "Page 99" was not found/);
  });
});

describe('importing a counted criterion that code can count', () => {
  const ANCHORS = { '0': 'a', '1': 'b', '2': 'c', '3': 'd', '4': 'e', '5': 'f' };
  const reply = (criteria: unknown[], extra: Record<string, unknown> = {}) => ({
    scorecard: {
      id: 'SC-X', name: 'X', version: '1', judges: 'D1 schema design', thresholds: { accept: 90, refine: 75 },
      artifact: { sheets: [{ name: 'Whatever' }] },
      dimensions: [{ id: 'G04', name: 'Field quality', weight: 10, critical: true, measured_by: 'raters', measure: 'm', anchors: ANCHORS, criteria, ...extra }],
    },
    uncertain: [],
    adjustments: [],
  });
  const vague = { id: 'G04-C04', name: 'Vague-term free', kind: 'counted', check: { id: 'text_terms_absent', params: { terms: ['etc', 'TBD'] } } };

  const crit = (file: ReturnType<typeof checkDraft>['file'], id: string) => file.scorecard.dimensions.flatMap((d) => d.criteria ?? []).find((c) => c.id === id);

  it('keeps it inside its dimension as a code count with the source bands, next to the criteria the examiners score', () => {
    const { file, adjustments } = checkDraft(
      reply([{ id: 'G04-C01', name: 'Clear', kind: 'judged' }, { id: 'G04-C02', name: 'Count by hand', kind: 'counted' }, vague, { id: 'G04-C03', name: 'Reasoned', kind: 'judged' }]),
      'x',
      null,
    );
    // One dimension, with the source's own weight: nothing is split off any more.
    expect(file.scorecard.dimensions.map((d) => [d.id, d.weight])).toEqual([['G04', 10]]);
    const dim = file.scorecard.dimensions[0]!;
    expect(dim.criteria!.map((c) => [c.id, c.kind])).toEqual([['G04-C01', 'judged'], ['G04-C02', 'counted'], ['G04-C04', 'counted'], ['G04-C03', 'judged']]);
    expect(crit(file, 'G04-C04')!.check).toMatchObject({ id: 'text_terms_absent', params: { terms: ['etc', 'TBD'] } });
    expect(crit(file, 'G04-C02')!.check).toBeUndefined();
    // Read as a scorecard: the count gets the source's ratio bands, the uncountable "counted" criterion is estimated by the examiners.
    const sc = parseScorecard(JSON.stringify({ scorecard: file.scorecard })).scorecard;
    const parsed = sc.dimensions[0]!.criteria!;
    expect(parsed.find((c) => c.id === 'G04-C04')!.check!.bands[0]).toEqual({ min: 0.98, score: 5 });
    expect(parsed.find((c) => c.id === 'G04-C02')).toMatchObject({ kind: 'judged', measure: expect.stringMatching(/Estimate the share/) });
    expect(sc.dimensions[0]!.measuredBy).toBe('raters');
    expect(adjustments.join(' ')).toMatch(/G04-C04: counted by code \(text_terms_absent\) on the words or pattern shown/);
    expect(adjustments.join(' ')).toMatch(/G04: scored criterion by criterion \(3 by the examiners, 1 counted by code\)/);
    expect(summarise(file)).toEqual(expect.objectContaining({ dimensions: 1, byExaminers: 3, byCode: 1 }));
    expect(summarise(file)).not.toHaveProperty('byPerson');
    expect(listQuestions(file)[0]!.criteria!.find((c) => c.id === 'G04-C04')).toMatchObject({ by: 'code', how: 'Counts the lines that avoid: etc, TBD' });
  });

  it('a dimension of only code-counted criteria is counted by code and keeps its weight', () => {
    const { file } = checkDraft(reply([vague, { ...vague, id: 'G04-C05', name: 'Present', check: { id: 'text_terms_present', params: { terms: ['approver'] } } }]), 'x', null);
    expect(file.scorecard.dimensions.map((d) => [d.id, d.weight, d.criteria!.length])).toEqual([['G04', 10, 2]]);
    expect(parseScorecard(JSON.stringify({ scorecard: file.scorecard })).scorecard.dimensions[0]!.measuredBy).toBe('code');
    expect(listQuestions(file)[0]!.by).toBe('code');
  });

  it('drops a proposed count the app cannot make or whose pattern is broken, and leaves it to the examiners', () => {
    const unknown = { id: 'C1', name: 'Odd', kind: 'counted', check: { id: 'run_a_script', params: {} } };
    const broken = { id: 'C2', name: 'Pattern', kind: 'counted', check: { id: 'text_ids_valid', params: { find: '(', valid: 'x' } } };
    const { file, adjustments } = checkDraft(reply([{ id: 'J', name: 'Judged', kind: 'judged' }, unknown, broken]), 'x', null);
    expect(file.scorecard.dimensions[0]!.criteria!.map((c) => [c.id, c.check ?? null])).toEqual([['J', null], ['C1', null], ['C2', null]]);
    expect(adjustments.join(' ')).toMatch(/C1: the proposed count was dropped/);
    expect(adjustments.join(' ')).toMatch(/C2: the proposed count was dropped/);
  });

  it('counts toward the verdict like any code question, once the run combines the criteria', async () => {
    const { file } = checkDraft(reply([vague]), 'x', null);
    const scorecard = parseScorecard(JSON.stringify({ scorecard: file.scorecard })).scorecard;
    const wb = await WorkbookModel.load(await makePdf([['All fine here', 'Nothing vague']]));
    const { expandCriteria, collapseCriteria } = await import('../src/agent/aggregate.js');
    const outcomes = runCodeChecks(expandCriteria(scorecard), wb);
    expect(outcomes[0]!.result).toMatchObject({ id: 'G04-C04', status: 'scored', consolidated: 5 });
    const dims = collapseCriteria(scorecard, outcomes.map((o) => o.result));
    expect(dims[0]).toMatchObject({ id: 'G04', consolidated: 5, measuredBy: 'code' });
    expect(decide(scorecard, effectiveDimensions(scorecard, dims), []).score).toBe(100);
  });
});

describe('counting a workbook from an imported scorecard', () => {
  const book = async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Register');
    sheet.addRow(['Register of NFRs']);
    sheet.addRow(['4.1.1', '4.1.2', '4.2.1']);
    sheet.addRow(['nfr_id', 'statement', 'priority']);
    sheet.addRow(['NFR-001', 'Fast', 'High']);
    sheet.addRow(['NFR-002', 'Safe', 'High']);
    sheet.addRow(['NFR-002', '', 'Low']);
    return outlineDocument({ name: 'w.xlsx', bytes: Buffer.from(await wb.xlsx.writeBuffer()) });
  };
  const counted = (check: Record<string, unknown>) => ({ scorecard: { id: 'SC', version: 1, judges: 'D1 schema', thresholds: { accept: 90, refine: 75 }, dimensions: [{ id: 'G', name: 'G', weight: 10, measured_by: 'raters', anchors: { '0': 'a', '1': 'b', '2': 'c', '3': 'd', '4': 'e', '5': 'f' }, criteria: [{ id: 'C1', name: 'Ids are unique', kind: 'counted', check }] }] }, uncertain: [], adjustments: [] });

  it('finds the header row below the title, and tells the model which row it is', async () => {
    const outline = await book();
    expect(outline.headerRows?.get('register')).toBe(3);
    // The model is shown what each column holds and how full it is, from the workbook profile.
    expect(outline.text).toMatch(/Register \(header row 3, 3 data rows/);
    expect(outline.text).toMatch(/A "nfr_id": [a-z]+, 100% filled, e\.g\. "NFR-001", "NFR-002"/);
    expect(outline.text).toMatch(/B "statement": [a-z]+, 67% filled/);
    expect(outline.profile?.sheets[0]!.headerRow).toBe(3);
  });

  it('keeps a count that runs on the real file, with the header row set for it', async () => {
    const outline = await book();
    const { file, adjustments } = checkDraft(counted({ id: 'unique', params: { sheet: 'Register', column: 'nfr_id' } }), 'x', outline);
    const dim = file.scorecard.dimensions[0]!;
    expect(dim.criteria![0]).toMatchObject({ id: 'C1', kind: 'counted', check: { id: 'unique' } });
    expect(file.scorecard.artifact.sheets).toEqual([{ name: 'Register', header_row: 3 }]);
    expect(adjustments.join(' ')).toMatch(/C1: counted by code \(unique\)/);
  });

  it('drops a count that names a column the sheet does not have, and leaves it to the examiners', async () => {
    const outline = await book();
    const { file, adjustments } = checkDraft(counted({ id: 'unique', params: { sheet: 'Register', column: 'no_such_column' } }), 'x', outline);
    expect(file.scorecard.dimensions[0]!.criteria![0]!.check).toBeUndefined();
    expect(adjustments.join(' ')).toMatch(/C1: the proposed count was dropped/);
  });

  it('keeps a count that gives the same answer as the figure the scorecard states, and drops one that does not', async () => {
    const outline = await book();
    // Three ids, one repeated: the sheet's own count is 1 of 3 unique rows.
    const same = checkDraft({ ...counted({ id: 'unique', params: { sheet: 'Register', column: 'nfr_id' } }) }, 'x', outline);
    const counts = (r: ReturnType<typeof checkDraft>) => Boolean(r.file.scorecard.dimensions[0]!.criteria![0]!.check);
    expect(counts(same)).toBe(true);
    const withSource = (n: number, d: number, check: Record<string, unknown>) => {
      const reply = counted(check);
      (reply.scorecard.dimensions[0] as { criteria: Array<Record<string, unknown>> }).criteria[0]!.source_n = n;
      (reply.scorecard.dimensions[0] as { criteria: Array<Record<string, unknown>> }).criteria[0]!.source_d = d;
      return checkDraft(reply, 'x', outline);
    };
    const filled = { id: 'column_filled', params: { sheet: 'Register', column: 'statement' } }; // 2 of 3 filled
    const kept = withSource(2, 3, filled);
    expect(counts(kept)).toBe(true);
    expect(kept.trials.C1).toMatch(/2 of 3 pass on your file/);
    const dropped = withSource(3, 3, filled);
    expect(counts(dropped)).toBe(false);
    expect(dropped.adjustments.join(' ')).toMatch(/it gave 2 of 3, but your scorecard says 3 of 3, so it is not counting the same thing/);
  });

  it('drops a count that passes nothing when the scorecard gives no figure to compare with', async () => {
    const outline = await book();
    const { adjustments, file } = checkDraft(counted({ id: 'column_filled', params: { sheet: 'Register', column: 'priority', pattern: '^zzz$' } }), 'x', outline);
    expect(file.scorecard.dimensions[0]!.criteria![0]!.check).toBeUndefined();
    expect(adjustments.join(' ')).toMatch(/it passed none of 3 rows/);
  });

  it('does not accept a workbook count when the document is a PDF', async () => {
    const outline = await outlineDocument({ name: 'd.pdf', bytes: await makePdf([['Some text']]) });
    const { adjustments } = checkDraft(counted({ id: 'unique', params: { sheet: 'Page 1', column: 'x' } }), 'x', outline);
    expect(adjustments.join(' ')).toMatch(/the proposed count was dropped/);
  });
});

describe('a question nobody can measure', () => {
  const card = (unmeasured: string) => parseScorecard(`
scorecard:
  id: SC
  version: 1
  judges: D1 schema
  frozen: true
  unmeasured: ${unmeasured}
  thresholds: { accept: 90, refine: 75 }
  artifact: { sheets: [Sheet1] }
  dimensions:
    - { id: A, name: Counted, weight: 90, measured_by: raters, anchors: { 0: a, 1: b, 2: c, 3: d, 4: e, 5: f } }
    - { id: B, name: Second run, weight: 10, critical: true, measured_by: human, needs: A second run }
`).scorecard;
  const scored = [{ id: 'A', name: 'Counted', weight: 90, critical: false, measuredBy: 'raters', status: 'scored', raterScores: {}, consolidated: 5, spread: 0, resolution: 'agreement', flagged: false, rationale: '', evidence: [] }] as unknown as Parameters<typeof effectiveDimensions>[1];

  it('never waits for a person: the old "person" setting leaves the question out of the score, like skip', () => {
    const sc = card('person');
    const verdict = decide(sc, effectiveDimensions(sc, scored), []);
    expect(verdict.decision).toBe('green');
    expect(verdict.skipped).toEqual(['B']);
    expect(verdict.reasons.join(' ')).not.toMatch(/person/i);
  });

  it('counts the question as 0 when the scorecard says zero', () => {
    const sc = card('zero');
    const verdict = decide(sc, effectiveDimensions(sc, scored), []);
    expect(verdict.score).toBe(90);
    expect(verdict.skipped).toEqual([]);
  });

  it('is left out of the score when the scorecard says skip, and does not hold the result back', () => {
    const sc = card('skip');
    const verdict = decide(sc, effectiveDimensions(sc, scored), []);
    expect(verdict.decision).toBe('green');
    expect(verdict.score).toBe(100);
    expect(verdict.skipped).toEqual(['B']);
    expect(verdict.criticalGates.find((g) => g.dimensionId === 'B')?.status).toBe('skipped');
    expect(verdict.reasons.join(' ')).toMatch(/so they are left out of the score: B \(Second run\)/);
  });
});

describe('the columns an imported question reads', () => {
  const ANCHORS = { '0': 'a', '1': 'b', '2': 'c', '3': 'd', '4': 'e', '5': 'f' };
  const withReads = (reads: string[]) => ({ scorecard: { id: 'SC', version: 1, judges: 'D1 schema', thresholds: { accept: 90, refine: 75 }, dimensions: [{ id: 'G', name: 'G', weight: 10, measured_by: 'raters', anchors: ANCHORS, reads }] }, uncertain: [], adjustments: [] });
  const book = async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Register');
    sheet.addRow(['Register of NFRs']);
    sheet.addRow(['nfr_id', 'Statement  text', 'priority', 'owner']);
    sheet.addRow(['NFR-001', 'Fast', 'High', 'Ops']);
    return outlineDocument({ name: 'w.xlsx', bytes: Buffer.from(await wb.xlsx.writeBuffer()) });
  };

  it('keeps only real columns, written with their exact titles, so a big sheet is sent in part', async () => {
    const { file, adjustments } = checkDraft(withReads(['register[NFR_ID|statement text|Nope]']), 'x', await book());
    expect(file.scorecard.dimensions[0]!.reads).toEqual(['Register[nfr_id|Statement  text]']);
    expect(adjustments.join(' ')).toMatch(/G: Register has no column "Nope", so it was left out/);
  });

  it('reads the whole sheet when none of the named columns exist', async () => {
    const { file, adjustments } = checkDraft(withReads(['Register[Missing]']), 'x', await book());
    expect(file.scorecard.dimensions[0]!.reads).toEqual(['Register']);
    expect(adjustments.join(' ')).toMatch(/so the whole sheet is read/);
  });

  it('the trimmed columns really are what the examiners are sent', async () => {
    const outline = await book();
    const { file } = checkDraft(withReads(['Register[nfr_id|priority]']), 'x', outline);
    const scorecard = parseScorecard(JSON.stringify({ scorecard: file.scorecard })).scorecard;
    const { buildAllRaterPrompts } = await import('../src/agent/prompt.js');
    const [section] = buildAllRaterPrompts({ scorecard, wb: outline.wb!, sources: '' });
    expect(section!.prompt.user).toContain('NFR-001');
    expect(section!.prompt.user).toContain('High');
    expect(section!.prompt.user).not.toContain('Ops');
  });
});

describe('keeping a converted question small enough for the models', () => {
  const ANCHORS = { '0': 'a', '1': 'b', '2': 'c', '3': 'd', '4': 'e', '5': 'f' };
  const wide = async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Fields');
    const headers = ['Field ID', 'Name', 'Definition', 'Validation rule', 'Owner', ...Array.from({ length: 15 }, (_, i) => `Extra ${i}`)];
    sheet.addRow(headers);
    for (let r = 0; r < 300; r++) sheet.addRow(headers.map((h) => `${h} value for row ${r} with some words to make it long`));
    return outlineDocument({ name: 'w.xlsx', bytes: Buffer.from(await wb.xlsx.writeBuffer()) });
  };
  const question = (reads: string[], measure = 'Are the validation rules testable?', name = 'Validation rules') => ({
    scorecard: { id: 'SC', version: 1, judges: 'D1 schema', thresholds: { accept: 90, refine: 75 }, dimensions: [{ id: 'G07', name, weight: 10, measured_by: 'raters', measure, anchors: ANCHORS, reads }] },
    uncertain: [], adjustments: [],
  });

  it('cuts a whole wide sheet to the id column plus the columns that match the question, when it is over the budget', async () => {
    const { file, adjustments } = checkDraft(question(['Fields']), 'x', await wide(), 3, 5_000);
    expect(file.scorecard.dimensions[0]!.reads).toEqual(['Fields[Field ID|Validation rule]']);
    expect(adjustments.join(' ')).toMatch(/G07: what it reads was about [\d,]+ tokens, too big for the models, so code kept only the columns that match the question/);
  });

  it('leaves it alone when it fits, and keeps columns the model chose itself', async () => {
    const outline = await wide();
    expect(checkDraft(question(['Fields']), 'x', outline, 3, 10_000_000).file.scorecard.dimensions[0]!.reads).toEqual(['Fields']);
    expect(checkDraft(question(['Fields[Name|Owner]']), 'x', outline, 3, 5_000).file.scorecard.dimensions[0]!.reads).toEqual(['Fields[Name|Owner]']);
  });

  it('says so when even the cut-down sheet is over the budget, and keeps at most eight columns', async () => {
    const { file, adjustments } = checkDraft(question(['Fields'], 'Nothing in common here', 'Unrelated'), 'x', await wide(), 3, 50);
    const reads = file.scorecard.dimensions[0]!.reads![0]!;
    expect(reads.split('|')).toHaveLength(8);
    expect(adjustments.join(' ')).toMatch(/still reads about [\d,]+ tokens, more than the 50 planned/);
  });

  it('gives each question a budget that fits the tightest rater', async () => {
    const { importCandidates, QUESTION_TOKEN_BUDGET: budget } = await import('../src/scorecard/importer.js').then(async (m) => ({ ...m, ...(await import('../src/scorecard/importDraft.js')) }));
    const { mockModels } = await import('./helpers.js');
    const { createProviderFactory } = await import('../src/llm/registry.js');
    const roomy = mockModels();
    expect(importCandidates(roomy, createProviderFactory(roomy, { mockDelayMs: 0 }))[0]!.tokenBudget).toBe(budget);
    const tight = mockModels();
    tight.raters[1]!.maxInputTokens = 8_000;
    expect(importCandidates(tight, createProviderFactory(tight, { mockDelayMs: 0 }))[0]!.tokenBudget).toBe(4_000);
  });
});
