import { randomUUID } from 'node:crypto';
import type { Decision, FeedbackLabel, FindingFeedback, HumanReview } from '@ddd/shared';
import { UserError } from '../util/errors.js';
import type { Db } from './pool.js';

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString());
const parseScores = (value: unknown): Record<string, number> => (typeof value === 'string' ? JSON.parse(value) : (value as Record<string, number>)) ?? {};

/** A person's marks and issue verdicts. Plain rows, no judgement: the accuracy page reads them and does the arithmetic. */
export class HumanStore {
  constructor(private readonly db: Db) {}

  async addReview(runId: string, input: { reviewer: string; verdict: Decision | null; scores: Record<string, number>; note: string }): Promise<HumanReview> {
    const id = randomUUID();
    await this.db.query('insert into human_reviews (id, run_id, reviewer, verdict, scores, note) values ($1,$2,$3,$4,$5,$6)', [
      id, runId, input.reviewer, input.verdict, JSON.stringify(input.scores), input.note,
    ]);
    const [row] = await this.db.query<Record<string, unknown>>('select * from human_reviews where id = $1', [id]);
    return this.toReview(row!);
  }

  async listReviews(runId: string): Promise<HumanReview[]> {
    const rows = await this.db.query<Record<string, unknown>>('select * from human_reviews where run_id = $1 order by created_at, id', [runId]);
    return rows.map((r) => this.toReview(r));
  }

  /** The ids of runs with at least one review, and every review of them. */
  async allReviews(): Promise<HumanReview[]> {
    const rows = await this.db.query<Record<string, unknown>>('select * from human_reviews order by created_at, id');
    return rows.map((r) => this.toReview(r));
  }

  /** One verdict per person per issue: a second one from the same person replaces the first. */
  async setFeedback(runId: string, findingId: string, input: { label: FeedbackLabel; who: string; note: string }): Promise<void> {
    const [found] = await this.db.query('select 1 as ok from findings where run_id = $1 and finding_id = $2', [runId, findingId]);
    if (!found) throw new UserError('That issue is not in this run.', 404);
    await this.db.tx(async (tx) => {
      await tx.query('delete from finding_feedback where run_id = $1 and finding_id = $2 and who = $3', [runId, findingId, input.who]);
      await tx.query('insert into finding_feedback (run_id, finding_id, who, label, note) values ($1,$2,$3,$4,$5)', [runId, findingId, input.who, input.label, input.note]);
    });
  }

  async listFeedback(runId: string): Promise<FindingFeedback[]> {
    const rows = await this.db.query<Record<string, unknown>>('select * from finding_feedback where run_id = $1 order by created_at, finding_id', [runId]);
    return rows.map((r) => this.toFeedback(r));
  }

  async allFeedback(): Promise<FindingFeedback[]> {
    const rows = await this.db.query<Record<string, unknown>>('select * from finding_feedback order by created_at, run_id, finding_id');
    return rows.map((r) => this.toFeedback(r));
  }

  /** The step each project was given (the step chosen on the upload form), by run. */
  async stepOfRuns(): Promise<Map<string, string | null>> {
    const rows = await this.db.query<{ id: string; step: string | null }>('select r.id as id, p.step as step from runs r join projects p on p.id = r.project_id');
    return new Map(rows.map((r) => [r.id, r.step]));
  }

  private toReview(r: Record<string, unknown>): HumanReview {
    return {
      id: String(r.id), runId: String(r.run_id), reviewer: String(r.reviewer), verdict: (r.verdict as Decision | null) ?? null,
      scores: parseScores(r.scores), note: String(r.note ?? ''), createdAt: iso(r.created_at),
    };
  }

  private toFeedback(r: Record<string, unknown>): FindingFeedback {
    return {
      runId: String(r.run_id), findingId: String(r.finding_id), who: String(r.who), label: r.label as FeedbackLabel,
      note: String(r.note ?? ''), createdAt: iso(r.created_at),
    };
  }
}
