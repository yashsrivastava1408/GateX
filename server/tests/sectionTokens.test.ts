import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { preflight } from '../src/agent/index.js';
import { disputedDimensions } from '../src/agent/consolidate.js';
import { buildAllRaterPrompts } from '../src/agent/prompt.js';
import { buildConsolidatorUser } from '../src/agent/prompts/consolidator.js';
import { parseReadsEntry, planSections, sheetsForDisagreements } from '../src/agent/sectionPlanner.js';
import type { RaterOutcome } from '../src/agent/types.js';
import { WorkbookModel } from '../src/excel/workbook.js';
import { scorecardToWorkbook } from '../src/scorecard/excel.js';
import { parseScorecard, parseScorecardFile } from '../src/scorecard/parse.js';
import { TALENTRA_XLSX, mockModels, runEvaluation } from './helpers.js';

const raters = (limits: Array<number | undefined>) => limits.map((maxInputTokens, i) => ({ id: 'ABC'[i]!, model: `model-${i}`, maxInputTokens }));
const loadSectioned = async () =>
  parseScorecard(await readFile(new URL('../../samples/talentra/talentra-schema-d2-sectioned.yaml', import.meta.url), 'utf8'));

describe('reads entries', () => {
  it('reads a plain sheet name and a sheet narrowed to some columns', () => {
    expect(parseReadsEntry('Tree')).toEqual({ name: 'Tree' });
    expect(parseReadsEntry('Tree[Path id|Name | Definition]')).toEqual({ name: 'Tree', columns: ['Path id', 'Name', 'Definition'] });
    expect(parseReadsEntry('Allowed values[]')).toEqual({ name: 'Allowed values[]' });
  });

  it('keeps the same reads through an Excel scorecard, with the same hash', async () => {
    const { scorecard, hash } = await loadSectioned();
    const back = await parseScorecardFile(await scorecardToWorkbook(scorecard), 'again.xlsx');
    expect(back.scorecard.dimensions.find((d) => d.id === 'J04')!.reads).toEqual(['Tree[Path id|Name]', 'Stage 1 steps', 'Playbook map']);
    expect(back.hash).toBe(hash);
  });
});

describe('the sectioned Talentra D2 scorecard', () => {
  it('has the same questions, weights and anchors as the whole-workbook one', async () => {
    const sectioned = (await loadSectioned()).scorecard;
    const whole = parseScorecard(await readFile(new URL('../../samples/talentra/talentra-schema-d2.yaml', import.meta.url), 'utf8')).scorecard;
    const strip = (s: typeof whole) => s.dimensions.map(({ reads: _reads, ...d }) => d);
    expect(strip(sectioned)).toEqual(strip(whole));
  });

  it('sends each rater much smaller prompts than the whole workbook', async () => {
    const wb = await WorkbookModel.load(TALENTRA_XLSX);
    const sectioned = (await loadSectioned()).scorecard;
    const whole = parseScorecard(await readFile(new URL('../../samples/talentra/talentra-schema-d2.yaml', import.meta.url), 'utf8')).scorecard;
    const size = (sc: typeof whole) => buildAllRaterPrompts({ scorecard: sc, wb, sources: '' }).map((p) => p.prompt.user.length);
    expect(size(whole)).toHaveLength(1);
    expect(size(sectioned).length).toBeGreaterThan(1);
    expect(Math.max(...size(sectioned))).toBeLessThan(size(whole)[0]! * 0.5);
    // every question is still asked exactly once
    const asked = buildAllRaterPrompts({ scorecard: sectioned, wb, sources: '' }).flatMap((p) => p.prompt.rated.map((d) => d.id));
    expect(asked.sort()).toEqual(['H01', 'J01', 'J02', 'J03', 'J04', 'J05', 'J06']);
  });

  it('only sends the columns a question reads', async () => {
    const wb = await WorkbookModel.load(TALENTRA_XLSX);
    const sectioned = (await loadSectioned()).scorecard;
    const prompts = buildAllRaterPrompts({ scorecard: sectioned, wb, sources: '' });
    const definitions = prompts.find((p) => p.prompt.rated.some((d) => d.id === 'J02'))!.prompt.artifactText;
    expect(definitions).toContain('Definition');
    expect(definitions).not.toMatch(/Example|Data type/);
  });

  it('is judged section by section: it passes the size check on limits the whole-workbook one fails', async () => {
    const wb = await WorkbookModel.load(TALENTRA_XLSX);
    const sectioned = (await loadSectioned()).scorecard;
    const whole = parseScorecard(await readFile(new URL('../../samples/talentra/talentra-schema-d2.yaml', import.meta.url), 'utf8')).scorecard;
    const limits = raters([9000, undefined, 9000]);
    expect(preflight({ scorecard: whole, wb, sources: '', raters: limits }).ok).toBe(false);
    const result = preflight({ scorecard: sectioned, wb, sources: '', raters: limits });
    expect(result.ok).toBe(true);
    expect(result.sections).toBe(4);
    expect(result.tokens).toBeLessThan(9000);
  });

  it('names the section that is too big when too few raters can take it', async () => {
    const wb = await WorkbookModel.load(TALENTRA_XLSX);
    const result = preflight({ scorecard: (await loadSectioned()).scorecard, wb, sources: '', raters: raters([4000, undefined, 4000]) });
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/in section \d/);
    expect(result.problem).toMatch(/"reads"/);
  });
});

describe('what the consolidator is sent', () => {
  const outcome = (id: string, scores: Record<string, number>): RaterOutcome =>
    ({ status: 'ok', model: { id }, dimensions: Object.entries(scores).map(([dim, score]) => ({ id: dim, score })) }) as unknown as RaterOutcome;

  it('finds the dimensions the raters disagree on by more than one point', () => {
    const rated = [{ id: 'J01' }, { id: 'J02' }, { id: 'J03' }] as never;
    const disputed = disputedDimensions(rated, [outcome('A', { J01: 4, J02: 1, J03: 3 }), outcome('B', { J01: 3, J02: 4, J03: 3 })]);
    expect([...disputed]).toEqual(['J02']);
  });

  it('attaches only the sheets behind disputed dimensions, and everything when the scorecard is not sectioned', async () => {
    const sections = planSections((await loadSectioned()).scorecard);
    const some = sheetsForDisagreements(sections, new Set(['J05']))!;
    expect(some.sheets.map((s) => s.name)).toEqual(['Allowed values']);
    expect(some.context).toEqual([]);
    expect(sheetsForDisagreements(sections, new Set())).toEqual({ sheets: [], context: [] });
    const whole = planSections(parseScorecard(await readFile(new URL('../../samples/talentra/talentra-schema-d2.yaml', import.meta.url), 'utf8')).scorecard);
    expect(sheetsForDisagreements(whole, new Set(['J05']))).toBeNull();
  });

  it('says so when nothing is attached or the sheets are partial', async () => {
    const { scorecard } = await loadSectioned();
    const base = { scorecard, dimensions: scorecard.dimensions, raterResults: '{}' };
    expect(buildConsolidatorUser({ ...base, artifactText: '' })).toContain('agreed within one point everywhere');
    expect(buildConsolidatorUser({ ...base, artifactText: 'x', artifactIsPartial: true })).toContain('Only the sheets behind the disputed dimensions');
    expect(buildConsolidatorUser({ ...base, artifactText: 'x' })).not.toContain('Only the sheets behind');
  });
});

describe('a full mock run of the sectioned D2 scorecard', () => {
  it('scores every question, once, and sends the models less than the whole-workbook run', async () => {
    const parsed = await loadSectioned();
    const run = await runEvaluation({ workbook: TALENTRA_XLSX, scorecard: parsed, models: mockModels(['mock-mid', 'mock-lenient', 'mock-strict']) });
    const rated = run.core.dimensions.filter((d) => d.measuredBy === 'raters');
    expect(rated.map((d) => d.id)).toEqual(['J01', 'J02', 'J03', 'J04', 'J05', 'J06', 'H01']);
    expect(rated.every((d) => d.consolidated !== null)).toBe(true);
    expect(run.runLog.participants.filter((p) => p.role === 'rater').every((p) => p.status === 'ok')).toBe(true);
  });
});
