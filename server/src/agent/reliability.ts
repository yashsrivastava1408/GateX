import type { ReliabilityTable } from '@ddd/shared';
import type { DraftFinding } from './types.js';

/**
 * What the test library has measured about each examiner, used as a plain rule: a finding that only one examiner raised is set
 * aside when that examiner's model family has been right too rarely on its lone findings, once enough of them were checked
 * against the real file. A second examiner agreeing keeps the finding. Nothing here changes while a run is scoring: the table is
 * read once, it is data, and every set-aside finding is listed with this reason. A family with too few checked findings is
 * never filtered.
 */

export const MIN_SOLO_SAMPLES = 20;
export const SOLO_DROP_BELOW = 0.2;

export interface Examiner {
  id: string;
  family: string;
}

/** Why a finding raised by one examiner alone should be set aside, or null when it should stay. */
export function loneFindingReason(f: Pick<DraftFinding, 'source' | 'reportedBy'>, examiners: Examiner[], table?: ReliabilityTable): string | null {
  if (!table || f.source !== 'raters' || f.reportedBy.length !== 1) return null;
  const examiner = examiners.find((e) => e.id === f.reportedBy[0]);
  const solo = examiner ? table.families[examiner.family]?.solo : undefined;
  const minSamples = table.thresholds.minSamples;
  if (!examiner || !solo || solo.n < minSamples || solo.useful / solo.n >= table.thresholds.dropBelow) return null;
  return `Only examiner ${examiner.id} (${examiner.family}) reported it. Across ${solo.n} findings that ${examiner.family} alone reported and that were checked against the real files, ${solo.useful} were useful (${Math.round((solo.useful / solo.n) * 100)}%), so a lone finding from it is set aside. A second examiner agreeing would have kept it.`;
}
