import { describe, expect, it } from 'vitest';
import { columnStarts, groupLines, tablePage, tableLines, type Piece } from '../src/excel/pdfTables.js';

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

describe('the table of a page as columns and rows (for the row sweep)', () => {
  /** Four pieces per row at x = 40 / 110 / 220 / 280, ids wrapped at the dash over three lines, rows padded (16 between rows, 10 between lines). */
  function field(y: number, n: number, over: { why?: string } = {}): Piece[] {
    return [
      piece('F-', 40, y), piece(`S0${n}-`, 40, y - 10), piece(`${n}`, 40, y - 20),
      piece(`name_${n}`, 110, y), piece(over.why ?? 'a reason', 220, y), piece('Yes', 280, y),
    ].filter((p) => p.text !== '');
  }
  const head = (y: number) => [piece('ID', 40, y), piece('Field', 110, y), piece('Why', 220, y), piece('Required', 280, y)];

  it('reads each row under the header columns and puts a dash-wrapped id back together', () => {
    const pieces = [...head(700)];
    for (let i = 0; i < 6; i++) pieces.push(...field(684 - i * 36, i + 1));
    const [table] = tablePage(pieces)!.tables;
    expect(table!.headers).toEqual(['ID', 'Field', 'Why', 'Required']);
    expect(table!.rows).toHaveLength(6);
    expect(table!.rows[2]!.cells).toEqual(['F-S03-3', 'name_3', 'a reason', 'Yes']);
    expect(table!.rows.every((r) => !r.merged)).toBe(true);
  });

  it('keeps an empty cell empty instead of letting the next piece slide into it', () => {
    const pieces = [...head(700)];
    for (let i = 0; i < 6; i++) pieces.push(...field(684 - i * 36, i + 1, i === 3 ? { why: '' } : {}));
    const [table] = tablePage(pieces)!.tables;
    expect(table!.rows[3]!.cells).toEqual(['F-S04-4', 'name_4', '', 'Yes']);
  });

  it('does not make a column of a word repeated at one x inside a wide cell', () => {
    const pieces = [...head(700)];
    for (let i = 0; i < 8; i++) {
      pieces.push(...field(684 - i * 36, i + 1));
      pieces.push(piece('S02', 160, 684 - i * 36 - 10)); // "see S02" wrapped inside the Field/Why gap, again and again
    }
    const [table] = tablePage(pieces)!.tables;
    expect(table!.x).toHaveLength(4);
    expect(table!.rows).toHaveLength(8);
  });

  it('finds a second block of rows below a note and a heading, opened by the same header again', () => {
    const pieces = [...head(780)];
    for (let i = 0; i < 4; i++) pieces.push(...field(764 - i * 36, i + 1));
    pieces.push(piece('Example: some prose that is not a row of the table at all, running on and on', 41, 600));
    pieces.push(piece('Check. more prose that goes on across the page without any columns in it', 41, 588));
    pieces.push(piece('B S02 - 2 - Next group', 40, 560));
    pieces.push(...head(540));
    for (let i = 4; i < 9; i++) pieces.push(...field(524 - (i - 4) * 36, i + 1));
    const tables = tablePage(pieces)!.tables;
    expect(tables.map((t) => t.rows.length)).toEqual([4, 5]);
  });

  it('gives no table to a page whose first block is not headed by plain words', () => {
    const pieces: Piece[] = [];
    for (let i = 0; i < 8; i++) pieces.push(...field(700 - i * 36, i + 1));
    expect(tablePage(pieces)?.tables ?? []).toEqual([]);
  });
});
