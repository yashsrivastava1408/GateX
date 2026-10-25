import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { bandOf } from '@ddd/shared';
import type { Scorecard } from '@ddd/shared';
import { parseScorecard } from '../src/scorecard/parse.js';
import { evaluate } from '../src/agent/orchestrator.js';
import { assembleReport } from '../src/report/assemble.js';
import type { LlmProvider } from '../src/llm/types.js';
import { sha256 } from '../src/util/hash.js';
import {
  CLEAN_SCORECARD_YAML, CLEAN_TREE, TALENTRA_XLSX, loadTalentraScorecard, makeWorkbook, mockModels, patchCells, runEvaluation, writeTemp,
} from './helpers.js';

const verdictOf = (run: Awaited<ReturnType<typeof runEvaluation>>) => assembleReport(run.core, null).verdict;

describe('Level 1 evaluation of the Talentra workbook', () => {
  it('finds the real defects with exact cells, and scores the author-interview question itself instead of waiting for a person', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX });
    const report = assembleReport(run.core, null);

    expect(report.verdict.decision).toBe(bandOf(report.verdict.weightedScore));
    expect(report.notMeasurable).toEqual([]);
    expect(report.dimensions.find((d) => d.id === 'H01')).toMatchObject({ measuredBy: 'raters', status: 'scored' });
    expect(report.verdict.reasons.join(' ')).not.toMatch(/person|must supply/i);

    const c06 = report.findings.find((f) => f.dimensionId === 'C06')!;
    expect(c06.location).toEqual({ sheet: 'Tree', cell: 'L121' });
    expect(c06.title).toMatch(/44 of 45/);
    const c07 = report.findings.find((f) => f.dimensionId === 'C07')!;
    expect(c07.location).toEqual({ sheet: 'Allowed values', cell: 'A156' });
    expect(report.dimensions.find((d) => d.id === 'C02')!.consolidated).toBe(5);
  });

  it('takes its colour from the score alone, and says which band it is in', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX });
    const v = verdictOf(run);
    expect(v.decision).toBe(bandOf(v.weightedScore));
    expect(v.reasons[0]).toMatch(new RegExp(`in the ${v.decision} band`));
  });

  it('writes a header that proves what was evaluated, and never touches the workbook', async () => {
    const before = sha256(await readFile(TALENTRA_XLSX));
    const run = await runEvaluation({ workbook: TALENTRA_XLSX });
    expect(run.core.header.artifactHash).toBe(before);
    expect(sha256(await readFile(TALENTRA_XLSX))).toBe(before);
    expect(run.core.header.raters.map((r) => r.model)).toEqual(['mock-mid', 'mock-lenient', 'mock-strict']);
    expect(run.core.header.scorecardApproval).toMatch(/Sample scorecard/);
    expect(run.runLog.promptVersion).toBe('l1-prompts/1.8');
    expect(run.runLog.participants).toHaveLength(4);
  });

  it('is deterministic: the same inputs give the same scores and verdict', async () => {
    const a = await runEvaluation({ workbook: TALENTRA_XLSX });
    const b = await runEvaluation({ workbook: TALENTRA_XLSX });
    expect(a.core.dimensions).toEqual(b.core.dimensions);
    expect(verdictOf(a)).toEqual(verdictOf(b));
  });

  it('keeps raters blind: identical prompts, no scores, no other rater, only the rater dimensions', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX });
    const raters = run.calls.filter((c) => c.role === 'rater');
    expect(new Set(raters.map((c) => c.promptHash)).size).toBe(1);
    const prompt = raters[0]!.prompt;
    expect(prompt).not.toMatch(/mock-|rater_results|self-?assess/i);
    const card = JSON.parse(/<scorecard>\n([\s\S]*?)\n<\/scorecard>/.exec(prompt)![1]!);
    // H01 was written for a person (an author interview): it needs evidence from outside the file, so it is one outside criterion, and the examiners
    // score it now from what the file shows.
    expect(card.dimensions.map((d: { id: string }) => d.id)).toEqual(['J01', 'J02', 'J03', 'J04', 'J05', 'J06', 'H01-C01']);
    expect(card.dimensions.find((d: { id: string }) => d.id === 'H01-C01').measure).toMatch(/Score only what the file itself shows/);
    expect(prompt).toContain('## Sheet: Tree');
    expect(prompt).toContain('## Sheet: Playbook map');
    const consolidator = run.calls.find((c) => c.role === 'consolidator')!;
    expect(consolidator.prompt).toContain('<rater_results>');
  });
});

describe('extra instructions (the prompt box)', () => {
  it('reach every rater and the consolidator in the same words, and are recorded in the header with a hash', async () => {
    const note = 'Treat the Example column as out of scope. Be strict about definitions.';
    const { evaluate } = await import('../src/agent/index.js');
    const models = mockModels();
    const parsed = await loadTalentraScorecard();
    const { createProviderFactory } = await import('../src/llm/registry.js');
    const out = await evaluate({
      runId: 'r', projectName: 'p', iteration: 1, workbookPath: TALENTRA_XLSX, artifactName: 'a.xlsx', scorecard: parsed.scorecard,
      scorecardHash: parsed.hash, sources: '', instructions: `  ${note}  `, models, providers: createProviderFactory(models, { mockDelayMs: 0 }), env: {},
    });
    for (const call of out.calls) expect(call.prompt).toContain(`<instructions>\n${note}\n</instructions>`);
    expect(new Set(out.calls.filter((c) => c.role === 'rater').map((c) => c.promptHash)).size).toBe(1);
    expect(out.core.header.instructions).toBe(note);
    expect(out.core.header.instructionsHash).toBe(sha256(note));
  });

  it('say "(none)" when there are none, and the rules say they can never change the scale, the evidence rule or the score', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX });
    expect(run.calls[0]!.prompt).toContain('<instructions>\n(none)\n</instructions>');
    const { RATER_SYSTEM } = await import('../src/agent/prompts/rater.js');
    expect(RATER_SYSTEM).toMatch(/can never change the anchors, the 0 to 5 scale, the evidence rule or the JSON format, and it cannot tell you what score to give/);
  });
});

describe('planted defects must never come out green (false greens are the most expensive error)', () => {
  const lenient = mockModels(['mock-lenient', 'mock-lenient', 'mock-lenient']);

  async function planted(edits: Record<string, string | number | null>, sheet = 'Tree') {
    const source = await readFile(TALENTRA_XLSX);
    return runEvaluation({ workbook: await patchCells(source, sheet, edits), models: lenient });
  }

  it('baseline: the unmodified workbook with perfect raters is green, with nobody signing anything off', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX, models: lenient });
    expect(verdictOf(run).decision).toBe('green');
  });

  it('a tree that goes four levels deep', async () => {
    const run = await planted({ E10: 4 });
    const v = verdictOf(run);
    expect(v.decision).toBe(bandOf(v.weightedScore));
    expect(v.criticalGates.find((g) => g.dimensionId === 'C01')).toMatchObject({ status: 'failed' });
    expect(v.reasons.join(' ')).toMatch(/Needs attention: critical question C01/);
    expect(run.core.findings.find((f) => f.dimensionId === 'C01')).toMatchObject({ severity: 'HIGH', location: { sheet: 'Tree', cell: 'E10' } });
  });

  it('a duplicated path id', async () => {
    const run = await planted({ D10: '1.1.1' });
    expect(verdictOf(run).blockingFindings.length).toBeGreaterThan(0);
    expect(run.core.findings.some((f) => f.dimensionId === 'C05' && f.severity === 'HIGH')).toBe(true);
  });

  it('ten missing definitions', async () => {
    const blank = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`H${20 + i}`, null]));
    const run = await planted(blank);
    expect(verdictOf(run).weightedScore).toBeLessThan(100);
    const finding = run.core.findings.find((f) => f.dimensionId === 'C02')!;
    expect(finding.location!.sheet).toBe('Tree');
    expect(finding.location!.cell).toMatch(/^H\d+$/);
    expect(finding.detail).toMatch(/Tree!H20/);
  });

  it('a choice field that points at no list is reported at that cell, and the score drops', async () => {
    const run = await planted({ L6: 'unbounded' });
    expect(run.core.findings.some((f) => f.dimensionId === 'C09' && f.location?.cell === 'L6')).toBe(true);
    const base = await runEvaluation({ workbook: TALENTRA_XLSX, models: lenient });
    expect(verdictOf(run).weightedScore).toBeLessThan(verdictOf(base).weightedScore);
  });

  it('a list reference with a rule glued onto the name is already in the real file, and is found', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX, models: lenient });
    expect(run.core.findings.find((f) => f.dimensionId === 'C06')!.detail).toContain('Tree!L121');
  });
});

describe('high-risk findings from the raters', () => {
  it('on a question marked 5 in the end are listed, but as Worth a look: the examiners\' own marks say the file meets it, so they do not head the report', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX, models: mockModels(['mock-alarmist', 'mock-alarmist', 'mock-alarmist']) });
    const report = assembleReport(run.core, null);
    expect(report.verdict.weightedScore).toBeGreaterThan(95);
    const high = report.findings.filter((f) => f.severity === 'HIGH' && f.source === 'raters');
    expect(high.length).toBeGreaterThan(0);
    expect(high.every((f) => f.tier === 'worth_a_look' && /marked 5/.test(f.tierReason ?? ''))).toBe(true);
    expect(report.verdict.decision).toBe('green');
    expect(report.verdict.blockingFindings).toEqual([]);
    expect(report.verdict.reasons.join(' ')).not.toMatch(/high-risk finding/);
  });

  it('on a question marked below 5 stay Confirmed, keep a perfect-looking evaluation green, and are listed to fix', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX, models: mockModels(['mock-alarmist-4', 'mock-alarmist-4', 'mock-alarmist-4']) });
    const report = assembleReport(run.core, null);
    expect(report.findings.some((f) => f.severity === 'HIGH' && f.source === 'raters' && f.tier === 'confirmed')).toBe(true);
    expect(report.verdict.decision).toBe(bandOf(report.verdict.weightedScore));
    expect(report.verdict.blockingFindings.length).toBeGreaterThan(0);
    expect(report.pathToGreen.blockingFindingIds).toEqual(report.verdict.blockingFindings);
  });
});

describe('when models misbehave', () => {
  it('leaves out a rater that never returns JSON, after one repair attempt, and says so', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX, models: mockModels(['mock-mid', 'mock-garbage', 'mock-strict']) });
    const garbage = run.calls.find((c) => c.model.model === 'mock-garbage')!;
    expect(garbage).toMatchObject({ status: 'failed', attempts: 2 });
    expect(run.core.notes.join(' ')).toMatch(/Rater B .* failed and was left out/);
    expect(run.core.dimensions.find((d) => d.id === 'J01')).toMatchObject({ raterScores: { A: 4, B: null, C: 3 }, consolidated: 4 });
  });

  it('discards scores that cite no evidence, and does not let them count', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX, models: mockModels(['mock-mid', 'mock-nocite', 'mock-strict']) });
    const rater = run.calls.find((c) => c.model.model === 'mock-nocite')!;
    expect(rater.discarded).toBe(7); // six J questions plus H01, which the examiners now score
    expect(rater.discardedDetail[0]!.reason).toMatch(/no supported evidence/);
    expect(run.core.dimensions.find((d) => d.id === 'J02')!.raterScores).toEqual({ A: 4, B: null, C: 3 });
    expect(run.core.notes.join(' ')).toMatch(/7 claim\(s\) discarded/);
  });

  it('fails loudly, not with a misleading red, when every rater fails', async () => {
    await expect(runEvaluation({ workbook: TALENTRA_XLSX, models: mockModels(['mock-down', 'mock-garbage', 'mock-down']) })).rejects.toThrow(
      /All three raters failed/,
    );
  });

  it('keeps the median mark and flags it as uncertain when a big disagreement cannot be resolved', async () => {
    const run = await runEvaluation({
      workbook: TALENTRA_XLSX,
      models: mockModels(['mock-low', 'mock-lenient', 'mock-strict'], 'mock-consolidator-unresolved'),
    });
    const j01 = run.core.dimensions.find((d) => d.id === 'J01')!;
    // Marks 1, 5 and 3 and no one settles it: the median (3) stands, and the question is flagged as uncertain.
    expect(j01).toMatchObject({ consolidated: 3, spread: 4, resolution: 'lower_stands', flagged: true });
    expect(assembleReport(run.core, null).agreement.find((a) => a.dimensionId === 'J01')!.flagged).toBe(true);
  });

  it('accepts the consolidator\'s score for a big disagreement only when it cites real evidence', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX, models: mockModels(['mock-low', 'mock-lenient', 'mock-strict']) });
    const j01 = run.core.dimensions.find((d) => d.id === 'J01')!;
    expect(j01).toMatchObject({ consolidated: 3, resolution: 'claims_checked', flagged: false });
    expect(j01.evidence.length).toBeGreaterThan(0);
  });

  it('refuses a consolidator score outside the range of the raters', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX, models: mockModels(['mock-low', 'mock-low', 'mock-strict'], 'mock-consolidator-greedy') });
    // raters scored 1, 1, 3; the consolidator answered 5, which no rater supports
    expect(run.core.dimensions.find((d) => d.id === 'J01')).toMatchObject({ consolidated: 1, resolution: 'lower_stands', flagged: true });
  });

  it('falls back to the median mark everywhere when the consolidator itself fails', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX, models: mockModels(['mock-mid', 'mock-lenient', 'mock-strict'], 'mock-consolidator-down') });
    expect(run.core.consolidatorFailed).toBe(true);
    // marks 4, 5 and 3: the median is 4, set by code without the final reviewer
    expect(run.core.dimensions.find((d) => d.id === 'J01')).toMatchObject({ consolidated: 4, flagged: true });
    expect(run.core.notes.join(' ')).toMatch(/consolidator failed/);
    expect(run.core.findings.some((f) => f.source === 'raters')).toBe(true);
  });

  it('sets aside findings about a question the file cannot measure, and says so', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX, models: mockModels(['mock-abstain', 'mock-abstain', 'mock-abstain']) });
    expect(run.core.dimensions.find((d) => d.id === 'J01')!.status).toBe('not_measurable');
    expect(run.core.findings.filter((f) => f.dimensionId === 'J01' && f.source === 'raters')).toEqual([]);
    expect(run.core.droppedFindings?.find((d) => d.dimensionId === 'J01')?.reason).toMatch(/nothing that could measure this question/);
    expect(run.core.notes.join(' ')).toMatch(/cannot measure \(.*J01/);
  });

  it('does the same when the question is made of criteria, whose findings carry the criterion id', async () => {
    const parsed = await loadTalentraScorecard();
    const scorecard = {
      ...parsed.scorecard,
      dimensions: parsed.scorecard.dimensions.map((d) =>
        d.id === 'J01' ? { ...d, criteria: [{ id: 'J01-C1', name: 'First', kind: 'judged' as const }, { id: 'J01-C2', name: 'Second', kind: 'judged' as const }] } : d,
      ),
    };
    const run = await runEvaluation({ workbook: TALENTRA_XLSX, scorecard: { ...parsed, scorecard }, models: mockModels(['mock-abstain', 'mock-abstain', 'mock-abstain']) });
    expect(run.core.dimensions.find((d) => d.id === 'J01')!.status).toBe('not_measurable');
    expect(run.core.findings.filter((f) => f.dimensionId === 'J01' && f.source === 'raters')).toEqual([]);
    expect(run.core.droppedFindings?.some((d) => /^J01/.test(d.dimensionId) && /nothing that could measure/.test(d.reason))).toBe(true);
  });

  it('leaves a dimension every rater declines out of the score, without waiting for a person', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX, models: mockModels(['mock-abstain', 'mock-abstain', 'mock-abstain']) });
    const report = assembleReport(run.core, null);
    expect(run.core.dimensions.find((d) => d.id === 'J01')!.status).toBe('not_measurable');
    expect(report.notMeasurable.find((n) => n.dimensionId === 'J01')).toMatchObject({ treatment: 'skipped' });
    expect(report.verdict.skipped).toContain('J01');
    // Only the code-counted questions are left, and they alone decide the result.
    const counted = report.dimensions.filter((d) => d.measuredBy === 'code');
    expect(report.verdict.weightedScore).toBeCloseTo(
      Math.floor((counted.reduce((sum, d) => sum + d.weight * (d.consolidated ?? 0), 0) * 1000) / (counted.reduce((sum, d) => sum + d.weight, 0) * 5)) / 10,
      1,
    );
    expect(report.verdict.reasons.join(' ')).not.toMatch(/person|must supply/i);
  });

  it('flags a dimension scored by only one rater', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX, models: mockModels(['mock-mid', 'mock-garbage', 'mock-down']) });
    expect(run.core.dimensions.find((d) => d.id === 'J01')).toMatchObject({ consolidated: 4, resolution: 'single_rater', flagged: true });
    // The note says what really happened, not that "all examiners agree".
    expect(run.core.dimensions.find((d) => d.id === 'J01')!.rationale).toMatch(/^Only examiner A gave a score that the file could back up, so this is a single opinion\./);
  });
});

describe('guardrails (PDF page 13)', () => {
  const unfrozen = async (): Promise<{ scorecard: Scorecard; hash: string }> => {
    const { scorecard, hash } = await loadTalentraScorecard();
    return { scorecard: { ...scorecard, frozen: false }, hash };
  };

  it('Freeze: a scorecard not marked frozen is not refused; it is frozen by its hash, which the report records', async () => {
    const card = await unfrozen();
    const run = await runEvaluation({ workbook: TALENTRA_XLSX, scorecard: card });
    expect(run.core.header.scorecardHash).toBe(card.hash);
    expect(run.runLog.scorecardHash).toBe(card.hash);
  });

  it('Freeze: aborts if the workbook changes while it is being evaluated', async () => {
    const path = await writeTemp('x.xlsx', await makeWorkbook({ Tree: CLEAN_TREE }));
    const parsed = parseScorecard(CLEAN_SCORECARD_YAML);
    const models = mockModels();
    const tamper: LlmProvider = {
      name: 'mock',
      async complete() {
        await writeFile(path, 'tampered');
        return { text: '{}', inputTokens: 0, outputTokens: 0 };
      },
    };
    await expect(
      evaluate({
        runId: 'r', projectName: 'p', iteration: 1, workbookPath: path, artifactName: 'x.xlsx', scorecard: parsed.scorecard,
        scorecardHash: parsed.hash, sources: '', models, providers: () => tamper, env: {},
      }),
    ).rejects.toThrow(/changed while it was being evaluated|All three raters failed/);
  });

  it('Independence: refuses two raters from the same model family', async () => {
    const models = mockModels();
    models.raters[1]!.family = models.raters[0]!.family;
    await expect(runEvaluation({ workbook: TALENTRA_XLSX, models })).rejects.toThrow(/three different model families/);
  });

  it('Confidentiality: refuses a model that is not on the approved list', async () => {
    const models = mockModels();
    models.approved = ['mock:mock-mid'];
    await expect(runEvaluation({ workbook: TALENTRA_XLSX, models })).rejects.toThrow(/not on the approved list/);
  });

  it('Confidentiality: refuses a live provider that has no API key', async () => {
    const models = mockModels();
    models.providers.groq = { type: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY' };
    models.approved.push('groq:*');
    models.raters[0] = { id: 'A', provider: 'groq', model: 'llama', family: 'meta' };
    await expect(runEvaluation({ workbook: TALENTRA_XLSX, models })).rejects.toThrow(/no API key\. Set GROQ_API_KEY/);
  });

  it('names the problem when the scorecard asks for a sheet the workbook does not have', async () => {
    const wb = await makeWorkbook({ Other: [['a']] });
    await expect(runEvaluation({ workbook: wb })).rejects.toThrow(/Sheet "Tree" named by the scorecard was not found.*Other/);
  });

  it('Evidence: every finding and strength the report shows points at a real cell', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX });
    const { WorkbookModel } = await import('../src/excel/workbook.js');
    const wb = await WorkbookModel.load(TALENTRA_XLSX);
    const cited = [...run.core.findings.map((f) => f.location), ...run.core.strengths.map((s) => s.location)];
    expect(cited.length).toBeGreaterThan(5);
    for (const loc of cited) expect(wb.inBounds(loc!.sheet, loc!.cell)).toBe(true);
    for (const dim of run.core.dimensions) for (const e of dim.evidence) expect(wb.inBounds(e.sheet, e.cell)).toBe(true);
  });
});

describe('a scorecard with nothing for the raters', () => {
  it('runs code checks only and does not call a model', async () => {
    const yaml = CLEAN_SCORECARD_YAML.replace(/    - id: J01[\s\S]*$/, '');
    const run = await runEvaluation({ workbook: await makeWorkbook({ Tree: CLEAN_TREE }), scorecard: parseScorecard(yaml) });
    expect(run.calls).toHaveLength(0);
    expect(run.core.notes.join(' ')).toMatch(/no rater dimensions/);
    expect(verdictOf(run).decision).toBe('green');
  });
});

describe('the output gate (D3 against D4)', () => {
  it('evaluates the NFR register against the output scorecard and finds the open items', async () => {
    const { readFile: read } = await import('node:fs/promises');
    const parsed = parseScorecard(await read(new URL('../../samples/talentra/talentra-step04-d4.yaml', import.meta.url), 'utf8'));
    const run = await runEvaluation({ workbook: TALENTRA_XLSX, scorecard: parsed });
    expect(run.core.header.gate).toBe('D3');
    const report = assembleReport(run.core, null);
    expect(report.dimensions.filter((d) => d.measuredBy === 'code').every((d) => d.status === 'scored')).toBe(true);
    expect(report.notMeasurable).toEqual([]);
    expect(report.dimensions.find((d) => d.id === 'H01')).toMatchObject({ measuredBy: 'raters' });
    expect(report.verdict.decision).toBe(bandOf(report.verdict.weightedScore));
  });
});

describe('extra run notes', () => {
  it('puts where the scorecard came from first in the run notes', async () => {
    const { evaluate } = await import('../src/agent/index.js');
    const { createProviderFactory } = await import('../src/llm/registry.js');
    const models = mockModels();
    const parsed = await loadTalentraScorecard();
    const out = await evaluate({
      runId: 'r', projectName: 'p', iteration: 1, workbookPath: TALENTRA_XLSX, artifactName: 'a.xlsx', scorecard: parsed.scorecard,
      scorecardHash: parsed.hash, sources: '', scorecardNotes: ['Converted from GS1.xlsx.'], models, providers: createProviderFactory(models, { mockDelayMs: 0 }), env: {},
    });
    expect(out.core.notes[0]).toBe('Converted from GS1.xlsx.');
  });
});
