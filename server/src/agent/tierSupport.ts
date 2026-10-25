import type { DimensionResult, Finding } from '@ddd/shared';

/**
 * A finding about a question that was marked 5 in the end.
 *
 * Step 3 on the correct scorecard: three examiners "independently" raised a HIGH finding that sections lack depth, which made it Confirmed and put it at the
 * top of the report ("Needs attention: 1 high-risk finding"). But the same report marked that question 5 out of 5, and its own anchor for 5 is "fully specified,
 * no outcome-changing gap". The report said both things; the file (every section does have its lowest level) said the mark was right.
 *
 * Measured on the 171 labelled findings kept by the filters (`npm run tiers:measure -- --full-mark`): of the 46 examiner findings about a question the final mark
 * gave 5 (any severity), 0 were real, 12 partly right, 12 wrong and 22 vague. Moving them from Confirmed to Worth a look loses no real finding
 * (Confirmed keeps 23 of 23 real). They stay in the report, with the reason.
 */
export const FULL_MARK = 4.5;

/** True when the finding comes from the examiners and its question's final mark (the dimension's, as combined from its criteria) is 5. Findings found by code are never moved. */
export function aboutAFullMarkQuestion(finding: Pick<Finding, 'source' | 'dimensionId'>, dimensions: DimensionResult[]): boolean {
  if (finding.source !== 'raters') return false;
  const dimension = dimensions.find((d) => d.id === finding.dimensionId);
  return Boolean(dimension && dimension.status === 'scored' && dimension.consolidated !== null && dimension.consolidated >= FULL_MARK);
}
