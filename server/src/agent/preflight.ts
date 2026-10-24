import type { Scorecard } from '@ddd/shared';
import type { WorkbookModel } from '../excel/workbook.js';
import { buildAllRaterPrompts } from './prompt.js';
import { RATER_SYSTEM } from './prompts/rater.js';
import { estimateTokens } from './rater.js';

/** An evaluation needs at least this many raters able to take the prompt, or it is not worth running. */
export const MIN_RATERS = 2;

export interface RaterLimit {
  id: string;
  model: string;
  /** Prompt ceiling set in models.json; undefined means no known limit. */
  maxInputTokens?: number;
  /** Limits of the fallback models that may answer if this one cannot. */
  fallbackLimits?: Array<number | undefined>;
}

export interface PreflightResult {
  /** Estimated size of the largest prompt any rater receives (a sectioned scorecard sends several smaller ones). */
  tokens: number;
  /** How many prompts each rater is sent. */
  sections: number;
  ok: boolean;
  fits: Array<RaterLimit & { fits: boolean }>;
  /** Plain-words explanation when it is not ok. */
  problem?: string;
}

/**
 * Checks, before anything is sent, that enough raters can take the prompt. Raters without a known limit are
 * assumed to fit. A scorecard with no rater dimensions sends no prompt, so it always passes.
 */
export function preflight(input: {
  scorecard: Scorecard;
  wb: WorkbookModel;
  sources: string;
  instructions?: string;
  raters: RaterLimit[];
}): PreflightResult {
  const limits = input.raters.map((r) => r.maxInputTokens).filter((n): n is number => n !== undefined);
  const prompts = buildAllRaterPrompts({ ...input, ...(limits.length > 0 ? { limit: Math.min(...limits) } : {}) });
  if (prompts.every((p) => p.prompt.rated.length === 0)) return { tokens: 0, sections: 0, ok: true, fits: input.raters.map((r) => ({ ...r, fits: true })) };

  const sizes = prompts.map((p) => ({ label: p.label, tokens: estimateTokens(RATER_SYSTEM) + estimateTokens(p.prompt.user) }));
  const tokens = Math.max(...sizes.map((x) => x.tokens));
  const sections = sizes.length;
  const canTake = (rater: RaterLimit, size: number) =>
    [rater.maxInputTokens, ...(rater.fallbackLimits ?? [])].some((limit) => limit === undefined || size <= limit);

  // Every section needs enough raters able to take it; a rater that misses one section can still score the others.
  const fits = input.raters.map((r) => ({ ...r, fits: sizes.every((x) => canTake(r, x.tokens)) }));
  const tooBig = sizes.filter((x) => input.raters.filter((r) => canTake(r, x.tokens)).length < MIN_RATERS);
  if (tooBig.length === 0) return { tokens, sections, ok: true, fits };

  const worst = tooBig.reduce((a, b) => (b.tokens > a.tokens ? b : a));
  const count = input.raters.filter((r) => canTake(r, worst.tokens)).length;
  const blocked = input.raters
    .filter((r) => !canTake(r, worst.tokens))
    .map((r) => `${r.id} (${r.model}, limit ${r.maxInputTokens!.toLocaleString('en-US')}${r.fallbackLimits?.length ? ', and its fallbacks too' : ''})`)
    .join(', ');
  return {
    tokens,
    sections,
    ok: false,
    fits,
    problem:
      `This evaluation sends about ${worst.tokens.toLocaleString('en-US')} tokens to each rater${sections > 1 ? ` in ${worst.label}` : ''}, but only ${count} of ${fits.length} raters can take that: ` +
      `${blocked} cannot. At least ${MIN_RATERS} are needed for the result to mean anything. ` +
      'To fix it: (1) add a "reads" list to each rater dimension, such as Tree[Path id|Name|Definition], so each section sends only what it needs, ' +
      '(2) add a "columns" list to the scorecard\'s sheets, (3) give a rater a model or plan with a larger limit (then raise or remove its maxInputTokens in server/config/models.json).',
  };
}
