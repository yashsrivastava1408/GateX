import { describe, expect, it } from 'vitest';
import PDFDocument from 'pdfkit';
import { WorkbookModel } from '../src/excel/workbook.js';
import { serializeSheets } from '../src/excel/serialize.js';
import { expandPageRange, resolvePageRanges } from '../src/excel/pageRanges.js';
import { parseScorecard } from '../src/scorecard/parse.js';
import { planSections } from '../src/agent/sectionPlanner.js';

function makePdf(pages: string[][]): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  pages.forEach((lines, i) => {
    if (i > 0) doc.addPage();
    doc.fontSize(11);
    for (const line of lines) doc.text(line);
  });
  doc.end();
  return done;
}

const CARD = `
scorecard:
  id: SC-PDF
  name: pdf
  version: "1"
  judges: D1 schema design
  step: "1"
  frozen: true
  thresholds: { accept: 90, refine: 75 }
  artifact:
    sheets: [{ name: "Page 1-4", header_row: 1 }]
  dimensions:
    - id: P01
      name: First
      weight: 50
      measured_by: raters
      reads: ["Page 1-2"]
      measure: m
      anchors: { 5: a, 4: b, 3: c, 2: d, 1: e, 0: f }
    - id: P02
      name: Second
      weight: 50
      measured_by: raters
      reads: ["Page 3-4"]
      measure: m
      anchors: { 5: a, 4: b, 3: c, 2: d, 1: e, 0: f }
`;

describe('reading a PDF as a workbook', () => {
  it('makes one sheet per page and one cell per line, so evidence can cite Page n!An', async () => {
    const bytes = await makePdf([['Alpha line', 'Beta line'], ['Gamma line'], [], ['Delta line']]);
    const wb = await WorkbookModel.load(bytes);
    expect(wb.sheetNames()).toEqual(['Page 1', 'Page 2', 'Page 3', 'Page 4']);
    expect(wb.cellText('Page 1', 'A1')).toBe('Alpha line');
    expect(wb.cellText('Page 1', 'A2')).toBe('Beta line');
    expect(wb.cellText('Page 2', 'A1')).toBe('Gamma line');
    expect(wb.inBounds('Page 1', 'A2')).toBe(true);
    expect(serializeSheets(wb, ['Page 1'])).toContain('A2="Beta line"');
  });

  it('refuses a PDF with no text and a file that is neither PDF nor xlsx, in plain words', async () => {
    await expect(WorkbookModel.load(await makePdf([[]]))).rejects.toThrow(/no readable text/);
    await expect(WorkbookModel.load(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]))).rejects.toThrow(/not a valid .xlsx/);
  });

  it('expands page ranges in sheets and reads, and plans one section per range', async () => {
    const wb = await WorkbookModel.load(await makePdf([['a'], ['b'], ['c'], ['d']]));
    expect(expandPageRange('Page 2-3', wb.sheetNames())).toEqual(['Page 2', 'Page 3']);
    expect(expandPageRange('Tree', wb.sheetNames())).toBeNull();

    const resolved = resolvePageRanges(parseScorecard(CARD).scorecard, wb);
    expect(resolved.artifact.sheets.map((s) => s.name)).toEqual(['Page 1', 'Page 2', 'Page 3', 'Page 4']);
    const sections = planSections(resolved);
    expect(sections.map((s) => s.sheets.map((x) => x.name))).toEqual([['Page 1', 'Page 2'], ['Page 3', 'Page 4']]);
  });

  it('leaves a scorecard with no ranges untouched', async () => {
    const wb = await WorkbookModel.load(await makePdf([['a']]));
    const card = parseScorecard(CARD.replace('"Page 1-4"', '"Page 1"').replace('"Page 1-2"', '"Page 1"').replace('"Page 3-4"', '"Page 1"')).scorecard;
    expect(resolvePageRanges(card, wb)).toBe(card);
  });
});
