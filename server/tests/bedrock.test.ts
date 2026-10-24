import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { modelsConfigSchema, loadModelsConfig, resolveModelsFile } from '../src/config.js';
import { BedrockProvider, bedrockBaseId, bedrockRegion } from '../src/llm/bedrock.js';
import { listModelsRequest, parseModelList } from '../src/llm/catalog.js';
import { createProviderFactory } from '../src/llm/registry.js';
import { inspectRoster } from '../src/llm/roster.js';
import { LlmError } from '../src/llm/types.js';

const request = { model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', system: 'sys', user: 'usr', temperature: 0, maxOutputTokens: 100 };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function scripted(responses: Response[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return responses.shift()!;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const http = (fetchImpl: typeof fetch) => ({ timeoutMs: 1000, retries: 0, fetchImpl, sleep: async () => undefined });

describe('Amazon Bedrock provider', () => {
  it('sends a Converse request with the key as a bearer token and reads text and token counts', async () => {
    const { fetchImpl, calls } = scripted([reply(200, { output: { message: { content: [{ reasoningContent: {} }, { text: '{"ok":' }, { text: 'true}' }] } }, usage: { inputTokens: 12, outputTokens: 5 } })]);
    const provider = new BedrockProvider('KEY', http(fetchImpl), 'https://bedrock-runtime.us-east-1.amazonaws.com/');
    expect(await provider.complete(request)).toEqual({ text: '{"ok":true}', inputTokens: 12, outputTokens: 5 });
    expect(calls[0]!.url).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/converse');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      system: [{ text: 'sys' }],
      messages: [{ role: 'user', content: [{ text: 'usr' }] }],
      inferenceConfig: { temperature: 0, maxTokens: 100 },
    });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer KEY');
  });

  it('fails clearly on an empty reply and on a refusal, never echoing the key', async () => {
    const { fetchImpl } = scripted([reply(200, { output: { message: { content: [] } }, stopReason: 'content_filtered' }), reply(403, { message: 'You do not have access to the model with the specified model ID.' })]);
    const provider = new BedrockProvider('SECRET', http(fetchImpl), 'https://x');
    await expect(provider.complete(request)).rejects.toThrow(/no text \(content_filtered\)/);
    const error = (await provider.complete(request).catch((e: Error) => e)) as Error;
    expect(error).toBeInstanceOf(LlmError);
    expect(error.message).toMatch(/HTTP 403: You do not have access to the model/);
    expect(error.message).not.toContain('SECRET');
  });

  it('picks the region from AWS_REGION, then the config, then us-east-1', () => {
    expect(bedrockRegion('eu-west-1', { AWS_REGION: 'ap-south-1' })).toBe('ap-south-1');
    expect(bedrockRegion('eu-west-1', {})).toBe('eu-west-1');
    expect(bedrockRegion(undefined, {})).toBe('us-east-1');
  });

  it('lists models from the control-plane host and matches inference-profile ids to base ids', () => {
    expect(listModelsRequest({ type: 'bedrock', region: 'us-west-2' }, 'K', {})).toEqual({
      url: 'https://bedrock.us-west-2.amazonaws.com/foundation-models', headers: { authorization: 'Bearer K' },
    });
    expect(parseModelList('bedrock', { modelSummaries: [{ modelId: 'meta.llama3-3-70b-instruct-v1:0' }, {}] })).toEqual(['meta.llama3-3-70b-instruct-v1:0']);
    expect(bedrockBaseId('us.meta.llama3-3-70b-instruct-v1:0')).toBe('meta.llama3-3-70b-instruct-v1:0');
    expect(bedrockBaseId('mistral.mistral-large-2402-v1:0')).toBe('mistral.mistral-large-2402-v1:0');
  });

  it('is built by the provider factory and refuses to start without a key', () => {
    const models = loadModelsConfig(new URL('../config/models.bedrock.json', import.meta.url).pathname);
    expect(createProviderFactory(models, { env: { AWS_BEARER_TOKEN_BEDROCK: 'k' } })('bedrock')).toBeInstanceOf(BedrockProvider);
    expect(() => createProviderFactory(models, { env: {} })('bedrock')).toThrow(/no API key \(AWS_BEARER_TOKEN_BEDROCK\)/);
  });
});

describe('mock mode', () => {
  it('uses the scripted models even when MODELS_CONFIG points at a live roster', async () => {
    const { loadAppConfig } = await import('../src/config.js');
    const config = loadAppConfig({ MOCK_LLM: '1', MODELS_CONFIG: 'server/config/models.bedrock.json' });
    expect(config.mock).toBe(true);
    expect(config.models.raters.every((r) => r.provider === 'mock')).toBe(true);
    expect(loadAppConfig({ MODELS_CONFIG: 'server/config/models.bedrock.json' }).models.raters[0]!.provider).toBe('bedrock');
  });
});

describe('finding the models file', () => {
  it('resolves a repository-relative path from the server folder, and leaves absolute paths alone', () => {
    const absolute = path.resolve(__dirname, '../config/models.bedrock.json');
    expect(resolveModelsFile('server/config/models.bedrock.json', {})).toBe(absolute);
    expect(resolveModelsFile('config/models.bedrock.json', {})).toBe(absolute);
    expect(resolveModelsFile(absolute, {})).toBe(absolute);
  });
});

describe('the Bedrock roster file', () => {
  const file = new URL('../config/models.bedrock.json', import.meta.url).pathname;

  it('is a valid 3 + 1 roster of four different families that is ready with one key', () => {
    const models = loadModelsConfig(file);
    expect(models.raters.map((r) => r.family)).toEqual(['zhipu', 'meta', 'qwen']);
    expect(models.consolidator.family).toBe('amazon');
    const status = inspectRoster(models, { AWS_BEARER_TOKEN_BEDROCK: 'k' });
    expect(status.problems).toEqual([]);
    expect(status.ready).toBe(true);
    expect(inspectRoster(models, {}).ready).toBe(false);
  });

  it('keeps the existing Groq and Gemini roster valid and untouched', () => {
    const existing = loadModelsConfig(new URL('../config/models.json', import.meta.url).pathname);
    expect(existing.raters.map((r) => `${r.provider}:${r.model}`)).toEqual(['groq:openai/gpt-oss-120b', 'gemini:gemini-3.5-flash', 'groq:qwen/qwen3.8-27b']);
    expect(modelsConfigSchema.safeParse(existing).success).toBe(true);
  });
});
