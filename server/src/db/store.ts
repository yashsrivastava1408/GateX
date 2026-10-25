import { randomUUID } from 'node:crypto';
import { SCORE_BANDS } from '@ddd/shared';
import type { BoardRun } from '@ddd/shared';
import type {
  Decision,
  DimensionTrendRow,
  EvaluationCore,
  Finding,
  FindingDiff,
  Gate,
  Override,
  ProjectHistory,
  ProjectSummary,
  RunDetail,
  RunLog,
  RunProgress,
  RunStage,
  RunStatus,
  RunSummary,
  Scorecard,
} from '@ddd/shared';
import { assembleReport } from '../report/assemble.js';
import type { EvaluationOutput } from '../agent/index.js';
import { UserError } from '../util/errors.js';
import type { Db } from './pool.js';

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));
const isoOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : iso(value));
const json = (value: unknown): string => JSON.stringify(value);
const parseJson = <T>(value: unknown): T | null => {
  if (value === null || value === undefined) return null;
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
};

interface RunRow {
  id: string;
  project_id: string;
  project_name: string;
  iteration: number;
  status: RunStatus;
  stage: RunStage;
  gate: Gate | null;
  scorecard_id: string | null;
  artifact_name: string | null;
  artifact_path: string | null;
  weighted_score: number | null;
  agent_decision: Decision | null;
  final_decision: Decision | null;
  created_at: unknown;
  finished_at: unknown;
  progress: unknown;
  error: string | null;
  core: unknown;
  run_log: unknown;
  scorecard: unknown;
}

const RUN_COLUMNS = `r.id, r.project_id, p.name as project_name, r.iteration, r.status, r.stage, r.gate, r.scorecard_id,
  r.artifact_name, r.artifact_path, r.weighted_score, r.agent_decision, r.final_decision, r.created_at, r.finished_at,
  r.progress, r.error, r.core, r.run_log, r.scorecard`;

function toSummary(row: RunRow, positions: Map<string, number> = new Map()): RunSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    iteration: Number(row.iteration),
    status: row.status,
    stage: row.stage,
    gate: row.gate,
    scorecardId: row.scorecard_id,
    artifactName: row.artifact_name,
    weightedScore: row.weighted_score === null ? null : Number(row.weighted_score),
    agentDecision: row.agent_decision,
    finalDecision: row.final_decision,
    createdAt: iso(row.created_at),
    finishedAt: isoOrNull(row.finished_at),
    queuePosition: row.status === 'waiting' ? (positions.get(row.id) ?? null) : null,
  };
}

export interface NewRun {
  projectName: string;
  step?: string;
  gate: Gate;
  scorecard: Scorecard;
  scorecardHash: string;
  sources: string;
  instructions: string;
  artifactName: string;
  artifactHash: string;
  artifactPath: string;
  progress: RunProgress;
  options: RunOptions;
}

/** What was chosen at submit that the run needs later, when it leaves the waiting line. */
export interface RunOptions {
  quick: boolean;
  runTwice: boolean;
  scorecardNotes: string[];
}

/** Everything needed to start a saved run. */
export interface RunJob {
  runId: string;
  projectName: string;
  iteration: number;
  artifactPath: string;
  artifactName: string;
  sources: string;
  instructions: string;
  scorecard: Scorecard;
  scorecardHash: string;
  progress: RunProgress;
  options: RunOptions;
}

/** The scorecard a project is marked against for one uploaded scorecard file. */
export interface ScorecardPin {
  sourceName: string;
  scorecardHash: string;
  scorecard: Scorecard;
  /** The iteration that first used it. */
  iteration: number;
}

export interface DeletedRun {
  runId: string;
  iteration: number;
  artifactPath: string | null;
  projectId: string;
  projectName: string;
}

export class Store {
  constructor(private readonly db: Db) {}

  /* ------------------------------ runs ------------------------------ */

  /** Creates the project if needed and the next iteration of it, in one transaction. */
  async createRun(input: NewRun, runId = randomUUID()): Promise<{ runId: string; projectId: string; iteration: number }> {
    return this.db.tx(async (tx) => {
      let [project] = await tx.query<{ id: string }>('select id from projects where name = $1', [input.projectName]);
      if (!project) {
        project = { id: randomUUID() };
        await tx.query('insert into projects (id, name, step) values ($1, $2, $3)', [project.id, input.projectName, input.step ?? null]);
      } else if (input.step) {
        // A step chosen at submit places an older project that was saved without one; a step already saved is not changed.
        await tx.query('update projects set step = $2 where id = $1 and step is null', [project.id, input.step]);
      }
      const [last] = await tx.query<{ last: number | null }>('select max(iteration) as last from runs where project_id = $1', [project.id]);
      const iteration = Number(last?.last ?? 0) + 1;
      const [top] = await tx.query<{ top: number | string | null }>('select max(queue_no) as top from runs');
      const queueNo = Number(top?.top ?? 0) + 1;
      await tx.query(
        `insert into runs (id, project_id, iteration, status, stage, gate, scorecard_id, scorecard_version, scorecard_hash,
           scorecard, sources, instructions, artifact_name, artifact_hash, artifact_path, progress, queue_no, run_options)
         values ($1,$2,$3,'waiting','waiting',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          runId, project.id, iteration, input.gate, input.scorecard.id, input.scorecard.version, input.scorecardHash,
          json(input.scorecard), input.sources, input.instructions, input.artifactName, input.artifactHash, input.artifactPath, json(input.progress),
          queueNo, json(input.options),
        ],
      );
      return { runId, projectId: project.id, iteration };
    });
  }

  /* --------------------------- waiting line --------------------------- */

  /** Waiting runs, first in line first. */
  async waitingIds(): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(`select id from runs where status = 'waiting' order by queue_no, id`);
    return rows.map((r) => r.id);
  }

  private async positions(): Promise<Map<string, number>> {
    return new Map((await this.waitingIds()).map((id, index) => [id, index + 1]));
  }

  /**
   * Takes the run at the front of the line off it (waiting -> queued) and returns what is needed to start it, or null when nobody waits.
   * Only the status flips, so a run cancelled a moment earlier is never started.
   */
  async claimNext(): Promise<RunJob | null> {
    for (const id of await this.waitingIds()) {
      const claimed = await this.db.tx(async (tx) => {
        const [still] = await tx.query<{ id: string }>(`select id from runs where id = $1 and status = 'waiting'`, [id]);
        if (!still) return false;
        await tx.query(`update runs set status = 'queued', stage = 'queued' where id = $1 and status = 'waiting'`, [id]);
        return true;
      });
      if (claimed) return this.jobOf(id);
    }
    return null;
  }

  private async jobOf(runId: string): Promise<RunJob> {
    const [row] = await this.db.query<Record<string, unknown>>(
      `select r.id, r.iteration, r.artifact_path, r.artifact_name, r.sources, r.instructions, r.scorecard, r.scorecard_hash, r.progress, r.run_options,
         p.name as project_name from runs r join projects p on p.id = r.project_id where r.id = $1`,
      [runId],
    );
    if (!row) throw new UserError('That run does not exist.', 404);
    const options = parseJson<Partial<RunOptions>>(row.run_options) ?? {};
    return {
      runId: String(row.id),
      projectName: String(row.project_name),
      iteration: Number(row.iteration),
      artifactPath: String(row.artifact_path),
      artifactName: String(row.artifact_name),
      sources: String(row.sources ?? ''),
      instructions: String(row.instructions ?? ''),
      scorecard: parseJson<Scorecard>(row.scorecard)!,
      scorecardHash: String(row.scorecard_hash),
      progress: parseJson<RunProgress>(row.progress) ?? { participants: [] },
      options: { quick: Boolean(options.quick), runTwice: Boolean(options.runTwice), scorecardNotes: options.scorecardNotes ?? [] },
    };
  }

  /** Takes a run out of the line before it starts. A run that already started cannot be stopped. */
  async cancelWaiting(runId: string): Promise<void> {
    const [row] = await this.db.query<{ status: string }>('select status from runs where id = $1', [runId]);
    if (!row) throw new UserError('That run does not exist.', 404);
    if (row.status === 'cancelled') return;
    if (row.status !== 'waiting') {
      throw new UserError(
        row.status === 'queued' || row.status === 'running'
          ? 'This check has already started and cannot be stopped. It finishes by itself.'
          : 'This check has already finished, so there is nothing to cancel.',
        409,
      );
    }
    // The status test sits in the update, so a run that was started in the meantime is left alone.
    await this.db.query(`update runs set status = 'cancelled', stage = 'cancelled', error = $2, finished_at = now() where id = $1 and status = 'waiting'`, [
      runId, 'Cancelled before it started.',
    ]);
    const [after] = await this.db.query<{ status: string }>('select status from runs where id = $1', [runId]);
    if (after?.status !== 'cancelled') throw new UserError('This check started just now and cannot be stopped. It finishes by itself.', 409);
  }

  /* ------------------------- scorecard pins ------------------------- */

  /** The scorecard a project pinned for this uploaded scorecard file, if any. */
  async findPin(projectName: string, sourceHash: string): Promise<ScorecardPin | null> {
    const [row] = await this.db.query<Record<string, unknown>>(
      `select s.source_name, s.scorecard_hash, s.scorecard, s.pinned_iteration from scorecard_pins s
       join projects p on p.id = s.project_id where p.name = $1 and s.source_hash = $2`,
      [projectName, sourceHash],
    );
    if (!row) return null;
    const scorecard = parseJson<Scorecard>(row.scorecard);
    if (!scorecard) return null;
    return { sourceName: String(row.source_name), scorecardHash: String(row.scorecard_hash), scorecard, iteration: Number(row.pinned_iteration) };
  }

  /** Pins a scorecard to a project for one scorecard file. The first pin stands: a second one for the same file is ignored. */
  async addPin(projectId: string, sourceHash: string, pin: ScorecardPin): Promise<void> {
    await this.db.tx(async (tx) => {
      const [known] = await tx.query<{ n: number | string }>('select count(*) as n from scorecard_pins where project_id = $1 and source_hash = $2', [projectId, sourceHash]);
      if (Number(known?.n ?? 0) > 0) return;
      await tx.query(
        'insert into scorecard_pins (project_id, source_hash, source_name, scorecard_hash, scorecard, pinned_iteration) values ($1,$2,$3,$4,$5,$6)',
        [projectId, sourceHash, pin.sourceName, pin.scorecardHash, json(pin.scorecard), pin.iteration],
      );
    });
  }

  async setStage(runId: string, stage: RunStage, progress?: RunProgress): Promise<void> {
    const status: RunStatus = stage === 'queued' ? 'queued' : 'running';
    if (progress) {
      await this.db.query('update runs set stage = $2, status = $3, progress = $4 where id = $1', [runId, stage, status, json(progress)]);
    } else {
      await this.db.query('update runs set stage = $2, status = $3 where id = $1', [runId, stage, status]);
    }
  }

  async setProgress(runId: string, progress: RunProgress): Promise<void> {
    await this.db.query('update runs set progress = $2 where id = $1', [runId, json(progress)]);
  }

  async failRun(runId: string, message: string): Promise<void> {
    await this.db.query(
      `update runs set status = 'failed', stage = 'failed', error = $2, finished_at = now() where id = $1`,
      [runId, message],
    );
  }

  /** Deletes one run and everything saved for it. A run that is still being evaluated cannot be deleted. */
  async deleteRun(runId: string): Promise<DeletedRun[]> {
    const [row] = await this.db.query<{ status: string }>('select status from runs where id = $1', [runId]);
    if (!row) throw new UserError('That run does not exist.', 404);
    if (row.status === 'waiting') throw new UserError('This evaluation is waiting its turn. Cancel it first, then delete it.', 409);
    if (row.status === 'queued' || row.status === 'running') throw new UserError('This evaluation is still running. Delete it once it has finished.', 409);
    return this.removeRuns('where r.id = $1', [runId]);
  }

  /** Deletes a project with all of its runs. */
  async deleteProject(projectId: string): Promise<DeletedRun[]> {
    const [project] = await this.db.query<{ id: string }>('select id from projects where id = $1', [projectId]);
    if (!project) throw new UserError('That project does not exist.', 404);
    const [live] = await this.db.query<{ n: number | string }>(`select count(*) as n from runs where project_id = $1 and status in ('waiting', 'queued', 'running')`, [projectId]);
    if (Number(live?.n ?? 0) > 0) throw new UserError('This project has an evaluation that is running or waiting its turn. Delete it once it has finished (or cancel the waiting one).', 409);
    return this.removeRuns('where r.project_id = $1', [projectId], projectId);
  }

  /** Removes the rows, children first. Returns where each run's files were, so the caller can delete them too. */
  private async removeRuns(where: string, params: unknown[], projectId?: string): Promise<DeletedRun[]> {
    return this.db.tx(async (tx) => {
      const runs = await tx.query<DeletedRun>(
        `select r.id as "runId", r.iteration, r.artifact_path as "artifactPath", p.id as "projectId", p.name as "projectName"
         from runs r join projects p on p.id = r.project_id ${where}`,
        params,
      );
      for (const { runId } of runs) {
        // human_evidence only holds rows from older versions, which let a person add scores by hand.
        for (const table of ['model_calls', 'dimension_scores', 'findings', 'human_evidence', 'overrides']) {
          await tx.query(`delete from ${table} where run_id = $1`, [runId]);
        }
        await tx.query('delete from runs where id = $1', [runId]);
      }
      const owner = projectId ?? runs[0]?.projectId;
      if (owner) {
        const [left] = await tx.query<{ n: number | string }>('select count(*) as n from runs where project_id = $1', [owner]);
        if (Number(left?.n ?? 0) === 0) {
          await tx.query('delete from scorecard_pins where project_id = $1', [owner]);
          await tx.query('delete from projects where id = $1', [owner]);
        }
      }
      return runs;
    });
  }

  /**
   * On start-up, a run left "running" by a crashed process can never finish: mark it failed.
   * A run that was only waiting is left alone: it kept its uploads and starts again by itself.
   */
  async failInterrupted(): Promise<number> {
    const rows = await this.db.query<{ id: string }>(`select id from runs where status in ('queued', 'running')`);
    for (const row of rows) await this.failRun(row.id, 'The server stopped before this evaluation finished. Submit it again.');
    return rows.length;
  }

  async completeRun(runId: string, output: EvaluationOutput, progress: RunProgress): Promise<void> {
    const { core, calls, runLog } = output;
    const report = assembleReport(core, null);
    await this.db.tx(async (tx) => {
      await tx.query(
        `update runs set status = 'done', stage = 'done', core = $2, run_log = $3, progress = $4,
           weighted_score = $5, agent_decision = $6, final_decision = $6, finished_at = now() where id = $1`,
        [runId, json(core), json(runLog), json(progress), report.verdict.weightedScore, report.verdict.agentDecision],
      );

      for (const call of calls) {
        await tx.query(
          `insert into model_calls (run_id, participant_id, role, provider, model, family, status, attempts, prompt_hash,
             prompt, raw_response, discarded, input_tokens, output_tokens, latency_ms, error)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            runId, call.model.id, call.role, call.model.provider, call.model.model, call.model.family, call.status,
            call.attempts, call.promptHash, call.prompt, call.rawResponse, json(call.discardedDetail),
            call.inputTokens, call.outputTokens, Math.round(call.latencyMs), call.error ?? null,
          ],
        );
      }

      for (const dim of core.dimensions) {
        await tx.query(
          `insert into dimension_scores (run_id, dimension_id, name, weight, critical, measured_by, status, score, spread,
             resolution, flagged, rater_scores) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            runId, dim.id, dim.name, dim.weight, dim.critical, dim.measuredBy, dim.status, dim.consolidated, dim.spread,
            dim.resolution, dim.flagged, json(dim.raterScores),
          ],
        );
      }

      for (const f of core.findings) {
        await tx.query(
          `insert into findings (run_id, finding_id, fingerprint, severity, dimension_id, sheet, cell, title, detail, fix,
             return_to, source, reported_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            runId, f.id, fingerprint(f), f.severity, f.dimensionId, f.location?.sheet ?? null,
            f.location?.cell ?? null, f.title, f.detail, f.fix, f.returnTo, f.source, f.reportedBy.join(','),
          ],
        );
      }
    });
  }

  private async row(runId: string): Promise<RunRow> {
    const [row] = await this.db.query<RunRow>(
      `select ${RUN_COLUMNS} from runs r join projects p on p.id = r.project_id where r.id = $1`,
      [runId],
    );
    if (!row) throw new UserError('That run does not exist.', 404);
    return row;
  }

  async getArtifactPath(runId: string): Promise<string | null> {
    return (await this.row(runId)).artifact_path;
  }

  async getRunDetail(runId: string): Promise<RunDetail> {
    const row = await this.row(runId);
    const override = await this.latestOverride(runId);
    const core = parseJson<EvaluationCore>(row.core);
    return {
      ...toSummary(row, await this.positions()),
      progress: parseJson<RunProgress>(row.progress),
      error: row.error,
      report: core ? assembleReport(core, override) : null,
      runLog: parseJson<RunLog>(row.run_log),
    };
  }

  /* --------------------------- overrides --------------------------- */

  async latestOverride(runId: string): Promise<Override | null> {
    const [r] = await this.db.query<Record<string, unknown>>(
      'select id, run_id, decision, reason, by_name, created_at from overrides where run_id = $1 order by created_at desc',
      [runId],
    );
    return r
      ? { id: String(r.id), runId: String(r.run_id), decision: r.decision as Decision, reason: String(r.reason), by: String(r.by_name), createdAt: iso(r.created_at) }
      : null;
  }

  async addOverride(runId: string, input: { decision: Decision; reason: string; by: string }): Promise<void> {
    await this.requireDone(runId);
    await this.db.query('insert into overrides (id, run_id, decision, reason, by_name) values ($1,$2,$3,$4,$5)', [
      randomUUID(), runId, input.decision, input.reason, input.by,
    ]);
    await this.refreshVerdict(runId);
  }

  private async requireDone(runId: string): Promise<RunDetail> {
    const detail = await this.getRunDetail(runId);
    if (detail.status !== 'done' || !detail.report) throw new UserError('This run has no finished report yet.', 409);
    return detail;
  }

  /**
   * Brings the saved result of every finished run in line with the rule as it stands now, so a list or a chart never shows an older
   * rule's answer. Returns how many changed.
   */
  async refreshVerdicts(): Promise<number> {
    const rows = await this.db.query<{ id: string; final_decision: string | null; weighted_score: number | string | null }>(
      `select id, final_decision, weighted_score from runs where status = 'done'`,
    );
    let changed = 0;
    for (const row of rows) {
      const detail = await this.getRunDetail(row.id);
      const verdict = detail.report?.verdict;
      if (!verdict || (verdict.decision === row.final_decision && Number(row.weighted_score) === verdict.weightedScore)) continue;
      await this.refreshVerdict(row.id);
      changed += 1;
    }
    return changed;
  }

  /** Keeps the columns people query in step with the live verdict. */
  private async refreshVerdict(runId: string): Promise<void> {
    const detail = await this.getRunDetail(runId);
    if (!detail.report) return;
    const { verdict } = detail.report;
    await this.db.query('update runs set weighted_score = $2, agent_decision = $3, final_decision = $4 where id = $1', [
      runId, verdict.weightedScore, verdict.agentDecision, verdict.decision,
    ]);
  }

  /* ---------------------------- projects ---------------------------- */

  /** Every run with its project's step, newest first: what the status board is built from. */
  async boardRuns(): Promise<BoardRun[]> {
    const rows = await this.db.query<{ id: string; project_id: string; name: string; step: string | null; gate: Gate | null; status: RunStatus; weighted_score: number | null; created_at: unknown }>(
      `select r.id, r.project_id, p.name, p.step, r.gate, r.status, r.weighted_score, r.created_at
         from runs r join projects p on p.id = r.project_id order by r.created_at desc`,
    );
    return rows.map((r) => ({
      runId: r.id,
      projectId: r.project_id,
      projectName: r.name,
      step: r.step,
      gate: r.gate,
      status: r.status,
      score: r.weighted_score === null ? null : Number(r.weighted_score),
      createdAt: iso(r.created_at),
    }));
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const projects = await this.db.query<{ id: string; name: string; step: string | null; created_at: unknown }>(
      'select id, name, step, created_at from projects order by created_at desc',
    );
    const out: ProjectSummary[] = [];
    const positions = await this.positions();
    for (const project of projects) {
      const runs = await this.runsOf(project.id, positions);
      const latest = runs.length > 0 ? runs[runs.length - 1]! : null;
      out.push({
        id: project.id,
        name: project.name,
        step: project.step,
        runCount: runs.length,
        latest,
        scores: runs.filter((r) => r.status === 'done').map((r) => r.weightedScore).slice(-12),
      });
    }
    return out.sort((a, b) => (b.latest?.createdAt ?? '').localeCompare(a.latest?.createdAt ?? ''));
  }

  private async runsOf(projectId: string, positions?: Map<string, number>): Promise<RunSummary[]> {
    const place = positions ?? (await this.positions());
    const rows = await this.db.query<RunRow>(
      `select ${RUN_COLUMNS} from runs r join projects p on p.id = r.project_id where r.project_id = $1 order by r.iteration`,
      [projectId],
    );
    return rows.map((row) => toSummary(row, place));
  }

  async getHistory(projectId: string): Promise<ProjectHistory> {
    const [project] = await this.db.query<{ id: string; name: string; step: string | null }>(
      'select id, name, step from projects where id = $1',
      [projectId],
    );
    if (!project) throw new UserError('That project does not exist.', 404);

    const runs = await this.runsOf(projectId);
    const done = runs.filter((r) => r.status === 'done');

    const dimensionRows = new Map<string, DimensionTrendRow>();
    const findingSets = new Map<string, Set<string>>();
    for (const [index, run] of done.entries()) {
      const scores = await this.db.query<{ dimension_id: string; name: string; critical: boolean; score: number | null }>(
        'select dimension_id, name, critical, score from dimension_scores where run_id = $1',
        [run.id],
      );
      for (const s of scores) {
        const row = dimensionRows.get(s.dimension_id) ?? {
          dimensionId: s.dimension_id, name: s.name, critical: Boolean(s.critical), scores: done.map(() => null),
        };
        row.scores[index] = s.score === null ? null : Number(s.score);
        dimensionRows.set(s.dimension_id, row);
      }
      const fingerprints = await this.db.query<{ fingerprint: string }>('select fingerprint from findings where run_id = $1', [run.id]);
      findingSets.set(run.id, new Set(fingerprints.map((f) => f.fingerprint)));
    }

    const findingDiffs: FindingDiff[] = done.map((run, index) => {
      const current = findingSets.get(run.id)!;
      const previous = index > 0 ? findingSets.get(done[index - 1]!.id)! : new Set<string>();
      const stillOpen = [...current].filter((f) => previous.has(f)).length;
      return {
        runId: run.id,
        iteration: run.iteration,
        fixed: index === 0 ? 0 : [...previous].filter((f) => !current.has(f)).length,
        stillOpen,
        added: current.size - stillOpen,
      };
    });

    const latest = done[done.length - 1];
    const scorecard = latest ? parseJson<Scorecard>((await this.row(latest.id)).scorecard) : null;
    // Rows follow the scorecard's own order; a dimension that only older iterations had goes last.
    const position = new Map((scorecard?.dimensions ?? []).map((d, i) => [d.id, i]));
    const dimensions = [...dimensionRows.values()].sort(
      (a, b) => (position.get(a.dimensionId) ?? Number.MAX_SAFE_INTEGER) - (position.get(b.dimensionId) ?? Number.MAX_SAFE_INTEGER),
    );
    return {
      project,
      runs,
      trend: done.map((r) => ({ runId: r.id, iteration: r.iteration, score: r.weightedScore, decision: r.finalDecision, createdAt: r.createdAt })),
      dimensions,
      findingDiffs,
      thresholds: scorecard ? { ...SCORE_BANDS } : null,
    };
  }
}

/**
 * Identity of a finding across iterations, to tell "fixed" from "still open".
 * A code finding is the dimension itself (the failing cell moves as rows get fixed);
 * a rater finding is the dimension at a cell.
 */
export function fingerprint(finding: Pick<Finding, 'dimensionId' | 'location' | 'source'>): string {
  if (finding.source === 'code') return `${finding.dimensionId}|code`;
  return `${finding.dimensionId}|${finding.location?.sheet ?? ''}|${finding.location?.cell ?? ''}`;
}
