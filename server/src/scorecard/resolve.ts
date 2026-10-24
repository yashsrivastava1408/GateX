import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { WorkbookModel } from '../excel/workbook.js';
import { sha256 } from '../util/hash.js';
import { UserError, errorMessage } from '../util/errors.js';
import { importWithFallbacks, outlineDocument, type DocumentOutline, type ImportDeps, type ImportResult } from './importer.js';
import { IMPORT_VERSION } from './importPrompt.js';
import { parseScorecard, parseScorecardFile, type ParsedScorecard } from './parse.js';

/**
 * Turns whatever scorecard was uploaded into a frozen scorecard the agent can use, with nobody in the loop.
 *
 *   - A scorecard already in this app's format (YAML/JSON with a `scorecard:` key, or the app's Excel layout with the
 *     sheets Scorecard, Sheets and Dimensions) is read as it is, and its own mistakes are reported.
 *   - Anything else (a GS-1 workbook, a CSV, a PDF, a text rubric) is converted by one model call, checked by code,
 *     frozen by its hash and used straight away.
 *
 * Conversions are cached on disk by the scorecard's bytes and the shape of the file it judges, so every iteration of a
 * project is marked against the identical scorecard (same hash) and the model is only called once per scorecard.
 * Two submissions of the same scorecard at the same moment share one conversion.
 */

export interface ScorecardSource {
  name: string;
  bytes: Buffer;
}

export interface Conversion {
  /** The uploaded file the scorecard came from. */
  from: string;
  model: ImportResult['model'];
  /** True when an earlier conversion of the same scorecard was reused (no model call). */
  cached: boolean;
  convertedAt: string;
  uncertain: string[];
  adjustments: string[];
  /** The converted scorecard, as YAML in this app's format. */
  yaml: string;
}

export interface ResolvedScorecard extends ParsedScorecard {
  /** Set when the scorecard was converted from another layout. */
  conversion: Conversion | null;
}

/** What the cache keeps for one conversion: the full import result, so a cached preview looks exactly like a fresh one. */
interface CacheEntry {
  version: string;
  convertedAt: string;
  result: Omit<ImportResult, 'draft'>;
}

const APP_EXCEL_SHEETS = ['scorecard', 'sheets', 'dimensions'];

/** Is this file meant to be in the app's own format? Then its errors are real errors, not a reason to convert it. */
export async function isAppFormat(source: ScorecardSource): Promise<boolean> {
  if (/\.xlsx$/i.test(source.name)) {
    try {
      const names = new Set((await WorkbookModel.load(source.bytes)).sheetNames().map((n) => n.trim().toLowerCase()));
      return APP_EXCEL_SHEETS.every((n) => names.has(n));
    } catch {
      return false;
    }
  }
  if (/\.(ya?ml|json)$/i.test(source.name)) {
    try {
      const raw = YAML.parse(source.bytes.toString('utf8')) as unknown;
      return Boolean(raw && typeof raw === 'object' && !Array.isArray(raw) && 'scorecard' in raw);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * The parts of the judged file a conversion depends on: its sheet names, or for a PDF its page count. Row counts are left
 * out on purpose, so adding rows in the next iteration reuses the same scorecard.
 */
export function documentShape(outline: DocumentOutline | null): string {
  if (!outline) return 'none';
  return outline.kind === 'pdf' ? `pdf:${outline.pages}` : `xlsx:${[...outline.names].map((n) => n.toLowerCase()).sort().join('|')}`;
}

export const conversionKey = (source: ScorecardSource, outline: DocumentOutline | null): string =>
  sha256([IMPORT_VERSION, sha256(source.bytes), documentShape(outline)].join('\n')).slice(0, 32);

export interface ScorecardResolverOptions {
  /** Where converted scorecards are kept (one JSON file each). Omit to keep them in memory only. */
  cacheDir?: string;
  /** The models that may read a scorecard, first choice first. Called only when a conversion is needed. */
  candidates: () => ImportDeps[];
  now?: () => Date;
  log?: (message: string) => void;
}

export class ScorecardResolver {
  private readonly memory = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<CacheEntry>>();

  constructor(private readonly options: ScorecardResolverOptions) {}

  /** The scorecard to evaluate `document` against, converting it first when it is in another layout. */
  async resolve(source: ScorecardSource, document?: ScorecardSource): Promise<ResolvedScorecard> {
    if (await isAppFormat(source)) return { ...(await parseScorecardFile(source.bytes, source.name)), conversion: null };
    const { entry, cached } = await this.convertCached(source, document);
    return { ...parseScorecard(entry.result.yaml, source.name), conversion: toConversion(source.name, entry, cached) };
  }

  /**
   * The scorecard, without ever calling a model: one in the app's format is read, one in another layout is returned only
   * if it was already converted (in memory or on disk). Null when it would need a conversion.
   */
  async lookup(source: ScorecardSource, document?: ScorecardSource): Promise<ResolvedScorecard | null> {
    if (await isAppFormat(source)) return { ...(await parseScorecardFile(source.bytes, source.name)), conversion: null };
    const key = conversionKey(source, document ? await outlineDocument(document) : null);
    const entry = this.memory.get(key) ?? (await this.readDisk(key));
    if (!entry) return null;
    this.memory.set(key, entry);
    return { ...parseScorecard(entry.result.yaml, source.name), conversion: toConversion(source.name, entry, true) };
  }

  /** Converts a scorecard in another layout (or returns the cached conversion), for the preview page. */
  async preview(source: ScorecardSource, document?: ScorecardSource): Promise<ImportResult & { cached: boolean }> {
    const { entry, cached } = await this.convertCached(source, document);
    const draft = YAML.parse(entry.result.yaml) as ImportResult['draft'];
    return { ...entry.result, draft, cached };
  }

  private async convertCached(source: ScorecardSource, document?: ScorecardSource): Promise<{ entry: CacheEntry; cached: boolean }> {
    const outline = document ? await outlineDocument(document) : null;
    const key = conversionKey(source, outline);

    const known = this.memory.get(key) ?? (await this.readDisk(key));
    if (known) {
      this.memory.set(key, known);
      return { entry: known, cached: true };
    }
    const running = this.inFlight.get(key);
    if (running) return { entry: await running, cached: true };

    const job = this.convert(source, document, outline, key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, job);
    return { entry: await job, cached: false };
  }

  private async convert(source: ScorecardSource, document: ScorecardSource | undefined, outline: DocumentOutline | null, key: string): Promise<CacheEntry> {
    const candidates = this.options.candidates();
    if (candidates.length === 0) {
      throw new UserError('No model is ready to read this scorecard. Check the keys with "npm run models:check".', 409);
    }
    const started = Date.now();
    const { draft: _draft, ...result } = await importWithFallbacks({ source, ...(document ? { document } : {}) }, candidates, outline);
    const entry: CacheEntry = { version: IMPORT_VERSION, convertedAt: (this.options.now?.() ?? new Date()).toISOString(), result };
    this.memory.set(key, entry);
    await this.writeDisk(key, entry);
    this.options.log?.(`scorecard ${source.name} converted by ${result.model.provider}/${result.model.model} in ${Math.round((Date.now() - started) / 1000)} s`);
    return entry;
  }

  private file(key: string): string | null {
    return this.options.cacheDir ? path.join(this.options.cacheDir, `${key}.json`) : null;
  }

  private async readDisk(key: string): Promise<CacheEntry | null> {
    const file = this.file(key);
    if (!file) return null;
    try {
      const entry = JSON.parse(await readFile(file, 'utf8')) as CacheEntry;
      if (entry.version !== IMPORT_VERSION || typeof entry.result?.yaml !== 'string') return null;
      // A cached file that no longer parses (edited by hand, or written by an older version) is converted again.
      parseScorecard(entry.result.yaml);
      return entry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.options.log?.(`ignoring cached scorecard ${file}: ${errorMessage(error)}`);
      return null;
    }
  }

  /** Written to a temporary name first, so a crash mid-write never leaves half a file that later reads as the scorecard. */
  private async writeDisk(key: string, entry: CacheEntry): Promise<void> {
    const file = this.file(key);
    if (!file) return;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, JSON.stringify(entry, null, 2));
      await rename(temp, file);
    } catch (error) {
      // The conversion is still used for this run; only the reuse next time is lost.
      this.options.log?.(`could not cache the converted scorecard: ${errorMessage(error)}`);
    }
  }
}

function toConversion(from: string, entry: CacheEntry, cached: boolean): Conversion {
  return {
    from,
    model: entry.result.model,
    cached,
    convertedAt: entry.convertedAt,
    uncertain: entry.result.uncertain,
    adjustments: entry.result.adjustments,
    yaml: entry.result.yaml,
  };
}

/** One line for the run notes, saying where the scorecard came from. */
export function conversionNote(conversion: Conversion): string {
  const by = `${conversion.model.provider}/${conversion.model.model} on ${conversion.convertedAt.slice(0, 10)}`;
  const how = conversion.cached ? `the conversion made automatically by ${by} was reused` : `it was converted automatically by ${by}`;
  return `The scorecard ${conversion.from} is not in this app's format, so ${how}, checked by code. Every iteration with the same scorecard uses the identical conversion.`;
}

/** Accepts the upload types a scorecard may come in. */
export const SCORECARD_TYPES = /\.(xlsx|ya?ml|json|csv|pdf|txt|md)$/i;
