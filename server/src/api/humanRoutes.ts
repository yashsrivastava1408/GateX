import type express from 'express';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Store } from '../db/store.js';
import { loadAccuracy } from '../library/accuracyData.js';
import { UserError } from '../util/errors.js';

const reviewBody = z.object({
  reviewer: z.string().trim().min(1, 'Say who you are.').max(120),
  scores: z.record(z.string(), z.number().min(0, 'A mark is from 0 to 5.').max(5, 'A mark is from 0 to 5.')),
  verdict: z.enum(['green', 'amber', 'red']).nullish(),
  note: z.string().trim().max(2000).default(''),
});

const feedbackBody = z.object({
  label: z.enum(['right', 'wrong', 'unclear']),
  who: z.string().trim().min(1, 'Say who you are.').max(120),
  note: z.string().trim().max(2000).default(''),
});

/**
 * A person's side of the evidence: their own marks for a finished check (shadow mode), their right / wrong marks on issues, and the accuracy
 * figures built from them. Nothing here changes a check's score, colour or report.
 */
export function registerHumanRoutes(app: express.Express, deps: { store: Store; config: AppConfig }): void {
  const { store, config } = deps;

  app.get('/api/runs/:id/human-review', async (req, res) => {
    res.json(await store.human.listReviews(req.params.id));
  });

  app.post('/api/runs/:id/human-review', async (req, res) => {
    const body = reviewBody.parse(req.body);
    const run = await store.getRunDetail(req.params.id);
    if (run.status !== 'done' || !run.report) throw new UserError('This check has no finished report yet, so there is nothing to compare with.', 409);
    const scored = new Set(run.report.dimensions.filter((d) => d.status === 'scored').map((d) => d.id));
    const unknown = Object.keys(body.scores).filter((id) => !scored.has(id));
    if (Object.keys(body.scores).length === 0) throw new UserError('Give at least one mark.');
    if (unknown.length > 0) throw new UserError(`These areas are not in this report: ${unknown.join(', ')}.`);
    res.status(201).json(await store.human.addReview(req.params.id, { reviewer: body.reviewer, verdict: body.verdict ?? null, scores: body.scores, note: body.note }));
  });

  app.get('/api/runs/:id/feedback', async (req, res) => {
    res.json(await store.human.listFeedback(req.params.id));
  });

  app.post('/api/runs/:id/findings/:findingId/feedback', async (req, res) => {
    const body = feedbackBody.parse(req.body);
    await store.getRunDetail(req.params.id);
    await store.human.setFeedback(req.params.id, req.params.findingId, body);
    res.status(201).json(await store.human.listFeedback(req.params.id));
  });

  app.get('/api/accuracy', async (_req, res) => {
    res.json(await loadAccuracy(config.dataDir, store));
  });
}
