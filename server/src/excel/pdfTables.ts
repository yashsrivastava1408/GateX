/**
 * Rebuilds the rows of a table in a PDF page. A PDF stores a table as loose pieces of text at positions. A cell whose text wraps onto three
 * lines becomes three separate lines, and reading line by line gives `question_to_ask | The exact | A precise` with the rest of each
 * description left floating below. This finds the table by its columns (x positions many lines start at), starts a new row where the
 * vertical gap is wider than the gap between wrapped lines, and joins each column's pieces across those lines, so a row is read as one row.
 * Pages without a table are left exactly as they were.
 */

export interface Piece {
  text: string;
  x: number;
  y: number;
  width: number;
}

interface Line {
  y: number;
  pieces: Piece[];
}

/** Pieces whose y differs by no more than this are on one line. */
const LINE_TOLERANCE = 3;
/** Two column starts closer than this are one column. */
const COLUMN_MERGE = 10;
/** A piece belongs to a column when it starts at most this far left of the column's start. */
const COLUMN_SLACK = 3;
/** A line is "strong" when pieces start in at least this many columns; the table runs from the first strong line to the last. */
const STRONG_COLUMNS = 4;
const MIN_COLUMNS = 3;
const MIN_STRONG_LINES = 4;
/** Weak lines (the wrapped lines of a cell) allowed between two strong lines of the same table. */
const MAX_WEAK_BETWEEN = 8;

export function groupLines(pieces: Piece[]): Line[] {
  const lines: Line[] = [];
  for (const piece of pieces) {
    const line = lines.find((l) => Math.abs(l.y - piece.y) <= LINE_TOLERANCE);
    if (line) line.pieces.push(piece);
    else lines.push({ y: piece.y, pieces: [piece] });
  }
  for (const line of lines) line.pieces.sort((a, b) => a.x - b.x);
  return lines.sort((a, b) => b.y - a.y);
}

/** The x positions that many lines start a piece at: the table's columns, left to right. */
export function columnStarts(lines: Line[]): number[] {
  const counts = new Map<number, number>();
  for (const line of lines) for (const x of new Set(line.pieces.map((p) => Math.round(p.x / 2) * 2))) counts.set(x, (counts.get(x) ?? 0) + 1);
  const wanted = Math.max(5, Math.floor(lines.length * 0.12));
  const frequent = [...counts].filter(([, n]) => n >= wanted).sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [x, n] of frequent) {
    const last = merged[merged.length - 1];
    if (last && x - last[0] < COLUMN_MERGE) {
      if (n > last[1]) merged[merged.length - 1] = [x, n];
    } else merged.push([x, n]);
  }
  return merged.map(([x]) => x);
}

const columnOf = (columns: number[], x: number): number => {
  let index = 0;
  for (let i = 0; i < columns.length; i++) if (columns[i]! <= x + COLUMN_SLACK) index = i;
  return index;
};

// Invisible marks (zero-width spaces, soft hyphens) are not text; leaving them in made a column look used.
const tidy = (text: string) => text.replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '').replace(/\s+/g, ' ').trim();

/** One line of plain text from its pieces, as the reader always did (a wide gap becomes " | "). */
export function plainLine(line: Line, gap = 14): string {
  let out = '';
  let end = 0;
  line.pieces.forEach((p, i) => {
    if (i > 0) out += p.x - end > gap ? ' | ' : p.x > end + 0.5 ? ' ' : '';
    out += p.text;
    end = p.x + p.width;
  });
  return tidy(out);
}

/** The page's lines with any table rebuilt, or null when the page has no table. */
export function tableLines(pieces: Piece[]): string[] | null {
  const lines = groupLines(pieces);
  if (lines.length < 8) return null;
  const columns = columnStarts(lines);
  if (columns.length < MIN_COLUMNS) return null;
  const startsIn = (line: Line) => new Set(line.pieces.map((p) => columnOf(columns, p.x))).size;
  const strong = lines.map((l, i) => ({ i, n: startsIn(l) })).filter((x) => x.n >= STRONG_COLUMNS);
  // The table is the longest dense run of strong lines: a few weak lines (wrapped cells) may sit between them, a stretch of prose may not.
  // Bold run-in headings in a paragraph can look like a strong line, so a lone one above or below the table is not part of it.
  let best: typeof strong = [];
  let run: typeof strong = [];
  for (const line of strong) {
    if (run.length > 0 && line.i - run[run.length - 1]!.i > MAX_WEAK_BETWEEN + 1) {
      if (run.length > best.length) best = run;
      run = [];
    }
    run.push(line);
  }
  if (run.length > best.length) best = run;
  if (best.length < MIN_STRONG_LINES) return null;
  const first = best[0]!.i;
  let last = best[best.length - 1]!.i;

  // Rows. Two signals say where a row starts. Padding: the gap above the line is wider than the gap between wrapped lines of one row (the
  // Docket). First column: the line has a piece in the first column, which wrapped lines do not (a table with no padding between rows).
  // Padding is used when it clearly marks rows, that is, when a fifth or more of the gaps are wide; otherwise the first column is.
  const region = lines.slice(first, last + 1);
  const gaps = region.slice(1).map((l, i) => region[i]!.y - l.y);
  const sorted = [...gaps].sort((a, b) => a - b);
  const inner = sorted[Math.floor(sorted.length * 0.25)] ?? 0;
  const threshold = inner * 1.2;
  const wide = gaps.filter((g) => g > threshold).length;
  const byPadding = gaps.length > 0 && wide / gaps.length >= 0.2;
  // The column a row's first piece usually sits in (the field name), which wrapped lines of a cell do not start in.
  const starts = region.map((l) => columnOf(columns, l.pieces[0]!.x));
  const tally = new Map<number, number>();
  for (const c of starts) tally.set(c, (tally.get(c) ?? 0) + 1);
  const keyColumn = [...tally].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0];
  // The last row's wrapped lines come after the last strong line: take in the lines right below it that continue it.
  while (last + 1 < lines.length) {
    const next = lines[last + 1]!;
    const gap = lines[last]!.y - next.y;
    const continues = byPadding ? gap <= threshold : columnOf(columns, next.pieces[0]!.x) > keyColumn && gap <= inner * 1.6;
    if (!continues) break;
    last += 1;
  }
  region.push(...lines.slice(region.length + first, last + 1));
  starts.push(...region.slice(starts.length).map((l) => columnOf(columns, l.pieces[0]!.x)));
  gaps.push(...region.slice(gaps.length + 1).map((l, i) => region[gaps.length + i]!.y - l.y));
  const rows: Line[][] = [];
  region.forEach((line, i) => {
    const startsRow = i === 0 || (byPadding ? gaps[i - 1]! > threshold : starts[i]! <= keyColumn);
    if (startsRow) rows.push([line]);
    else rows[rows.length - 1]!.push(line);
  });

  const out: string[] = lines.slice(0, first).map((l) => plainLine(l));
  const table = rows.map((row) => {
    const cells: string[][] = columns.map(() => []);
    for (const line of row) for (const p of line.pieces) cells[columnOf(columns, p.x)]!.push(p.text);
    return cells.map((c) => tidy(c.join(' ')));
  });
  // A column empty in every row (a stray mark between two columns) carries nothing. Empty cells in a column that is used keep each value under its column.
  const used = columns.map((_, i) => table.some((r) => r[i] !== ''));
  for (const cells of table) {
    const texts = cells.filter((_, i) => used[i]);
    while (texts.length > 0 && texts[texts.length - 1] === '') texts.pop();
    out.push(texts.join(' | '));
  }
  for (const l of lines.slice(last + 1)) out.push(plainLine(l));
  return out.filter((l) => l !== '');
}
