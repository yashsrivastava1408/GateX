import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { examinerLabel, type CostLine, type RunCost, type UsageLine } from '@ddd/shared';

export { costCell, costSentence } from '@ddd/shared';

/** Price per million tokens for a model id. A model with no entry has no price and is shown with its tokens only. */
export interface PriceTable {
  currency: string;
  perMillionTokens: Record<string, { input: number; output: number }>;
}

const EMPTY: PriceTable = { currency: 'USD', perMillionTokens: {} };

/** server/config/prices.json (or PRICES_CONFIG). Missing or unreadable means no prices, never an error. */
export function loadPrices(env: NodeJS.ProcessEnv = process.env): PriceTable {
  const serverDir = path.resolve(import.meta.dirname, '../..');
  const file = env.PRICES_CONFIG ? path.resolve(env.PRICES_CONFIG) : path.join(serverDir, 'config', 'prices.json');
  try {
    if (!existsSync(file)) return EMPTY;
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<PriceTable>;
    const entries = Object.entries(raw.perMillionTokens ?? {}).filter(([, p]) => p && Number.isFinite(p.input) && Number.isFinite(p.output) && p.input >= 0 && p.output >= 0);
    return { currency: typeof raw.currency === 'string' && raw.currency ? raw.currency : 'USD', perMillionTokens: Object.fromEntries(entries) };
  } catch {
    return EMPTY;
  }
}

const labelOf = (id: string): string => (id === 'checks' ? 'Fact checks' : examinerLabel(id));
const priceOf = (table: PriceTable, model: string) => table.perMillionTokens[model] ?? table.perMillionTokens[model.replace(/^(?:us|eu|apac|global)\./, '')];

/** The run's cost table: tokens in and out per model, plus a price where the table has one. Null when the run recorded no usage. */
export function buildCost(usage: UsageLine[] | undefined, prices: PriceTable = loadPrices()): RunCost | null {
  const used = (usage ?? []).filter((u) => u.inputTokens > 0 || u.outputTokens > 0);
  if (used.length === 0) return null;
  const lines: CostLine[] = used.map((u) => {
    const p = priceOf(prices, u.model);
    return {
      label: labelOf(u.id),
      model: u.model,
      calls: u.calls,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cost: p ? (u.inputTokens * p.input + u.outputTokens * p.output) / 1_000_000 : null,
    };
  });
  const priced = lines.filter((l) => l.cost !== null);
  return {
    lines,
    inputTokens: lines.reduce((a, l) => a + l.inputTokens, 0),
    outputTokens: lines.reduce((a, l) => a + l.outputTokens, 0),
    totalCost: priced.length > 0 ? priced.reduce((a, l) => a + (l.cost ?? 0), 0) : null,
    currency: priced.length > 0 ? prices.currency : null,
    complete: priced.length === lines.length,
  };
}
