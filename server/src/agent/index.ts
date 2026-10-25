/**
 * The Level 1 evaluator agent: public entry point.
 *
 * Everything the agent does lives in this folder. The rest of the application (API, CLI,
 * report renderer, database) talks to it only through the exports below.
 *
 *   evaluate()            run one evaluation: freeze, count, rate x3, consolidate, decide
 *   buildVerdictSection() the green / amber / red rule, applied to stored scores
 *   buildPathToGreen()    the smallest set of fixes that would change the verdict
 *   preflight()           before running: can enough raters take the prompt? (measures the real prompt)
 *   PROMPT_VERSION        version of the rater and consolidator prompts
 *   checkScorecardFit()   does the scorecard ask about things this kind of file cannot hold? (a note, never a block)
 *   analyseStability()    how much the same file's result moves between runs (reads saved reports)
 *
 * Start reading at orchestrator.ts; docs/agent.md walks through it.
 */
export { evaluate } from './orchestrator.js';
export type { EvaluateArgs, EvaluationOutput, ProgressEvent } from './orchestrator.js';
export { buildVerdictSection } from './verdict.js';
export { buildPathToGreen } from './pathToGreen.js';
export { preflight, MIN_RATERS } from './preflight.js';
export type { PreflightResult, RaterLimit } from './preflight.js';
export { PROMPT_VERSION } from './prompts/rater.js';
export { evaluateTwice, summariseTwoRuns } from './twoRuns.js';
export { checkScorecardFit, fitNote } from './fit.js';
export type { ScorecardFit } from './fit.js';
export { analyseStability, describeStability } from './stability.js';
export type { Stability, RunSummary as StabilityRun } from './stability.js';
