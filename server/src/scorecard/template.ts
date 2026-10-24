import type { Scorecard } from '@ddd/shared';
import { scorecardToWorkbook } from './excel.js';

/**
 * The starter Excel scorecard offered for download. It is valid as it stands (so it can be tried
 * straight away) and shows both kinds of dimension: counted by code, and scored by the examiners.
 * Edit the sheet names, columns, weights and anchors to fit your own workbook.
 */
export const TEMPLATE_SCORECARD: Scorecard = {
  id: 'SC-MY-SCORECARD',
  name: 'My scorecard (edit me)',
  version: '1.0',
  gate: 'D1',
  frozen: true,
  approval: 'Starter template',
  thresholds: { accept: 75, refine: 60 },
  artifact: { sheets: [{ name: 'Tree', headerRow: 1 }], context: [] },
  dimensions: [
    {
      id: 'C01',
      name: 'Every row has a definition',
      weight: 40,
      critical: true,
      measuredBy: 'code',
      measure: 'Rows with a definition, as a share of all rows',
      check: {
        id: 'column_filled',
        params: { sheet: 'Tree', column: 'Definition' },
        bands: [{ min: 1, score: 5 }, { min: 0.97, score: 4 }, { min: 0.9, score: 3 }, { min: 0.75, score: 2 }, { min: 0.01, score: 1 }],
        fix: 'Write a one-sentence definition for each listed row.',
      },
    },
    {
      id: 'J01',
      name: 'A newcomer could fill it in unaided',
      weight: 40,
      critical: false,
      measuredBy: 'raters',
      measure: 'Could a new team member read it and know what to record, without asking?',
      anchors: {
        5: 'Every field says what to record, in what form, with an example where needed.',
        4: 'Almost all fields are clear; a few need a short explanation.',
        3: 'Most are clear, but several need the author to explain.',
        2: 'Many fields are ambiguous without help from the author.',
        1: 'A newcomer could not fill most of it in unaided.',
        0: 'Unusable without the author.',
      },
    },
    {
      id: 'J02',
      name: 'Decisions are explained',
      weight: 20,
      critical: true,
      measuredBy: 'raters',
      measure: 'Does the file record why each design decision was made, so the author could defend it?',
      anchors: {
        5: 'Every decision names the alternative rejected and why.',
        4: 'Almost every decision has a reason; one is thin.',
        3: 'Most decisions have a reason, several do not.',
        2: 'Only a few decisions are explained.',
        1: 'Decisions are listed with no reasons.',
        0: 'No decisions are recorded.',
      },
    },
  ],
};

export const buildScorecardTemplate = (): Promise<Buffer> => scorecardToWorkbook(TEMPLATE_SCORECARD);
