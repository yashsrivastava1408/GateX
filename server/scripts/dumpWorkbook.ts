import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { columnLetters } from '../src/excel/workbook.js';
import { readXlsx } from '../src/excel/xlsxReader.js';

/**
 * Writes a workbook as plain text, one file per sheet, one line per row (`A5=value | B5=value`). A reviewer who cannot open Excel can then
 * search and read the real cells.   npm run dump -- --workbook <file.xlsx> --out <folder>
 */
const { values } = parseArgs({ options: { workbook: { type: 'string' }, out: { type: 'string' } } });
if (!values.workbook || !values.out) {
  console.log('Usage: npm run dump -- --workbook <file.xlsx> --out <folder>');
  process.exit(1);
}
const base = process.env.INIT_CWD ?? process.cwd();
const out = path.resolve(base, values.out);
mkdirSync(out, { recursive: true });
const sheets = readXlsx(new Uint8Array(readFileSync(path.resolve(base, values.workbook))));
for (const [name, grid] of sheets) {
  const lines: string[] = [];
  for (let r = 1; r <= grid.maxRow; r++) {
    const parts: string[] = [];
    for (let c = 1; c <= grid.maxCol; c++) {
      const v = grid.cells.get(`${columnLetters(c)}${r}`);
      if (v) parts.push(`${columnLetters(c)}${r}=${v.replace(/\n/g, ' ⏎ ')}`);
    }
    if (parts.length) lines.push(parts.join(' | '));
  }
  writeFileSync(path.join(out, `${name.replace(/[\\/]/g, '_')}.txt`), lines.join('\n'));
}
console.log(`${sheets.size} sheets written to ${out}`);
