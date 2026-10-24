import type { DimensionSpec, ModelRef, ReturnTo } from '@ddd/shared';
import type { WorkbookModel } from '../excel/workbook.js';
import type { LlmProvider } from '../llm/types.js';
import { RATER_SYSTEM } from './prompts/rater.js';
import { callJsonModel, extractJson, type CallSettings } from './callModel.js';
import { validateCitations } from './evidence.js';
import {
  findingSchema,
  raterDimensionSchema,
  raterReplySchema,
  strengthSchema,
} from './raterSchema.js';
import type { Discarded, RaterDimension, RaterFinding, RaterOutcome, RaterStrength } from './types.js';

export interface RunRaterArgs {
  model: ModelRef;
  provider: LlmProvider;
  user: string;
  expected: DimensionSpec[];
  wb: WorkbookModel;
  allowedSheets: ReadonlySet<string>;
  defaultReturnTo: ReturnTo;
  settings: CallSettings;
  maxInputTokens?: number;
}

/**
 * About 2.7 characters to a token. The cell-address text we send (`H5="..."`) is token-heavy: Groq counted 18,336 and 21,482
 * tokens for a prompt of 53,700 characters. Four characters per token, which suits plain prose, under-counted it by a third or more.
 */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 2.7);

/** A reply this short cannot hold the JSON for even a few questions, so a model with less room than this is not asked at all. */
const MIN_OUTPUT_TOKENS = 2048;
/** The estimate runs low (see above), so the prompt is counted ten percent heavier when working out what room is left for the answer. */
const ESTIMATE_MARGIN = 1.1;

/**
 * Models with a small window share it between the prompt and the answer: Qwen3-32B's 32,768 tokens were over by one when a 24,577-token
 * prompt asked for 8,192 back. `limit` is the model's window (its maxInputTokens in the config). Returns how many tokens the answer may use,
 * at most `wanted`, or null when too little room is left for a usable answer.
 */
export function outputBudget(limit: number | undefined, estimatedInput: number, wanted: number): number | null {
  if (!limit) return wanted;
  const room = Math.floor(limit - estimatedInput * ESTIMATE_MARGIN);
  if (room < MIN_OUTPUT_TOKENS) return null;
  return Math.min(wanted, room);
}

type RawReply = ReturnType<typeof raterReplySchema.parse>;

function parseReply(raw: string): RawReply {
  const result = raterReplySchema.safeParse(extractJson(raw));
  if (!result.success) {
    throw new Error('the JSON does not have a "dimensions" list in the required shape');
  }
  return result.data;
}

/**
 * Runs one rater, then keeps only what is supported: a score needs a valid integer
 * and at least one citation that really exists. Everything else is discarded and logged.
 */
export async function runRater(args: RunRaterArgs): Promise<RaterOutcome> {
  const estimated = estimateTokens(RATER_SYSTEM) + estimateTokens(args.user);
  const outputTokens = outputBudget(args.maxInputTokens, estimated, args.settings.maxOutputTokens);
  if (args.maxInputTokens && (estimated > args.maxInputTokens || outputTokens === null)) {
    return {
      model: args.model,
      role: 'rater',
      status: 'failed',
      prompt: args.user,
      promptHash: '',
      rawResponse: '',
      attempts: 0,
      latencyMs: 0,
      inputTokens: null,
      outputTokens: null,
      error: `The prompt is about ${estimated} tokens, over the ${args.maxInputTokens} limit set for ${args.model.model}. ${estimated > args.maxInputTokens ? '' : 'That leaves too little room in its window for an answer. '}Add a "columns" list to the scorecard's sheets so raters see only what they need, or raise maxInputTokens.`,
      dimensions: [],
      findings: [],
      strengths: [],
      discarded: [],
    };
  }
  const call = await callJsonModel({
    provider: args.provider,
    model: args.model.model,
    system: RATER_SYSTEM,
    user: args.user,
    settings: { ...args.settings, maxOutputTokens: outputTokens ?? args.settings.maxOutputTokens },
    parse: parseReply,
    // Examiners write long JSON and now and then break it. A reply that is not JSON is asked again once with strict JSON-only rules; if that
    // is broken too, this model is given up on for the section and the next one in line (its fallback) takes it. A reply that is JSON in the
    // wrong shape gets the extra ask (with a nudge to be brief).
    attempts: 3,
    syntaxRetries: 1,
  });

  const outcome: RaterOutcome = {
    model: args.model,
    role: 'rater',
    status: call.ok ? 'ok' : 'failed',
    prompt: args.user,
    promptHash: call.promptHash,
    rawResponse: call.raw,
    attempts: call.attempts,
    latencyMs: call.latencyMs,
    inputTokens: call.inputTokens,
    outputTokens: call.outputTokens,
    error: call.error,
    dimensions: [],
    findings: [],
    strengths: [],
    discarded: [],
  };
  if (!call.ok || !call.value) return outcome;

  outcome.dimensions = validateDimensions(args, call.value, outcome.discarded);
  outcome.findings = validateFindings(args, call.value, outcome.discarded);
  outcome.strengths = validateStrengths(args, call.value, outcome.discarded);
  return outcome;
}

function validateDimensions(args: RunRaterArgs, reply: RawReply, discarded: Discarded[]): RaterDimension[] {
  const byId = new Map<string, ReturnType<typeof raterDimensionSchema.parse>>();
  for (const item of reply.dimensions) {
    const parsed = raterDimensionSchema.safeParse(item);
    if (parsed.success) byId.set(parsed.data.id.trim().toLowerCase(), parsed.data);
    else discarded.push({ kind: 'dimension', reason: 'a dimension entry was malformed' });
  }

  return args.expected.map((spec): RaterDimension => {
    const empty = { id: spec.id, score: null, notMeasurable: false, rationale: '', evidence: [] };
    const given = byId.get(spec.id.toLowerCase());
    if (!given) {
      discarded.push({ kind: 'dimension', id: spec.id, reason: 'the rater did not score this dimension' });
      return empty;
    }
    if (given.not_measurable) {
      return { ...empty, notMeasurable: true, rationale: given.rationale };
    }
    const score = given.score;
    if (score === null || !Number.isInteger(score) || score < 0 || score > 5) {
      discarded.push({ kind: 'dimension', id: spec.id, reason: `score "${String(score)}" is not an integer from 0 to 5` });
      return { ...empty, rationale: given.rationale };
    }
    const { valid, reasons } = validateCitations(args.wb, args.allowedSheets, given.evidence);
    if (valid.length === 0) {
      const why = reasons[0] ?? 'no evidence was cited';
      discarded.push({ kind: 'dimension', id: spec.id, reason: `score ${score} discarded, no supported evidence (${why})` });
      return { ...empty, rationale: given.rationale };
    }
    return {
      id: spec.id,
      score,
      notMeasurable: false,
      anchor: given.anchor ?? undefined,
      rationale: given.rationale,
      evidence: valid,
    };
  });
}

function validateFindings(args: RunRaterArgs, reply: RawReply, discarded: Discarded[]): RaterFinding[] {
  const known = new Set(args.expected.map((d) => d.id.toLowerCase()));
  const out: RaterFinding[] = [];
  for (const item of reply.findings) {
    const parsed = findingSchema.safeParse(item);
    if (!parsed.success) {
      discarded.push({ kind: 'finding', reason: 'a finding was malformed' });
      continue;
    }
    const finding = parsed.data;
    const dimension = args.expected.find((d) => d.id.toLowerCase() === finding.dimension.trim().toLowerCase());
    if (!dimension || !known.has(dimension.id.toLowerCase())) {
      discarded.push({ kind: 'finding', id: finding.title, reason: `unknown dimension "${finding.dimension}"` });
      continue;
    }
    if (!finding.location) {
      discarded.push({ kind: 'finding', id: finding.title, reason: 'no location was cited' });
      continue;
    }
    const { valid, reasons } = validateCitations(args.wb, args.allowedSheets, [finding.location]);
    if (valid.length === 0) {
      discarded.push({ kind: 'finding', id: finding.title, reason: reasons[0] ?? 'unsupported location' });
      continue;
    }
    out.push({
      ref: `${args.model.id}${out.length + 1}`,
      raterId: args.model.id,
      dimensionId: dimension.id,
      severity: finding.severity,
      title: finding.title,
      detail: finding.detail,
      fix: finding.fix,
      returnTo: finding.return_to ?? dimension.returnTo ?? args.defaultReturnTo,
      location: { sheet: valid[0]!.sheet, cell: valid[0]!.cell },
    });
  }
  return out;
}

function validateStrengths(args: RunRaterArgs, reply: RawReply, discarded: Discarded[]): RaterStrength[] {
  const out: RaterStrength[] = [];
  for (const item of reply.strengths) {
    const parsed = strengthSchema.safeParse(item);
    const dimension = parsed.success
      ? args.expected.find((d) => d.id.toLowerCase() === parsed.data.dimension.trim().toLowerCase())
      : undefined;
    if (!parsed.success || !dimension) {
      discarded.push({ kind: 'strength', reason: 'a strength was malformed or named an unknown dimension' });
      continue;
    }
    let location = null;
    if (parsed.data.location) {
      const { valid } = validateCitations(args.wb, args.allowedSheets, [parsed.data.location]);
      if (valid[0]) location = { sheet: valid[0].sheet, cell: valid[0].cell };
    }
    if (!location) {
      discarded.push({ kind: 'strength', reason: 'a strength cited no supported location' });
      continue;
    }
    out.push({ raterId: args.model.id, dimensionId: dimension.id, text: parsed.data.text, location });
  }
  return out;
}
