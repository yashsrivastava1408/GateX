import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { assembleReport } from '../src/report/assemble.js';
import { renderMarkdown } from '../src/report/markdown.js';
import { renderXlsx } from '../src/report/xlsx.js';
import { renderPdf } from '../src/report/pdf.js';
import { improvementPlan } from '../src/report/improvements.js';
import { TALENTRA_XLSX, runEvaluation } from './helpers.js';

describe('the GateX report', () => {
  it('has plainly named sheets in the workbook and a briefing-style Markdown', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX });
    const report = assembleReport(run.core, null);

    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await renderXlsx(report)) as unknown as ExcelJS.Buffer);
    expect(book.creator).toBe('GateX');
    expect(book.worksheets.map((s) => s.name)).toEqual(['Summary', 'Areas', 'Issues', 'Strengths', 'Examiners', 'Path to green', 'Not checked']);

    const summary = book.getWorksheet('Summary')!;
    const values = new Map<string, unknown>();
    summary.eachRow((row) => values.set(String(row.getCell(1).value), row.getCell(2).value));
    expect(values.get('File')).toBe(report.header.artifactName);
    expect(String(values.get('Marked by'))).toMatch(/3 examiners and a Final reviewer/);

    // One row per area, one per issue, and the header row on each.
    expect(book.getWorksheet('Areas')!.rowCount).toBe(report.dimensions.length + 1);
    expect(book.getWorksheet('Issues')!.rowCount).toBe(report.findings.length + 1);
    expect(book.getWorksheet('Issues')!.getRow(2).getCell(1).value).toBe('Issue 1');

    const markdown = renderMarkdown(report);
    expect(markdown).toContain('Issue 1');
    const order = ['## What this means', '## What to fix first', '## How each area scored', '## Your path to green', '## What is already good', '## How the examiners compared', '## Not checked from the file', '## About this check'];
    const positions = order.map((h) => markdown.indexOf(h));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('never shows a model name, a provider, or an area, criterion or finding code, in any format', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX });
    const report = assembleReport(run.core, null);
    const text: string[] = [renderMarkdown(report)];
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await renderXlsx(report)) as unknown as ExcelJS.Buffer);
    book.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => text.push(String(c.value ?? '')))));
    const all = text.join('\n');
    expect(all).not.toMatch(/\bG\d{2}\b/);
    expect(all).not.toMatch(/\bF-\d+\b/);
    expect(all).not.toMatch(/\b[A-Z]\d{2}-C\d{2}\b/);
    expect(all).not.toMatch(/bedrock|mock/i);
    const models = [...report.header.raters.map((r) => r.model), report.header.consolidator.model];
    for (const m of models) expect(all).not.toContain(m);
    expect(all).toMatch(/Examiner 1/);

    const pdf = await renderPdf(report);
    // PDF text is compressed, so check the build inputs instead: the view the PDF draws from carries no codes either.
    const { buildView } = await import('../src/report/view.js');
    const view = buildView(report);
    const viewText = JSON.stringify({ ...view, report: undefined });
    expect(viewText).not.toMatch(/\bG\d{2}\b|\bF-\d+\b|bedrock|mock/i);
    expect(pdf.length).toBeGreaterThan(3000);
  });

  it('renders a valid, multi-page PDF for a report with many issues', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX });
    const core = structuredClone(run.core);
    const base = core.findings[0]!;
    core.findings = Array.from({ length: 14 }, (_, i) => ({ ...base, id: `F-${String(i + 1).padStart(2, '0')}`, severity: (['HIGH', 'MEDIUM', 'LOW'] as const)[i % 3]!, title: `A long title to make the card wrap onto a second line, number ${i + 1}`, detail: 'Detail sentence. '.repeat(20), fix: 'Fix sentence. '.repeat(12) }));
    const pdf = await renderPdf(assembleReport(core, null));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect((pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1);
  });

  it('lists every finding and every question the file gave nothing to measure in the improvement plan, and renders a PDF', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX });
    const report = assembleReport(run.core, null);
    const plan = improvementPlan(report);
    expect(plan.filter((r) => ['HIGH', 'MEDIUM', 'LOW'].includes(r.severity))).toHaveLength(report.findings.length);
    expect(plan.filter((r) => r.severity === 'UNMEASURED')).toHaveLength(report.notMeasurable.length);
    expect(plan.map((r) => r.priority)).toEqual(plan.map((_, i) => i + 1));
    const pdf = await renderPdf(report);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(3000);
  });

  it('shows the extra instructions in both formats when there are some, and not otherwise', async () => {
    const { evaluate } = await import('../src/agent/index.js');
    const { createProviderFactory } = await import('../src/llm/registry.js');
    const { mockModels, loadTalentraScorecard } = await import('./helpers.js');
    const models = mockModels();
    const parsed = await loadTalentraScorecard();
    const out = await evaluate({ runId: 'r', projectName: 'p', iteration: 1, workbookPath: TALENTRA_XLSX, artifactName: 'a.xlsx', scorecard: parsed.scorecard, scorecardHash: parsed.hash, sources: '', instructions: 'Be strict about definitions.', models, providers: createProviderFactory(models, { mockDelayMs: 0 }), env: {} });
    const report = assembleReport(out.core, null);
    expect(renderMarkdown(report)).toMatch(/\| Extra instructions \| Be strict about definitions\. \|/);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await renderXlsx(report)) as unknown as ExcelJS.Buffer);
    const rows = new Map<string, unknown>();
    book.getWorksheet('Summary')!.eachRow((row) => rows.set(String(row.getCell(1).value), row.getCell(2).value));
    expect(rows.get('Extra instructions')).toBe('Be strict about definitions.');
    const plain = assembleReport((await runEvaluation({ workbook: TALENTRA_XLSX })).core, null);
    expect(renderMarkdown(plain)).not.toMatch(/Extra instructions/);
  });

  it('shows each finding as a numbered issue with its priority word, area, location and fix', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX });
    const report = assembleReport(run.core, null);
    const md = renderMarkdown(report);
    const first = report.findings[0]!;
    expect(md).toMatch(new RegExp(`\\*\\*Issue 1\\*\\* - `));
    expect(md).toContain(`- Where: Sheet "${first.location!.sheet}", cell ${first.location!.cell}`);
    expect(md).toMatch(/### (Must fix|Should fix|Nice to fix) \(\d+\)/);
  });

  it('is rebuilt from the stored evaluation plus an optional override, and the evaluation itself never changes', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX });
    const snapshot = JSON.stringify(run.core);
    const first = assembleReport(run.core, null);
    const second = assembleReport(run.core, { id: 'o', runId: 'r', decision: 'red', reason: 'because', by: 'Lead', createdAt: '2026-10-22T11:00:00Z' });
    expect(JSON.stringify(run.core)).toBe(snapshot);
    expect(first.verdict.override).toBeNull();
    expect(second.verdict).toMatchObject({ decision: 'red', agentDecision: first.verdict.agentDecision });
  });

  it('never asks a person for anything, in any format', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX });
    const report = assembleReport(run.core, null);
    // The sample scorecard's author-interview question is scored by the examiners now, not held for a person.
    expect(report.dimensions.find((d) => d.id === 'H01')).toMatchObject({ measuredBy: 'raters', status: 'scored' });
    expect(report.notMeasurable).toEqual([]);
    const md = renderMarkdown(report);
    expect(md).not.toMatch(/a person|must supply|outstanding/i);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await renderXlsx(report)) as unknown as ExcelJS.Buffer);
    const text: string[] = [];
    book.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => text.push(String(c.value ?? '')))));
    expect(text.join(' ')).not.toMatch(/a person must|needs a person|flagged for a person/i);
  });

  it('lists a question the file holds nothing for under Not checked, saying how it was treated', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX });
    const core = structuredClone(run.core);
    const target = core.dimensions.find((d) => d.measuredBy === 'raters')!;
    Object.assign(target, { status: 'not_measurable', consolidated: null, rationale: 'The examiners found nothing in the file that measures this dimension.' });
    const skipped = assembleReport(core, null);
    expect(skipped.notMeasurable).toEqual([expect.objectContaining({ dimensionId: target.id, treatment: 'skipped' })]);
    expect(skipped.verdict.skipped).toContain(target.id);
    expect(renderMarkdown(skipped)).toMatch(/Left out of the score\./);
    core.scorecard.unmeasured = 'zero';
    const zeroed = assembleReport(core, null);
    expect(zeroed.notMeasurable[0]!.treatment).toBe('zero');
    expect(zeroed.verdict.skipped).toEqual([]);
    expect(improvementPlan(zeroed).find((r) => r.severity === 'UNMEASURED')!.problem).toMatch(/It counts as 0\./);
  });
});

describe('a score built on fewer examiners says so next to the colour', () => {
  it('adds a "Needs attention" line naming the examiner that failed, and nothing when all answered', async () => {
    const all = assembleReport((await runEvaluation({ workbook: TALENTRA_XLSX })).core, null);
    expect(all.verdict.reasons.join(' ')).not.toMatch(/failed and was left out/);
    const lost = assembleReport((await runEvaluation({ workbook: TALENTRA_XLSX, models: (await import('./helpers.js')).mockModels(['mock-mid', 'mock-garbage', 'mock-strict']) })).core, null);
    expect(lost.verdict.reasons.join(' ')).toMatch(/Needs attention: examiner B failed and was left out, so this score rests on 2 of 3 examiners\. Run it again before relying on it\./);
  });
});
