/** Preflight: says in plain words whether this machine is ready to run GateX.   npm run doctor   (exit 1 if something needs fixing) */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDoctor, readEnvFile, runDoctor } from '../src/util/doctor.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const items = await runDoctor({
  env: process.env,
  nodeVersion: process.version,
  envFileText: readEnvFile(path.join(root, '.env')),
  dataDir: path.resolve(process.env.DATA_DIR ?? path.join(root, 'data')),
});
const { text, ok } = renderDoctor(items);
console.log(`\nGateX doctor\n\n${text}\n`);
process.exit(ok ? 0 : 1);
