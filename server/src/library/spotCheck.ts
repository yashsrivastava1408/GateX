/**
 * The pure parts of the human spot-check (scripts/spotCheck.ts): writing and reading the CSV, and scoring a filled sheet against our labels.
 * Nothing here touches the model or the disk.
 */

export const ANSWERS = ['real', 'partly', 'wrong', 'vague'] as const;
export type Answer = (typeof ANSWERS)[number];
const useful = (a: string) => a === 'real' || a === 'partly';

const quote = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(quote).join(',')).join('\r\n') + '\r\n';
}
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}


export interface SpotCheckReport {
  asked: number;
  answered: number;
  skipped: Array<{ id: string; why: string }>;
  exact: number;
  usefulAgree: number;
  matrix: Record<string, Record<string, number>>;
  ours: { useful: number; wrong: number };
  theirs: { useful: number; wrong: number };
  disagreements: Array<{ id: string; pair: string; ours: string; theirs: string; note: string }>;
  byPair: Record<string, { n: number; exact: number; usefulAgree: number }>;
}

export function scoreSheet(csv: string, keyRows: Array<{ id: string; pair: string; ourLabel: string }>): SpotCheckReport {
  const [head, ...rows] = parseCsv(csv);
  if (!head) throw new Error('The sheet is empty.');
  const col = (name: string) => head.findIndex((h) => h.trim().toLowerCase() === name);
  const idCol = col('id');
  const answerCols = ANSWERS.map((a) => col(a));
  const noteCol = col('notes');
  if (idCol < 0 || answerCols.some((c) => c < 0)) throw new Error('The sheet needs the columns id, real, partly, wrong, vague. Was it re-ordered or saved with other headings?');
  const keyById = new Map(keyRows.map((k) => [k.id, k]));
  const report: SpotCheckReport = {
    asked: keyRows.length, answered: 0, skipped: [], exact: 0, usefulAgree: 0,
    matrix: Object.fromEntries(ANSWERS.map((a) => [a, Object.fromEntries(ANSWERS.map((b) => [b, 0]))])),
    ours: { useful: 0, wrong: 0 }, theirs: { useful: 0, wrong: 0 }, disagreements: [], byPair: {},
  };
  const answeredIds = new Set<string>();
  for (const row of rows) {
    const id = (row[idCol] ?? '').trim();
    const key = keyById.get(id);
    if (!key) { report.skipped.push({ id: id || '(no id)', why: 'not in the answer key' }); continue; }
    const marked = ANSWERS.filter((_, i) => (row[answerCols[i]!] ?? '').trim() !== '');
    if (marked.length === 0) { report.skipped.push({ id, why: 'no answer given' }); continue; }
    if (marked.length > 1) { report.skipped.push({ id, why: `more than one column marked (${marked.join(', ')})` }); continue; }
    if (answeredIds.has(id)) { report.skipped.push({ id, why: 'row appears twice' }); continue; }
    answeredIds.add(id);
    const theirs = marked[0]!;
    const ours = key.ourLabel as Answer;
    report.answered++;
    report.matrix[ours]![theirs]!++;
    if (ours === theirs) report.exact++;
    if (useful(ours) === useful(theirs)) report.usefulAgree++;
    if (useful(ours)) report.ours.useful++;
    if (ours === 'wrong') report.ours.wrong++;
    if (useful(theirs)) report.theirs.useful++;
    if (theirs === 'wrong') report.theirs.wrong++;
    const p = (report.byPair[key.pair] ??= { n: 0, exact: 0, usefulAgree: 0 });
    p.n++;
    if (ours === theirs) p.exact++;
    if (useful(ours) === useful(theirs)) p.usefulAgree++;
    if (useful(ours) !== useful(theirs) || (ours === 'wrong') !== (theirs === 'wrong')) report.disagreements.push({ id, pair: key.pair, ours, theirs, note: (row[noteCol] ?? '').trim() });
  }
  for (const k of keyRows) if (!answeredIds.has(k.id) && !report.skipped.some((s) => s.id === k.id)) report.skipped.push({ id: k.id, why: 'row missing from the sheet' });
  return report;
}

export const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(0)}%`);
