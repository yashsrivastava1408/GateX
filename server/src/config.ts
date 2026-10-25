import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';

/** A backup for a model. It answers as the same participant and counts as the same family, so independence is kept. */
const fallbackSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  maxInputTokens: z.number().int().positive().optional(),
});

const modelEntrySchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  family: z.string().min(1),
  /** Optional ceiling on the prompt (about 4 characters per token). A prompt over it fails early, with advice. */
  maxInputTokens: z.number().int().positive().optional(),
  /** Tried in order if this model fails for any reason (overload, rate limit, prompt too large). Must be the same model family. */
  fallbacks: z.array(fallbackSchema).optional(),
});

const providerSchema = z.object({
  type: z.enum(['openai-compatible', 'gemini', 'bedrock', 'mock']),
  baseUrl: z.string().url().optional(),
  keyEnv: z.string().optional(),
  /** Bedrock only: the AWS region the models are enabled in. The AWS_REGION variable overrides it. */
  region: z.string().optional(),
});

/** The model that double-checks findings. Optional: without it the consolidator does the job. Must be on the approved list. */
const verifierSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  fallbacks: z.array(fallbackSchema).optional(),
  /** Models that each give a second reading of a finding about to be set aside; all must agree. Default: the verifier itself. */
  confirmers: z.array(z.object({ provider: z.string().min(1), model: z.string().min(1) })).optional(),
});

export const modelsConfigSchema = z.object({
  /** "provider:model" or "provider:*". Only these may receive project documents. */
  approved: z.array(z.string()),
  providers: z.record(z.string(), providerSchema),
  raters: z.array(modelEntrySchema).length(3, 'the 3 + 1 model needs exactly three raters'),
  consolidator: modelEntrySchema,
  verifier: verifierSchema.optional(),
  settings: z
    .object({
      /** Temperature of every model call (0: the most repeatable answer a model gives). */
      temperature: z.number().min(0).max(2).default(0),
      /** Temperature for the repeat answers of an examiner only. Unset: the same as `temperature`. */
      repeatTemperature: z.number().min(0).max(2).optional(),
      maxOutputTokens: z.number().int().positive().default(8192),
      timeoutMs: z.number().int().positive().default(120_000),
      retries: z.number().int().min(0).max(6).default(3),
      /** Sections scored at the same time. Keep 1 on free tiers (rate limits); a roster with room can use more. */
      sectionConcurrency: z.number().int().min(1).max(8).default(1),
      /** Times each rater scores each section; the median is kept. 1 on free tiers; 3 steadies scores when quota allows. */
      repeats: z.number().int().min(1).max(5).default(1),
      /**
       * How repeats are spent. "adaptive" (default): each rater scores everything once, then only the questions the examiners
       * disagree on by more than a point (or gave no usable score for) are scored again, up to `repeats` times in all.
       * "all": every question is scored `repeats` times.
       */
      repeatMode: z.enum(['all', 'adaptive']).default('adaptive'),
      /**
       * Near a colour line (a score within 4 points of 75 or 60) the questions the examiners still disagree on by 2 or more are scored again and the
       * result says it is close to the line. Needs repeats above 1. On by default; false turns the extra calls off (the note about the line stays).
       */
      closeLook: z.boolean().default(true),
      /** Double-check every examiner finding against the file with a separate model call (on by default; a quick check skips it). The VERIFY_FINDINGS=0 variable also turns it off. */
      verifyFindings: z.boolean().default(true),
    })
    .default({ temperature: 0, maxOutputTokens: 8192, timeoutMs: 120_000, retries: 3, sectionConcurrency: 1, repeats: 1, repeatMode: 'adaptive', closeLook: true, verifyFindings: true }),
});

export type ModelsConfig = z.infer<typeof modelsConfigSchema>;
export type ModelEntry = z.infer<typeof modelEntrySchema>;
export type FallbackEntry = z.infer<typeof fallbackSchema>;
export type ProviderSpec = z.infer<typeof providerSchema>;

export interface AppConfig {
  port: number;
  dataDir: string;
  dbMode: 'postgres' | 'memory';
  databaseUrl: string | undefined;
  mock: boolean;
  mockDelayMs: number;
  models: ModelsConfig;
}

const serverDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * MODELS_CONFIG may be absolute or relative. A relative path is looked for where the command was typed, where the process
 * runs (npm runs workspace scripts from server/) and at the repository root, so "server/config/models.bedrock.json" works from anywhere.
 */
export function resolveModelsFile(configured: string, env: NodeJS.ProcessEnv = process.env): string {
  if (path.isAbsolute(configured)) return configured;
  const bases = [env.INIT_CWD, process.cwd(), path.dirname(serverDir)].filter((b): b is string => Boolean(b));
  const found = bases.map((base) => path.resolve(base, configured)).find((candidate) => existsSync(candidate));
  return found ?? path.resolve(bases[0] ?? '.', configured);
}

export function loadModelsConfig(file: string): ModelsConfig {
  const parsed = modelsConfigSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid models config ${file}: ${issues}`);
  }
  return parsed.data;
}

/** The models file the app will load: the scripted roster in mock mode, else MODELS_CONFIG, else server/config/models.json. */
export function modelsFileFor(env: NodeJS.ProcessEnv = process.env): string {
  // Mock mode is "no live APIs, whatever else is set": it always uses the scripted roster.
  if (env.MOCK_LLM === '1') return path.join(serverDir, 'config', 'models.mock.json');
  return env.MODELS_CONFIG ? resolveModelsFile(env.MODELS_CONFIG, env) : path.join(serverDir, 'config', 'models.json');
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const mock = env.MOCK_LLM === '1';
  const modelsFile = modelsFileFor(env);
  const databaseUrl = env.DATABASE_URL || undefined;
  const dbMode = env.DB_MODE === 'memory' || !databaseUrl ? 'memory' : 'postgres';
  return {
    port: Number(env.PORT ?? 4000),
    dataDir: path.resolve(env.DATA_DIR ?? path.join(serverDir, '..', 'data')),
    dbMode,
    databaseUrl,
    mock,
    mockDelayMs: Number(env.MOCK_DELAY_MS ?? 700),
    models: loadModelsConfig(modelsFile),
  };
}
