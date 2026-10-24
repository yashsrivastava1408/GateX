import { columnLetters, type WorkbookModel } from '../excel/workbook.js';
import type { DroppedFinding } from '@ddd/shared';
import { claimsAbsence } from './findingCheck.js';
import { namedIds } from './presence.js';
import type { DraftFinding } from './types.js';

/**
 * Three code-only checks on the examiners' findings, written after a blind re-check of 40 findings showed that the largest wrong group
 * was "X is missing / not defined" when the file has X under its own name, and that some findings check the wrong cell. No model is asked:
 * every rule needs a cell of the file that proves it, and names that cell in the reason.
 *
 *   definedNames       A finding says an identifier (snake_case field name, or an id such as D3-S04-P27) is not defined, and every one of them is the
 *                      name of a row in the file that has a description beside it.
 *   citedCellContent   A finding says what its cited cell holds ("H5 contains 'Atomic'") and the cell does not hold that. It is flagged, not dropped:
 *                      the claim is usually about another file or sheet (the scorecard's H5, not the schema's), but a drop would also lose a
 *                      finding that is partly right under another reading.
 *   alreadyDisclosed   The cited cell is itself a marker the file uses for a known gap (UNKNOWN, UNSPECIFIED, "NOT STATED IN SOURCE", CONFLICT, To add,
 *                      PARTIAL) and the finding is about that gap. It is marked "already disclosed", never dropped: the gap is real, only not news.
 *
 * A rule can only remove or annotate; none raises a severity or adds a finding.
 */

export const CLAIM_RULES = ['definedNames', 'citedCellContent', 'alreadyDisclosed'] as const;
export type ClaimRule = (typeof CLAIM_RULES)[number];

/** Sheets that discuss the work instead of defining it (decisions, gaps, questions, comparisons): a name there is not a definition. */
const DISCUSSION_SHEET = /decision|log\b|_log|comparison|question|gap|interpretation|conflict|corrections?|pdf_vs|checks?$/i;
const SNAKE = /(?<![\w-])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![\w-])/g;
/** A sentence that says the thing is there and complains about something else ("is defined but ... no example"). */
const SAYS_PRESENT = /\b(?:is|are) (?:defined|declared|present|specified|listed|required)\b|\bdefined (?:and|but)\b|\bexists?\b/i;

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const sentencesOf = (f: Pick<DraftFinding, 'title' | 'detail'>) =>
  `${f.title}. ${f.detail.replace(/\s*\[(?:Also reported as|Fact check):.*$/s, '')}`.split(/(?<=[.;!?])\s+/);

/** A row that defines a name: the name is a whole cell, or a whole token of a cell, and the row holds a description of some length beside it. */
function definingRow(wb: WorkbookModel, name: string): string | null {
  const lower = name.toLowerCase();
  for (const sheet of wb.sheetNames()) {
    if (DISCUSSION_SHEET.test(sheet)) continue;
    const pdf = /^page \d+$/i.test(sheet);
    const rows = new Map<number, Array<[number, string]>>();
    for (const [r, c, text] of wb.cells(sheet)) {
      const list = rows.get(r) ?? [];
      list.push([c, text]);
      rows.set(r, list);
    }
    for (const [row, cells] of rows) {
      // A whole cell, or in a PDF (where a table row is one cell) the name as a column of the row: "... source_of_truth | Which side owns ...".
      const hit = cells.find(([, text]) => {
        const t = norm(text).toLowerCase();
        return t === lower || (pdf && t.length <= 400 && new RegExp(`(?:^|\\| |\\d )${lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\|`).test(t));
      });
      if (!hit) continue;
      const where = `${columnLetters(hit[0])}${row}`;
      const rest = cells.filter(([c]) => c !== hit[0]).map(([, t]) => norm(t)).filter(Boolean);
      const inCell = norm(hit[1]).length - lower.length;
      // A description beside the name (other cells of the row, or the words after it in the same row text).
      if (rest.join(' ').length >= 20 || inCell >= 20) return `${sheet}!${where}`;
    }
  }
  return null;
}

const ID_TOKEN = /\b[A-Z]{1,4}\d?-[A-Z]?\d+(?:-[A-Z]?\d+)*\b/g;
/** Where the last identifier in a text ends (0 when there is none). */
const lastNameEnd = (text: string): number =>
  Math.max(0, ...[...text.matchAll(SNAKE), ...text.matchAll(ID_TOKEN)].map((m) => m.index! + m[0].length));
const NAME_LIST = '((?:[^.;]|\\.\\.){0,160}?)';
const idsAndSnake = (text: string): string[] => {
  const out = new Set<string>();
  for (const m of text.matchAll(SNAKE)) out.add(m[0]);
  for (const id of namedIds(text)) if (/\d/.test(id) && id.includes('-')) out.add(id);
  return [...out];
};
/** "X and Y are not defined", "X is missing": the names are the subject of the sentence. */
const SUBJECT = new RegExp(`${NAME_LIST}\\s+(?:is|are|was|were)\\s+(?:not (?:defined|declared|specified|present|found)|undefined|missing|absent|nowhere defined)\\b`, 'i');
/** "lacks a definition for X", "no row for X and Y", "missing definitions of X". */
const OBJECT = new RegExp(`\\b(?:lack(?:s|ing)?|missing|no|without)\\s+(?:a\\s+|an\\s+|any\\s+)?(?:clear\\s+|explicit\\s+|formal\\s+)?(?:definitions?|rows?|entry|entries|declarations?)\\s+(?:for|of)\\s+${NAME_LIST}(?:[.;]|$)`, 'i');

/**
 * Identifiers a finding says are themselves not defined: snake_case names and ids (ranges expanded), only when the sentence is about the
 * name ("X is not defined", "lacks a definition for X"). "Fields X and Y have UNKNOWN values" is about the values and names nothing here.
 */
function claimedUndefined(f: Pick<DraftFinding, 'title' | 'detail'>): string[] {
  const names = new Set<string>();
  for (const s of sentencesOf(f)) {
    if (SAYS_PRESENT.test(s)) continue;
    const subject = SUBJECT.exec(s);
    if (subject) {
      // The names must end the subject: a long tail between the last name and the verb is another subject ("X's values ... are missing").
      const found = idsAndSnake(subject[1]!);
      const tail = subject[1]!.slice(lastNameEnd(subject[1]!));
      if (found.length > 0 && tail.length <= 40 && !/\b(?:values?|statements?|examples?|content|cells?)\b/i.test(tail)) for (const n of found) names.add(n);
    }
    const object = OBJECT.exec(s);
    if (object) for (const n of idsAndSnake(object[1]!)) names.add(n);
  }
  return [...names];
}

export function definedNames(f: DraftFinding, wb: WorkbookModel): string | null {
  const names = claimedUndefined(f);
  if (names.length === 0) return null;
  const proofs: string[] = [];
  for (const name of names) {
    const at = definingRow(wb, name);
    if (!at) return null; // one name the file does not hold: the finding may be right about it
    proofs.push(`"${name}" in ${at}`);
  }
  return `It says ${names.length === 1 ? 'a name is' : 'names are'} not defined, but the file defines ${proofs.join('; ')}.`;
}

/** What a finding says its cited cell holds: "H5 contains 'Atomic'", "cell H5 says 'x'". */
export function citedCellContent(f: DraftFinding, wb: WorkbookModel): string | null {
  const loc = f.location;
  const sheet = loc && wb.resolveSheet(loc.sheet);
  if (!loc || !sheet) return null;
  const text = `${f.title}. ${f.detail}`;
  for (const m of text.matchAll(/(?<![\w-])([A-Z]{1,3}[1-9]\d{0,5})(?![\w-])[^.;]{0,25}?\b(?:contains|holds|has|says|shows|reads)\s+['"“‘]([^'"”’]{2,60})['"”’]/g)) {
    const actual = wb.cellText(sheet, m[1]!);
    if (actual === undefined) continue;
    const want = norm(m[2]!).toLowerCase();
    if (!norm(actual).toLowerCase().includes(want)) {
      return `It says ${m[1]} holds "${m[2]}", but ${m[1]} of "${sheet}" ${actual.trim() === '' ? 'is empty' : `holds "${norm(actual).slice(0, 60)}"`}. The claim may be about another file or sheet.`;
    }
  }
  return null;
}

const DISCLOSED = /^(?:unknown|unspecified|none stated(?: explicitly)?|not stated(?: in source)?|to be confirmed|tbc|to add|partial|conflict|proposed|to be set|pending)\b/i;

/** The cited cell is a marker the file uses for a known gap, and the finding quotes that marker. */
export function alreadyDisclosed(f: DraftFinding, wb: WorkbookModel): string | null {
  const loc = f.location;
  const sheet = loc && wb.resolveSheet(loc.sheet);
  if (!loc || !sheet) return null;
  const cell = norm(wb.cellText(sheet, loc.cell) ?? '');
  if (!DISCLOSED.test(cell) || cell.length > 60) return null;
  const marker = DISCLOSED.exec(cell)![0].toLowerCase();
  if (!`${f.title} ${f.detail}`.toLowerCase().includes(marker.replace(/ explicitly$/, ''))) return null;
  return `${sheet}!${loc.cell} itself says "${cell}": the file already marks this as open.`;
}

export interface ClaimVerdict {
  rule: ClaimRule;
  /** drop = set aside with the reason; flag = kept, with the note added to the detail. */
  action: 'drop' | 'flag';
  reason: string;
}

const RUNNERS: Record<ClaimRule, { action: 'drop' | 'flag'; run: (f: DraftFinding, wb: WorkbookModel) => string | null }> = {
  definedNames: { action: 'drop', run: definedNames },
  citedCellContent: { action: 'flag', run: citedCellContent },
  alreadyDisclosed: { action: 'flag', run: alreadyDisclosed },
};

/** Every rule that fires on a finding, the dropping ones first. */
export function claimVerdicts(f: DraftFinding, wb: WorkbookModel, rules: readonly ClaimRule[] = CLAIM_RULES): ClaimVerdict[] {
  if (f.source !== 'raters') return [];
  const out: ClaimVerdict[] = [];
  for (const rule of rules) {
    const r = RUNNERS[rule];
    if (r.action === 'drop' && !claimsAbsence(f)) continue;
    const reason = r.run(f, wb);
    if (reason) out.push({ rule, action: r.action, reason });
  }
  return out.sort((a, b) => (a.action === b.action ? 0 : a.action === 'drop' ? -1 : 1));
}

export interface ClaimCheckResult {
  findings: DraftFinding[];
  dropped: DroppedFinding[];
  /** Findings kept with a note added to their detail. */
  flagged: number;
  notes: string[];
}

/** Runs the rules over the examiners' findings: a dropping rule sets the finding aside with its reason, a flagging rule adds a note to the detail. */
export function checkClaims(findings: DraftFinding[], wb: WorkbookModel, options: { rules?: readonly ClaimRule[] } = {}): ClaimCheckResult {
  const kept: DraftFinding[] = [];
  const dropped: DroppedFinding[] = [];
  let flagged = 0;
  for (const f of findings) {
    const verdicts = claimVerdicts(f, wb, options.rules);
    const drop = verdicts.find((v) => v.action === 'drop');
    if (drop) {
      dropped.push({ dimensionId: f.dimensionId, severity: f.severity, title: f.title, location: f.location, reportedBy: f.reportedBy, reason: drop.reason });
      continue;
    }
    const notes = verdicts.filter((v) => v.action === 'flag').map((v) => v.reason);
    if (notes.length === 0) {
      kept.push(f);
      continue;
    }
    flagged++;
    kept.push({ ...f, detail: `${f.detail} [Fact check: ${notes.join(' ')}]` });
  }
  const notes: string[] = [];
  if (dropped.length > 0) notes.push(`${dropped.length} finding(s) said a named field or id was not defined, but the file defines it; each is listed with the cell that has it under the dropped findings.`);
  if (flagged > 0) notes.push(`${flagged} finding(s) were kept with a fact-check note: the cell they cite says something else than they claim, or the file itself already marks the gap as open.`);
  return { findings: kept, dropped, flagged, notes };
}
