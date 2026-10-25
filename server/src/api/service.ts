import { randomUUID } from 'node:crypto';
import { mkdir, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Gate, ParticipantProgress, RunProgress, RunStatus } from '@ddd/shared';
import type { AppConfig } from '../config.js';
import type { DeletedRun, RunJob, Store } from '../db/store.js';
import { checkScorecardFit, evaluate, evaluateTwice, fitNote, preflight, type ProgressEvent, type ScorecardFit } from '../agent/index.js';
import { serializeSheets } from '../excel/serialize.js';
import { resolvePageRanges } from '../excel/pageRanges.js';
import { addRelevantPages } from '../excel/pageSelect.js';
import { WorkbookModel } from '../excel/workbook.js';
import { assertRosterReady, inspectRoster, usableFallbacks } from '../llm/roster.js';
import type { ProviderFactory } from '../llm/registry.js';
import { loadReliability } from '../library/library.js';
import { saveRunSnapshot, snapshotFolder } from './snapshot.js';
import { checkScorecardYaml, importCandidates, type ImportInput, type ImportResult } from '../scorecard/importer.js';
import { ScorecardResolver, conversionNote } from '../scorecard/resolve.js';
import { sha256 } from '../util/hash.js';
import { UserError, errorMessage } from '../util/errors.js';

export interface SubmitInput {
  workbook: { name: string; buffer: Buffer };
  scorecard: { name: string; buffer: Buffer };
  sources: string;
  /** Extra instructions for the examiners (the "prompt box"). */
  instructions?: string;
  projectName?: string;
  /** Quick check: every question is scored once and findings are not double-checked, so a repeat run is faster. Scores are a little less steady. */
  quick?: boolean;
  /** Run twice: two full checks with the same examiners; the report shows the average and the gap. */
  runTwice?: boolean;
  /** Which of the five steps this is (1-5), and whether the file is a schema (D1) or an output (D3). They place the result on the status board; when empty, the scorecard's own are used. */
  step?: string;
  gate?: string;
}

export interface ServiceDeps {
  store: Store;
  config: AppConfig;
  providers: ProviderFactory;
  env: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

export const MAX_INSTRUCTIONS = 4000;

const safeName = (name: string) => path.basename(name).replace(/[^\w.\- ]+/g, '_') || 'workbook.xlsx';

/**
 * Accepts a submission, checks it straight away so mistakes come back as a clear error,
 * then evaluates in the background while the dashboard follows the progress.
 */
export class EvaluationService {
  private readonly running = new Set<Promise<void>>();
  /** Filling free places from the waiting line happens one call at a time, so two triggers never take the same run or an extra place. */
  private fillChain: Promise<void> = Promise.resolve();
  /** Saving a run and giving it its place in line happens one submission at a time, so the line is strictly first come, first served. */
  private saveChain: Promise<unknown> = Promise.resolve();
  readonly scorecards: ScorecardResolver;

  constructor(private readonly deps: ServiceDeps) {
    // The model that converts a scorecard is the first rater without a prompt-size limit (the most room), else the consolidator.
    this.scorecards = new ScorecardResolver({
      cacheDir: path.join(deps.config.dataDir, 'scorecards'),
      candidates: () => importCandidates(deps.config.models, deps.providers),
      log: deps.log,
    });
  }

  /** Shows how a scorecard in another layout is converted. The same conversion is used when work is submitted with it. */
  async importScorecard(input: ImportInput): Promise<ImportResult & { cached: boolean; fit: (ScorecardFit & { note: string }) | null }> {
    const result = await this.scorecards.preview(input.source, input.document);
    // With the file the scorecard will judge, say now whether the scorecard asks about things that kind of file cannot hold (see agent/fit.ts).
    let fit: (ScorecardFit & { note: string }) | null = null;
    if (input.document) {
      const questions = result.questions.flatMap((q) =>
        q.criteria && q.criteria.length > 0 ? q.criteria.map((c) => ({ id: c.id, name: c.name, by: c.by })) : [{ id: q.id, name: q.name, by: q.by }],
      );
      const found = checkScorecardFit(
        questions.map((q) => ({ id: q.id, name: q.name, weight: 1, critical: false, measuredBy: q.by === 'code' ? ('code' as const) : ('raters' as const) })),
        await WorkbookModel.load(input.document.bytes),
      );
      if (found) fit = { ...found, note: fitNote(found) };
    }
    return { ...result, fit };
  }

  checkScorecard(yamlText: string) {
    return checkScorecardYaml(yamlText);
  }

  /** How many evaluations may run at once (1 unless MAX_CONCURRENT_RUNS says otherwise); 0 means no limit. */
  get limit(): number {
    return this.deps.config.maxConcurrentRuns ?? 1;
  }

  async submit(input: SubmitInput): Promise<{ runId: string; projectId: string; iteration: number; status: RunStatus; queuePosition: number | null }> {
    const instructions = (input.instructions ?? '').trim();
    if (instructions.length > MAX_INSTRUCTIONS) {
      throw new UserError(`The extra instructions are ${instructions.length} characters; the limit is ${MAX_INSTRUCTIONS}. Shorten them.`);
    }
    // The same file in both slots would score a scorecard against itself, and every finding would point at its own notes.
    if (sha256(input.workbook.buffer) === sha256(input.scorecard.buffer)) {
      throw new UserError('The file to check and the scorecard are the same file. Put the schema or output you want scored in "Your file", and the scorecard in "Scorecard".');
    }
    const step = (input.step ?? '').trim();
    if (step && !/^[1-5]$/.test(step)) throw new UserError('The step must be a number from 1 to 5.');
    const gate = (input.gate ?? '').trim().toUpperCase();
    if (gate && gate !== 'D1' && gate !== 'D3') throw new UserError('Say whether the file is a schema (D1) or an output (D3).');
    const name = safeName(input.workbook.name);
    const projectName = (input.projectName?.trim() || path.basename(name, path.extname(name))).slice(0, 120);

    // A project keeps the scorecard its first iteration was converted to (one per scorecard file), so the target never
    // moves between iterations, even when the workbook gains or renames sheets. Otherwise any layout is accepted: one in
    // another layout is converted (once, then cached) and used straight away.
    const sourceHash = sha256(input.scorecard.buffer);
    const pin = await this.deps.store.findPin(projectName, sourceHash);
    const resolved = pin
      ? null
      : await this.scorecards.resolve(
          { name: input.scorecard.name, bytes: input.scorecard.buffer },
          { name: input.workbook.name, bytes: input.workbook.buffer },
        );
    const parsed = pin ? pin.scorecard : resolved!.scorecard;
    const hash = pin ? pin.scorecardHash : resolved!.hash;
    const scorecardNotes = pin
      ? [`This project is pinned to iteration ${pin.iteration}'s scorecard (converted from ${pin.sourceName}), so every iteration is marked against the identical target.`]
      : resolved!.conversion
        ? [conversionNote(resolved!.conversion)]
        : [];
    const roster = inspectRoster(this.deps.config.models, this.deps.env);
    assertRosterReady(roster);

    const wb = await WorkbookModel.load(input.workbook.buffer);
    const scorecard = addRelevantPages(resolvePageRanges(parsed, wb), wb);
    for (const sheet of [...scorecard.artifact.sheets, ...scorecard.artifact.context]) {
      if (!wb.resolveSheet(sheet.name)) {
        throw new UserError(
          pin
            ? `This project is pinned to iteration ${pin.iteration}'s scorecard, which reads a sheet "${sheet.name}" that this workbook no longer has. Restore that sheet name, or submit under a new project name to convert the scorecard again. Sheets found: ${wb.sheetNames().join(', ')}`
            : `The scorecard names a sheet "${sheet.name}" that this workbook does not have. Sheets found: ${wb.sheetNames().join(', ')}`,
        );
      }
    }

    // Column lists are checked now too, so a typo comes back as an error, not as a failed run.
    serializeSheets(wb, [...scorecard.artifact.sheets, ...scorecard.artifact.context]);

    // Refuse now, in plain words, an evaluation that most of the raters could not take, instead of failing three calls later.
    const fit = preflight({
      scorecard, wb, sources: input.sources, instructions,
      raters: roster.raters.map((r) => ({
        id: r.id, model: r.model, maxInputTokens: r.maxInputTokens,
        fallbackLimits: usableFallbacks(r).map((f) => f.maxInputTokens),
      })),
    });
    if (!fit.ok) throw new UserError(fit.problem!, 409);

    const runId = randomUUID();
    const folder = path.join(this.deps.config.dataDir, 'uploads', runId);
    await mkdir(folder, { recursive: true });
    const workbookPath = path.join(folder, name);
    await writeFile(workbookPath, input.workbook.buffer, { flag: 'wx' });

    const progress: RunProgress = {
      participants: [...roster.raters.map((r) => ({ ...r, role: 'rater' as const })), { ...roster.consolidator, role: 'consolidator' as const }].map(
        (m): ParticipantProgress => ({ id: m.id, role: m.role, provider: m.provider, model: m.model, family: m.family, status: 'waiting' }),
      ),
    };

    const save = this.saveChain.then(() =>
      this.deps.store.createRun(
        {
          projectName, step: step || parsed.step, gate: (gate as Gate) || parsed.gate, scorecard: parsed, scorecardHash: hash, sources: input.sources, instructions,
          artifactName: name, artifactHash: sha256(input.workbook.buffer), artifactPath: workbookPath, progress,
          options: { quick: Boolean(input.quick), runTwice: Boolean(input.runTwice), scorecardNotes },
        },
        runId,
      ),
    );
    this.saveChain = save.catch(() => undefined);
    const created = await save;
    // Only a converted scorecard is pinned: one in the app's own format is the same scorecard whenever the same file is sent.
    if (!pin && resolved?.conversion) {
      await this.deps.store.addPin(created.projectId, sourceHash, { sourceName: input.scorecard.name, scorecardHash: hash, scorecard: parsed, iteration: created.iteration });
    }

    // The run is saved as "waiting"; it starts now if there is a free place, else it keeps its place in the line.
    await this.fill();
    const detail = await this.deps.store.getRunDetail(created.runId);
    return { ...created, status: detail.status, queuePosition: detail.queuePosition };
  }

  /**
   * Starts waiting runs, oldest first, while there is a free place. Called after every submit, whenever a run ends
   * (finished, failed or crashed) and when the server starts, so the line cannot stall.
   */
  fill(): Promise<void> {
    this.fillChain = this.fillChain
      .then(async () => {
        while (this.limit === 0 || this.running.size < this.limit) {
          const job = await this.deps.store.claimNext();
          if (!job) break;
          this.start(job);
        }
      })
      .catch((error) => this.deps.log?.(`could not start the next waiting check: ${errorMessage(error)}`));
    return this.fillChain;
  }

  /** After a restart: carries on with the runs that were waiting. Runs that were mid-way were already marked failed. */
  async resume(): Promise<number> {
    const waiting = (await this.deps.store.waitingIds()).length;
    await this.fill();
    return waiting;
  }

  /** Takes a waiting run out of the line. A run that has already started cannot be stopped (it needs a way to stop the model calls it has sent). */
  async cancelRun(runId: string): Promise<void> {
    await this.deps.store.cancelWaiting(runId);
  }

  private start(job: RunJob): void {
    const task = this.execute(job)
      .catch(async (error) => {
        this.deps.log?.(`run ${job.runId} crashed: ${errorMessage(error)}`);
        // Whatever went wrong, the run must not stay "running" for ever, or its place could never be freed.
        await this.deps.store.failRun(job.runId, errorMessage(error)).catch(() => undefined);
      })
      .finally(() => {
        this.running.delete(task);
        void this.fill();
      });
    this.running.add(task);
  }

  /** Saves a copy of the run's report as files. A failure here is logged and never loses the result held in the database. */
  async snapshot(runId: string): Promise<void> {
    try {
      const folder = await saveRunSnapshot(this.deps.config.dataDir, await this.deps.store.getRunDetail(runId));
      if (folder) this.deps.log?.(`report saved to ${folder}`);
    } catch (error) {
      this.deps.log?.(`could not save report files: ${errorMessage(error)}`);
    }
  }

  async deleteRun(runId: string): Promise<void> {
    await this.removeFiles(await this.deps.store.deleteRun(runId));
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.removeFiles(await this.deps.store.deleteProject(projectId));
  }

  /** Deletes the saved upload and report copy of each removed run. Only paths inside the data folder are touched. */
  private async removeFiles(runs: DeletedRun[]): Promise<void> {
    const { dataDir } = this.deps.config;
    const inside = (target: string) => path.resolve(target).startsWith(path.resolve(dataDir) + path.sep);
    for (const run of runs) {
      const targets = [run.artifactPath ? path.dirname(run.artifactPath) : null, snapshotFolder(dataDir, run.projectName, run.iteration)];
      for (const target of targets) {
        if (!target || !inside(target)) continue;
        await rm(target, { recursive: true, force: true }).catch((error) => this.deps.log?.(`could not delete ${target}: ${errorMessage(error)}`));
      }
      // The project's report folder goes with its last report; rmdir refuses while anything is still in it.
      await rmdir(path.dirname(snapshotFolder(dataDir, run.projectName, run.iteration))).catch(() => {});
    }
  }

  /** Resolves when every started evaluation has finished (used by tests and graceful shutdown). */
  async idle(): Promise<void> {
    for (;;) {
      await this.fillChain;
      if (this.running.size === 0) return;
      await Promise.allSettled([...this.running]);
    }
  }

  private async execute(job: RunJob): Promise<void> {
    const { runId, projectName, iteration, artifactName, sources, instructions, scorecard, scorecardHash, progress } = job;
    const workbookPath = job.artifactPath;
    const scorecardNotes = job.options.scorecardNotes;
    const quick = job.options.quick;
    const runTwice = job.options.runTwice;
    const { store, config, providers, env } = this.deps;
    // Progress writes are queued so they reach the database in the order they happened.
    let chain: Promise<unknown> = Promise.resolve();
    const persist = (work: () => Promise<void>) => {
      chain = chain.then(work).catch((error) => this.deps.log?.(`progress write failed: ${errorMessage(error)}`));
    };

    const onProgress = (event: ProgressEvent) => {
      if (event.type === 'stage') {
        persist(() => store.setStage(runId, event.stage, progress));
        return;
      }
      const participant = progress.participants.find((p) => p.id === event.id);
      if (!participant) return;
      participant.status = event.status;
      if (event.provider) participant.provider = event.provider;
      if (event.model) participant.model = event.model;
      participant.error = event.error;
      participant.latencyMs = event.latencyMs;
      persist(() => store.setProgress(runId, progress));
    };

    try {
      const output = await (runTwice ? evaluateTwice : evaluate)({
        runId, projectName, iteration, workbookPath, artifactName, scorecard, scorecardHash, sources, instructions, scorecardNotes,
        // A quick check scores each question once; the other settings are the roster's own.
        models: quick ? { ...config.models, settings: { ...config.models.settings, repeats: 1, verifyFindings: false } } : config.models, providers, env, onProgress, reliability: await loadReliability(this.deps.config.dataDir),
      });
      await chain;
      await store.completeRun(runId, output, progress);
      await this.snapshot(runId);
    } catch (error) {
      await chain;
      await store.failRun(runId, errorMessage(error));
    }
  }
}
