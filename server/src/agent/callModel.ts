import { sha256 } from '../util/hash.js';
import { errorMessage } from '../util/errors.js';
import type { LlmProvider } from '../llm/types.js';

export interface CallSettings {
  temperature: number;
  maxOutputTokens: number;
}

export interface CallArgs<T> {
  provider: LlmProvider;
  model: string;
  system: string;
  user: string;
  settings: CallSettings;
  /** Parses and validates the raw reply; throws with a readable message when it is unusable. */
  parse(raw: string): T;
  /** How many times to ask in all (default 2). The last ask also tells the model to keep its texts short. */
  attempts?: number;
}

export interface CallResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
  raw: string;
  attempts: number;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  promptHash: string;
}

const DEFAULT_ATTEMPTS = 2;

function addTokens(total: number | null, next: number | null): number | null {
  if (next === null) return total;
  return (total ?? 0) + next;
}

/**
 * Calls a model and checks the reply. If the reply is not usable it asks again (twice at most),
 * telling the model what was wrong and, the last time, to keep every text short; after that the call is reported as failed.
 */
export async function callJsonModel<T>(args: CallArgs<T>): Promise<CallResult<T>> {
  const result: CallResult<T> = {
    ok: false,
    raw: '',
    attempts: 0,
    latencyMs: 0,
    inputTokens: null,
    outputTokens: null,
    promptHash: sha256(`${args.system}\n${args.user}`),
  };
  let problem = '';
  const maxAttempts = args.attempts ?? DEFAULT_ATTEMPTS;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    result.attempts = attempt;
    const user =
      attempt === 1
        ? args.user
        : `${args.user}\n\n<previous_reply_problem>${problem}</previous_reply_problem>\nReply again with one valid JSON object in the required shape and nothing else.${attempt === maxAttempts && attempt > 2 ? ' Keep every rationale, detail and fix to one short sentence, so the JSON stays small and easy to get right.' : ''}`;
    const started = Date.now();
    let text: string;
    try {
      const reply = await args.provider.complete({
        model: args.model,
        system: args.system,
        user,
        temperature: args.settings.temperature,
        maxOutputTokens: args.settings.maxOutputTokens,
      });
      text = reply.text;
      result.inputTokens = addTokens(result.inputTokens, reply.inputTokens);
      result.outputTokens = addTokens(result.outputTokens, reply.outputTokens);
    } catch (error) {
      // A transport error was already retried by the HTTP layer; asking again would not help.
      result.latencyMs += Date.now() - started;
      result.error = errorMessage(error);
      return result;
    }
    result.latencyMs += Date.now() - started;
    result.raw = text;

    try {
      result.value = args.parse(text);
      result.ok = true;
      return result;
    } catch (error) {
      problem = errorMessage(error);
    }
  }
  result.error = `The reply was not usable after ${maxAttempts} attempts: ${problem}`;
  return result;
}

/**
 * Some models write a text value without its opening quote: `"rationale": The artifact lacks a legend.",`. Only used after the
 * reply failed to parse as written, and only for a line that is a key followed by words (not a number, object, array, true,
 * false or null): the value is quoted, with any quotes inside it escaped.
 */
export function quoteBareValues(json: string): string {
  return json
    .split('\n')
    .map((line) => {
      const hit = /^(\s*"[^"\n]+"\s*:\s*)([A-Za-z][^\n]*)$/.exec(line);
      if (!hit || /^(?:true|false|null)\b\s*,?\s*$/.test(hit[2]!)) return line;
      const comma = /,\s*$/.test(hit[2]!) ? ',' : '';
      const value = hit[2]!.replace(/,\s*$/, '').replace(/"$/, '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `${hit[1]}"${value}"${comma}`;
    })
    .join('\n');
}

/** Pulls a JSON object out of a reply, tolerating code fences, chatter around it, and a text value missing its opening quote. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('the reply is not a JSON object');
    const body = trimmed.slice(start, end + 1);
    try {
      return JSON.parse(body);
    } catch (error) {
      try {
        return JSON.parse(quoteBareValues(body));
      } catch {
        throw new Error(`the reply is not valid JSON (${(error as Error).message})`);
      }
    }
  }
}
