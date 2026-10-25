import type { CellRef, Evidence, ModelRef, ReturnTo, Severity } from '@ddd/shared';

export interface RaterDimension {
  id: string;
  /** null when the rater abstained (not measurable) or its score was discarded. */
  score: number | null;
  notMeasurable: boolean;
  anchor?: string;
  rationale: string;
  evidence: Evidence[];
  /** When a rater scored this more than once: highest minus lowest score across the repeats. */
  repeatSpread?: number;
}

export interface RaterFinding {
  /** Reference the consolidator uses, e.g. "A3". */
  ref: string;
  raterId: string;
  dimensionId: string;
  severity: Severity;
  title: string;
  detail: string;
  fix: string;
  returnTo: ReturnTo;
  location: CellRef | null;
}

export interface RaterStrength {
  raterId: string;
  dimensionId: string;
  text: string;
  location: CellRef | null;
}

export interface Discarded {
  kind: 'dimension' | 'finding' | 'strength' | 'reply';
  id?: string;
  reason: string;
}

export interface CallMeta {
  model: ModelRef;
  role: 'rater' | 'consolidator';
  status: 'ok' | 'failed';
  prompt: string;
  promptHash: string;
  rawResponse: string;
  attempts: number;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  error?: string;
}

export interface RaterOutcome extends CallMeta {
  dimensions: RaterDimension[];
  findings: RaterFinding[];
  strengths: RaterStrength[];
  discarded: Discarded[];
}

/** A finding before it gets its final id and position in the report. */
export interface DraftFinding {
  source: 'code' | 'raters';
  dimensionId: string;
  severity: Severity;
  title: string;
  detail: string;
  fix: string;
  returnTo: ReturnTo;
  location: CellRef | null;
  reportedBy: string[];
  /** Set by code when it read the file and the claim holds (for example the cells the finding names are empty). Not set for a judgement. */
  proof?: string;
}
