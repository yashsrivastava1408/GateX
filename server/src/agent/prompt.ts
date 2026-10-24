import type { DimensionSpec, Scorecard } from '@ddd/shared';
import { serializeSheets } from '../excel/serialize.js';
import type { WorkbookModel } from '../excel/workbook.js';
import { buildRaterUser } from './prompts/rater.js';
import { planSections, type EvalSection } from './sectionPlanner.js';
import { withSupportingRows } from './supporting.js';
import { expandCriteria } from './aggregate.js';
import { withAutoReads } from './autoReads.js';

export interface RaterPrompt {
  /** The dimensions the raters (not code, not a person) score. */
  rated: DimensionSpec[];
  /** The judged sheets as text with cell addresses; the consolidator is sent the same text. */
  artifactText: string;
  /** What every rater receives. */
  user: string;
}

/**
 * The one place that builds what the raters are sent. The orchestrator uses it to run an evaluation and
 * the pre-submit check uses it to measure one, so the size that is checked is the size that is sent.
 */
export function buildRaterPrompt(input: {
  scorecard: Scorecard;
  wb: WorkbookModel;
  sources: string;
  instructions?: string;
}): RaterPrompt {
  const { scorecard, wb } = input;
  const rated = scorecard.dimensions.filter((d) => d.measuredBy === 'raters');
  const artifactText = serializeSheets(wb, scorecard.artifact.sheets);
  const user = buildRaterUser({
    scorecard,
    dimensions: rated,
    artifactText,
    contextText: serializeSheets(wb, scorecard.artifact.context),
    sources: input.sources,
    instructions: input.instructions,
  });
  return { rated, artifactText, user };
}

/**
 * Builds the rater prompt for a single section produced by `planSections`.
 * Only the sheets declared in the section are serialised — this is what keeps
 * the token count small. The scorecard metadata (id, name, thresholds) is still
 * sent in full so the rater has context.
 */
export function buildRaterPromptForSection(input: {
  scorecard: Scorecard;
  section: EvalSection;
  wb: WorkbookModel;
  sources: string;
  instructions?: string;
}): RaterPrompt {
  const { scorecard, section, wb } = input;
  const artifactText = serializeSheets(wb, section.sheets);
  const contextText = serializeSheets(wb, section.context);
  const user = buildRaterUser({
    scorecard,
    dimensions: section.dimensions,
    artifactText,
    contextText,
    sources: input.sources,
    instructions: input.instructions,
    workbookSheets: wb.sheetNames(),
  });
  return { rated: section.dimensions, artifactText, user };
}


/** Every prompt an evaluation will send to each rater: one per section, or one for the whole workbook. */
export function buildAllRaterPrompts(input: {
  scorecard: Scorecard;
  wb: WorkbookModel;
  sources: string;
  instructions?: string;
  /** The smallest prompt limit among the examiners: supporting rows are cut to fit beside the sections. */
  limit?: number;
}): Array<{ label: string; prompt: RaterPrompt }> {
  // Measured on the scorecard as it is run: every criterion a question of its own.
  const scorecard = withAutoReads(expandCriteria(input.scorecard), input.wb).scorecard;
  const sections = withSupportingRows(planSections(scorecard), input.wb, { limit: input.limit });
  if (sections.length === 0) return [{ label: 'full workbook', prompt: buildRaterPrompt({ ...input, scorecard }) }];
  return sections.map((section) => ({ label: section.label, prompt: buildRaterPromptForSection({ ...input, scorecard, section }) }));
}
