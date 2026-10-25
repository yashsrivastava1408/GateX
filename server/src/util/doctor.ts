import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { loadModelsConfig, modelsFileFor, type ModelsConfig } from '../config.js';
import { createDb } from '../db/pool.js';
import { inspectRoster } from '../llm/roster.js';

export interface DoctorItem {
  ok: boolean;
  /** A warning does not fail the check; a problem that is not ok and not a warning does. */
  warn?: boolean;
  title: string;
  /** Plain-words next step, shown when the item is not ok. */
  fix?: string;
}

export interface DoctorInput {
  env: NodeJS.ProcessEnv;
  nodeVersion: string;
  /** Text of the .env file, or null when there is none. Only the key names are ever read from it. */
  envFileText: string | null;
  dataDir: string;
  /** Test hook: how to check the database. Default opens the configured one. */
  pingDb?: (databaseUrl: string) => Promise<void>;
  /** Test hook: how to load the models file. */
  loadModels?: (file: string) => ModelsConfig;
}

/** Names of the keys written in a .env file (never the values). */
export function envKeyNames(text: string): string[] {
  return text.split('\n').map((l) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1]).filter((k): k is string => Boolean(k));
}

const MIN_NODE = 22;

async function defaultPing(databaseUrl: string): Promise<void> {
  const db = await createDb({ dbMode: 'postgres', databaseUrl });
  try {
    await db.query('select 1');
  } finally {
    await db.close().catch(() => undefined);
  }
}

/** Checks the set-up and answers in plain words. Never returns or prints a secret value. */
export async function runDoctor(input: DoctorInput): Promise<DoctorItem[]> {
  const { env } = input;
  const items: DoctorItem[] = [];

  const major = Number(/^v?(\d+)/.exec(input.nodeVersion)?.[1] ?? 0);
  items.push({ ok: major >= MIN_NODE, title: `Node ${input.nodeVersion} (needs ${MIN_NODE} or newer)`, fix: `Install Node ${MIN_NODE} or newer (run "nvm use" in the project folder).` });

  const fileKeys = input.envFileText === null ? [] : envKeyNames(input.envFileText);
  items.push({
    ok: input.envFileText !== null || Boolean(env.MOCK_LLM),
    warn: true,
    title: input.envFileText === null ? 'No .env file found' : `.env file found (${fileKeys.length} setting names)`,
    fix: 'Copy .env.example to .env and fill in the keys. Keys can also come from the real environment.',
  });

  let models: ModelsConfig | null = null;
  const file = modelsFileFor(env);
  try {
    models = (input.loadModels ?? loadModelsConfig)(file);
    items.push({ ok: true, title: `Models file reads fine (${file.split('/').slice(-1)[0]})` });
  } catch (error) {
    items.push({ ok: false, title: 'Models file could not be read', fix: `${error instanceof Error ? error.message : String(error)}. Fix the file, or point MODELS_CONFIG at a good one.` });
  }

  if (models) {
    const roster = inspectRoster(models, env);
    const members = [...roster.raters, roster.consolidator];
    const wanted = [...new Set(members.map((m) => models!.providers[m.provider]?.keyEnv).filter((k): k is string => Boolean(k)))];
    for (const name of wanted) {
      const set = Boolean(env[name]);
      items.push({ ok: set, title: set ? `Key ${name} is set` : `Key ${name} is missing`, fix: `Add ${name}=... to .env (the models in use need it).` });
    }
    for (const p of roster.problems.filter((p) => !/has no API key\. Set/.test(p.message))) {
      items.push({ ok: false, warn: p.level === 'warning', title: p.message, fix: 'Edit the models file (see docs/operations.md, "The roster file").' });
    }
    if (roster.ready && roster.problems.length === 0) items.push({ ok: true, title: 'Three raters from three families, all approved' });
  }

  if (env.DB_MODE === 'memory' || !env.DATABASE_URL) {
    items.push({ ok: false, warn: true, title: 'No database set: results are lost when the server stops', fix: 'Set DATABASE_URL in .env to keep history (see docs/operations.md, "Database").' });
  } else {
    try {
      await (input.pingDb ?? defaultPing)(env.DATABASE_URL);
      items.push({ ok: true, title: 'Database answers' });
    } catch (error) {
      const code = (error as { code?: string }).code;
      items.push({ ok: false, title: `Database does not answer${code ? ` (${code})` : ''}`, fix: 'Start it (docker compose up -d db) and check DATABASE_URL in .env.' });
    }
  }

  let writable = false;
  try {
    accessSync(existsSync(input.dataDir) ? input.dataDir : '.', constants.W_OK);
    writable = true;
  } catch { /* reported below */ }
  items.push({ ok: writable, title: writable ? 'Data folder is writable' : 'Data folder is not writable', fix: `Make ${input.dataDir} writable by the user running GateX.` });

  return items;
}

export function renderDoctor(items: DoctorItem[]): { text: string; ok: boolean } {
  const lines = items.map((i) => (i.ok ? `  OK         ${i.title}` : `  ${i.warn ? 'CHECK' : 'NEEDS FIX'}${i.warn ? '      ' : '  '}${i.title}\n             -> ${i.fix ?? ''}`));
  const bad = items.filter((i) => !i.ok && !i.warn).length;
  const warn = items.filter((i) => !i.ok && i.warn).length;
  const summary = bad === 0 ? `All good${warn ? ` (${warn} thing${warn > 1 ? 's' : ''} worth a look)` : ''}.` : `${bad} thing${bad > 1 ? 's' : ''} need${bad > 1 ? '' : 's'} fixing before GateX will work.`;
  return { text: `${lines.join('\n')}\n\n${summary}`, ok: bad === 0 };
}

export function readEnvFile(file: string): string | null {
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}
