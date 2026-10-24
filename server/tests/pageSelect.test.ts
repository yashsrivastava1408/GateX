import { describe, expect, it } from 'vitest';
import PDFDocument from 'pdfkit';
import type { Scorecard } from '@ddd/shared';
import { WorkbookModel } from '../src/excel/workbook.js';
import { addRelevantPages } from '../src/excel/pageSelect.js';

function makePdf(pages: string[]): Promise<Buffer> {
  const doc = new PDFDocument();
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  pages.forEach((text, i) => {
    if (i > 0) doc.addPage();
    doc.text(text);
  });
  doc.end();
  return done;
}

const card = (reads: string[] | undefined, measuredBy: 'raters' | 'human' = 'raters'): Scorecard => ({
  id: 'S', name: 's', version: '1', gate: 'D1', frozen: true, thresholds: { accept: 90, refine: 75 },
  artifact: { sheets: [{ name: 'Page 1', headerRow: 1 }, { name: 'Page 2', headerRow: 1 }, { name: 'Page 3', headerRow: 1 }, { name: 'Page 4', headerRow: 1 }], context: [] },
  dimensions: [{ id: 'D1', name: 'Handling of unknown values', description: 'unknown value states', weight: 10, critical: false, measuredBy, reads }],
});

describe('addRelevantPages', () => {
  it('adds the pages whose text matches the question, keeps the named ones, and is repeatable', async () => {
    const wb = await WorkbookModel.load(await makePdf(['cover title', 'unknown value state unknown handling', 'colours and fonts', 'unknown values appear once']));
    const first = addRelevantPages(card(['Page 1']), wb, 2);
    expect(first.dimensions[0]!.reads).toEqual(['Page 1', 'Page 2', 'Page 4']);
    expect(addRelevantPages(card(['Page 1']), wb, 2)).toEqual(first);
  });

  it('leaves questions with no reads, and people-judged ones, alone', async () => {
    const wb = await WorkbookModel.load(await makePdf(['unknown value', 'x', 'y', 'z']));
    expect(addRelevantPages(card(undefined), wb).dimensions[0]!.reads).toBeUndefined();
    expect(addRelevantPages(card(['Page 1'], 'human'), wb).dimensions[0]!.reads).toEqual(['Page 1']);
  });
});
