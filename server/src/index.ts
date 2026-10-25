import './env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './api/app.js';
import { EvaluationService } from './api/service.js';
import { loadAppConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createDb, explainDbError } from './db/pool.js';
import { Store } from './db/store.js';
import { createProviderFactory } from './llm/registry.js';
import { inspectRoster } from './llm/roster.js';

const log = (message: string) => console.log(`[ddd] ${message}`);

const config = loadAppConfig();
const env = process.env;
let db: Awaited<ReturnType<typeof createDb>>;
try {
  db = await createDb(config);
  const applied = await migrate(db);
  if (applied.length > 0) log(`database migrated: ${applied.join(', ')}`);
} catch (error) {
  const advice = explainDbError(error, config.databaseUrl);
  if (!advice) throw error;
  console.error(`\n[ddd] ${advice}\n`);
  process.exit(1);
}

const store = new Store(db);
const interrupted = await store.failInterrupted();
if (interrupted > 0) log(`${interrupted} unfinished run(s) from a previous session marked as failed`);

const refreshed = await store.refreshVerdicts();
if (refreshed > 0) log(`${refreshed} saved result(s) updated to the current decision rule`);

const providers = createProviderFactory(config.models, { env, mockDelayMs: config.mockDelayMs });
const service = new EvaluationService({ store, config, providers, env, log });
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const waiting = await service.resume();
if (waiting > 0) log(`${waiting} waiting check(s) from a previous session carry on in line`);
const app = createApp({ store, service, config, env, webDist, log });

const server = app.listen(config.port, () => {
  const roster = inspectRoster(config.models, env);
  log(`listening on http://localhost:${config.port}`);
  log(config.maxConcurrentRuns === 0 ? 'checks: no limit, every check starts at once' : `checks: ${config.maxConcurrentRuns ?? 1} at a time, the rest wait in line`);
  log(config.dbMode === 'postgres' ? 'database: Postgres' : 'database: in-memory (set DATABASE_URL to keep data)');
  log(config.mock ? 'models: MOCK (scripted, no live APIs)' : `models: ${roster.raters.map((r) => `${r.id}=${r.provider}/${r.model}`).join(', ')}, consolidator ${roster.consolidator.provider}/${roster.consolidator.model}`);
  for (const problem of roster.problems) log(`${problem.level}: ${problem.message}`);
});

const shutdown = () => {
  server.close(() => {
    void service.idle().then(() => db.close()).then(() => process.exit(0));
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
