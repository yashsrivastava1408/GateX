import type { CostLine, RunCost } from './types.js';

const grouped = (n: number) => n.toLocaleString('en-US');
const money = (n: number, currency: string) => `${currency === 'USD' ? '$' : `${currency} `}${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;

/** One line for a report: "This check used 1,204,300 tokens in and 31,200 out. Estimated cost $1.82." (tokens only when no price is known). */
export function costSentence(cost: RunCost): string {
  const tokens = `This check used ${grouped(cost.inputTokens)} tokens in and ${grouped(cost.outputTokens)} out`;
  if (cost.totalCost === null || !cost.currency) return `${tokens}.`;
  return `${tokens}. ${cost.complete ? 'Estimated cost' : 'Estimated cost of the models with a price'}: ${money(cost.totalCost, cost.currency)}.`;
}

export const costCell = (line: CostLine, currency: string | null): string => (line.cost === null || !currency ? '' : money(line.cost, currency));
