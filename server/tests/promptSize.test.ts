import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { promptSizeReport } from '../scripts/promptSize.js';
import { loadAppConfig, loadModelsConfig, modelsFileFor } from '../src/config.js';
import { WorkbookModel } from '../src/excel/workbook.js';
import { ScorecardResolver } from '../src/scorecard/resolve.js';
import { CLEAN_SCORECARD_YAML, CLEAN_TREE, TALENTRA_XLSX, loadTalentraScorecard, makeWorkbook, mockModels, tempDir } from './helpers.js';

const bedrockFile = new URL('../config/models.bedrock.json', import.meta.url).pathname;

describe('prompt:size', () => {
  it('reads the roster the app would use: MODELS_CONFIG when set, the default otherwise, the mock roster in mock mode', () => {
    expect(modelsFileFor({ MODELS_CONFIG: 'server/config/models.bedrock.json' })).toBe(path.resolve(bedrockFile));
    expect(modelsFileFor({})).toMatch(/server\/config\/models\.json$/);
    expect(modelsFileFor({ MOCK_LLM: '1', MODELS_CONFIG: 'server/config/models.bedrock.json' })).toMatch(/models\.mock\.json$/);
    expect(loadAppConfig({ MODELS_CONFIG: 'server/config/models.bedrock.json' }).models.raters[2]!.model).toMatch(/^qwen\./);
  });

  it('names the config file, checks every rater and each backup against its own limit', async () => {
    const wb = await WorkbookModel.load(TALENTRA_XLSX);
    const { scorecard } = await loadTalentraScorecard();
    const roster = loadModelsConfig(bedrockFile);
    const lines = promptSizeReport({ wb, scorecard, roster, configFile: 'server/config/models.bedrock.json' }).join('\n');
    expect(lines).toContain('Can each model take it? (limits from server/config/models.bedrock.json)');
    expect(lines).toMatch(/C qwen\.qwen3-next-80b-a3b \(limit 120,000\)/);
    expect(lines).toMatch(/backup qwen\.qwen3-32b-v1:0 \(limit 32,000\)/);
    expect(lines).toMatch(/all sections together \(per rater\)/);
  });

  it('says "too big" for a limit a section is over', async () => {
    const wb = await WorkbookModel.load(TALENTRA_XLSX);
    const { scorecard } = await loadTalentraScorecard();
    const roster = mockModels();
    roster.raters[0]!.maxInputTokens = 100;
    const lines = promptSizeReport({ wb, scorecard, roster, configFile: 'x.json' });
    expect(lines.find((l) => l.includes(' A mock-mid'))).toMatch(/limit 100\):  whole workbook too big  \|  section 1 too big/);
    expect(lines.find((l) => l.includes(' B mock-lenient'))).toMatch(/section 1 fits/);
  });
});

describe('looking a scorecard up without a model call', () => {
  it('reads the app format, returns a cached conversion, and returns null (never converting) otherwise', async () => {
    let calls = 0;
    const counting = {
      provider: { name: 'fake', complete: async () => { calls += 1; throw new Error('must not be called'); } },
      model: { id: 'A', provider: 'fake', model: 'm' },
      settings: { temperature: 0, maxOutputTokens: 10 },
    };
    const resolver = new ScorecardResolver({ cacheDir: await tempDir(), candidates: () => [counting] });
    const doc = { name: 'w.xlsx', bytes: await makeWorkbook({ Tree: CLEAN_TREE }) };
    expect((await resolver.lookup({ name: 's.yaml', bytes: Buffer.from(CLEAN_SCORECARD_YAML) }, doc))!.conversion).toBeNull();
    expect(await resolver.lookup({ name: 'GS1.csv', bytes: Buffer.from('a,b') }, doc)).toBeNull();
    expect(calls).toBe(0);
  });

  it('finds a conversion another resolver saved to the same folder', async () => {
    const dir = await tempDir();
    const { MockProvider } = await import('../src/llm/mock.js');
    const deps = [{ provider: new MockProvider(0), model: { id: 'A', provider: 'mock', model: 'mock-mid' }, settings: { temperature: 0, maxOutputTokens: 100 } }];
    const doc = { name: 'w.xlsx', bytes: await makeWorkbook({ Tree: CLEAN_TREE }) };
    const source = { name: 'GS1.csv', bytes: Buffer.from('Dimension,Weight\nPurpose,100') };
    const converted = await new ScorecardResolver({ cacheDir: dir, candidates: () => deps }).resolve(source, doc);
    const found = await new ScorecardResolver({ cacheDir: dir, candidates: () => [] }).lookup(source, doc);
    expect(found!.hash).toBe(converted.hash);
    expect(found!.conversion!.cached).toBe(true);
  });
});

describe('the Bedrock roster', () => {
  it('gives rater C a same-family backup with room for the big sections, and it is approved', () => {
    const roster = loadModelsConfig(bedrockFile);
    const c = roster.raters.find((r) => r.id === 'C')!;
    expect(c.family).toBe('qwen');
    expect(c.fallbacks).toEqual([{ provider: 'bedrock', model: 'qwen.qwen3-32b-v1:0', maxInputTokens: 32000 }]);
    expect(roster.approved).toContain('bedrock:qwen.qwen3-32b-v1:0');
    expect(roster.raters.find((r) => r.id === 'A')!.fallbacks).toEqual([{ provider: 'bedrock', model: 'zai.glm-4.7' }]);
    expect(roster.raters.find((r) => r.id === 'B')!.maxInputTokens).toBe(118000);
  });
});
