import { describe, expect, it } from 'vitest';
import { WorkbookModel } from '../src/excel/workbook.js';
import { modelsConfigSchema } from '../src/config.js';
import { verifierCandidates } from '../src/llm/roster.js';
import { confirmContradictions, evidencePreview, needsVerifying, proofOfContradiction, verifyFindings, VERIFY_SYSTEM, CONFIRM_SYSTEM, type VerifyStats } from '../src/agent/verifyFindings.js';
import type { LlmProvider } from '../src/llm/types.js';
import type { DraftFinding } from '../src/agent/types.js';
import { assembleReport } from '../src/report/assemble.js';
import { createProviderFactory, type ProviderFactory } from '../src/llm/registry.js';
import { evaluate } from '../src/agent/orchestrator.js';
import { parseScorecard } from '../src/scorecard/parse.js';
import { CLEAN_SCORECARD_YAML, TALENTRA_XLSX, makeWorkbook, mockModels, runEvaluation, writeTemp } from './helpers.js';

const finding = (title: string, detail: string, loc: DraftFinding['location'], extra: Partial<DraftFinding> = {}): DraftFinding => ({
  source: 'raters', dimensionId: 'G02', severity: 'MEDIUM', title, detail, fix: `Fix: ${title}`, returnTo: 'Define' as never, location: loc, reportedBy: ['A', 'B'], ...extra,
});
const settings = { temperature: 0, maxOutputTokens: 1000 };

/** A scripted model. `finder` answers the first-look prompt by finding id order, `confirm` answers the second reading. Every prompt is kept. */
function scripted(finder: (ids: string[]) => unknown[], confirm: (ids: string[]) => unknown[] = (ids) => ids.map((id) => ({ id, answer: 'contradicts', why: 'it does' }))) {
  const prompts: string[] = [];
  const provider: LlmProvider = {
    name: 'scripted',
    complete: async (r) => {
      prompts.push(r.user);
      const ids = [...r.user.matchAll(/<(?:finding|item) id="([^"]+)">/g)].map((m) => m[1]!);
      const results = r.system.includes('You are a fact checker') ? finder(ids) : confirm(ids);
      return { text: JSON.stringify({ results }), inputTokens: 100, outputTokens: 20 };
    },
  };
  return { provider, prompts };
}

// Three cases the blind check found wrong in real runs, rebuilt as small files: the thing the finding calls missing is in the file.
const FILES = {
  // S25 (docket): "no clear definition for the degradation element", but the service-level schema defines degraded_behaviour.
  s25: { 'Page 29': [['ID | Field | What to write'], ['F S11 15 | data_state | Data condition during measurement'], ['F S11 16 | degraded_behaviour | What must happen when the target cannot be met']] },
  // S28 (step 4b): "NFR-020, NFR-057 and NFR-058 have missing source statements", but only NFR-016 says NOT STATED IN SOURCE.
  s28: { Register: [['Id', 'Title', 'Source statement'], ['NFR-016', 'Recovery point objective', 'NOT STATED IN SOURCE'], ['NFR-020', 'Encrypt sensitive data', 'Sensitive data requires encryption, tokenisation, or masking, with the approach stated.']] },
  // S37 (step 5): "source codes such as CtO have no definition", but the legend on page 2 defines CtO.
  s37: { 'Page 2': [['M mandatory · C conditional'], ['Source codes: D§1 Docket §1 · CtO Control the Output v2 (Define attributes, UNKNOWN rule, scorecard)']], 'Page 3': [['doc_id | Unique ID | string | M | CtO']] },
  // A real gap: the file has a purpose field but no signature column anywhere.
  gap: { Params: [['Id', 'Name', 'Meaning'], ['P-01', 'Access purpose', 'Why the data is accessed.']], 'Decision_Log': [['Id', 'Decision'], ['DEC-1', 'A signature column will be added later']] },
};
const load = async (sheets: Record<string, string[][]>) => WorkbookModel.load(await makeWorkbook(sheets));

const s25 = finding('Missing Service Level Element', "The template is missing a clear definition for the 'degradation' service level element.", { sheet: 'Page 29', cell: 'A1' });
const s28 = finding('Missing source statements for NFRs', 'NFR-020 has a missing source statement, breaking traceability.', { sheet: 'Register', cell: 'C3' });
const s37 = finding('Source codes inconsistently formatted', "Some source codes such as 'CtO' are used without definition in the artifact.", { sheet: 'Page 3', cell: 'A1' });
const gap = finding('No signature column', 'The file has no signature column, so nobody can sign a version off.', { sheet: 'Params', cell: 'A1' }, { severity: 'HIGH' });

describe('the verify pass drops a finding only on proof', () => {
  it('drops S25, S28 and S37 when the model quotes the cell that shows the claim is false, and names the cell and words', async () => {
    const wb = await load({ ...FILES.s25, ...FILES.s28, ...FILES.s37 });
    const keep = gap;
    const byTitle: Record<string, unknown> = {
      'Missing Service Level Element': { verdict: 'false', cell: 'Page 29!A3', quote: 'degraded_behaviour | What must happen when the target cannot be met', why: 'the field exists' },
      'Missing source statements for NFRs': { verdict: 'false', cell: 'Register!C3', quote: 'Sensitive data requires encryption, tokenisation, or masking', why: 'NFR-020 has a source statement' },
      'Source codes inconsistently formatted': { verdict: 'false', cell: 'Page 2!A2', quote: 'CtO Control the Output v2', why: 'the legend defines CtO' },
    };
    const claims = [s25, s28, s37, keep];
    const confirmer = scripted(() => []);
    // Findings are sent most serious first, so ids do not follow the input order: the scripted finder reads each title from the prompt.
    const result = await verifyFindings({
      findings: claims, wb, settings,
      models: [{ model: 'finder', provider: { name: 's', complete: async (r) => {
        const results = [...r.user.matchAll(/<finding id="([^"]+)">\nPoints at: [^\n]*\nClaim: ([^.\n]*)/g)].map((m) => ({ id: m[1], ...((byTitle[m[2]!] as object | undefined) ?? { verdict: 'true' }) }));
        return { text: JSON.stringify({ results }), inputTokens: 500, outputTokens: 50 };
      } } }],
      confirmers: [{ model: 'confirmer', provider: confirmer.provider }],
    });
    expect(result.findings).toEqual([keep]);
    expect(result.dropped.map((d) => d.title).sort()).toEqual([s25.title, s28.title, s37.title].sort());
    const reasons = result.dropped.map((d) => d.reason).join('\n');
    expect(reasons).toContain('Page 29!A3 says "degraded_behaviour | What must happen when the target cannot be met"');
    expect(reasons).toContain('Register!C3 says "Sensitive data requires encryption, tokenisation, or masking"');
    expect(reasons).toContain('Page 2!A2 says "CtO Control the Output v2"');
    expect(result.stats).toMatchObject({ checked: 4, dropped: 3, failed: 0 });
    expect(result.stats.inputTokens).toBeGreaterThan(0);
  });

  it('keeps a real gap when the model says it is true, or says nothing', async () => {
    const wb = await load(FILES.gap);
    for (const verdict of [{ verdict: 'true' }, { verdict: 'unsure' }, {}]) {
      const m = scripted((ids) => ids.map((id) => ({ id, ...verdict })));
      const result = await verifyFindings({ findings: [gap], wb, settings, models: [{ model: 'x', provider: m.provider }] });
      expect(result.findings).toEqual([gap]);
      expect(result.dropped).toEqual([]);
    }
  });

  it('keeps a finding whose "false" quote is not in the file (a made-up quote)', async () => {
    const wb = await load(FILES.gap);
    const m = scripted((ids) => ids.map((id) => ({ id, verdict: 'false', cell: 'Params!B2', quote: 'Signature of the approving officer', why: 'there is one' })));
    const result = await verifyFindings({ findings: [gap], wb, settings, models: [{ model: 'x', provider: m.provider }] });
    expect(result.findings).toEqual([gap]);
    expect(result.dropped).toEqual([]);
    expect(result.stats.dropped).toBe(0);
  });

  it('refuses a quote that is real but cannot show the claim is false', async () => {
    const wb = await load({ ...FILES.gap, ...FILES.s37 });
    const claim = gap;
    const cases = [
      { cell: 'Params!B2', quote: 'Access purpose', why: 'shares no word with the claim' },
      { cell: 'Decision_Log!B2', quote: 'A signature column will be added later', why: 'a log of plans, not a definition' },
      { cell: 'Params!B2', quote: 'Acc', why: 'too short' },
      { cell: 'Nowhere!B2', quote: 'Access purpose', why: 'no such sheet' },
    ];
    for (const c of cases) expect(proofOfContradiction(wb, claim, c).ok, c.why).toBe(false);
    // A cell that is itself a placeholder is the gap, not proof.
    const wb2 = await load({ Params: [['Id', 'Signature column'], ['P-01', 'Signature column: TBD, to add later']] });
    expect(proofOfContradiction(wb2, claim, { cell: 'Params!B2', quote: 'Signature column: TBD, to add later' }).ok).toBe(false);
    // A real quote in the cell, sharing a key word with the claim, passes.
    const wb3 = await load({ Params: [['Id', 'Name'], ['P-01', 'Signature column: who signed this version off and when']] });
    expect(proofOfContradiction(wb3, claim, { cell: 'Params!B2', quote: 'Signature column: who signed this version off' })).toMatchObject({ ok: true, cell: 'Params!B2' });
  });

  it('needs the second reading to agree: "partly" keeps the finding, and so does a reader that fails', async () => {
    const wb = await load(FILES.s25);
    const found = (ids: string[]) => ids.map((id) => ({ id, verdict: 'false', cell: 'Page 29!A3', quote: 'degraded_behaviour | What must happen when the target cannot be met', why: 'present' }));
    const partly = scripted(found, (ids) => ids.map((id) => ({ id, answer: 'partly' })));
    const kept = await verifyFindings({ findings: [s25], wb, settings, models: [{ model: 'f', provider: partly.provider }], confirmers: [{ model: 'c', provider: partly.provider }] });
    expect(kept.findings).toEqual([s25]);
    const agree = scripted(found);
    const broken: LlmProvider = { name: 'down', complete: async () => { throw new Error('boom'); } };
    const oneFails = await verifyFindings({ findings: [s25], wb, settings, models: [{ model: 'f', provider: agree.provider }], confirmers: [{ model: 'c1', provider: agree.provider }, { model: 'c2', provider: broken }] });
    expect(oneFails.findings).toEqual([s25]);
    expect(oneFails.notes.join(' ')).toMatch(/could not answer/);
    const bothAgree = await verifyFindings({ findings: [s25], wb, settings, models: [{ model: 'f', provider: agree.provider }], confirmers: [{ model: 'c1', provider: agree.provider }, { model: 'c2', provider: agree.provider }] });
    expect(bothAgree.findings).toEqual([]);
    expect(bothAgree.stats.confirmModel).toBe('c1 + c2');
  });

  it('never sends findings found by code, or ones code has already marked with a fact-check note', async () => {
    const wb = await load(FILES.gap);
    const code = finding('Empty cell in a full column', 'Params!C3 is empty.', { sheet: 'Params', cell: 'C3' }, { source: 'code' });
    const noted = finding('Cell says otherwise', 'H5 contains X. [Fact check: It says H5 holds "X", but H5 holds "Y".]', { sheet: 'Params', cell: 'A1' });
    expect(needsVerifying(code)).toBe(false);
    expect(needsVerifying(noted)).toBe(false);
    const m = scripted((ids) => ids.map((id) => ({ id, verdict: 'true' })));
    const result = await verifyFindings({ findings: [code, noted, gap], wb, settings, models: [{ model: 'x', provider: m.provider }] });
    expect(result.stats).toMatchObject({ checked: 1, skipped: 2 });
    expect(m.prompts.join('\n')).not.toContain('Empty cell in a full column');
    expect(m.prompts.join('\n')).not.toContain('Cell says otherwise');
    expect(result.findings).toEqual([code, noted, gap]);
  });

  it('sends several findings per call, counts tokens, and keeps everything when the model is down', async () => {
    const wb = await load(FILES.gap);
    const many = Array.from({ length: 13 }, (_, i) => finding(`Claim number ${i} about signature`, `The file has no signature column ${i}.`, { sheet: 'Params', cell: 'A1' }));
    const m = scripted((ids) => ids.map((id) => ({ id, verdict: 'true' })));
    const ok = await verifyFindings({ findings: many, wb, settings, models: [{ model: 'x', provider: m.provider }] });
    expect(ok.stats).toMatchObject({ checked: 13, calls: 3, inputTokens: 300, outputTokens: 60 });
    const down: LlmProvider = { name: 'down', complete: async () => { throw new Error('boom'); } };
    const failed = await verifyFindings({ findings: many, wb, settings, models: [{ model: 'x', provider: down }] });
    expect(failed.findings).toEqual(many);
    expect(failed.stats.failed).toBe(13);
    expect(failed.notes.join(' ')).toMatch(/could not run for/);
  });

  it('falls back to the next model when the first fails, and checks the most serious findings first when over the limit', async () => {
    const wb = await load(FILES.gap);
    const low = finding('Low thing about signature', 'The file has no signature column.', { sheet: 'Params', cell: 'A1' }, { severity: 'LOW' });
    const down: LlmProvider = { name: 'down', complete: async () => { throw new Error('boom'); } };
    const m = scripted((ids) => ids.map((id) => ({ id, verdict: 'true' })));
    const result = await verifyFindings({ findings: [low, gap], wb, settings, models: [{ model: 'a', provider: down }, { model: 'b', provider: m.provider }], options: { maxFindings: 1 } });
    expect(result.stats).toMatchObject({ checked: 1, skipped: 1, model: 'b' });
    expect(m.prompts[0]).toContain('No signature column');
    expect(m.prompts[0]).not.toContain('Low thing about signature');
    expect(result.notes.join(' ')).toMatch(/at most 1/);
  });

  it('shows the model the cited row, the header and the rows that hold the claim words, and tells it to say unsure when in doubt', async () => {
    const wb = await load(FILES.s25);
    const rows = evidencePreview(s25, wb).join('\n');
    expect(rows).toContain('A1="ID | Field | What to write"');
    expect(rows).toContain('degraded_behaviour');
    expect(VERIFY_SYSTEM).toMatch(/When in doubt, answer "unsure"/);
    expect(CONFIRM_SYSTEM).toMatch(/same subject/);
  });

  it('counts the second reading in the tokens, and the confirm helper keeps only unanimous answers', async () => {
    const wb = await load(FILES.s25);
    const stats: { stats: VerifyStats; notes: string[] } = { stats: { checked: 0, skipped: 0, calls: 0, failed: 0, dropped: 0, inputTokens: 0, outputTokens: 0 }, notes: [] };
    const yes = scripted((ids) => ids, (ids) => ids.map((id) => ({ id, answer: 'contradicts' })));
    const no = scripted((ids) => ids, (ids) => ids.map((id) => ({ id, answer: id === 'a' ? 'contradicts' : 'no' })));
    const items = ['a', 'b'].map((id) => ({ id, f: s25, wb, cell: 'Page 29!A3', quote: 'degraded_behaviour' }));
    const got = await confirmContradictions(items, [{ model: 'one', provider: yes.provider }, { model: 'two', provider: no.provider }], settings, stats);
    expect(got.get('a')).toBe('contradicts');
    expect(got.get('b')).toBe('no');
    expect(stats.stats.calls).toBe(2);
    expect(no.prompts[0]).toContain('The finding points at Page 29!A1');
  });
});

describe('the verify pass inside an evaluation', () => {
  const alarmists = () => mockModels(['mock-alarmist', 'mock-alarmist', 'mock-alarmist']);

  it('runs by default, logs its tokens, and drops nothing when the model is unsure', async () => {
    const run = await runEvaluation({ workbook: TALENTRA_XLSX, models: alarmists() });
    expect(run.runLog.verification).toMatchObject({ dropped: 0, failed: 0 });
    expect(run.runLog.verification!.checked).toBeGreaterThan(0);
    expect(run.runLog.verification!.inputTokens).toBeGreaterThan(0);
    expect(run.runLog.verification!.droppedFindings).toEqual([]);
  });

  it('is skipped by the setting, by a quick check, and by VERIFY_FINDINGS=0', async () => {
    const off = alarmists();
    off.settings = { ...off.settings, verifyFindings: false };
    expect((await runEvaluation({ workbook: TALENTRA_XLSX, models: off })).runLog.verification).toBeUndefined();
    expect((await runEvaluation({ workbook: TALENTRA_XLSX, models: alarmists(), env: { VERIFY_FINDINGS: '0' } })).runLog.verification).toBeUndefined();
  });

  it('records a dropped finding with its cell and quote in the report and the run log', async () => {
    // A tiny file whose first cell is the one the scripted raters cite. A wrapped model plays the double-check: it says the finding is false, quoting that cell.
    const models = mockModels(['mock-alarmist', 'mock-alarmist', 'mock-alarmist']);
    const real = createProviderFactory(models, { mockDelayMs: 0 });
    const providers: ProviderFactory = (name) => {
      const inner = real(name);
      return {
        name: inner.name,
        complete: async (r) => {
          if (r.system.includes('You are a fact checker')) {
            const results = [...r.user.matchAll(/<finding id="([^"]+)">/g)].map((m) => ({ id: m[1], verdict: 'false', cell: 'Tree!A1', quote: 'Clearer wording for the headings', why: 'the heading is already clear' }));
            return { text: JSON.stringify({ results }), inputTokens: 700, outputTokens: 40 };
          }
          if (r.system.includes('settle one question per item')) {
            return { text: JSON.stringify({ results: [...r.user.matchAll(/<item id="([^"]+)">/g)].map((m) => ({ id: m[1], answer: 'contradicts' })) }), inputTokens: 300, outputTokens: 20 };
          }
          return inner.complete(r);
        },
      };
    };
    const parsed = parseScorecard(CLEAN_SCORECARD_YAML, 'clean.yaml');
    const workbook = await writeTemp('clear.xlsx', await makeWorkbook({ Tree: [['Clearer wording for the headings', 'Definition'], ['x', 'y']] }));
    const run = await evaluate({ runId: 'r', projectName: 'p', iteration: 1, workbookPath: workbook, artifactName: 'clear.xlsx', scorecard: parsed.scorecard, scorecardHash: parsed.hash, sources: '', models, providers, env: {} });
    const dropped = (run.core.droppedFindings ?? []).filter((d) => d.reason.startsWith('The double-check found'));
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped[0]!.reason).toContain('Tree!A1 says "Clearer wording for the headings"');
    expect(run.core.findings.some((f) => f.source === 'raters' && f.severity === 'HIGH')).toBe(false);
    expect(run.runLog.verification).toMatchObject({ dropped: dropped.length, failed: 0 });
    expect(run.runLog.verification!.droppedFindings[0]!.reason).toContain('Clearer wording for the headings');
    expect(run.runLog.verification!.inputTokens).toBeGreaterThan(0);
    expect(assembleReport(run.core, null).droppedFindings!.length).toBe(run.core.droppedFindings!.length);
    expect(run.core.notes.join(' ')).toMatch(/second check read each finding against the file/);
  });
});

describe('configuration', () => {
  const base = mockModels();
  it('is on by default, and the verifier falls back to the consolidator when none is set', () => {
    expect(base.settings.verifyFindings).toBe(true);
    expect(verifierCandidates(base, {})).toEqual([{ provider: 'mock', model: 'mock-consolidator' }]);
  });

  it('uses the configured verifier, its fallbacks and its confirmers, and never an unapproved model', () => {
    const cfg = modelsConfigSchema.parse({
      approved: ['bedrock:a', 'bedrock:b', 'bedrock:c'],
      providers: { bedrock: { type: 'bedrock', keyEnv: 'KEY' } },
      raters: [1, 2, 3].map((i) => ({ id: `R${i}`, provider: 'bedrock', model: 'a', family: `f${i}` })),
      consolidator: { id: 'K', provider: 'bedrock', model: 'a', family: 'k' },
      verifier: { provider: 'bedrock', model: 'b', fallbacks: [{ provider: 'bedrock', model: 'zzz-unapproved' }], confirmers: [{ provider: 'bedrock', model: 'c' }, { provider: 'bedrock', model: 'zzz-unapproved' }] },
    });
    expect(verifierCandidates(cfg, { KEY: 'x' })).toEqual([{ provider: 'bedrock', model: 'b' }]);
    expect(verifierCandidates(cfg, { KEY: 'x' }, 'confirmers')).toEqual([{ provider: 'bedrock', model: 'c' }]);
    expect(verifierCandidates(cfg, {})).toEqual([]);
  });
});
