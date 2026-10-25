import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/agent/orchestrator.js';
import { loadModelsConfig } from '../src/config.js';
import { MockProvider } from '../src/llm/mock.js';
import type { LlmProvider, LlmRequest } from '../src/llm/types.js';
import { BedrockProvider } from '../src/llm/bedrock.js';
import { TALENTRA_XLSX, loadTalentraScorecard, mockModels } from './helpers.js';

const isRater = (r: LlmRequest) => !r.system.includes('You are the consolidator') && !r.system.includes('SCORECARD_IMPORT') && !r.system.includes('You check claims');

async function temperatures(settings: Record<string, unknown>) {
  const models = mockModels(['mock-low', 'mock-lenient', 'mock-strict']);
  models.settings = { ...models.settings, repeats: 3, ...settings } as typeof models.settings;
  const parsed = await loadTalentraScorecard();
  const mock = new MockProvider(0);
  const seen: Array<{ rater: boolean; temperature: number }> = [];
  const provider: LlmProvider = { name: 'mock', complete: async (request) => (seen.push({ rater: isRater(request), temperature: request.temperature }), mock.complete(request)) };
  const out = await evaluate({ runId: 'r', projectName: 'p', iteration: 1, workbookPath: TALENTRA_XLSX, artifactName: 'a.xlsx', scorecard: parsed.scorecard, scorecardHash: parsed.hash, sources: '', models, providers: () => provider, env: {} });
  return { seen, out };
}

describe('temperature', () => {
  it('asks every model call at temperature 0 by default, repeats included (the examiners, the final reviewer and every check)', async () => {
    const { seen, out } = await temperatures({});
    expect(seen.length).toBeGreaterThan(9);
    expect(seen.filter((c) => c.rater).length).toBeGreaterThan(3);
    expect(new Set(seen.map((c) => c.temperature))).toEqual(new Set([0]));
    expect(out.runLog.settings.temperature).toBe(0);
    expect(out.runLog.settings.repeatTemperature).toBeUndefined();
  });

  it('uses repeatTemperature for the examiners\' repeat answers only, and records it', async () => {
    const { seen, out } = await temperatures({ repeatTemperature: 0.4 });
    const raterTemps = seen.filter((c) => c.rater).map((c) => c.temperature);
    expect(raterTemps.slice(0, 3)).toEqual([0, 0, 0]); // the first answers
    expect(raterTemps.filter((t) => t === 0.4).length).toBeGreaterThan(0);
    expect(seen.filter((c) => !c.rater).every((c) => c.temperature === 0)).toBe(true);
    expect(out.runLog.settings.repeatTemperature).toBe(0.4);
  });

  it('is 0 in every shipped models file, with no repeat temperature', () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../config');
    const files = readdirSync(dir).filter((f) => /^models.*\.json$/.test(f));
    expect(files.length).toBeGreaterThan(2);
    for (const file of files) {
      const config = loadModelsConfig(path.join(dir, file));
      expect(config.settings.temperature, file).toBe(0);
      expect(config.settings.repeatTemperature, file).toBeUndefined();
      expect(JSON.parse(readFileSync(path.join(dir, file), 'utf8')).settings?.temperature ?? 0, file).toBe(0);
    }
  });

  it('sends the temperature to Bedrock\'s Converse call as it was asked', async () => {
    const bodies: Array<{ inferenceConfig: { temperature: number } }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      bodies.push(JSON.parse(init?.body ?? '{}'));
      return new Response(JSON.stringify({ output: { message: { content: [{ text: 'ok' }] } }, usage: { inputTokens: 1, outputTokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const provider = new BedrockProvider('key', { timeoutMs: 1000, retries: 0 } as never, 'https://bedrock.example');
      await provider.complete({ model: 'zai.glm-5', system: 's', user: 'u', temperature: 0, maxOutputTokens: 10 });
      expect(bodies[0]!.inferenceConfig.temperature).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
