/** Every word GateX uses to explain itself, in one place. The rule: short everyday words, no jargon, no codes. */
import type { Decision, DimensionResult, MeasuredBy, Resolution, Severity } from '@ddd/shared';

export const VERDICT: Record<Decision, { label: string; headline: string; body: string }> = {
  green: {
    label: 'Green',
    headline: 'Looks good',
    body: 'This passes. It can move on to the next step.',
  },
  amber: {
    label: 'Amber',
    headline: 'Almost there',
    body: 'Fix the issues below, then check it again.',
  },
  red: {
    label: 'Red',
    headline: 'Not there yet',
    body: 'The score is too low. Work through the issues below, then check it again.',
  },
};

/** Terms that need a one-line explanation. `help` is shown as a tooltip next to the term. */
export const TERMS = {
  mustPass: {
    label: 'Key checks',
    help: 'These matter most. Each needs 4 out of 5 or more. If one is lower, the result cannot be green, however high the total score is.',
  },
  importance: {
    label: 'Importance',
    help: 'How much this check counts towards the total score. A check with importance 10 counts twice as much as one with 5.',
  },
  disagreement: {
    label: 'Disagreement',
    help: 'How far apart the examiners’ scores are. 0 means they all gave the same score.',
  },
  examiner: {
    label: 'Examiner',
    help: 'Marks your work on its own, without seeing the other examiners. Three examiners mark every question that needs judgement.',
  },
  finalReviewer: {
    label: 'Final reviewer',
    help: 'Compares the three examiners’ scores and settles any difference. It cannot invent a score outside what they gave.',
  },
  score: {
    label: 'Score',
    help: 'Out of 5. Green means 4 or 5, amber 3, red 2 or less.',
  },
} as const;

export const METHOD: Record<MeasuredBy, { label: string; group: string; blurb: string }> = {
  code: {
    label: 'Computer',
    group: 'Checked by the computer',
    blurb: 'Counted exactly, so there is no guessing and the same file always gives the same answer.',
  },
  raters: {
    label: 'Examiners',
    group: 'Scored by the examiners',
    blurb: 'Judgement calls. Three examiners score each one on their own, and every score has to point at a real place in your file.',
  },
  // Older checks can have these; new scorecards give such questions to the examiners.
  human: {
    label: 'Not in the file',
    group: 'Not in the file',
    blurb: 'Questions the file gave nothing to measure. They are left out of the score.',
  },
};

export const SEVERITY: Record<Severity, { label: string; plural: string; help: string }> = {
  HIGH: { label: 'Must fix', plural: 'must fix', help: 'Fix this first. It does not change the colour, but it matters most.' },
  MEDIUM: { label: 'Should fix', plural: 'should fix', help: 'Fix this in this round.' },
  LOW: { label: 'Nice to fix', plural: 'nice to fix', help: 'A nice improvement for when you have time.' },
};

export const RESOLUTION: Record<Resolution, { label: string; tone: 'green' | 'accent' | 'amber' | 'muted'; text: string }> = {
  agreement: { label: 'Agreed', tone: 'accent', text: 'All the examiners were within one point of each other.' },
  claims_checked: {
    label: 'Settled',
    tone: 'accent',
    text: 'They differed by more than one point, so the final reviewer checked each point against your file.',
  },
  lower_stands: {
    label: 'Lower score kept',
    tone: 'amber',
    text: 'They differed and the file could not settle it, so the lower score was kept.',
  },
  single_rater: { label: 'One examiner only', tone: 'amber', text: 'Only one examiner gave a usable score. Check again to bring in the others.' },
  code: { label: 'Counted', tone: 'muted', text: 'Counted by the computer.' },
  none: { label: '—', tone: 'muted', text: '' },
};

/** What to show in the "status" column of the scores table. */
export function statusOf(d: DimensionResult): { label: string; tone: 'green' | 'accent' | 'amber' | 'red' | 'muted' | 'blue'; help: string } {
  if (d.status === 'unscored') return { label: 'Could not be scored', tone: 'red', help: d.error ?? 'No examiner gave a score that pointed at a real place in your file, so it counts as 0.' };
  if (d.status === 'not_measurable') return { label: 'Not in the file', tone: 'muted', help: 'The examiners found nothing in your file to measure this, so it is not scored.' };
  if (d.flagged) return { label: 'Uncertain', tone: 'amber', help: RESOLUTION[d.resolution].text };
  if (d.measuredBy === 'code') return { label: 'Checked', tone: 'blue', help: METHOD.code.blurb };
  if (d.confidence === 'shaky') return { label: 'Scores differ', tone: 'amber', help: 'The examiners gave scores more than a point apart. Take this score with care.' };
  return { label: 'Examiners agreed', tone: 'accent', help: RESOLUTION[d.resolution].text };
}

/** The stages of a run, in plain words. */
export const STAGES = [
  { stage: 'reading', title: 'Reading your files', detail: 'Opening your file and the scorecard, and making a note of each so we can show they were not changed' },
  { stage: 'checks', title: 'Checking the facts', detail: 'Counting what can be counted exactly: blanks, repeats and allowed values' },
  { stage: 'rating', title: 'Three examiners mark it', detail: 'Each one marks the questions that need judgement, alone' },
  { stage: 'consolidating', title: 'Final review', detail: 'The final reviewer compares the three sets of marks' },
  { stage: 'reporting', title: 'Writing the report', detail: 'A fixed rule decides the result, then your report and the steps to green are written' },
] as const;

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The server writes its reasons in technical words; this softens them without changing what they say. */
export const friendlyReason = (text: string): string =>
  text
    .replace(/Critical gate/g, 'Key check')
    .replace(/Must-pass check/g, 'Key check')
    .replace(/(\d+) high-risk (?:findings?|issues?) blocks? green until fixed/g, (_m, n: string) => `${n} must-fix ${n === '1' ? 'issue blocks' : 'issues block'} green until fixed`);
