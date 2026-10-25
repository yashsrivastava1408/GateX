import { readFile } from 'node:fs/promises';
import { CLOSE_TO_LINE, SCORE_BANDS, TIER_RULE, tierFindings } from '@ddd/shared';
import type {
  CloseLook,
  DimensionResult,
  DimensionSpec,
  EvaluationCore,
  ModelRef,
  ParticipantStatus,
  RunLog,
  ReliabilityTable,
  RunStage,
  Scorecard,
} from '@ddd/shared';
import { runCodeChecks } from './checks/index.js';
import type { ModelsConfig } from '../config.js';
import { WorkbookModel } from '../excel/workbook.js';
import { inspectRoster, assertRosterReady, verifierCandidates } from '../llm/roster.js';
import type { ProviderFactory } from '../llm/registry.js';
import { candidatesFor, describeFailures, runWithFallback } from './fallback.js';
import { buildRaterPrompt, buildRaterPromptForSection } from './prompt.js';
import { PROMPT_VERSION } from './prompts/rater.js';
import { buildConsolidatorUser } from './prompts/consolidator.js';
import { sha256 } from '../util/hash.js';
import { UserError } from '../util/errors.js';
import { buildRaterResultsJson, disputedDimensions, consolidateInBatches } from './consolidate.js';
import { defaultReturnTo, finalizeFindings, findingsFromChecks } from './findings.js';
import { checkFindings, complainsAboutOutsideEvidence } from './findingCheck.js';
import { checkClaims } from './claimCheck.js';
import { checkPresence } from './presence.js';
import { verifyFindings, type VerifyStats } from './verifyFindings.js';
import { withAutoReads } from './autoReads.js';
import { usageOf } from './usage.js';
import { loneFindingReason, loneFindingTrusted } from './reliability.js';
import { capByExactFindings, sweepFindings } from './sweep.js';
import { applyAnchorFloors } from './anchorFloor.js';
import { applyExactCeilings, exactCeilingsFor } from './exactScore.js';
import { collapseCriteria, expandCriteria, findingsToDimensions, retypeOutsideCriteria } from './aggregate.js';
import { runRater } from './rater.js';
import { effectiveDimensions, weightedScore } from './verdict.js';
import type { CallMeta, DraftFinding, RaterOutcome } from './types.js';
import { heavyQuestionIds, idsToRepeat, medianOutcome, type RepeatStats } from './repeats.js';
import { mapWithConcurrency } from '../util/concurrency.js';
import { resolvePageRanges } from '../excel/pageRanges.js';
import { addRelevantPages } from '../excel/pageSelect.js';
import { sheetsForDisagreements } from './sectionPlanner.js';
import { planSectionsWithSupport } from './supporting.js';
import { serializeSheets } from '../excel/serialize.js';

export type ProgressEvent =
  | { type: 'stage'; stage: RunStage }
  | { type: 'participant'; id: string; status: ParticipantStatus; error?: string; latencyMs?: number; provider?: string; model?: string };

export interface EvaluateArgs {
  runId: string;
  projectName: string;
  iteration: number;
  workbookPath: string;
  artifactName: string;
  scorecard: Scorecard;
  scorecardHash: string;
  sources: string;
  /** Extra instructions from the person submitting the work. Recorded in the report header. */
  instructions?: string;
  /** Where the scorecard came from (for example an automatic conversion), added to the run notes. */
  scorecardNotes?: string[];
  /** What the test library measured about each examiner; a finding only a rarely-right examiner raised is set aside. Optional. */
  reliability?: ReliabilityTable;
  models: ModelsConfig;
  providers: ProviderFactory;
  env?: NodeJS.ProcessEnv;
  onProgress?: (event: ProgressEvent) => void;
  now?: () => Date;
}

export interface EvaluationOutput {
  core: EvaluationCore;
  /** Raters first, then the consolidator, with prompts and raw replies for the run log. */
  calls: Array<CallMeta & { discarded: number; discardedDetail: RaterOutcome['discarded'] }>;
  runLog: RunLog;
}

type DroppedFindingLike = { title: string; dimensionId: string; reason: string };
const APP_VERSION = '1.0.0';
/** At most this many questions are scored again by the second look near a colour line. */
const CLOSE_LOOK_MAX_QUESTIONS = 8;

/**
 * One evaluation, start to finish. It follows the Level 1 flow on PDF page 9:
 * freeze the inputs, score the countable dimensions in code, let three blind raters
 * score the rest, consolidate, then apply the decision rule. It never writes to the workbook.
 */
/** One rater's answers to every section, as a single outcome. A rater is only "failed" if it failed every section. */
function mergeSectionOutcomes(done: RaterOutcome[]): RaterOutcome {
  if (done.length === 1) return done[0]!;
  const last = done[done.length - 1]!;
  const sum = (pick: (o: RaterOutcome) => number | null | undefined) => done.reduce((total, o) => total + (pick(o) ?? 0), 0);
  const known = (pick: (o: RaterOutcome) => number | null | undefined) => (done.some((o) => pick(o) != null) ? sum(pick) : null);
  return {
    model: last.model,
    role: 'rater',
    status: done.every((o) => o.status === 'failed') ? 'failed' : 'ok',
    prompt: done.map((o) => o.prompt).join('\n---\n'),
    promptHash: sha256(done.map((o) => o.promptHash).join(',')),
    rawResponse: done.map((o) => o.rawResponse).join('\n---\n'),
    attempts: sum((o) => o.attempts),
    latencyMs: sum((o) => o.latencyMs),
    inputTokens: known((o) => o.inputTokens),
    outputTokens: known((o) => o.outputTokens),
    error: done.find((o) => o.error)?.error,
    dimensions: done.flatMap((o) => o.dimensions),
    // Each section numbers its findings from 1, so renumber: the consolidator tells findings apart by this reference.
    findings: done.flatMap((o) => o.findings).map((f, i) => ({ ...f, ref: `${last.model.id}${i + 1}` })),
    strengths: done.flatMap((o) => o.strengths),
    discarded: done.flatMap((o) => o.discarded),
  };
}

export async function evaluate(args: EvaluateArgs): Promise<EvaluationOutput> {
  const now = args.now ?? (() => new Date());
  const startedAt = now();
  const emit = args.onProgress ?? (() => undefined);
  const instructions = (args.instructions ?? '').trim();

  const roster = inspectRoster(args.models, args.env);
  assertRosterReady(roster);

  /* 1. Freeze: read once, hash, and check the sheets the scorecard names exist. */
  emit({ type: 'stage', stage: 'reading' });
  const bytes = await readFile(args.workbookPath);
  const artifactHash = sha256(bytes);
  const wb = await WorkbookModel.load(bytes);
  const judged = addRelevantPages(resolvePageRanges(args.scorecard, wb), wb);
  // Every criterion becomes a question of its own for the run; the results are combined back per dimension in step 5.
  const retyped = retypeOutsideCriteria(judged);
  const expanded = expandCriteria(retyped.scorecard);
  // A question that names no sheets would be sent the whole file; on a big file that is more than any model takes, so code picks its sheets.
  const { scorecard, summary: readsSummary } = withAutoReads(expanded, wb);
  const readsNotes = readsSummary ? [readsSummary] : [];
  const artifactSheets = scorecard.artifact.sheets.map((s) => s.name);
  const contextSheets = scorecard.artifact.context.map((s) => s.name);
  for (const name of [...artifactSheets, ...contextSheets]) {
    if (!wb.resolveSheet(name)) {
      throw new UserError(`Sheet "${name}" named by the scorecard was not found. Sheets in this file: ${wb.sheetNames().join(', ')}`);
    }
  }
  const allowedSheets = new Set([...artifactSheets, ...contextSheets].map((n) => wb.resolveSheet(n)!.toLowerCase()));

  /* 2. Countable dimensions, scored by code. */
  emit({ type: 'stage', stage: 'checks' });
  const checkStarted = Date.now();
  const codeOutcomes = runCodeChecks(scorecard, wb);
  const checksMs = Date.now() - checkStarted;

  /* 3. Blind rating by three models. */
  const raterRefs: ModelRef[] = roster.raters.map(({ id, provider, model, family }) => ({ id, provider, model, family }));
  const consolidatorRef: ModelRef = {
    id: roster.consolidator.id,
    provider: roster.consolidator.provider,
    model: roster.consolidator.model,
    family: roster.consolidator.family,
  };
  const raterLimits = roster.raters.map((r) => r.maxInputTokens).filter((n): n is number => n !== undefined);
  const smallestLimit = raterLimits.length > 0 ? Math.min(...raterLimits) : undefined;
  const repeats = args.models.settings.repeats;
  const repeatMode = args.models.settings.repeatMode ?? 'adaptive';
  let callsMade = 0;
  const repeatedIds = new Set<string>();
  const repeatStats: RepeatStats = { mode: repeatMode, repeats, planned: 0, made: 0, saved: 0, repeated: [] };
  const settings = { temperature: args.models.settings.temperature, maxOutputTokens: args.models.settings.maxOutputTokens };
  // Every call asks for the configured temperature (0 by default): the first answer of each examiner, the final reviewer, the checks. Repeat
  // answers use settings.repeatTemperature when one is set (it is not by default: models do not repeat themselves exactly even at 0).
  const repeatSettings = { ...settings, temperature: args.models.settings.repeatTemperature ?? settings.temperature };
  const returnTo = defaultReturnTo(scorecard.gate);

  const { rated, artifactText } = buildRaterPrompt({ scorecard, wb, sources: args.sources, instructions });

  const fallbackNotes: string[] = [];
  const ratingStarted = Date.now();
  let outcomes: RaterOutcome[] = [];
  /** Set when there are examiners to ask: scores the given questions again and rebuilds `outcomes`; returns the number of calls made. */
  let reScore: ((ids: string[]) => Promise<number>) | null = null;
  if (rated.length > 0) {
    emit({ type: 'stage', stage: 'rating' });

    // One prompt per section (a scorecard without `reads` is a single section holding the whole workbook).
    // The raters work in parallel inside a section; sections run one at a time unless the roster allows more (settings.sectionConcurrency).
    const sections = planSectionsWithSupport(scorecard, wb, { limit: smallestLimit });
    const perRater = roster.raters.map((member) => ({ member, outcomes: [] as RaterOutcome[] }));
    const adaptive = repeatMode === 'adaptive' && repeats > 1;
    const heavy = heavyQuestionIds(rated);
    const scoreOnce = (member: (typeof roster.raters)[number], expected: DimensionSpec[], user: string, again = false) => {
      const candidates = candidatesFor(member);
      callsMade += 1;
      return runWithFallback(
        candidates,
        (candidate) => {
          if (candidate !== candidates[0]) {
            emit({ type: 'participant', id: member.id, status: 'running', provider: candidate.ref.provider, model: candidate.ref.model });
          }
          return runRater({
            model: candidate.ref,
            provider: args.providers(candidate.ref.provider),
            user,
            expected,
            wb,
            allowedSheets,
            defaultReturnTo: returnTo,
            settings: again ? repeatSettings : settings,
            maxInputTokens: candidate.maxInputTokens,
          });
        },
        (o) => ({ ok: o.status === 'ok', error: o.error }),
      );
    };

    // Every attempt of every rater is kept per section, so that a second look at the disputed questions can add answers to them.
    type Attempt = Awaited<ReturnType<typeof scoreOnce>>;
    const sectionPasses: Attempt[][][] = [];
    const settled: RaterOutcome[][] = perRater.map(() => []);
    /** One rater's answers to one section as a single outcome (the median of its attempts). `firstNew` is the first attempt not yet reported. */
    const settle = (sectionIndex: number, raterIndex: number, firstNew: number) => {
      const member = perRater[raterIndex]!.member;
      const attempts = sectionPasses[sectionIndex]![raterIndex]!;
      const where = sections.length > 1 ? ` (${sections[sectionIndex]!.label})` : '';
      const outcome = medianOutcome(attempts.map((a) => a.result));
      const failures = attempts.slice(firstNew).flatMap((a) => a.failures);
      if (failures.length > 0) {
        if (outcome.status === 'ok') {
          fallbackNotes.push(`Rater ${member.id}${where}: ${describeFailures(failures)}. ${outcome.model.model} answered instead (same model family).`);
        } else {
          outcome.error = describeFailures(attempts.flatMap((a) => a.failures));
        }
      }
      settled[raterIndex]![sectionIndex] = outcome;
      emit({ type: 'participant', id: member.id, status: outcome.status, error: outcome.error, latencyMs: outcome.latencyMs, provider: outcome.model.provider, model: outcome.model.model });
    };

    await mapWithConcurrency(sections, args.models.settings.sectionConcurrency, async (section, sectionIndex) => {
      const sectionPrompt = buildRaterPromptForSection({ scorecard, section, wb, sources: args.sources, instructions });

      // Pass 1: each rater scores the whole section, `repeats` times when every question is repeated, else once.
      const passes = await Promise.all(
        perRater.map(({ member }) => {
          emit({ type: 'participant', id: member.id, status: 'running', provider: member.provider, model: member.model });
          return Promise.all(Array.from({ length: adaptive ? 1 : repeats }, (_, n) => scoreOnce(member, section.dimensions, sectionPrompt.user, n > 0)));
        }),
      );

      // Pass 2 (adaptive): only the questions the examiners disagree on, or gave no usable score for, are scored again,
      // by every rater that answered, with a prompt that holds just those questions. The median is then taken as before.
      // Heavy questions (the top weights) are scored again on a one-point difference too.
      if (adaptive) {
        const again = idsToRepeat(section.dimensions.map((d) => d.id), passes.map((attempts) => attempts[0]!.result), heavy);
        if (again.length > 0) {
          again.forEach((id) => repeatedIds.add(id));
          const subset = section.dimensions.filter((d) => again.includes(d.id));
          const smaller = buildRaterPromptForSection({ scorecard, section: { ...section, dimensions: subset }, wb, sources: args.sources, instructions });
          await Promise.all(
            perRater.map(async ({ member }, i) => {
              if (passes[i]![0]!.result.status !== 'ok') return;
              passes[i]!.push(...(await Promise.all(Array.from({ length: repeats - 1 }, () => scoreOnce(member, subset, smaller.user, true)))));
            }),
          );
        }
      }

      sectionPasses[sectionIndex] = passes;
      perRater.forEach((_, i) => settle(sectionIndex, i, 0));
    });
    repeatStats.planned = sections.length * roster.raters.length * repeats;
    outcomes = perRater.map((_, i) => mergeSectionOutcomes(settled[i]!));

    // The second look near a colour line: the given questions are scored `repeats - 1` more times by each rater that answered, and the
    // examiners' outcomes are rebuilt from all their attempts (the median is then taken over more answers).
    reScore = async (ids: string[]) => {
      const before = callsMade;
      const touched = sections.map((section, s) => ({ section, s, subset: section.dimensions.filter((d) => ids.includes(d.id)) })).filter((x) => x.subset.length > 0);
      await mapWithConcurrency(touched, args.models.settings.sectionConcurrency, async ({ section, s, subset }) => {
        const prompt = buildRaterPromptForSection({ scorecard, section: { ...section, dimensions: subset }, wb, sources: args.sources, instructions });
        await Promise.all(
          perRater.map(async ({ member }, i) => {
            const attempts = sectionPasses[s]![i]!;
            if (attempts[0]!.result.status !== 'ok') return;
            const start = attempts.length;
            attempts.push(...(await Promise.all(Array.from({ length: Math.max(1, repeats - 1) }, () => scoreOnce(member, subset, prompt.user, true)))));
            settle(s, i, start);
          }),
        );
      });
      outcomes = perRater.map((_, i) => mergeSectionOutcomes(settled[i]!));
      return callsMade - before;
    };

    if (outcomes.every((o) => o.status === 'failed')) {
      const why = outcomes.map((o) => `${o.model.id}: ${o.error}`).join('; ');
      throw new Error(`All three raters failed, so nothing can be scored. ${why}`);
    }
  }
  const ratingMs = Date.now() - ratingStarted;
  repeatStats.made = callsMade;
  repeatStats.saved = Math.max(0, repeatStats.planned - callsMade);
  repeatStats.repeated = [...repeatedIds];

  /* 4. Consolidation. */
  const consolidationStarted = Date.now();
  let consolidatedDims: DimensionResult[] = [];
  let raterFindings: DraftFinding[] = [];
  let consolidation: Awaited<ReturnType<typeof consolidateInBatches>> | null = null;
  /** Set when the final reviewer has been asked: reviews only the given questions again, on the examiners' latest outcomes. */
  let reconsolidate: ((ids: string[]) => Promise<{ dimensions: DimensionResult[]; call: CallMeta }>) | null = null;
  if (rated.length > 0) {
    emit({ type: 'stage', stage: 'consolidating' });
    emit({ type: 'participant', id: consolidatorRef.id, status: 'running', provider: roster.consolidator.provider, model: roster.consolidator.model });
    const consolidatorCandidates = candidatesFor(roster.consolidator);
    // A sectioned scorecard keeps the consolidator's prompt small too: it only needs the sheets behind the
    // dimensions the raters disagree on. Without `reads` it is sent the whole artifact, as before.
    const sections = planSectionsWithSupport(scorecard, wb, { limit: smallestLimit });
    // One prompt per batch of questions: only their results, and for disputes only the sheets behind them.
    const buildUser = (batch: DimensionSpec[], batchOutcomes: RaterOutcome[]) => {
      const partial = sheetsForDisagreements(sections, disputedDimensions(batch, batchOutcomes));
      return buildConsolidatorUser({
        scorecard,
        dimensions: batch,
        raterResults: buildRaterResultsJson(batch, batchOutcomes),
        artifactText: partial ? serializeSheets(wb, [...partial.sheets, ...partial.context]) : artifactText,
        artifactIsPartial: partial !== null,
        instructions,
      });
    };
    const { result, failures } = await runWithFallback(
      consolidatorCandidates,
      (candidate) => {
        if (candidate !== consolidatorCandidates[0]) {
          emit({ type: 'participant', id: consolidatorRef.id, status: 'running', provider: candidate.ref.provider, model: candidate.ref.model });
        }
        return consolidateInBatches({
          model: candidate.ref,
          provider: args.providers(candidate.ref.provider),
          rated,
          outcomes,
          buildUser,
          wb,
          allowedSheets,
          defaultReturnTo: returnTo,
          settings,
        });
      },
      (r) => ({ ok: r.call.status === 'ok', error: r.call.error }),
    );
    consolidation = result;
    if (failures.length > 0) {
      if (consolidation.call.status === 'ok') {
        fallbackNotes.push(`Consolidator: ${describeFailures(failures)}. ${consolidation.call.model.model} answered instead.`);
      } else {
        consolidation.call.error = describeFailures(failures);
      }
    }
    emit({
      type: 'participant',
      id: consolidatorRef.id,
      status: consolidation.call.status,
      error: consolidation.call.error,
      latencyMs: consolidation.call.latencyMs,
      provider: consolidation.call.model.provider,
      model: consolidation.call.model.model,
    });
    consolidatedDims = consolidation.dimensions;
    raterFindings = consolidation.findings;
    reconsolidate = async (ids) => {
      const subset = rated.filter((d) => ids.includes(d.id));
      const again = await runWithFallback(
        consolidatorCandidates,
        (candidate) => consolidateInBatches({ model: candidate.ref, provider: args.providers(candidate.ref.provider), rated: subset, outcomes, buildUser, wb, allowedSheets, defaultReturnTo: returnTo, settings }),
        (r) => ({ ok: r.call.status === 'ok', error: r.call.error }),
      );
      return { dimensions: again.result.dimensions, call: again.result.call };
    };
  }
  const consolidationMs = Date.now() - consolidationStarted;

  /* 5. Assemble every dimension in scorecard order, then the findings. */
  emit({ type: 'stage', stage: 'reporting' });
  // The examiners tag a finding with the question it answers, which is a criterion id ("AU-01") when the dimension has criteria.
  const parentOf = new Map(retyped.scorecard.dimensions.flatMap((d) => (d.criteria ?? []).map((c) => [c.id, d.id] as const)));
  // A row-by-row sweep in code: models skim a long sheet and miss a blank cell or a repeated id; code reads every row.
  const swept = sweepFindings(scorecard, scorecard.dimensions.filter((d) => d.measuredBy === 'raters'), wb, returnTo);
  const outsideIds = new Set(retyped.scorecard.dimensions.flatMap((d) => (d.criteria ?? []).filter((c) => c.outside).map((c) => c.id)));
  /** From the final reviewer's results to the dimensions of the scorecard: floors, exact ceilings, criteria combined, caps. Pure code, so it can be run again on other marks. */
  const assemble = (consolidatedInput: DimensionResult[]) => {
    const byId = new Map<string, DimensionResult>();
    for (const { result } of codeOutcomes) byId.set(result.id, result);
    for (const dim of consolidatedInput) byId.set(dim.id, dim);
    const working = scorecard.dimensions.map((spec): DimensionResult => {
      return (
        byId.get(spec.id) ?? {
          id: spec.id,
          name: spec.name,
          weight: spec.weight,
          critical: spec.critical,
          measuredBy: spec.measuredBy,
          status: 'not_measurable',
          raterScores: {},
          consolidated: null,
          spread: null,
          resolution: 'none',
          flagged: false,
          rationale: 'Nothing in the file measures this.',
          evidence: [],
        }
      );
    });
    // A counted criterion ("no duplicate ids", "every field has a definition") is counted by code over every row; the examiners can only lower it.
    // A score below the lowest rung the criterion's own scale describes ("1 prose only" scored 0) is pulled back to that rung first, when the cited cells show it.
    const floored = applyAnchorFloors(working, scorecard.dimensions, wb, outsideIds);
    const exact = applyExactCeilings(floored.results, exactCeilingsFor(scorecard.dimensions, wb));
    const collapsed = collapseCriteria(retyped.scorecard, exact.results);
    // The score follows the exact evidence: a question the sweep found mistakes under cannot keep a clean score the examiners gave it.
    const capped = capByExactFindings(collapsed, swept, parentOf);
    return { floored, exact, dimensions: capped.dimensions, capNotes: capped.notes };
  };
  const scoreOf = (dims: DimensionResult[]) => weightedScore(effectiveDimensions(args.scorecard, dims));
  let assembled = assemble(consolidatedDims);

  /* 5b. Close to a colour line: look again at the questions the examiners still disagree on, and say how wide the result is. */
  let closeLook: CloseLook | undefined;
  let secondLookCalls = 0;
  if (rated.length > 0) {
    const firstScore = scoreOf(assembled.dimensions);
    const lineOf = (score: number) => [SCORE_BANDS.accept, SCORE_BANDS.refine].reduce((best, line) => (Math.abs(score - line) < Math.abs(score - best) ? line : best));
    const disputedNow = () => consolidatedDims.filter((d) => d.measuredBy === 'raters' && d.status === 'scored' && (d.spread ?? 0) > 1);
    let looked: string[] = [];
    if (Math.abs(firstScore - lineOf(firstScore)) <= CLOSE_TO_LINE) {
      if (args.models.settings.closeLook && repeats > 1 && reScore && reconsolidate) {
        // The questions that can move the score most: wide disagreement on a heavy question, a handful at most so the extra cost stays bounded.
        const impact = (d: DimensionResult) => {
          const spec = rated.find((r) => r.id === d.id);
          const parent = spec?.criterionOf?.id ?? d.id;
          const siblings = Math.max(1, rated.filter((r) => (r.criterionOf?.id ?? r.id) === parent).length);
          return ((spec?.criterionOf?.weight ?? spec?.weight ?? 1) / siblings) * (d.spread ?? 0);
        };
        looked = disputedNow().sort((x, y) => impact(y) - impact(x)).slice(0, CLOSE_LOOK_MAX_QUESTIONS).map((d) => d.id);
        if (looked.length > 0) {
          emit({ type: 'stage', stage: 'rating' });
          secondLookCalls = await reScore(looked);
          emit({ type: 'stage', stage: 'consolidating' });
          const again = await reconsolidate(looked);
          secondLookCalls += 1;
          consolidatedDims = consolidatedDims.map((d) => again.dimensions.find((x) => x.id === d.id) ?? d);
          if (consolidation) {
            const sum = (a: number | null, b: number | null) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));
            consolidation.call = { ...consolidation.call, attempts: consolidation.call.attempts + again.call.attempts, latencyMs: consolidation.call.latencyMs + again.call.latencyMs, inputTokens: sum(consolidation.call.inputTokens, again.call.inputTokens), outputTokens: sum(consolidation.call.outputTokens, again.call.outputTokens) };
          }
          emit({ type: 'stage', stage: 'reporting' });
          assembled = assemble(consolidatedDims);
        }
      }
      const finalScore = scoreOf(assembled.dimensions);
      // The range: the questions still in dispute all going the lowest way, and all going the highest way.
      const stillDisputed = disputedNow();
      const extreme = (pick: (marks: number[]) => number) =>
        scoreOf(assemble(consolidatedDims.map((d) => (stillDisputed.includes(d) ? { ...d, consolidated: pick(Object.values(d.raterScores).filter((v): v is number => v !== null)) } : d))).dimensions);
      const lowScore = Math.min(finalScore, extreme((m) => Math.min(...m)));
      const highScore = Math.max(finalScore, extreme((m) => Math.max(...m)));
      if (Math.abs(finalScore - lineOf(finalScore)) <= CLOSE_TO_LINE) {
        closeLook = { line: lineOf(finalScore), first: firstScore, final: finalScore, low: lowScore, high: highScore, questions: looked, calls: secondLookCalls, stillDisputed: stillDisputed.map((d) => d.id) };
      }
    }
  }
  const { floored, exact, dimensions, capNotes } = assembled;
  // What code did with the examiners' marks, one line per question, for the run log; the report notes carry the totals.
  const markLog = dimensions.flatMap((d) => (d.criteria ?? [d]).flatMap((c) => (c.markNotes ?? []).map((n) => `${c.id}: ${n}`)));
  const setAside = markLog.filter((m) => m.includes('was set aside')).length;
  const refused = markLog.filter((m) => m.includes('no cell that code could confirm')).length;
  const movedFull = markLog.filter((m) => m.includes('moved the mark from the median')).length;
  const movedOne = markLog.filter((m) => m.includes('moved one point only')).length;
  const markSummary =
    markLog.length > 0
      ? [`Final marks are the median of the examiners' marks, set by code. ${setAside} stray mark${setAside === 1 ? '' : 's'} set aside for lack of proof; the final reviewer moved ${movedFull + movedOne} mark${movedFull + movedOne === 1 ? '' : 's'} (${movedFull} in full, ${movedOne} by one point) and was refused ${refused} time${refused === 1 ? '' : 's'} for citing no checked cell. Every case is in run-log.json.`]
      : [];
  // The examiners' findings are fact-checked against the file and their duplicates merged; code findings are exact and pass as they are.
  // A question the file cannot measure (an interview, a second run) is left out of the score. A complaint that its evidence is missing is not
  // a defect in the file, so it must not block green either.
  const unmeasurable = new Set(dimensions.filter((d) => d.status === 'not_measurable').map((d) => d.id));
  const outsideCriteria = new Set(retyped.scorecard.dimensions.flatMap((d) => (d.criteria ?? []).filter((c) => c.outside).map((c) => c.id)));
  const aboutUnmeasurable = (f: DraftFinding) => unmeasurable.has(parentOf.get(f.dimensionId) ?? f.dimensionId) || complainsAboutOutsideEvidence(f, outsideCriteria);
  const checked = checkFindings(
    raterFindings.filter((f) => !aboutUnmeasurable(f)),
    wb,
    { loneReason: (f) => loneFindingReason(f, roster.raters, args.reliability), schemaDesign: scorecard.gate === 'D1' },
  );
  // Names the file defines, a cited cell that says something else, a gap the file already marks as open: proved or noted by code.
  const claims = checkClaims(checked.findings, wb);
  checked.findings = claims.findings;
  checked.dropped.push(...claims.dropped);
  checked.notes.push(...claims.notes);
  // "The file has no X" said about X that the file does define: a model finds the row, code proves the quote is really in the cell.
  let presenceTokens: { model?: string; inputTokens: number; outputTokens: number } | undefined;
  if (rated.length > 0) {
    const presence = await checkPresence({
      findings: checked.findings,
      wb,
      models: candidatesFor(roster.consolidator).map((c) => ({ model: c.ref.model, provider: args.providers(c.ref.provider) })),
      settings,
    });
    presenceTokens = { model: presence.model, inputTokens: presence.inputTokens, outputTokens: presence.outputTokens };
    checked.findings = presence.findings;
    checked.dropped.push(...presence.dropped);
    checked.notes.push(...presence.notes);
  }
  // Every remaining examiner finding is read by a separate model call against the rows of the file it is about. It is set aside only when the
  // model quotes a cell that code finds in the file and that shows the claim is wrong; anything less keeps the finding.
  let verification: VerifyStats | undefined;
  let verifiedDrops: DroppedFindingLike[] = [];
  const env = args.env ?? process.env;
  if (rated.length > 0 && args.models.settings.verifyFindings && env.VERIFY_FINDINGS !== '0') {
    const checkers = verifierCandidates(args.models, env).map((c) => ({ model: c.model, provider: args.providers(c.provider) }));
    const confirmers = verifierCandidates(args.models, env, 'confirmers').map((c) => ({ model: c.model, provider: args.providers(c.provider) }));
    const verified = await verifyFindings({ findings: checked.findings, wb, models: checkers, confirmers, settings });
    checked.findings = verified.findings;
    checked.dropped.push(...verified.dropped);
    checked.notes.push(...verified.notes);
    verification = verified.stats;
    verifiedDrops = verified.dropped;
  }
  for (const f of raterFindings.filter(aboutUnmeasurable)) {
    checked.dropped.push({
      dimensionId: f.dimensionId,
      severity: f.severity,
      title: f.title,
      location: f.location,
      reportedBy: f.reportedBy,
      reason: unmeasurable.has(parentOf.get(f.dimensionId) ?? f.dimensionId)
        ? 'The file holds nothing that could measure this question, so it is left out of the score. A missing-evidence complaint about it is not a defect in the file.'
        : 'This question needs evidence from outside the file, so the scorecard handles missing evidence with its own cap. A missing-evidence complaint about it is not a defect in the file.',
    });
  }
  if (swept.length > 0) checked.notes.push(`A row-by-row sweep in code found ${swept.length} anomal${swept.length === 1 ? 'y' : 'ies'} (empty cells in otherwise full columns, repeated ids, references to ids that do not exist, wrong child counts, filler definitions). They are listed as code findings.`);
  if (unmeasurable.size > 0 && raterFindings.some(aboutUnmeasurable)) {
    checked.notes.push(`Findings about questions the file cannot measure (${[...unmeasurable].join(', ')}) were set aside and are listed with the dropped findings.`);
  }
  // Two tiers, by code: Confirmed (found by code, raised by two or more examiners, proved by a cell, or raised alone by an examiner with a good checked record)
  // and Worth a look (everything else). The headline uses Confirmed only; the score and the colour do not depend on the tier.
  const findings = tierFindings(
    finalizeFindings(retyped.scorecard, findingsToDimensions(retyped.scorecard, [...findingsFromChecks(scorecard, codeOutcomes), ...swept, ...checked.findings])),
    TIER_RULE,
    (f) => loneFindingTrusted(f, roster.raters, args.reliability),
  );

  /* 6. Freeze check: the file must be exactly what we hashed at the start. */
  const after = sha256(await readFile(args.workbookPath));
  if (after !== artifactHash) {
    throw new Error('The workbook changed while it was being evaluated. Nothing was reported; submit it again.');
  }

  const calls: EvaluationOutput['calls'] = [
    ...outcomes.map((o) => ({ ...o, discarded: o.discarded.length, discardedDetail: o.discarded })),
    ...(consolidation ? [{ ...consolidation.call, discarded: 0, discardedDetail: [] }] : []),
  ];

  const notes: string[] = [...(args.scorecardNotes ?? []), ...fallbackNotes, ...retyped.notes, ...readsNotes];
  // The report names the models that actually answered, which differ from the roster when a fallback was used.
  const usedRaters: ModelRef[] = outcomes.length > 0 ? outcomes.map((o) => o.model) : raterRefs;
  const usedConsolidator: ModelRef = consolidation?.call.model ?? consolidatorRef;
  for (const o of outcomes) {
    if (o.status === 'failed') notes.push(`Rater ${o.model.id} (${o.model.model}) failed and was left out: ${o.error}`);
    else if (o.discarded.length > 0) notes.push(`Rater ${o.model.id} had ${o.discarded.length} claim(s) discarded for missing or unsupported evidence.`);
  }
  if (consolidation?.consolidatorFailed) {
    notes.push(`The consolidator failed (${consolidation.call.error}). The middle of the examiners' marks (the lower one when two were left) was used wherever they differed, and those items are flagged as uncertain.`);
  }
  if (rated.length === 0) notes.push('This scorecard has no rater dimensions, so only code checks were run.');
  if (repeatStats.mode === 'adaptive' && repeats > 1 && rated.length > 0) {
    notes.push(
      repeatStats.repeated.length > 0
        ? `Adaptive repeats: only the questions the examiners disagreed on were scored again (${repeatStats.repeated.join(', ')}), ${repeatStats.made} rater calls instead of ${repeatStats.planned}.`
        : `Adaptive repeats: the examiners agreed on every question, so nothing was scored again (${repeatStats.made} rater calls instead of ${repeatStats.planned}).`,
    );
  }

  const finishedAt = now();
  const core: EvaluationCore = {
    header: {
      runId: args.runId,
      projectName: args.projectName,
      iteration: args.iteration,
      step: scorecard.step,
      gate: scorecard.gate,
      artifactName: args.artifactName,
      artifactHash,
      scorecardId: scorecard.id,
      scorecardName: scorecard.name,
      scorecardVersion: scorecard.version,
      scorecardHash: args.scorecardHash,
      scorecardApproval: scorecard.approval,
      raters: usedRaters,
      consolidator: usedConsolidator,
      promptVersion: PROMPT_VERSION,
      ...(instructions ? { instructions, instructionsHash: sha256(instructions) } : {}),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
    },
    scorecard: args.scorecard,
    dimensions,
    findings,
    strengths: consolidation?.strengths ?? [],
    consolidatorFailed: consolidation?.consolidatorFailed ?? false,
    notes: [...notes, ...floored.notes, ...exact.notes, ...capNotes, ...checked.notes, ...markSummary],
    ...(closeLook ? { closeLook } : {}),
    ...(checked.dropped.length > 0 ? { droppedFindings: checked.dropped } : {}),
    usage: usageOf(calls, verification, usedConsolidator, presenceTokens),
  };

  const runLog: RunLog = {
    appVersion: APP_VERSION,
    nodeVersion: process.version,
    promptVersion: PROMPT_VERSION,
    promptHashes: Object.fromEntries(calls.map((c) => [c.model.id, c.promptHash])),
    settings: { ...settings, ...(repeatSettings.temperature !== settings.temperature ? { repeatTemperature: repeatSettings.temperature } : {}) },
    models: [...usedRaters, usedConsolidator],
    artifactHash,
    scorecardHash: args.scorecardHash,
    timings: { totalMs: finishedAt.getTime() - startedAt.getTime(), checksMs, ratingMs, consolidationMs },
    ...(rated.length > 0 ? { repeats: repeatStats } : {}),
    ...(markLog.length > 0 ? { markLog } : {}),
    ...(closeLook ? { secondLook: { line: closeLook.line, questions: closeLook.questions, calls: closeLook.calls } } : {}),
    ...(verification && verification.checked > 0
      ? { verification: { ...verification, droppedFindings: verifiedDrops.map((d) => ({ title: d.title, dimensionId: d.dimensionId, reason: d.reason })) } }
      : {}),
    participants: calls.map((c) => ({
      id: c.model.id,
      role: c.role,
      status: c.status,
      attempts: c.attempts,
      latencyMs: c.latencyMs,
      inputTokens: c.inputTokens,
      outputTokens: c.outputTokens,
      discarded: c.discarded,
      error: c.error,
    })),
  };
  return { core, calls, runLog };
}
