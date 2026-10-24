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
  /**
   * When set, a reply that is not valid JSON (as opposed to valid JSON in the wrong shape) is asked again at most this many times, with the
   * stricter JSON-only rules, and then the call gives up so the caller can hand the section to the next model. Unset: any failure may use all the attempts.
   */
  syntaxRetries?: number;
}

/** A reply that is not JSON at all or is broken JSON, as opposed to JSON in the wrong shape. */
export class JsonSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonSyntaxError';
  }
}

/**
 * Added to the system prompt when a reply could not be read as JSON, so the second ask is stricter than the first. The failures seen in real
 * runs were a text value missing its opening quote, a missing comma between two objects, and a reply cut off in the middle.
 */
export const STRICT_JSON_RULES = [
  'STRICT OUTPUT RULES (your last reply could not be read as JSON):',
  '- Reply with ONE JSON object and nothing else: no words before or after it, no markdown, no code fence.',
  '- Every key and every text value is in double quotes. A quote inside a text is written \\". A line break inside a text is written \\n.',
  '- Put a comma between items of a list and between fields, and no comma after the last one.',
  '- Keep every rationale, detail and fix to one short sentence so the reply is complete and never cut off.',
].join('\n');

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
  let brokenJson = false;
  let syntaxFailures = 0;
  const maxAttempts = args.attempts ?? DEFAULT_ATTEMPTS;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    result.attempts = attempt;
    const strict = attempt > 1 && brokenJson;
    const system = strict ? `${args.system}\n\n${STRICT_JSON_RULES}` : args.system;
    const user =
      attempt === 1
        ? args.user
        : `${args.user}\n\n<previous_reply_problem>${problem}</previous_reply_problem>\nReply again with one valid JSON object in the required shape and nothing else.${attempt === maxAttempts && attempt > 2 ? ' Keep every rationale, detail and fix to one short sentence, so the JSON stays small and easy to get right.' : ''}`;
    const started = Date.now();
    let text: string;
    try {
      const reply = await args.provider.complete({
        model: args.model,
        system,
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
      brokenJson = error instanceof JsonSyntaxError;
      if (brokenJson) syntaxFailures++;
      // Asked once more with the strict rules; a second broken reply means this model cannot do the section, so the caller moves on.
      if (brokenJson && args.syntaxRetries !== undefined && syntaxFailures > args.syntaxRetries) break;
    }
  }
  result.error = `The reply was not usable after ${result.attempts} attempt${result.attempts === 1 ? '' : 's'}: ${problem}`;
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

/**
 * Fixes the two punctuation slips models make between items, outside text values: a comma missing between two objects or two fields that sit on
 * separate lines (`}` then `{`, or a value then a new `"key":`), and a comma left after the last item (`,]` or `,}`). Walks the text
 * once and tracks whether it is inside a string, so nothing inside a text value is touched.
 */
export function repairListPunctuation(json: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  let lastSignificant = '';
  let pendingWhitespace = '';
  for (let i = 0; i < json.length; i++) {
    const ch = json[i]!;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') { inString = false; lastSignificant = '"'; }
      continue;
    }
    if (/\s/.test(ch)) { pendingWhitespace += ch; continue; }
    // Something that starts a new item right after something that ended one, with no comma between.
    const startsItem = ch === '{' || ch === '"' || ch === '[';
    const endedItem = lastSignificant === '}' || lastSignificant === ']' || lastSignificant === '"' || /[0-9el]/.test(lastSignificant);
    if (startsItem && endedItem && (pendingWhitespace.includes('\n') || (lastSignificant === '}' && ch === '{'))) out += ',';
    // A comma just before a closing bracket.
    if ((ch === '}' || ch === ']') && lastSignificant === ',') out = out.replace(/,(\s*)$/, '$1');
    out += pendingWhitespace + ch;
    pendingWhitespace = '';
    if (ch === '"') inString = true;
    else lastSignificant = ch;
  }
  return out + pendingWhitespace;
}

/** Pulls a JSON object out of a reply, tolerating code fences, chatter around it, and a text value missing its opening quote. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) throw new JsonSyntaxError('the reply is not a JSON object');
    const body = trimmed.slice(start, end + 1);
    try {
      return JSON.parse(body);
    } catch (error) {
      for (const repair of [quoteBareValues, repairListPunctuation, (t: string) => repairListPunctuation(quoteBareValues(t))]) {
        try {
          return JSON.parse(repair(body));
        } catch {
          // try the next repair
        }
      }
      throw new JsonSyntaxError(`the reply is not valid JSON (${(error as Error).message})`);
    }
  }
}
