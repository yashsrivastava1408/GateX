import { describe, expect, it } from 'vitest';
import { columnStarts, groupLines, tableLines, type Piece } from '../src/excel/pdfTables.js';

const piece = (text: string, x: number, y: number): Piece => ({ text, x, y, width: text.length * 5 });
/** Columns at x = 40 (field), 110 (what to write), 220 (type), 280 (required). */
const header = (y: number) => [piece('Field', 40, y), piece('What to write', 110, y), piece('Type', 220, y), piece('Required', 280, y)];

describe('rebuilding the rows of a table in a PDF page', () => {
  /** A table whose rows are padded: 10 points between wrapped lines, 16 between rows (the Docket). */
  function padded(): Piece[] {
    const out = [...header(700)];
    let y = 684;
    for (const [name, a, b, type, req] of [
      ['vague_term', 'The vague word,', 'when that is the issue', 'Text(100)', 'Yes'],
      ['affected_ids', 'Records that cannot', 'be finalised', 'Reference', 'Yes'],
      ['question_to_ask', 'The exact', 'question', 'Text(500)', 'Yes'],
      ['answer', 'The answer', 'received', 'Text(1000)', 'No'],
      ['answered_on', 'Date of', 'the answer', 'Date', 'No'],
    ] as const) {
      out.push(piece(name, 40, y), piece(a, 110, y), piece(type, 220, y), piece(req, 280, y));
      out.push(piece(b, 110, y - 10));
      y -= 26;
    }
    return out;
  }

  it('joins the wrapped lines of each cell into its row, under the right column', () => {
    const lines = tableLines(padded())!;
    expect(lines[0]).toBe('Field | What to write | Type | Required');
    expect(lines[1]).toBe('vague_term | The vague word, when that is the issue | Text(100) | Yes');
    expect(lines[3]).toBe('question_to_ask | The exact question | Text(500) | Yes');
    expect(lines).toHaveLength(6);
  });

  it('finds the columns from where many lines start', () => {
    expect(columnStarts(groupLines(padded()))).toEqual([40, 110, 220, 280]);
  });

  /** A table with no extra padding between rows (Step 5): a row starts at the field name. */
  it('starts a row at the field name when the rows are not padded', () => {
    const out = [...header(700)];
    let y = 688;
    for (const [name, a, b] of [['doc_id', 'Unique ID', ''], ['version', 'Version of schema', 'and content'], ['status', 'Lifecycle state', ''], ['run_tag', 'Tool and model', 'of the fill'], ['owner', 'Who owns it', '']] as const) {
      out.push(piece(name, 40, y), piece(a, 110, y), piece('text', 220, y), piece('M', 280, y));
      y -= 9;
      if (b) {
        out.push(piece(b, 110, y));
        y -= 9;
      }
    }
    const lines = tableLines(out)!;
    expect(lines).toContain('version | Version of schema and content | text | M');
    expect(lines).toContain('status | Lifecycle state | text | M');
    expect(lines).toContain('run_tag | Tool and model of the fill | text | M');
  });

  it('leaves a page of prose alone', () => {
    const prose: Piece[] = [];
    for (let i = 0; i < 20; i++) prose.push(piece(`A sentence of ordinary running text number ${i}.`, 40, 700 - i * 12));
    expect(tableLines(prose)).toBeNull();
  });

  it('keeps the text above and below the table as plain lines, and a stretch of prose out of the table', () => {
    const lines = tableLines([piece('Field dictionary, part 1', 40, 760), ...padded(), piece('A closing note about the table above.', 40, 520)])!;
    expect(lines[0]).toBe('Field dictionary, part 1');
    expect(lines[lines.length - 1]).toBe('A closing note about the table above.');
    expect(lines).toContain('answer | The answer received | Text(1000) | No');
  });

  it('leaves out a column that is empty in every row', () => {
    const lines = tableLines(
      padded().flatMap((p) => (p.x === 220 ? [p, { ...piece('​', 224, p.y), width: 1 }] : [p])).concat([]),
    )!;
    expect(lines[0]).toBe('Field | What to write | Type | Required');
  });
});
