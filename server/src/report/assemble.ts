import { confirmedFirst, tierFindings, tierFor, type AgreementRow, type EvaluationCore, type Finding, type NotMeasurableItem, type Override, type Report, type Resolution } from '@ddd/shared';
import { buildCost, type PriceTable } from './cost.js';
import { buildPathToGreen, buildVerdictSection } from '../agent/index.js';

const RESOLUTION_NOTE: Record<Resolution, string> = {
  agreement: 'The raters agree within one point.',
  claims_checked: 'The raters differed by more than one point; the consolidator checked each claim against the artifact.',
  lower_stands: 'The disagreement could not be resolved from the artifact, so the lower score stands. Flagged as uncertain.',
  single_rater: 'Only one rater produced a supported score, so it is a single opinion. Flagged as uncertain.',
  code: 'Measured by code.',
  none: '',
};

/**
 * Builds the eight-section report (PDF page 11). The evaluation itself never changes; the verdict and the
 * path to green are recomputed from it, so an optional override shows up straight away.
 */
export function assembleReport(core: EvaluationCore, override: Override | null, prices?: PriceTable): Report {
  // Findings saved before tiers existed get theirs here from the same rule. Confirmed findings come first and are the only ones the headline counts.
  const all: Finding[] = confirmedFirst(core.findings.some((f) => !f.tier) ? tierFindings(core.findings) : core.findings);
  const confirmed = all.filter((f) => tierFor(f) === 'confirmed');
  const cost = buildCost(core.usage, prices);
  const agreement: AgreementRow[] = core.dimensions
    .filter((dim) => dim.measuredBy === 'raters')
    .map((dim) => ({
      dimensionId: dim.id,
      name: dim.name,
      scores: dim.raterScores,
      spread: dim.spread,
      resolution: dim.resolution,
      flagged: dim.flagged,
      note: dim.status === 'scored' ? RESOLUTION_NOTE[dim.resolution] : dim.rationale,
    }));

  const treatment = core.scorecard.unmeasured === 'zero' ? 'zero' : 'skipped';
  const notMeasurable: NotMeasurableItem[] = core.dimensions
    .filter((dim) => dim.measuredBy === 'human' || dim.status === 'not_measurable')
    .map((dim) => ({
      dimensionId: dim.id,
      name: dim.name,
      critical: dim.critical,
      weight: dim.weight,
      reason: dim.rationale || 'The examiners found nothing in the file that measures this.',
      treatment,
    }));

  const verdict = buildVerdictSection(core.scorecard, core.dimensions, override, confirmed, core.twoRuns);
  // A score from two examiners is not a score from three: say so next to the colour, not only in the run notes.
  const lost = core.notes.map((n) => /^Rater (\w+) \(.*\) failed and was left out/.exec(n)?.[1]).filter((id): id is string => Boolean(id));
  if (lost.length > 0) {
    verdict.reasons.push(`Needs attention: examiner${lost.length === 1 ? '' : 's'} ${lost.join(', ')} failed and ${lost.length === 1 ? 'was' : 'were'} left out, so this score rests on ${core.header.raters.length - lost.length} of ${core.header.raters.length} examiners. Run it again before relying on it.`);
  }
  return {
    header: core.header,
    verdict,
    dimensions: core.dimensions,
    strengths: core.strengths,
    findings: all,
    tiers: { confirmed: confirmed.length, worthALook: all.length - confirmed.length },
    agreement,
    notMeasurable,
    pathToGreen: buildPathToGreen(core.scorecard, core.dimensions, confirmed),
    notes: core.notes,
    ...(cost ? { cost } : {}),
    ...(core.twoRuns ? { twoRuns: core.twoRuns } : {}),
    ...(core.droppedFindings && core.droppedFindings.length > 0 ? { droppedFindings: core.droppedFindings } : {}),
  };
}
