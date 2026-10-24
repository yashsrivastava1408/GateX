import { readFile } from 'node:fs/promises';
import { WorkbookModel } from '../src/excel/workbook.js';
import { sweepAll as sweepWorkbook } from '../src/agent/sweep.js';
for (const f of process.argv.slice(2)) {
  const wb = await WorkbookModel.load(await readFile(f));
  const t = Date.now(); const found = sweepWorkbook(wb, { all: true });
  const by: Record<string, number> = {}; for (const x of found) by[x.kind] = (by[x.kind] ?? 0) + 1;
  console.log(`\n${f.split('/').slice(-2).join('/')}: ${found.length} findings in ${Date.now() - t}ms ${JSON.stringify(by)}`);
  for (const x of found.slice(0, 14)) console.log(`   ${x.kind.padEnd(18)} ${x.location.sheet}!${x.location.cell}  ${x.detail.slice(0, 150)}`);
}
