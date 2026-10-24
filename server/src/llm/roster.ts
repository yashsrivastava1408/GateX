import type { ModelRef, RosterProblem } from '@ddd/shared';
import type { ModelEntry, ModelsConfig } from '../config.js';
import { UserError } from '../util/errors.js';

export interface RosterFallback {
  provider: string;
  model: string;
  maxInputTokens?: number;
  keyPresent: boolean;
  approved: boolean;
}

export interface RosterMember extends ModelRef {
  keyPresent: boolean;
  approved: boolean;
  maxInputTokens?: number;
  fallbacks: RosterFallback[];
}

/** The fallbacks that may actually be used: approved to receive documents, and with a key. */
export const usableFallbacks = (m: RosterMember): RosterFallback[] => m.fallbacks.filter((f) => f.approved && f.keyPresent);

export interface RosterStatus {
  raters: RosterMember[];
  consolidator: RosterMember;
  problems: RosterProblem[];
  ready: boolean;
}

function isApproved(models: ModelsConfig, entry: { provider: string; model: string }): boolean {
  return models.approved.some(
    (rule) => rule === `${entry.provider}:${entry.model}` || rule === `${entry.provider}:*`,
  );
}

function hasKey(models: ModelsConfig, providerName: string, env: NodeJS.ProcessEnv): boolean {
  const provider = models.providers[providerName];
  return provider?.type === 'mock' || Boolean(provider?.keyEnv && env[provider.keyEnv]);
}

function member(models: ModelsConfig, entry: ModelEntry, env: NodeJS.ProcessEnv): RosterMember {
  const { fallbacks = [], ...rest } = entry;
  return {
    ...rest,
    keyPresent: hasKey(models, entry.provider, env),
    approved: isApproved(models, entry),
    fallbacks: fallbacks.map((f) => ({
      provider: f.provider,
      model: f.model,
      maxInputTokens: f.maxInputTokens,
      keyPresent: hasKey(models, f.provider, env),
      approved: isApproved(models, f),
    })),
  };
}

/**
 * Checks the roster against the PDF's guardrails (page 13): independent raters from
 * different model families, and only approved models receive project documents.
 */
export function inspectRoster(models: ModelsConfig, env: NodeJS.ProcessEnv = process.env): RosterStatus {
  const raters = models.raters.map((entry) => member(models, entry, env));
  const consolidator = member(models, models.consolidator, env);
  const problems: RosterProblem[] = [];
  const error = (message: string) => problems.push({ level: 'error', message });

  const families = raters.map((r) => r.family);
  if (new Set(families).size !== families.length) {
    error('The three raters must come from three different model families.');
  }
  if (new Set(raters.map((r) => r.id)).size !== raters.length) error('Rater ids must be unique.');

  for (const m of [...raters, consolidator]) {
    const spec = models.providers[m.provider];
    const label = `${m.id} (${m.provider}:${m.model})`;
    if (!spec) error(`Model ${label} uses a provider that is not configured.`);
    else if (!m.keyPresent) error(`Model ${label} has no API key. Set ${spec.keyEnv} in .env.`);
    if (!m.approved) error(`Model ${label} is not on the approved list, so it may not receive project documents.`);

    // A fallback only ever receives documents when the primary fails, so an unapproved one is refused up front.
    for (const f of m.fallbacks) {
      const fallbackLabel = `Fallback ${f.provider}:${f.model} for ${m.id}`;
      if (!models.providers[f.provider]) error(`${fallbackLabel} uses a provider that is not configured.`);
      else if (!f.keyPresent) {
        problems.push({ level: 'warning', message: `${fallbackLabel} has no API key and will be skipped.` });
      }
      if (!f.approved) error(`${fallbackLabel} is not on the approved list, so it may not receive project documents.`);
    }
  }

  if (raters.some((r) => r.family === consolidator.family)) {
    problems.push({
      level: 'warning',
      message: 'The consolidator shares a model family with a rater. A fourth family is preferred.',
    });
  }
  return { raters, consolidator, problems, ready: !problems.some((p) => p.level === 'error') };
}

export function assertRosterReady(status: RosterStatus): void {
  if (status.ready) return;
  const lines = status.problems.filter((p) => p.level === 'error').map((p) => `  • ${p.message}`);
  throw new UserError(`The evaluator roster is not ready:\n${lines.join('\n')}`, 409);
}

/**
 * The models that may double-check findings, in the order they are tried: the configured verifier and its fallbacks, else the consolidator
 * and its fallbacks. Only approved models with a key are returned, because they receive parts of the project document.
 */
export function verifierCandidates(models: ModelsConfig, env: NodeJS.ProcessEnv = process.env, role: 'finder' | 'confirmers' = 'finder'): Array<{ provider: string; model: string }> {
  const usable = (c: { provider: string; model: string }) => isApproved(models, c) && hasKey(models, c.provider, env);
  if (role === 'confirmers' && models.verifier?.confirmers) return models.verifier.confirmers.filter(usable).map((c) => ({ provider: c.provider, model: c.model }));
  const list = models.verifier
    ? [{ provider: models.verifier.provider, model: models.verifier.model }, ...(models.verifier.fallbacks ?? [])]
    : [{ provider: models.consolidator.provider, model: models.consolidator.model }, ...(models.consolidator.fallbacks ?? [])];
  return list.filter(usable).map((c) => ({ provider: c.provider, model: c.model }));
}
