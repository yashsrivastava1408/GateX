import YAML from 'yaml';
import { scorecardFileSchema, type ScorecardFile } from '@ddd/shared';
import { callJsonModel, extractJson, type CallSettings } from '../agent/callModel.js';
import { serializeSheet } from '../excel/serialize.js';
import { WorkbookModel } from '../excel/workbook.js';
import { describeProfile, profileWorkbook, type WorkbookProfile } from '../excel/profile.js';
import { isPdf } from '../excel/pdfReader.js';
import type { ModelsConfig } from '../config.js';
import type { ProviderFactory } from '../llm/registry.js';
import type { LlmProvider } from '../llm/types.js';
import { UserError } from '../util/errors.js';
import { truncate } from '../util/text.js';
import { MAX_PAGES_PER_QUESTION, MAX_PAGES_ROOMY, QUESTION_TOKEN_BUDGET, checkDraft, draftToYaml, listQuestions, summarise, type Draft } from './importDraft.js';
import { buildImportUser, importSystem } from './importPrompt.js';

export { MAX_PAGES_PER_QUESTION, MAX_PAGES_ROOMY, checkDraft } from './importDraft.js';
export { IMPORT_MARKER } from './importPrompt.js';

/**
 * Turns a scorecard written in any layout into a scorecard in this app's format. A model reads it and proposes the
 * scorecard; code then checks it, fixes what it can and says what it changed. The result is frozen and used straight
 * away: nobody has to approve it. resolve.ts caches it, so the same scorecard is only converted once.
 */

const MAX_SOURCE_CHARS = 60_000;
const MAX_SHEET_CHARS = 24_000;
const MAX_OUTLINE_PAGES = 400;

export interface ImportInput {
  source: { name: string; bytes: Buffer };
  /** The file the scorecard will judge. Optional, but it lets the draft name real sheets or pages. */
  document?: { name: string; bytes: Buffer };
}

export interface ImportedQuestion {
  id: string;
  name: string;
  weight: number;
  critical: boolean;
  by: 'examiners' | 'code';
  reads: string[];
  /** For a count made by code: what it counts, in words. */
  how?: string;
  /** The question's criteria, each scored on its own and combined by the scorecard's rule. */
  criteria?: Array<{ id: string; name: string; by: 'examiners' | 'code'; how?: string }>;
}

export interface ImportResult {
  draft: ScorecardFile;
  /** One row per question, for the review table. */
  questions: ImportedQuestion[];
  yaml: string;
  /** Things the model was not sure about, for the reviewer to check first. */
  uncertain: string[];
  /** What code changed or dropped after the model answered. */
  adjustments: string[];
  summary: { dimensions: number; byExaminers: number; byCode: number; critical: number; weightTotal: number };
  /** What the model was shown, so the reviewer can compare. */
  sourceText: string;
  documentOutline: string | null;
  model: { id: string; provider: string; model: string };
  inputTokens: number | null;
  outputTokens: number | null;
}

const isBook = (name: string, bytes: Buffer) => /\.xlsx$/i.test(name) || isPdf(bytes);

/** The text of the scorecard as the model sees it. */
export async function readSourceText(source: { name: string; bytes: Buffer }): Promise<string> {
  if (!isBook(source.name, source.bytes)) return truncate(source.bytes.toString('utf8'), MAX_SOURCE_CHARS);
  const wb = await WorkbookModel.load(source.bytes);
  const parts: string[] = [];
  let used = 0;
  for (const name of wb.sheetNames()) {
    let text = serializeSheet(wb, name);
    if (text.length > MAX_SHEET_CHARS) text = `${text.slice(0, MAX_SHEET_CHARS)}\n[sheet cut here: too long to show in full]`;
    if (used + text.length > MAX_SOURCE_CHARS) {
      parts.push(`## Sheet: ${name}\n[left out: the file is too long to show in full]`);
      continue;
    }
    parts.push(text);
    used += text.length;
  }
  return parts.join('\n\n');
}

export interface DocumentOutline {
  text: string;
  kind: 'pdf' | 'excel';
  names: string[];
  pages: number;
  /** For a workbook: the file itself, and the header row found in each sheet (keyed by lower-case sheet name), so a proposed count can be tried out. */
  wb?: WorkbookModel;
  headerRows?: Map<string, number>;
  /** For a workbook: what every sheet and column holds, built once by code. */
  profile?: WorkbookProfile;
}

export { detectHeaderRow } from '../excel/profile.js';

/** A short map of the document the scorecard will judge: pages with their first line, or sheets with their headers. */
export async function outlineDocument(document: { name: string; bytes: Buffer }): Promise<DocumentOutline> {
  const wb = await WorkbookModel.load(document.bytes);
  const names = wb.sheetNames();
  if (isPdf(document.bytes)) {
    const lines = names.slice(0, MAX_OUTLINE_PAGES).map((name) => `${name}: ${truncate(wb.cellText(name, 'A1') ?? '', 90)}`);
    return { kind: 'pdf', names, pages: names.length, text: `PDF with ${names.length} pages. Sheets are named "Page 1" to "Page ${names.length}". First line of each page:\n${lines.join('\n')}` };
  }
  // The profile tells the model what each column holds and how full it is, not just its title, so a question can name the
  // right columns in any layout. It is computed once, from the file alone.
  const profile = profileWorkbook(wb);
  const headerRows = new Map(profile.sheets.map((sheet) => [sheet.name.toLowerCase(), sheet.headerRow]));
  return {
    kind: 'excel', names, pages: 0, wb, headerRows, profile,
    text: `Excel workbook. For each sheet: the row that holds its column titles, its size and its id column; then each column with its letter, title, what it holds, how full it is and examples:\n${describeProfile(profile)}`,
  };
}

export interface ImportDeps {
  /** Pages one question may read from a PDF. Defaults to the small-model limit. */
  maxPages?: number;
  /** Tokens of workbook text one question may read. Defaults to QUESTION_TOKEN_BUDGET. */
  tokenBudget?: number;
  provider: LlmProvider;
  model: { id: string; provider: string; model: string };
  settings: CallSettings;
}

/** `outline` may be passed in when the caller has already read the document, so it is not read twice. */
export async function importScorecard(input: ImportInput, deps: ImportDeps, known?: DocumentOutline | null, now = new Date()): Promise<ImportResult> {
  const sourceText = await readSourceText(input.source);
  if (sourceText.trim() === '') throw new UserError('That file has no readable text to import.');
  const outline = known !== undefined ? known : input.document ? await outlineDocument(input.document) : null;

  const call = await callJsonModel<Draft>({
    provider: deps.provider,
    model: deps.model.model,
    system: importSystem(deps.maxPages ?? MAX_PAGES_PER_QUESTION),
    user: buildImportUser(input.source.name, sourceText, outline),
    settings: { temperature: 0, maxOutputTokens: Math.max(deps.settings.maxOutputTokens, 16_000) },
    parse: (raw) => checkDraft(extractJson(raw), input.source.name, outline, deps.maxPages, deps.tokenBudget),
  });
  if (!call.ok || !call.value) {
    throw new UserError(`The model could not turn this into a usable scorecard. ${call.error ?? ''}`.trim(), 502);
  }
  const { file, uncertain, adjustments, trials } = call.value;
  file.scorecard.approval = `Converted automatically from ${input.source.name} by ${deps.model.provider}/${deps.model.model} on ${now.toISOString().slice(0, 10)}, checked by code`;
  const summary = summarise(file);
  if (summary.weightTotal !== 100) {
    adjustments.push(`The weights add up to ${summary.weightTotal}, not 100. Scores are worked out as a share of the total, so this still works, but check it matches the original.`);
  }
  return {
    draft: file,
    questions: listQuestions(file, trials),
    yaml: draftToYaml(file, input.source.name),
    uncertain,
    adjustments,
    summary,
    sourceText,
    documentOutline: outline?.text ?? null,
    model: deps.model,
    inputTokens: call.inputTokens,
    outputTokens: call.outputTokens,
  };
}

/**
 * The models that may read a scorecard: the first rater with no prompt limit (the most room), else the consolidator, then its
 * backups (a backup with no key is skipped). The page cap follows the roster: tight free-tier limits mean fewer pages per question.
 */
export function importCandidates(models: ModelsConfig, providers: ProviderFactory): ImportDeps[] {
  const chosen = models.raters.find((r) => !r.maxInputTokens) ?? models.consolidator;
  const tight = models.raters.some((r) => r.maxInputTokens !== undefined && r.maxInputTokens <= 20_000);
  const maxPages = tight ? MAX_PAGES_PER_QUESTION : MAX_PAGES_ROOMY;
  // A question must fit the tightest rater, leaving room for the instructions, the scorecard and the reply.
  const limits = models.raters.map((r) => r.maxInputTokens).filter((n): n is number => n !== undefined);
  const tokenBudget = limits.length > 0 ? Math.max(2_000, Math.min(QUESTION_TOKEN_BUDGET, Math.min(...limits) - 4_000)) : QUESTION_TOKEN_BUDGET;
  const settings = { temperature: models.settings.temperature, maxOutputTokens: models.settings.maxOutputTokens };
  return [{ provider: chosen.provider, model: chosen.model }, ...(chosen.fallbacks ?? [])].flatMap((c) => {
    try {
      return [{ maxPages, tokenBudget, settings, provider: providers(c.provider), model: { id: chosen.id, provider: c.provider, model: c.model } }];
    } catch {
      return [];
    }
  });
}

/** Tries each model in turn (the chosen one, then its backups) and keeps the first draft that works. */
export async function importWithFallbacks(input: ImportInput, candidates: ImportDeps[], outline?: DocumentOutline | null): Promise<ImportResult> {
  let last: unknown;
  for (const candidate of candidates) {
    try {
      return await importScorecard(input, candidate, outline);
    } catch (error) {
      // A bad file is the same for every model; only a model-side failure is worth trying the next one for.
      if (!(error instanceof UserError) || error.status !== 502) throw error;
      last = error;
    }
  }
  throw last;
}

/** Re-checks a scorecard someone edited by hand, and freezes it so it can be uploaded and used as it is. */
export function checkScorecardYaml(yamlText: string): { yaml: string; summary: ImportResult['summary'] } {
  let raw: unknown;
  try {
    raw = YAML.parse(yamlText);
  } catch (error) {
    throw new UserError(`The scorecard is not valid YAML: ${(error as Error).message}`);
  }
  const parsed = scorecardFileSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.slice(0, 12).map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new UserError(`The scorecard has problems:\n${lines.join('\n')}`);
  }
  const file = parsed.data;
  file.scorecard.frozen = true;
  return { yaml: YAML.stringify(file, { lineWidth: 110 }), summary: summarise(file) };
}
