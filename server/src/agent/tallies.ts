import { columnLetters, type WorkbookModel } from '../excel/workbook.js';
import type { WorkbookProfile } from '../excel/profile.js';
import type { SweepFinding, SweepOptions } from './sweep.js';

/**
 * Tallies the file states about itself, recounted by code. A document that says "68 fields", "56 mandatory, 12 conditional" or "283 of 426 (66%)"
 * is making a claim that its own rows can settle, yet examiners tend to accept such a figure (a perfect score for a tally the file wrote about
 * itself). Three kinds are recounted, each only where a deterministic rule exists:
 *
 *   arithmetic        "283 of 426 fields (66%)" and "71/71 100%": the percentage must be the first number over the second.
 *   hierarchy blocks  tables headed "L1·2 — Happy Path Steps  L2=4 · L3=11 · L4=50" and closed by "COUNT | 4 L2 · 11 L3 · 50 L4 leaves": the ids
 *                     (STEP-01..) and numbered groups (2.1.1) between them are counted; the document's totals ("92 leaves") are the sum.
 *   field dictionary  a PDF (or any text) that lists its fields as rows (name | definition | type | allowed | M or C | source) under section
 *                     headings "S2 · Workflow register": "14 fields" on the overview must be the rows under S2, "8 sections · 68 fields" the
 *                     totals, "Mandatory · conditional fields  56 · 12" the count of M and C rows.
 *
 * A claim that cannot be matched to rows that can be counted ("71 atomic leaves", "78 allowed values") is left alone, never guessed at.
 */

const at = (sheet: string, row: number, col = 1) => ({ sheet, cell: `${columnLetters(col)}${row}` });
const num = (t: string) => Number(t.replace(/,/g, ''));
const SECTION = /^S(\d+)\s*·\s*(.+)$/;

/** "283 of 426 fields (66%)", "71/71 100%": returns the claim when the percentage is not the share. */
const OF_PERCENT = /(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+)\s+of\s+(\d{1,3}(?:,\d{3})+|\d+)\b[^()%\n]{0,48}?\(?\s*(\d+(?:\.\d+)?)\s*%/g;
const SLASH_PERCENT = /(?<![\w./])(\d{1,5})\s*\/\s*(\d{1,5})\s+(\d+(?:\.\d+)?)\s*%/g;

function arithmetic(wb: WorkbookModel, out: SweepFinding[], options: SweepOptions): void {
  const seen = new Set<string>();
  for (const sheet of wb.sheetNames()) {
    for (const [row, col, text] of wb.cells(sheet)) {
      if (text.length < 6 || text.length > 700) continue;
      for (const m of [...text.matchAll(OF_PERCENT), ...text.matchAll(SLASH_PERCENT)]) {
        const part = num(m[1]!);
        const whole = num(m[2]!);
        if (whole === 0 || part > whole) continue;
        const stated = Number(m[3]);
        const places = (m[3]!.split('.')[1] ?? '').length;
        const key = `${part}/${whole}/${stated}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (options.stats) options.stats.tallies += 1;
        const half = 0.5 * 10 ** -places;
        if (Math.abs((part / whole) * 100 - stated) <= half + 1e-9) continue;
        const real = Math.round((part / whole) * 100 * 10 ** places) / 10 ** places;
        const where = at(sheet, row, col);
        out.push({
          kind: 'tally_mismatch', location: where, severity: 'MEDIUM', topic: 'count total percent tally',
          title: `"${m[0].trim()}" does not add up (${sheet})`,
          detail: `${sheet}!${where.cell} says ${m[1]} of ${m[2]} is ${m[3]}%, but ${m[1]} of ${m[2]} is ${real}%.`,
          fix: `Correct the percentage or the counts at ${sheet}!${where.cell}.`,
        });
      }
    }
  }
}

interface Line { row: number; cells: string[] }

const linesOf = (wb: WorkbookModel, sheet: string): Line[] =>
  wb.cells(sheet).filter(([, col]) => col === 1).map(([row, , text]) => ({ row, cells: text.split(/\s\|\s/).map((c) => c.trim()) })).sort((a, b) => a.row - b.row);

const FIELD_NAME = /^[a-z][a-z0-9_]*(?:\[\])?$/;

/** The rows of a field dictionary, counted per section: a row is a field when it starts with a field name and carries an M or C obligation. */
function dictionary(wb: WorkbookModel, pages: string[]) {
  const sections = new Map<string, { title: string; fields: number; where: { sheet: string; row: number } }>();
  let mandatory = 0;
  let conditional = 0;
  let current: string | null = null;
  for (const sheet of pages) {
    for (const line of linesOf(wb, sheet)) {
      const head = SECTION.exec(line.cells[0] ?? '');
      const heads = line.cells.filter((c) => SECTION.test(c)).length;
      // A section heading starts a block; the overview lists all of them on one line, which is not one.
      if (head && heads === 1 && !line.cells.slice(1).some((c) => /\bfields?\b/.test(c) && /^\d/.test(c))) {
        current = `S${head[1]}`;
        if (!sections.has(current)) sections.set(current, { title: head[2]!.replace(/\s*\(continued\)/i, ''), fields: 0, where: { sheet, row: line.row } });
        continue;
      }
      if (!current || line.cells.length < 5 || !FIELD_NAME.test(line.cells[0] ?? '')) continue;
      const flag = line.cells.slice(2).find((c) => c === 'M' || c === 'C');
      if (!flag) continue;
      sections.get(current)!.fields += 1;
      if (flag === 'M') mandatory += 1;
      else conditional += 1;
    }
  }
  return { sections, mandatory, conditional };
}

function fieldDictionary(wb: WorkbookModel, out: SweepFinding[], options: SweepOptions): void {
  const cand: SweepFinding[] = [];
  let looked = 0;
  let tiles = 0;
  let tilesRight = 0;
  const pages = wb.sheetNames().filter((n) => /^Page \d+$/.test(n));
  if (pages.length === 0) return;
  const dict = dictionary(wb, pages);
  const total = [...dict.sections.values()].reduce((sum, s) => sum + s.fields, 0);
  // Not a dictionary of fields (a plain report): nothing to recount.
  if (dict.sections.size < 2 || total < 10) return;
  const miss = (sheet: string, row: number, claim: string, actual: string, what: string) => {
    const where = at(sheet, row);
    cand.push({
      kind: 'tally_mismatch', location: where, severity: 'MEDIUM', topic: 'count total fields tally',
      title: `"${claim}" does not match the ${what} (${sheet})`,
      detail: `${sheet}!${where.cell} says ${claim}, but counting the rows of the field dictionary gives ${actual}.`,
      fix: `Correct the figure at ${sheet}!${where.cell}, or add or remove the missing rows in the dictionary.`,
    });
  };
  for (const sheet of pages) {
    const lines = linesOf(wb, sheet);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Overview tiles: a line of section titles, then a line of "14 fields · 5 closed lists" in the same order.
      const heads = line.cells.filter((c) => SECTION.test(c));
      const next = lines[i + 1];
      if (heads.length >= 2 && next && next.row === line.row + 1) {
        const claims = next.cells.filter((c) => /^\d+\s+fields?\b/.test(c));
        if (claims.length === heads.length) {
          heads.forEach((h, k) => {
            const id = `S${SECTION.exec(h)![1]}`;
            const section = dict.sections.get(id);
            if (!section) return;
            const stated = Number(/^(\d+)/.exec(claims[k]!)![1]);
            looked += 1;
            tiles += 1;
            if (stated === section.fields) tilesRight += 1;
            if (stated !== section.fields) miss(sheet, next.row, `${id} has ${stated} fields`, `${section.fields} rows under ${id}`, `rows under ${id}`);
          });
        }
      }
      // "8 sections · 68 fields · 78 values": the totals.
      for (const cell of line.cells) {
        const m = /(\d+)\s+sections?\s*·\s*(\d+)\s+fields?\b/.exec(cell);
        if (!m) continue;
        looked += 2;
        if (Number(m[1]) !== dict.sections.size) miss(sheet, line.row, `${m[1]} sections`, `${dict.sections.size} sections`, 'sections of the dictionary');
        if (Number(m[2]) !== total) miss(sheet, line.row, `${m[2]} fields`, `${total} field rows`, 'field rows of the dictionary');
      }
      // "Mandatory · conditional fields | 56 · 12".
      if (/mandatory\s*·\s*conditional/i.test(line.cells[0] ?? '')) {
        const m = /(\d+)\s*·\s*(\d+)/.exec(line.cells.slice(1).join(' '));
        if (m) {
          looked += 1;
          if (Number(m[1]) !== dict.mandatory || Number(m[2]) !== dict.conditional)
            miss(sheet, line.row, `${m[1]} mandatory and ${m[2]} conditional fields`, `${dict.mandatory} mandatory and ${dict.conditional} conditional`, 'M and C marks of the dictionary');
        }
      }
    }
  }
  // Trusted only where the rows I counted agree with most of the document's own section tiles: then I am reading its layout right.
  if (tiles < 2 || tilesRight < Math.ceil(tiles * 0.6)) return;
  out.push(...cand);
  if (options.stats) options.stats.tallies += looked;
}

const BLOCK_HEAD = /^L1\s*·\s*(\d+)\s*[—–-]\s*(.+?)\s+L2=(\d+)\s*·\s*L3=(\d+)\s*·\s*L4=(\d+)\s*$/;
const BLOCK_END = /^COUNT\s+(\d+)\s+L2\s*·\s*(\d+)\s+L3\s*·\s*(\d+)\s+L4\s+leaves/i;
const LEAF_ID = /\b([A-Z]{2,5})-(\d{1,3})\b/g;

function pageOrder(names: string[]): string[] {
  return names.filter((n) => /^Page \d+$/.test(n)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
}

function hierarchyBlocks(wb: WorkbookModel, out: SweepFinding[], options: SweepOptions): void {
  const cand: SweepFinding[] = [];
  let looked = 0;
  let agreeing = 0;
  const pages = pageOrder(wb.sheetNames());
  const all: Array<{ sheet: string; row: number; text: string; cells: string[] }> = [];
  for (const sheet of pages) for (const l of linesOf(wb, sheet)) all.push({ sheet, row: l.row, text: l.cells.join(' ').replace(/\s+/g, ' ').trim(), cells: l.cells });
  const blocks: Array<{ k: string; title: string; stated: number[]; counted: number[]; headAt: { sheet: string; row: number } }> = [];
  for (let i = 0; i < all.length; i++) {
    const head = BLOCK_HEAD.exec(all[i]!.text);
    if (!head) continue;
    let end = -1;
    for (let j = i + 1; j < all.length && !BLOCK_HEAD.test(all[j]!.text); j++) if (BLOCK_END.test(all[j]!.text)) { end = j; break; }
    if (end < 0) continue;
    const k = head[1]!;
    const body = all.slice(i + 1, end);
    // A leaf is an id such as STEP-12. A prefix counts as a leaf prefix when ids of it open cells in this table (two or more); an id of any other
    // prefix inside a sentence is a mention of something elsewhere ("boundary IB-03").
    const opening = new Map<string, Set<string>>();
    const anywhere = new Map<string, Set<string>>();
    for (const l of body) {
      for (const c of l.cells) {
        // A cell opening with several ids ("ACT-05 ACT-10 ...") lists leaves of the prefix of the first one; "GAP-09 PRM-027 ..." is a leaf and a mention.
        const run = [...(/^((?:[A-Z]{2,5}-\d{1,3}(?:\s+|$))+)/.exec(c)?.[1] ?? '').matchAll(LEAF_ID)];
        for (const m of run.filter((x) => x[1] === run[0]![1])) opening.set(m[1]!, (opening.get(m[1]!) ?? new Set()).add(m[0]));
        for (const m of c.matchAll(LEAF_ID)) anywhere.set(m[1]!, (anywhere.get(m[1]!) ?? new Set()).add(m[0]));
      }
    }
    const leaves = new Set<string>();
    for (const [prefix, ids] of opening) if (ids.size >= 2) for (const id of anywhere.get(prefix) ?? ids) leaves.add(id);
    // Numbered groups at the start of a cell: "1.2 Employer" (level 2) and "1.2.3 Candidate Sourcing" (level 3) of this section.
    const groups = (parts: number) => {
      const found = new Set<string>();
      for (const l of body) for (const c of l.cells) { const m = /^(\d+(?:\.\d+)+)\s+[A-Za-z]/.exec(c); if (m && m[1]!.split('.').length === parts && m[1]!.split('.')[0] === k) found.add(m[1]!); }
      return found.size;
    };
    const end1 = BLOCK_END.exec(all[end]!.text)!;
    blocks.push({ k, title: head[2]!, stated: [Number(head[3]), Number(head[4]), Number(head[5])], counted: [groups(2), groups(3), leaves.size], headAt: { sheet: all[i]!.sheet, row: all[i]!.row } });
    const stated2 = [Number(end1[1]), Number(end1[2]), Number(end1[3])];
    const counted = blocks[blocks.length - 1]!.counted;
    const names = ['L2 groups', 'L3 groups', 'L4 leaves'];
    if (stated2[2] === counted[2] || blocks[blocks.length - 1]!.stated[2] === counted[2]) agreeing += 1;
    // Only the leaves are recounted: a leaf is an id such as STEP-12. Groups sit in merged cells of a table that text cannot tell apart reliably.
    stated2.forEach((v, n) => {
      if (n !== 2) return;
      looked += 1;
      if (v !== counted[n]) {
        const where = at(all[end]!.sheet, all[end]!.row);
        cand.push({
          kind: 'tally_mismatch', location: where, severity: 'MEDIUM', topic: 'count total leaves tally',
          title: `Count row of "${head[2]}" says ${v} ${names[n]}, the table has ${counted[n]} (${all[end]!.sheet})`,
          detail: `${all[end]!.sheet}!${where.cell} says ${v} ${names[n]} for L1·${k} ${head[2]}, but counting the table gives ${counted[n]}.`,
          fix: `Correct the count row at ${all[end]!.sheet}!${where.cell}, or add or remove the missing entries in the table.`,
        });
      }
    });
    blocks[blocks.length - 1]!.stated.forEach((v, n) => {
      if (n !== 2) return;
      looked += 1;
      if (v !== counted[n]) {
        const where = at(all[i]!.sheet, all[i]!.row);
        cand.push({
          kind: 'tally_mismatch', location: where, severity: 'MEDIUM', topic: 'count total leaves tally',
          title: `Heading of "${head[2]}" says ${v} ${names[n]}, the table has ${counted[n]} (${all[i]!.sheet})`,
          detail: `${all[i]!.sheet}!${where.cell} says ${v} ${names[n]} for L1·${k} ${head[2]}, but counting the table gives ${counted[n]}.`,
          fix: `Correct the heading at ${all[i]!.sheet}!${where.cell}, or add or remove the missing entries in the table.`,
        });
      }
    });
  }
  // The recount is trusted only where it agrees with the document on most tables: then it is reading the layout right, and a table it disagrees
  // with is a real mismatch. Where it agrees with few, the leaves are not ids of this shape and nothing is claimed.
  if (blocks.length < 3 || agreeing < Math.max(2, Math.ceil((blocks.length * 2) / 3))) return;
  const sum = (n: number) => blocks.reduce((t, b) => t + b.counted[n]!, 0);
  const totals = [blocks.length, sum(0), sum(1), sum(2)];
  const labels = ['sections', 'L2 groups', 'L3 groups', 'L4 leaves'];
  const leafSet = new Set([totals[3]!, ...blocks.map((b) => b.counted[2]!)]);
  for (const l of all) {
    // "5 | 16 | 30 | 92": the four level counts on one line.
    if (l.cells.length === 4 && l.cells.every((c) => /^\d+$/.test(c))) {
      l.cells.forEach((c, n) => {
        if (n !== 3 && n !== 0) return;
        looked += 1;
        if (Number(c) !== totals[n]) {
          const where = at(l.sheet, l.row);
          cand.push({
            kind: 'tally_mismatch', location: where, severity: 'MEDIUM', topic: 'count total leaves tally',
            title: `Overview says ${c} ${labels[n]}, the tables add up to ${totals[n]} (${l.sheet})`,
            detail: `${l.sheet}!${where.cell} says ${c} ${labels[n]}, but the section tables hold ${totals[n]}.`,
            fix: `Correct the overview figure at ${l.sheet}!${where.cell}.`,
          });
        }
      });
    }
    // "92 leaves", "L4 = 92 leaves": the total must be the sum of the tables (or the count of one table, said of that table).
    for (const m of l.text.matchAll(/\b(?:L4\s*=\s*)?(\d+)\s+(?:atomic\s+)?leaves\b/gi)) {
      looked += 1;
      if (!leafSet.has(Number(m[1]))) {
        const where = at(l.sheet, l.row);
        cand.push({
          kind: 'tally_mismatch', location: where, severity: 'MEDIUM', topic: 'count total leaves tally',
          title: `"${m[1]} leaves" matches no table (${l.sheet})`,
          detail: `${l.sheet}!${where.cell} says ${m[1]} leaves, but the section tables hold ${totals[3]} in all (${blocks.map((b) => b.counted[2]).join(' + ')}).`,
          fix: `Correct the figure at ${l.sheet}!${where.cell}.`,
        });
      }
    }
  }
  out.push(...cand);
  if (options.stats) options.stats.tallies += looked;
}

/** The tallies this file states about itself that its own rows contradict. */
export function recountTallies(wb: WorkbookModel, _profile?: WorkbookProfile, options: SweepOptions = {}): SweepFinding[] {
  const out: SweepFinding[] = [];
  arithmetic(wb, out, options);
  fieldDictionary(wb, out, options);
  hierarchyBlocks(wb, out, options);
  return out;
}
