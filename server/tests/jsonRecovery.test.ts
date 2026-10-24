import { describe, expect, it } from 'vitest';
import { STRICT_JSON_RULES, JsonSyntaxError, callJsonModel, extractJson, repairListPunctuation } from '../src/agent/callModel.js';
import type { LlmProvider, LlmRequest } from '../src/llm/types.js';
import { raterReplySchema } from '../src/agent/raterSchema.js';
import { TALENTRA_XLSX, mockModels, runEvaluation } from './helpers.js';

/**
 * Broken replies shaped like the ones in the logs of the live runs (data/live-v32-run1/run-log.json and data/live-v32-run2/run-log.json):
 *   1. GLM-5 wrote a rationale without its opening quote: `Unexpected token 'O', ..."tionale": Only the c"... is not valid JSON`.
 *   2. A review batch failed with `Expected ',' or ']' after array element in JSON at position 7816 (line 210 column 6)`:
 *      two objects of a list with no comma between them.
 * Only the error messages were kept in those logs, so the replies below are rebuilt to fail with the same message.
 */
const bareRationale = `{
  "dimensions": [
    {
      "id": "G03",
      "score": 3,
      "rationale": Only the checked columns are filled; the rest is blank.",
      "not_measurable": false,
      "evidence": [{ "sheet": "Actor_Register", "cell": "D5", "quote": "ACT-01" }]
    }
  ],
  "findings": [],
  "strengths": []
}`;

const missingCommaBetweenFindings = `{
  "dimensions": [{ "id": "G09", "score": 2, "rationale": "Object-level only.", "evidence": [{ "sheet": "Permission_Matrix", "cell": "G5" }] }],
  "findings": [
    {
      "dimension": "G09",
      "severity": "HIGH",
      "title": "No field-level visibility",
      "detail": "Permission_Matrix lists objects only.",
      "location": { "sheet": "Permission_Matrix", "cell": "G5" },
      "fix": "Add masked and hidden field lists."
    }
    {
      "dimension": "G09",
      "severity": "LOW",
      "title": "Scope wording",
      "detail": "Scope names differ.",
      "location": { "sheet": "Permission_Matrix", "cell": "A4" },
      "fix": "Use one wording."
    }
  ],
  "strengths": []
}`;

const trailingCommas = `{
  "dimensions": [
    { "id": "G01", "score": 4, "rationale": "Clear.", "evidence": [{ "sheet": "README", "cell": "A6" },], },
  ],
  "findings": [],
}`;

const cutOff = `{
  "dimensions": [
    { "id": "G01", "score": 4, "rationale": "Clear and complete, with the purpose stated in C6 and the non-goals in A9, and every co`;

describe('reading broken JSON from an examiner', () => {
  it('repairs a rationale that lost its opening quote (the GLM-5 failure in the logs)', () => {
    const value = raterReplySchema.parse(extractJson(bareRationale));
    expect(value.dimensions).toHaveLength(1);
    expect((value.dimensions[0] as { rationale: string }).rationale).toBe('Only the checked columns are filled; the rest is blank.');
  });

  it('repairs a comma missing between two findings (the review-batch failure in the logs)', () => {
    expect(() => JSON.parse(missingCommaBetweenFindings)).toThrow(/Expected ',' or '\]' after array element/);
    const value = raterReplySchema.parse(extractJson(missingCommaBetweenFindings));
    expect(value.findings).toHaveLength(2);
  });

  it('repairs commas left after the last item', () => {
    const value = raterReplySchema.parse(extractJson(trailingCommas));
    expect(value.dimensions).toHaveLength(1);
  });

  it('never touches punctuation inside a text value', () => {
    const tricky = '{\n  "a": "x },\\n { y",\n  "b": [1,\n 2]\n}';
    expect(repairListPunctuation(tricky)).toBe(tricky);
    expect(extractJson('{\n "a": "ends with , ]",\n "b": 1,\n}')).toEqual({ a: 'ends with , ]', b: 1 });
  });

  it('does not guess at a reply that was cut off: that is a syntax failure, so the section is asked again', () => {
    expect(() => extractJson(cutOff)).toThrow(JsonSyntaxError);
    expect(() => extractJson('I think the schema is fine overall.')).toThrow(JsonSyntaxError);
  });
});

function scripted(replies: string[]): LlmProvider & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    name: 'scripted',
    requests,
    async complete(request) {
      requests.push(request);
      return { text: replies[Math.min(requests.length - 1, replies.length - 1)]!, inputTokens: 10, outputTokens: 5 };
    },
  };
}
const ask = (provider: LlmProvider, extra: { attempts?: number; syntaxRetries?: number } = {}) =>
  callJsonModel({
    provider,
    model: 'm',
    system: 'SYSTEM',
    user: 'USER',
    settings: { temperature: 0, maxOutputTokens: 100 },
    parse: (raw) => raterReplySchema.parse(extractJson(raw)),
    ...extra,
  });

describe('asking again after a broken reply', () => {
  it('retries once with strict JSON-only rules, and the retry succeeds', async () => {
    const provider = scripted([cutOff, '{"dimensions": [], "findings": [], "strengths": []}']);
    const call = await ask(provider, { attempts: 3, syntaxRetries: 1 });
    expect(call.ok).toBe(true);
    expect(call.attempts).toBe(2);
    expect(provider.requests[0]!.system).toBe('SYSTEM');
    expect(provider.requests[1]!.system).toBe(`SYSTEM\n\n${STRICT_JSON_RULES}`);
    expect(provider.requests[1]!.user).toContain('previous_reply_problem');
  });

  it('gives up after that one strict retry, so the caller can use the next model', async () => {
    const provider = scripted([cutOff]);
    const call = await ask(provider, { attempts: 3, syntaxRetries: 1 });
    expect(call.ok).toBe(false);
    expect(call.attempts).toBe(2);
    expect(provider.requests).toHaveLength(2);
    expect(call.error).toMatch(/after 2 attempts.*not a JSON object/);
  });

  it('still uses every attempt for a reply that is JSON but in the wrong shape, without the strict rules', async () => {
    const provider = scripted(['{"nothing": true}', '{"nothing": true}', '{"dimensions": []}']);
    const call = await ask(provider, { attempts: 3, syntaxRetries: 1 });
    expect(call.ok).toBe(true);
    expect(call.attempts).toBe(3);
    expect(provider.requests.every((r) => r.system === 'SYSTEM')).toBe(true);
  });

  it('keeps asking as before when no syntax limit is set', async () => {
    const provider = scripted([cutOff]);
    const call = await ask(provider, { attempts: 3 });
    expect(call.attempts).toBe(3);
  });
});

describe('a section whose examiner keeps breaking its JSON', () => {
  it('moves to the next model of the same examiner and scores the section', async () => {
    const models = mockModels(['mock-mid', 'mock-garbage', 'mock-strict']);
    models.raters[1]!.fallbacks = [{ provider: 'mock', model: 'mock-lenient' }];
    const run = await runEvaluation({ workbook: TALENTRA_XLSX, models });
    const garbage = run.calls.find((c) => c.model.model === 'mock-garbage');
    // The broken model was tried twice (the second time with the strict rules) and the fallback answered in its place.
    expect(garbage).toBeUndefined();
    expect(run.core.header.raters.map((r) => r.model)).toEqual(['mock-mid', 'mock-lenient', 'mock-strict']);
    expect(run.core.dimensions.find((d) => d.id === 'J01')!.raterScores).toEqual({ A: 4, B: 5, C: 3 });
    expect(run.core.notes.join(' ')).toMatch(/Rater B: mock-garbage: .*not a JSON object.*mock-lenient answered instead/);
  });
});
