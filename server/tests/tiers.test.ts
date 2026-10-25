import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { bandOf, confirmedFirst, examinerCount, issueNumbers, presentReport, tierFindings, tierFor, tierOf, type Finding, type ReliabilityTable, type UsageLine } from '@ddd/shared';
import { assembleReport } from '../src/report/assemble.js';
import { buildCost, costSentence, loadPrices } from '../src/report/cost.js';
import { buildView } from '../src/report/view.js';
import { renderMarkdown } from '../src/report/markdown.js';
import { renderXlsx } from '../src/report/xlsx.js';
import { renderPdf } from '../src/report/pdf.js';
import { loneFindingTrusted } from '../src/agent/reliability.js';
import { checkFinding, checkFindings } from '../src/agent/findingCheck.js';
import { usageOf } from '../src/agent/usage.js';
import { WorkbookModel } from '../src/excel/workbook.js';
import { TALENTRA_XLSX, makeWorkbook, runEvaluation, writeTemp } from './helpers.js';

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: 'F-01', severity: 'MEDIUM', dimensionId: 'G01', location: { sheet: 'README', cell: 'A1' }, title: 'Something is unclear', detail: 'Detail', fix: 'Fix it',
  returnTo: 'Define', source: 'raters', reportedBy: ['A'], ...over,
});

describe('the two tiers: Confirmed and Worth a look', () => {
  it('confirms what code found, what two or more examiners raised, and what a cell proves', () => {
    expect(tierOf(finding({ source: 'code', reportedBy: ['code'] })).tier).toBe('confirmed');
    expect(tierOf(finding({ reportedBy: ['A', 'C'] })).tier).toBe('confirmed');
    expect(tierOf(finding({ reportedBy: ['A', 'B', 'C'] })).tier).toBe('confirmed');
    expect(tierOf(finding({ reportedBy: ['B'], proof: 'Code read the cells and they are empty: X!A1.' })).tier).toBe('confirmed');
  });

  it('puts a lone examiner judgement call under Worth a look, however severe, and says why in plain words', () => {
    for (const severity of ['HIGH', 'MEDIUM', 'LOW'] as const) {
      const t = tierOf(finding({ severity }));
      expect(t.tier).toBe('worth_a_look');
      expect(t.reason).toMatch(/one examiner/i);
      expect(t.reason).not.toMatch(/zhipu|meta|qwen|mistral|bedrock/i);
    }
  });

  it('counts an examiner once, and the computer check is not an examiner', () => {
    expect(examinerCount(finding({ reportedBy: ['A', 'A'] }))).toBe(1);
    expect(tierOf(finding({ reportedBy: ['A', 'A'] })).tier).toBe('worth_a_look');
    expect(examinerCount(finding({ reportedBy: ['code', 'A'] }))).toBe(1);
  });

  it('keeps a lone finding Confirmed only for an examiner with a good checked record, and never for a thin one', () => {
    const table: ReliabilityTable = {
      computedAt: 'x', thresholds: { minSamples: 20, dropBelow: 0.2 },
      families: { good: { solo: { n: 38, useful: 22 }, any: { n: 80, useful: 60 } }, poor: { solo: { n: 49, useful: 5 }, any: { n: 90, useful: 40 } }, thin: { solo: { n: 6, useful: 6 }, any: { n: 6, useful: 6 } } },
    };
    const roster = [{ id: 'A', family: 'good' }, { id: 'B', family: 'poor' }, { id: 'C', family: 'thin' }, { id: 'D', family: 'unknown' }];
    const lone = (id: string) => finding({ reportedBy: [id] });
    expect(['A', 'B', 'C', 'D'].map((id) => loneFindingTrusted(lone(id), roster, table))).toEqual([true, false, false, false]);
    expect(loneFindingTrusted(lone('A'), roster, undefined)).toBe(false);
    expect(loneFindingTrusted(finding({ reportedBy: ['A', 'B'] }), roster, table)).toBe(false);
    const tiered = tierFindings([lone('A'), lone('B')], undefined, (f) => loneFindingTrusted(f, roster, table));
    expect(tiered.map((f) => f.tier)).toEqual(['confirmed', 'worth_a_look']);
    expect(tiered[0]!.tierReason).toMatch(/held up/);
  });

  it('puts Confirmed first, keeps each order, and numbers issues and look items separately', () => {
    const list = tierFindings([finding({ id: 'F-01' }), finding({ id: 'F-02', reportedBy: ['A', 'B'] }), finding({ id: 'F-03' }), finding({ id: 'F-04', source: 'code', reportedBy: ['code'] })]);
    const ordered = confirmedFirst(list);
    expect(ordered.map((f) => f.id)).toEqual(['F-02', 'F-04', 'F-01', 'F-03']);
    const numbers = issueNumbers({ findings: ordered });
    expect([...numbers.values()]).toEqual(['Issue 1', 'Issue 2', 'Look 1', 'Look 2']);
  });

  it('uses the tier a finding already carries, and computes one for a report saved before tiers existed', () => {
    expect(tierFor(finding({ tier: 'confirmed' }))).toBe('confirmed');
    expect(tierFor(finding())).toBe('worth_a_look');
  });
});

describe('a cell that proves a finding makes it Confirmed', () => {
  it('marks a missing-value claim as proved when code reads the named cells and they are empty', async () => {
    const file = await writeTemp('proof.xlsx', await makeWorkbook({
      Fields: [['id', 'name', 'definition'], ['F1', 'a', 'x'], ['F2', 'b', ''], ['F3', 'c', ''], ['F4', 'd', 'y']],
    }));
    const wb = await WorkbookModel.load(file);
    const claim = { source: 'raters' as const, dimensionId: 'G01', severity: 'MEDIUM' as const, title: 'Missing definition', detail: 'Rows 3-4 have no definition in column C.', fix: 'Add them', returnTo: 'Define' as const, location: { sheet: 'Fields', cell: 'C3' }, reportedBy: ['A'] };
    const verdict = checkFinding(claim, wb);
    expect(verdict.keep).toBe(true);
    if (verdict.keep) {
      expect(verdict.finding.proof).toMatch(/empty/);
      expect(tierOf({ ...verdict.finding, source: 'raters' }).tier).toBe('confirmed');
    }
    // A merge keeps the proof of whichever member had it.
    const merged = checkFindings([claim, { ...claim, title: 'Definitions are absent', detail: 'No definition for rows 3-4 in column C.', reportedBy: ['B'] }], wb);
    expect(merged.findings).toHaveLength(1);
    expect(merged.findings[0]!.proof).toMatch(/empty/);
  });

  it('gives a judgement no proof', async () => {
    const file = await writeTemp('judg.xlsx', await makeWorkbook({ S: [['id'], ['1']] }));
    const wb = await WorkbookModel.load(file);
    const v = checkFinding({ source: 'raters', dimensionId: 'G01', severity: 'HIGH', title: 'Naming is inconsistent across IDs', detail: 'IDs such as ACT-01 and act_2 follow different patterns.', fix: 'Unify', returnTo: 'Define', location: null, reportedBy: ['A'] }, wb);
    expect(v.keep && v.finding.proof).toBeFalsy();
  });
});

describe('the report headline uses Confirmed findings only', () => {
  it('counts, blocks and plans from Confirmed, shows Worth a look apart, and leaves score and colour alone', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX });
    const core = structuredClone(run.core);
    const base = core.findings[0]!;
    const make = (id: string, severity: Finding['severity'], reportedBy: string[], source: Finding['source'] = 'raters'): Finding => ({ ...base, id, severity, reportedBy, source, tier: undefined, title: `Title of ${id}`, detail: 'Some detail.', fix: 'Do the fix.' });
    core.findings = [make('F-01', 'HIGH', ['A', 'B']), make('F-02', 'HIGH', ['C']), make('F-03', 'LOW', ['B']), make('F-04', 'MEDIUM', ['code'], 'code')];
    const before = assembleReport({ ...core, findings: core.findings.map((f) => ({ ...f, tier: 'confirmed' as const })) }, null);
    const report = assembleReport(core, null);

    expect(report.tiers).toEqual({ confirmed: 2, worthALook: 2 });
    expect(report.findings.map((f) => f.id)).toEqual(['F-01', 'F-04', 'F-02', 'F-03']);
    // One HIGH finding is Confirmed (F-01); the lone-examiner HIGH is not.
    expect(report.verdict.blockingFindings).toEqual(['F-01']);
    expect(report.verdict.reasons.join(' ')).toMatch(/1 high-risk finding\b/);
    expect(report.pathToGreen.blockingFindingIds).toEqual(['F-01']);
    // Score and colour are the same however the findings are tiered.
    expect(report.verdict.weightedScore).toBe(before.verdict.weightedScore);
    expect(report.verdict.decision).toBe(before.verdict.decision);
    expect(report.verdict.decision).toBe(bandOf(report.verdict.weightedScore));

    const view = buildView(report);
    expect(view.issues.map((i) => i.label)).toEqual(['Issue 1', 'Issue 2']);
    expect(view.lookIssues.map((i) => i.label)).toEqual(['Look 1', 'Look 2']);
    expect(view.bySeverity.HIGH).toHaveLength(1);
    expect(view.bySeverity.LOW).toHaveLength(0);
    expect(view.issuesByArea.reduce((n, a) => n + a.count, 0)).toBe(2);
    expect(view.lookNote).toMatch(/one examiner/i);
  });

  it('shows Worth a look on its own, closed or last, in Markdown, Excel and PDF, without model names', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX });
    const core = structuredClone(run.core);
    const base = core.findings[0]!;
    core.findings = [
      { ...base, id: 'F-01', severity: 'HIGH', reportedBy: ['A', 'B'], source: 'raters', tier: undefined, title: 'Confirmed title' },
      { ...base, id: 'F-02', severity: 'MEDIUM', reportedBy: ['C'], source: 'raters', tier: undefined, title: 'Single examiner title' },
    ];
    const report = assembleReport(core, null);

    const md = renderMarkdown(report);
    expect(md.indexOf('## What to fix first')).toBeLessThan(md.indexOf('## Worth a look (1)'));
    expect(md).toContain('<details>');
    const fixSection = md.slice(md.indexOf('## What to fix first'), md.indexOf('## Worth a look'));
    expect(fixSection).toContain('Confirmed title');
    expect(fixSection).not.toContain('Single examiner title');
    expect(md).toMatch(/\*\*Key numbers:\*\* 1 must fix, 0 should fix, 0 nice to fix/);
    expect(md.slice(md.indexOf('## Worth a look'))).toContain('Single examiner title');

    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await renderXlsx(report)) as unknown as ExcelJS.Buffer);
    expect(book.worksheets.map((s) => s.name)).toEqual(['Summary', 'Areas', 'Issues', 'Strengths', 'Examiners', 'Path to green', 'Not checked', 'Worth a look']);
    expect(book.getWorksheet('Issues')!.rowCount).toBe(2);
    expect(book.getWorksheet('Worth a look')!.getRow(2).getCell(5).value).toBe('Single examiner title');
    const text: string[] = [md];
    book.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => text.push(String(c.value ?? '')))));
    const all = text.join('\n');
    expect(all).not.toMatch(/bedrock|mock|\bF-\d+\b/i);
    for (const m of [...report.header.raters.map((r) => r.model), report.header.consolidator.model]) expect(all).not.toContain(m);

    const pdf = await renderPdf(report);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const presented = presentReport(report);
    expect(presented.findings.map((f) => f.reportedBy)).toEqual([['Examiner 1', 'Examiner 2'], ['Examiner 3']]);
  });

  it('has no Worth a look sheet or section when every finding is Confirmed', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX });
    const core = structuredClone(run.core);
    core.findings = core.findings.map((f) => ({ ...f, reportedBy: ['A', 'B'], source: 'raters' as const, tier: undefined }));
    const report = assembleReport(core, null);
    expect(report.tiers?.worthALook).toBe(0);
    expect(renderMarkdown(report)).not.toContain('Worth a look');
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await renderXlsx(report)) as unknown as ExcelJS.Buffer);
    expect(book.getWorksheet('Worth a look')).toBeUndefined();
  });

  it('a real evaluation stamps tiers and records usage', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX });
    expect(run.core.findings.length).toBeGreaterThan(0);
    expect(run.core.findings.every((f) => f.tier === 'confirmed' || f.tier === 'worth_a_look')).toBe(true);
    expect(run.core.usage).toBeDefined();
  });
});

describe('the cost line', () => {
  const usage: UsageLine[] = [
    { id: 'A', model: 'model-a', calls: 3, inputTokens: 1_000_000, outputTokens: 50_000 },
    { id: 'B', model: 'model-b', calls: 3, inputTokens: 500_000, outputTokens: 20_000 },
    { id: 'K', model: 'model-k', calls: 2, inputTokens: 200_000, outputTokens: 10_000 },
    { id: 'checks', model: 'model-k', calls: 4, inputTokens: 100_000, outputTokens: 5_000 },
  ];

  it('shows tokens only when the price table has no entry', () => {
    const cost = buildCost(usage, { currency: 'USD', perMillionTokens: {} })!;
    expect(cost.totalCost).toBeNull();
    expect(cost.inputTokens).toBe(1_800_000);
    expect(cost.outputTokens).toBe(85_000);
    expect(cost.lines.map((l) => l.label)).toEqual(['Examiner 1', 'Examiner 2', 'Final reviewer', 'Fact checks']);
    expect(costSentence(cost)).toBe('This check used 1,800,000 tokens in and 85,000 out.');
  });

  it('prices the models it has an entry for and says when the total is partial', () => {
    const prices = { currency: 'USD', perMillionTokens: { 'model-a': { input: 1, output: 4 }, 'model-k': { input: 0.5, output: 2 } } };
    const cost = buildCost(usage, prices)!;
    expect(cost.lines.map((l) => l.cost)).toEqual([1.2, null, 0.12, 0.06]);
    expect(cost.totalCost).toBeCloseTo(1.38, 6);
    expect(cost.complete).toBe(false);
    expect(costSentence(cost)).toMatch(/Estimated cost of the models with a price: \$1\.38/);
    const full = buildCost(usage, { ...prices, perMillionTokens: { ...prices.perMillionTokens, 'model-b': { input: 2, output: 2 } } })!;
    expect(full.complete).toBe(true);
    expect(costSentence(full)).toMatch(/Estimated cost: \$2\.\d\d\./);
  });

  it('matches a model with or without its region prefix, ignores empty usage, and reads a missing or broken price file as no prices', async () => {
    expect(buildCost([{ id: 'A', model: 'us.vendor.model-v1:0', calls: 1, inputTokens: 1_000_000, outputTokens: 0 }], { currency: 'USD', perMillionTokens: { 'vendor.model-v1:0': { input: 3, output: 3 } } })!.totalCost).toBe(3);
    expect(buildCost([], loadPrices({}))).toBeNull();
    expect(buildCost(undefined)).toBeNull();
    expect(loadPrices({ PRICES_CONFIG: '/nonexistent/prices.json' }).perMillionTokens).toEqual({});
    const broken = await writeTemp('prices.json', '{ not json');
    expect(loadPrices({ PRICES_CONFIG: broken }).perMillionTokens).toEqual({});
    const odd = await writeTemp('prices2.json', JSON.stringify({ currency: 'EUR', perMillionTokens: { ok: { input: 1, output: 2 }, bad: { input: 'x', output: 1 }, neg: { input: -1, output: 1 } } }));
    expect(loadPrices({ PRICES_CONFIG: odd })).toEqual({ currency: 'EUR', perMillionTokens: { ok: { input: 1, output: 2 } } });
  });

  it('adds a model-free cost line to the Markdown, the Excel summary and the view', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX });
    const core = structuredClone(run.core);
    core.usage = usage;
    const report = assembleReport(core, null, { currency: 'USD', perMillionTokens: { 'model-a': { input: 1, output: 4 } } });
    const md = renderMarkdown(report);
    expect(md).toContain('## What this check used');
    expect(md).toContain('This check used 1,800,000 tokens in and 85,000 out');
    expect(md).toContain('| Examiner 1 | 3 | 1,000,000 | 50,000 | $1.20 |');
    expect(md).not.toMatch(/model-a|model-b|model-k/);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await renderXlsx(report)) as unknown as ExcelJS.Buffer);
    const cells: string[] = [];
    book.getWorksheet('Summary')!.eachRow((row) => row.eachCell((c) => cells.push(String(c.value ?? ''))));
    expect(cells.join('\n')).toContain('What this check used');
    expect(cells.join('\n')).not.toMatch(/model-a/);
    expect(JSON.stringify(presentReport(report).cost)).not.toMatch(/model-a/);
    expect((await renderPdf(report)).length).toBeGreaterThan(3000);
  });

  it('shows no cost section when a run recorded no usage', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX });
    const core = structuredClone(run.core);
    delete core.usage;
    const report = assembleReport(core, null);
    expect(report.cost).toBeUndefined();
    expect(renderMarkdown(report)).not.toContain('What this check used');
  });

  it('builds the usage lines from the calls, the fact-check calls and the presence check', () => {
    const model = (id: string, m: string) => ({ id, provider: 'p', model: m, family: 'f' });
    const lines = usageOf(
      [
        { model: model('A', 'm-a'), role: 'rater', attempts: 2, inputTokens: 10, outputTokens: 5 },
        { model: model('K', 'm-k'), role: 'consolidator', attempts: 1, inputTokens: null, outputTokens: null },
      ],
      { model: 'm-v', calls: 3, inputTokens: 7, outputTokens: 2 },
      model('K', 'm-k'),
      { model: 'm-p', inputTokens: 4, outputTokens: 1 },
    );
    expect(lines).toEqual([
      { id: 'A', model: 'm-a', calls: 2, inputTokens: 10, outputTokens: 5 },
      { id: 'K', model: 'm-k', calls: 1, inputTokens: 0, outputTokens: 0 },
      { id: 'checks', model: 'm-p', calls: 1, inputTokens: 4, outputTokens: 1 },
      { id: 'checks', model: 'm-v', calls: 3, inputTokens: 7, outputTokens: 2 },
    ]);
  });
});
