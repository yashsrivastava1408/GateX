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

/** One row of the table as columns, kept beside the text line it became. `merged` is set when a cell's text runs under a neighbouring empty cell. */
export interface PageTableRow {
  cells: string[];
  merged: boolean;
}

/** The table of one page as columns and rows: `headers` is the first row, `rows` the others (a repeated header or a banner row may be among them). */
export interface PageTable {
  headers: string[];
  /** The x start of each column. */
  x: number[];
  rows: PageTableRow[];
  /** For each of `rows`, its index among the page's table rows (a row that did not start on a column is skipped, so these can have gaps). */
  indexes: number[];
}

/** An output line of a page; `row` is the index among all the rows the page's table was found in (see PageTable.indexes). */
export interface PageLine {
  text: string;
  row?: number;
}

const HYPHEN_END = /[-\u2010-\u2013\u00AD]$/;
/** A header cell is a few words; a long run of text is data. */
const MAX_HEADER_PIECE = 40;
/** Header pieces closer than this are one column. */
const HEADER_MERGE = 4;
/** A row is part of the table when pieces on its first line start in at least this share of the columns (and in two); a line of prose has few that do. */
const MIN_ALIGNED = 0.5;
/** The header rows searched for: a heading band above the header is skipped. */
const HEADER_SEARCH = 3;

/** The pieces of one cell joined in reading order; a word cut at a hyphen ("Multi- reference", "F-" "S21-" "01") is put back together. */
const joinCell = (texts: string[]): string => {
  let out = '';
  for (const t of texts) out += out === '' || HYPHEN_END.test(out) ? t : ` ${t}`;
  return tidy(out);
};

const squash = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '');

const pieceSig = (pieces: Piece[]) => squash([...pieces].sort((a, b) => a.x - b.x || b.y - a.y).map((p) => p.text).join(''));
const headerColumns = (pieces: Piece[]): number[] => {
  const x: number[] = [];
  for (const p of [...pieces].sort((a, b) => a.x - b.x)) if (x.length === 0 || p.x - x[x.length - 1]! > HEADER_MERGE) x.push(p.x);
  return x;
};
const wordsOnly = (pieces: Piece[]) => pieces.length >= MIN_COLUMNS && pieces.every((p) => p.text.trim().length <= MAX_HEADER_PIECE && /[A-Za-z]/.test(p.text));

/**
 * The tables of the page as columns and rows, each laid out on its own header. The header is the first row (of the first three) made only of
 * a few short words; its pieces say where the columns start, and every piece below belongs to the last column that starts at or before it. This
 * is stricter than the text rebuild above on purpose: a repeated word at one x inside a wide cell is not a column. A row whose first piece
 * is not on a column, or whose pieces mostly are not (a line of prose), ends the table; the same header again (a table that continues below a
 * note, or a second table of the same shape) starts the next one. Headerless pages give nothing. With `hint` (the signature of the page's
 * header, found in a first pass) the page is read from its top and every line that is that header opens a table.
 */
function structure(rows: Line[][], hint?: string): { tables: PageTable[]; sig: string } | null {
  const starts = hint ? [0] : [...Array(Math.min(HEADER_SEARCH, rows.length - 1)).keys()];
  for (const h of starts) {
    let sig = hint;
    if (!sig) {
      const head = rows[h]!.flatMap((l) => l.pieces);
      if (!wordsOnly(head) || headerColumns(head).length < MIN_COLUMNS) continue;
      sig = pieceSig(head);
    }
    const tables: PageTable[] = [];
    let layout: PageTable | null = null;
    let skipped = 0;
    let opened = -1;
    rows.forEach((r, k) => {
      if (k < h) return;
      const own = pieceSig(r.flatMap((l) => l.pieces)) === sig ? r : pieceSig(r[0]!.pieces) === sig ? [r[0]!] : null;
      if (own) {
        const x = headerColumns(own.flatMap((l) => l.pieces));
        layout = { headers: cellsOf(x, own).cells, x, rows: [], indexes: [] };
        tables.push(layout);
        if (opened < 0) opened = k;
        skipped = 0;
        return;
      }
      if (!layout) return;
      const x = layout.x;
      const first = r[0]!.pieces;
      const aligned = x.filter((cx) => first.some((p) => Math.abs(p.x - cx) <= COLUMN_SLACK)).length;
      if (!x.some((cx) => Math.abs(first[0]!.x - cx) <= COLUMN_SLACK) || aligned < Math.max(2, Math.ceil(x.length * MIN_ALIGNED))) {
        // One such row is a heading band between two groups of rows ("S2 · Workflow register"); two in a row are prose, and the table is over.
        skipped += 1;
        if (skipped >= 2) layout = null;
        return;
      }
      skipped = 0;
      layout.rows.push(cellsOf(x, r));
      layout.indexes.push(k);
    });
    // A row right under the first header (after at most one heading band) must belong to the table, or this header does not head a table laid out on its columns.
    if (!hint && (tables[0]?.indexes[0] ?? Infinity) > opened + 2) continue;
    return { tables: tables.filter((t) => t.rows.length > 0), sig };
  }
  return null;
}

/** The cells of one row on the given columns; `merged` when a cell runs past the next column's start with nothing on that line in that column. */
function cellsOf(x: number[], row: Line[]): PageTableRow {
  const cells: string[][] = x.map(() => []);
  let merged = false;
  for (const line of row) {
    for (const p of line.pieces) {
      const c = columnOf(x, p.x);
      cells[c]!.push(p.text);
      const next = x[c + 1];
      if (next !== undefined && p.x + p.width > next + COLUMN_SLACK + 1 && !line.pieces.some((q) => columnOf(x, q.x) === c + 1)) merged = true;
    }
  }
  return { cells: cells.map(joinCell), merged };
}

/** The page's lines with any table rebuilt, or null when the page has no table. */
export function tableLines(pieces: Piece[]): string[] | null {
  return tablePage(pieces)?.lines.map((l) => l.text) ?? null;
}

/** The page's lines with any table rebuilt, plus the table as columns and rows; null when the page has no table. */
export function tablePage(pieces: Piece[]): { lines: PageLine[]; tables: PageTable[] } | null {
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
  const rowStart: number[] = [];
  region.forEach((line, i) => {
    const startsRow = i === 0 || (byPadding ? gaps[i - 1]! > threshold : starts[i]! <= keyColumn);
    if (startsRow) {
      rows.push([line]);
      rowStart.push(first + i);
    } else rows[rows.length - 1]!.push(line);
  });
  // The same rule over the whole page, for the tables as columns and rows: the page may hold other blocks of rows beside the longest one (a
  // short table above a note, then a heading, then the next table).
  const probe = structure(rows);
  const pageRows: Line[][] = [];
  const pageRowAt = new Map<number, number>();
  lines.forEach((line, i) => {
    // A line that is the table's header starts a row of its own, even when a heading band sits right above it.
    const startsRow = i === 0 || (probe !== null && pieceSig(line.pieces) === probe.sig) || (byPadding ? lines[i - 1]!.y - line.y > threshold : columnOf(columns, line.pieces[0]!.x) <= keyColumn);
    if (startsRow) {
      pageRowAt.set(i, pageRows.length);
      pageRows.push([line]);
    } else pageRows[pageRows.length - 1]!.push(line);
  });

  const out: PageLine[] = lines.slice(0, first).map((l, i) => ({ text: plainLine(l), row: pageRowAt.get(i) }));
  const table = rows.map((row) => {
    const cells: string[][] = columns.map(() => []);
    for (const line of row) for (const p of line.pieces) cells[columnOf(columns, p.x)]!.push(p.text);
    return cells.map((c) => tidy(c.join(' ')));
  });
  // A column empty in every row (a stray mark between two columns) carries nothing. Empty cells in a column that is used keep each value under its column.
  const used = columns.map((_, i) => table.some((r) => r[i] !== ''));
  table.forEach((cells, k) => {
    const texts = cells.filter((_, i) => used[i]);
    while (texts.length > 0 && texts[texts.length - 1] === '') texts.pop();
    out.push({ text: texts.join(' | '), row: pageRowAt.get(rowStart[k]!) });
  });
  lines.slice(last + 1).forEach((l, i) => out.push({ text: plainLine(l), row: pageRowAt.get(last + 1 + i) }));
  return { lines: out.filter((l) => l.text !== ''), tables: probe ? (structure(pageRows, probe.sig)?.tables ?? []) : [] };
}
