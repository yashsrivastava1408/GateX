import type { ModelRef, UsageLine } from '@ddd/shared';

interface CallLike { model: ModelRef; role: 'rater' | 'consolidator'; attempts: number; inputTokens: number | null; outputTokens: number | null }
interface CheckUsage { model?: string; calls?: number; inputTokens: number; outputTokens: number }

/**
 * Tokens used in a run, per model: each examiner, the final reviewer, and the fact-check calls. Examiners are listed under their own id
 * (A, B, C) so the report can say "Examiner 1"; the fact-check calls are pooled under "checks" with the model that answered.
 * Calls that reported no token count add nothing, so the numbers can be lower than the real use but never invented.
 */
export function usageOf(calls: CallLike[], verification: CheckUsage | undefined, consolidator: ModelRef, presence?: CheckUsage): UsageLine[] {
  const lines: UsageLine[] = calls.map((c) => ({
    id: c.role === 'consolidator' ? 'K' : c.model.id,
    model: c.model.model,
    calls: Math.max(1, c.attempts),
    inputTokens: c.inputTokens ?? 0,
    outputTokens: c.outputTokens ?? 0,
  }));
  for (const u of [presence, verification]) {
    if (!u || (u.inputTokens === 0 && u.outputTokens === 0)) continue;
    lines.push({ id: 'checks', model: u.model ?? consolidator.model, calls: Math.max(1, u.calls ?? 1), inputTokens: u.inputTokens, outputTokens: u.outputTokens });
  }
  return lines;
}
