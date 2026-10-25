import { describe, expect, it } from 'vitest';
import { loadModelsConfig, modelsFileFor } from '../src/config.js';
import { envKeyNames, renderDoctor, runDoctor } from '../src/util/doctor.js';
import { tempDir } from './helpers.js';

const base = async () => ({ nodeVersion: 'v22.1.0', dataDir: await tempDir(), envFileText: 'GROQ_API_KEY=abc\n# note\nexport DATABASE_URL=x\n' });
const mockEnv = { MOCK_LLM: '1' } as NodeJS.ProcessEnv;

describe('npm run doctor', () => {
  it('reads only key names from .env', () => {
    expect(envKeyNames('A=1\n#B=2\n export C = 3\nnot a line')).toEqual(['A', 'C']);
  });

  it('passes on the mock roster with a good Node, and warns about the missing database', async () => {
    const items = await runDoctor({ ...(await base()), env: mockEnv });
    const out = renderDoctor(items);
    expect(out.ok).toBe(true);
    expect(out.text).toMatch(/OK +Node v22\.1\.0/);
    expect(out.text).toMatch(/CHECK +No database set/);
  });

  it('says what to fix: old Node, a missing key, an unreadable models file, a dead database', async () => {
    const old = renderDoctor(await runDoctor({ ...(await base()), nodeVersion: 'v18.0.0', env: mockEnv }));
    expect(old.ok).toBe(false);
    expect(old.text).toMatch(/NEEDS FIX +Node v18/);

    const live = { MODELS_CONFIG: modelsFileFor({}), DATABASE_URL: 'postgres://u:secretpw@h/d' } as NodeJS.ProcessEnv;
    const noKeys = renderDoctor(await runDoctor({ ...(await base()), env: live, pingDb: async () => { throw Object.assign(new Error('boom secretpw'), { code: 'ECONNREFUSED' }); } }));
    expect(noKeys.ok).toBe(false);
    expect(noKeys.text).toMatch(/Key GROQ_API_KEY is missing/);
    expect(noKeys.text).toMatch(/Database does not answer \(ECONNREFUSED\)/);
    expect(noKeys.text).not.toMatch(/secretpw/);

    const broken = renderDoctor(await runDoctor({ ...(await base()), env: mockEnv, loadModels: () => { throw new Error('Invalid models config'); } }));
    expect(broken.ok).toBe(false);
    expect(broken.text).toMatch(/Models file could not be read/);
  });

  it('never prints a key value', async () => {
    const env = { GROQ_API_KEY: 'sk-supersecret', GEMINI_API_KEY: 'sk-other', DATABASE_URL: 'postgres://u:pw@h/d' } as NodeJS.ProcessEnv;
    const out = renderDoctor(await runDoctor({ ...(await base()), env: { ...env, MODELS_CONFIG: modelsFileFor({}) }, pingDb: async () => undefined })).text;
    expect(out).not.toMatch(/supersecret|sk-other|pw@/);
    expect(out).toMatch(/Key GROQ_API_KEY is set/);
    expect(out).toMatch(/Database answers/);
    void loadModelsConfig;
  });
});
