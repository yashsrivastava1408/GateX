import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { ConfigResponse } from '@ddd/shared';
import type { AppConfig } from '../config.js';
import type { Store } from '../db/store.js';
import { inspectRoster } from '../llm/roster.js';
import { PROMPT_VERSION } from '../agent/index.js';
import { renderMarkdown } from '../report/markdown.js';
import { renderPdf } from '../report/pdf.js';
import { renderXlsx } from '../report/xlsx.js';
import { listLibrary, listPlanted, loadReliability, measureReliability, readLibraryCase } from '../library/library.js';
import { buildScorecardTemplate } from '../scorecard/template.js';
import { SCORECARD_TYPES } from '../scorecard/resolve.js';
import { UserError } from '../util/errors.js';
import type { EvaluationService } from './service.js';

export interface AppDeps {
  store: Store;
  service: EvaluationService;
  config: AppConfig;
  env: NodeJS.ProcessEnv;
  webDist?: string;
  log?: (message: string) => void;
}

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const overrideBody = z.object({
  decision: z.enum(['green', 'amber', 'red']),
  reason: z.string().trim().min(5, 'A written reason is required for an override.'),
  by: z.string().trim().min(1, 'Say who is overriding.'),
});

export function createApp(deps: AppDeps): express.Express {
  const { store, service, config } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 2 } });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, db: config.dbMode });
  });

  app.get('/api/config', (_req, res) => {
    const roster = inspectRoster(config.models, deps.env);
    const body: ConfigResponse = {
      mock: config.mock,
      raters: roster.raters,
      consolidator: roster.consolidator,
      problems: roster.problems,
      ready: roster.ready,
      promptVersion: PROMPT_VERSION,
      thresholds: { accept: 75, refine: 60 },
    };
    res.json(body);
  });

  app.get('/api/library', async (_req, res) => {
    res.json(await listLibrary(config.dataDir));
  });

  // The saved table the agent uses; when none is saved yet, what the checked runs would give now. Read-only: `npm run reliability` saves it.
  app.get('/api/library/reliability', async (_req, res) => {
    res.json((await loadReliability(config.dataDir)) ?? (await measureReliability(config.dataDir)));
  });

  app.get('/api/library/planted', async (_req, res) => {
    res.json(await listPlanted(config.dataDir));
  });

  app.get('/api/library/:id', async (req, res) => {
    res.json(await readLibraryCase(config.dataDir, req.params.id));
  });

  app.get('/api/projects', async (_req, res) => {
    res.json(await store.listProjects());
  });

  app.get('/api/projects/:id', async (req, res) => {
    res.json(await store.getHistory(req.params.id));
  });

  app.delete('/api/projects/:id', async (req, res) => {
    await service.deleteProject(req.params.id);
    res.status(204).end();
  });

  app.delete('/api/runs/:id', async (req, res) => {
    await service.deleteRun(req.params.id);
    res.status(204).end();
  });

  app.post(
    '/api/runs',
    upload.fields([{ name: 'workbook', maxCount: 1 }, { name: 'scorecard', maxCount: 1 }]),
    async (req, res) => {
      const files = req.files as Record<string, Express.Multer.File[]> | undefined;
      const workbook = files?.workbook?.[0];
      const scorecard = files?.scorecard?.[0];
      if (!workbook) throw new UserError('Attach the file to evaluate (.xlsx, .csv or .pdf).');
      if (!scorecard) throw new UserError('Attach the scorecard (any layout: .xlsx, .csv, .pdf, .yaml, .json, .txt or .md).');
      if (!/\.(xlsx|csv|pdf)$/i.test(workbook.originalname)) throw new UserError('The file to check must be an .xlsx, .csv or .pdf file.');
      if (!SCORECARD_TYPES.test(scorecard.originalname)) throw new UserError('The scorecard must be an .xlsx, .csv, .pdf, .yaml, .json, .txt or .md file.');

      const body = req.body as Record<string, string | undefined>;
      const created = await service.submit({
        workbook: { name: workbook.originalname, buffer: workbook.buffer },
        scorecard: { name: scorecard.originalname, buffer: scorecard.buffer },
        sources: body.sources ?? '',
        instructions: body.instructions,
        projectName: body.projectName,
        quick: body.quick === '1' || body.quick === 'true',
        runTwice: body.runTwice === '1' || body.runTwice === 'true',
      });
      res.status(202).json(created);
    },
  );

  app.post(
    '/api/scorecards/import',
    upload.fields([{ name: 'scorecard', maxCount: 1 }, { name: 'document', maxCount: 1 }]),
    async (req, res) => {
      const files = req.files as Record<string, Express.Multer.File[]> | undefined;
      const scorecard = files?.scorecard?.[0];
      const document = files?.document?.[0];
      if (!scorecard) throw new UserError('Attach the scorecard to import.');
      if (!SCORECARD_TYPES.test(scorecard.originalname)) throw new UserError('The scorecard must be an .xlsx, .csv, .pdf, .yaml, .json, .txt or .md file.');
      if (document && !/\.(xlsx|csv|pdf)$/i.test(document.originalname)) throw new UserError('The document the scorecard will judge must be an .xlsx, .csv or .pdf file.');
      const result = await service.importScorecard({
        source: { name: scorecard.originalname, bytes: scorecard.buffer },
        ...(document ? { document: { name: document.originalname, bytes: document.buffer } } : {}),
      });
      const { draft: _draft, ...body } = result;
      res.json(body);
    },
  );

  app.post('/api/scorecards/check', (req, res) => {
    const body = z.object({ yaml: z.string().min(1).max(500_000) }).parse(req.body);
    res.json(service.checkScorecard(body.yaml));
  });

  app.get('/api/scorecard-template.xlsx', async (_req, res) => {
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.attachment('scorecard-template.xlsx').send(await buildScorecardTemplate());
  });

  app.get('/api/runs/:id', async (req, res) => {
    res.json(await store.getRunDetail(req.params.id));
  });

  app.post('/api/runs/:id/override', async (req, res) => {
    await store.addOverride(req.params.id, overrideBody.parse(req.body));
    await service.snapshot(req.params.id);
    res.json(await store.getRunDetail(req.params.id));
  });

  app.get('/api/runs/:id/report.:ext', async (req, res) => {
    const detail = await store.getRunDetail(req.params.id);
    if (!detail.report) throw new UserError('This run has no finished report yet.', 409);
    const base = `${detail.projectName}-iteration-${detail.iteration}`.replace(/[^\w.-]+/g, '_');
    switch (req.params.ext) {
      case 'xlsx':
        res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.attachment(`${base}.xlsx`).send(await renderXlsx(detail.report));
        return;
      case 'pdf':
        res.type('application/pdf').attachment(`${base}.pdf`).send(await renderPdf(detail.report));
        return;
      case 'md':
        res.type('text/markdown').attachment(`${base}.md`).send(renderMarkdown(detail.report));
        return;
      case 'json':
        res.type('application/json').attachment(`${base}.json`).send(JSON.stringify(detail.report, null, 2));
        return;
      default:
        throw new UserError('Reports come as xlsx, pdf, md or json.', 404);
    }
  });

  app.use('/api', (_req, _res, next) => next(new UserError('No such endpoint.', 404)));

  if (deps.webDist && existsSync(deps.webDist)) {
    app.use(express.static(deps.webDist));
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      res.sendFile(path.join(deps.webDist!, 'index.html'));
    });
  }

  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof UserError) {
      res.status(error.status).json({ error: error.message });
    } else if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues.map((i) => i.message).join(' ') });
    } else if (error instanceof multer.MulterError) {
      res.status(400).json({ error: `Upload problem: ${error.message}` });
    } else {
      deps.log?.(`unhandled error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      res.status(500).json({ error: 'Something went wrong on the server. See the server log.' });
    }
  };
  app.use(onError);
  return app;
}
