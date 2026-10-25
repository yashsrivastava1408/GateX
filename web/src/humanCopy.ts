/** The words of the accuracy page, the "Compare with a person" panel and the right / wrong marks on issues. Short everyday words, no codes. */
import type { MeasureStatus } from '@ddd/shared';

export const ACCURACY = {
  eyebrow: 'Proof',
  title: 'Accuracy',
  intro:
    'How close GateX is to a person. The figures follow the Roadmap: scores near a person’s, the same colour as a person, never green when a person says no, steady when run again, and few wrong issues. Each figure comes from one kind of source only, and says so.',
  peopleTitle: 'From people',
  peopleHint: 'Scores, colours and right / wrong marks that a person gave. This is the proof the Roadmap asks for.',
  peopleNone:
    'No person has marked anything yet, so none of these figures can be judged. Open a finished check and use “Compare with a person”, tick issues as right or wrong, or ask a teammate to fill in the spot-check sheet.',
  selfTitle: 'Needs no person',
  selfHint: 'GateX against itself: does the same file get the same colour when it is checked again?',
  standinTitle: 'AI stand-in (not a human check)',
  standinHint:
    'An AI marked these, not a person. They show where GateX may be off, but they are not proof. Do not quote them as human agreement.',
  sourcesTitle: 'Where the numbers come from',
  byStep: 'By step',
  target: 'Target',
  needs: (n: number, files: number) => `needs ${n} or more from ${files} or more different files`,
  has: (n: number, files: number) => `has ${n} from ${files} ${files === 1 ? 'file' : 'files'}`,
  status: {
    pass: 'On target',
    fail: 'Below target',
    not_enough_data: 'Not enough data yet',
  } as Record<MeasureStatus, string>,
  source: { human: 'Person', 'ai-standin': 'AI stand-in', self: 'GateX against itself' } as Record<string, string>,
  totals: (t: { scores: number; verdicts: number; labels: number; reviews: number }) =>
    `People so far: ${t.scores} question marks, ${t.verdicts} colours, ${t.labels} issues marked right or wrong, ${t.reviews} ${t.reviews === 1 ? 'review' : 'reviews'} in the app.`,
};

export const REVIEW = {
  title: 'Compare with a person',
  hint: 'Give your own mark for each area, without looking at GateX’s. Saved next to GateX’s marks, they show how close it is. Nothing here changes the result.',
  name: 'Your name',
  colour: 'Your colour for the whole file (optional)',
  colourAuto: 'Work it out from my marks',
  note: 'A note (optional)',
  save: 'Save my marks',
  saved: 'Saved. Thank you.',
  need: 'Give at least one mark, and your name.',
  earlier: 'Earlier reviews of this check',
  gatex: 'GateX',
  you: 'You',
  gap: 'Gap',
  close: 'Close',
  far: 'Far apart',
  none: 'No marks yet.',
  markHint: '0 is nothing there, 5 is excellent',
};

export const FEEDBACK = {
  ask: 'Is this issue right?',
  right: 'Right',
  wrong: 'Wrong',
  unclear: 'Unclear',
  name: 'Your name',
  needName: 'Add your name to mark an issue.',
  thanks: 'Saved',
  counts: (right: number, wrong: number, unclear: number) => {
    const parts = [right ? `${right} say right` : '', wrong ? `${wrong} say wrong` : '', unclear ? `${unclear} say unclear` : ''].filter(Boolean);
    return parts.length ? parts.join(' · ') : 'Nobody has marked this yet';
  },
};
