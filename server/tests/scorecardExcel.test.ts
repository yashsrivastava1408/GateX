import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { scorecardToWorkbook } from '../src/scorecard/excel.js';
import { parseScorecard, parseScorecardFile } from '../src/scorecard/parse.js';
import { makeWorkbook } from './helpers.js';

type Cell = string | number | null;

const SETTINGS: Cell[][] = [['Setting', 'Value'], ['id', 'SC-X'], ['version', '1.0'], ['judges', 'D1 schema design'], ['frozen', 'yes']];
const SHEETS: Cell[][] = [['Sheet', 'Header row', 'Columns', 'Role'], ['Tree', 1, 'Path id, Definition', 'judged'], ['Playbook', 4, null, 'context']];
const DIM_HEADER: Cell[] = ['ID', 'Name', 'Weight', 'Critical', 'Measured by', 'Check', 'Params', 'Bands', 'Anchor 5', 'Anchor 4', 'Anchor 3', 'Anchor 2', 'Anchor 1', 'Anchor 0', 'Needs'];
const CODE: Cell[] = ['C01', 'Every node is defined', 40, 'yes', null, 'column_filled', '{"sheet": "Tree", "column": "Definition"}', 'strict', null, null, null, null, null, null, null];
const RATER: Cell[] = ['J01', 'Readable', 40, null, null, null, null, null, 'great', 'good', 'ok', 'weak', 'poor', 'none', null];
const HUMAN: Cell[] = ['H01', 'Interview', 20, 'yes', 'human', null, null, null, null, null, null, null, null, null, 'A scored interview'];

async function excelScorecard(parts: Partial<Record<'Scorecard' | 'Sheets' | 'Dimensions', Cell[][]>> = {}) {
  const sheets: Record<string, Cell[][]> = {
    Scorecard: parts.Scorecard ?? SETTINGS,
    Sheets: parts.Sheets ?? SHEETS,
    Dimensions: parts.Dimensions ?? [DIM_HEADER, CODE, RATER, HUMAN],
  };
  return makeWorkbook(sheets);
}

const parse = async (parts?: Parameters<typeof excelScorecard>[0]) => parseScorecardFile(await excelScorecard(parts), 'sc.xlsx');

describe('Excel scorecards', () => {
  it('reads settings, sheets and dimensions, and infers who measures each dimension', async () => {
    const { scorecard } = await parse();
    expect(scorecard).toMatchObject({ id: 'SC-X', version: '1.0', gate: 'D1', frozen: true, thresholds: { accept: 75, refine: 60 } });
    expect(scorecard.artifact.sheets).toEqual([{ name: 'Tree', headerRow: 1, columns: ['Path id', 'Definition'] }]);
    expect(scorecard.artifact.context).toEqual([{ name: 'Playbook', headerRow: 4 }]);
    // "human" is still accepted in the sheet; the examiners score such a row from what the file shows.
    expect(scorecard.dimensions.map((d) => [d.id, d.measuredBy, d.critical])).toEqual([['C01', 'code', true], ['J01', 'raters', false], ['H01', 'raters', true]]);
    expect(scorecard.dimensions[0]!.check).toMatchObject({ id: 'column_filled', params: { sheet: 'Tree', column: 'Definition' } });
    expect(scorecard.dimensions[1]!.anchors).toEqual({ 5: 'great', 4: 'good', 3: 'ok', 2: 'weak', 1: 'poor', 0: 'none' });
  });

  it('expands the band presets and accepts explicit pairs', async () => {
    const withBands = (bands: string): Cell[][] => [DIM_HEADER, [...CODE.slice(0, 7), bands, ...CODE.slice(8)] as Cell[], RATER, HUMAN];
    const strict = (await parse({ Dimensions: withBands('strict') })).scorecard.dimensions[0]!.check!.bands;
    const exact = (await parse({ Dimensions: withBands('exact') })).scorecard.dimensions[0]!.check!.bands;
    const pairs = (await parse({ Dimensions: withBands('1:5, 0.9:3, 0.01:1') })).scorecard.dimensions[0]!.check!.bands;
    expect(strict.map((b) => [b.min, b.score])).toEqual([[1, 5], [0.97, 4], [0.9, 3], [0.75, 2], [0.01, 1]]);
    expect(exact.map((b) => b.score)).toEqual([5, 1]);
    expect(pairs.map((b) => [b.min, b.score])).toEqual([[1, 5], [0.9, 3], [0.01, 1]]);
  });

  it('is forgiving about case and blank rows, and honours thresholds and yes/no spellings', async () => {
    const { scorecard } = await parse({
      Scorecard: [['setting', 'VALUE'], ['ID', 'SC-X'], ['Version', '2'], ['Judges', 'D3 output'], ['Frozen', 'TRUE'], ['Accept', 85], ['Refine', 60]],
      Dimensions: [['id', 'NAME', 'weight', 'critical', 'measured by'], ['H1', 'Sign-off', 10, 'Y', 'human'], [null, null, null, null, null], ['H2', 'Other', 5, 'no', 'human']],
    });
    expect(scorecard).toMatchObject({ gate: 'D3', frozen: true, thresholds: { accept: 85, refine: 60 } });
    expect(scorecard.dimensions.map((d) => [d.id, d.critical])).toEqual([['H1', true], ['H2', false]]);
  });

  it('accepts a blank "frozen": the scorecard is frozen by its hash when work is submitted', async () => {
    const { scorecard } = await parse({ Scorecard: [['Setting', 'Value'], ['id', 'X'], ['version', '1'], ['judges', 'D1']] });
    expect(scorecard.frozen).toBe(true);
    expect(scorecard.unmeasured).toBe('skip');
  });

  it('reads the unmeasured setting, and writes it back so the round trip keeps the hash', async () => {
    const parsed = await parse({ Scorecard: [['Setting', 'Value'], ['id', 'X'], ['version', '1'], ['judges', 'D1'], ['unmeasured', 'Zero']] });
    expect(parsed.scorecard.unmeasured).toBe('zero');
    const again = await parseScorecardFile(await scorecardToWorkbook(parsed.scorecard), 'again.xlsx');
    expect(again.scorecard.unmeasured).toBe('zero');
    expect(again.hash).toBe(parsed.hash);
  });

  describe('mistakes are reported with the sheet and row to fix', () => {
    it.each([
      ['a missing sheet', async () => parseScorecardFile(await makeWorkbook({ Scorecard: SETTINGS, Sheets: SHEETS }), 's.xlsx'), /needs a sheet called "Dimensions".*Sheets found: Scorecard, Sheets/s],
      ['a missing column', () => parse({ Dimensions: [['ID', 'Name'], ['C1', 'x']] }), /Sheet "Dimensions" needs a column titled "Weight" in row 1/],
      ['a weight that is not a number', () => parse({ Dimensions: [DIM_HEADER, [...CODE.slice(0, 2), 'lots', ...CODE.slice(3)] as Cell[], RATER, HUMAN] }), /Dimensions sheet, row 2 \(C01\): Weight:/],
      ['a rater dimension with a missing anchor', () => parse({ Dimensions: [DIM_HEADER, CODE, [...RATER.slice(0, 10), null, ...RATER.slice(11)] as Cell[], HUMAN] }), /Dimensions sheet, row 3 \(J01\).*anchor for score 3 is missing/s],
      ['params that are not JSON', () => parse({ Dimensions: [DIM_HEADER, [...CODE.slice(0, 6), '{sheet: Tree', ...CODE.slice(7)] as Cell[], RATER, HUMAN] }), /row 2 \(C01\): Params must be a JSON object/],
      ['a code dimension with no bands', () => parse({ Dimensions: [DIM_HEADER, [...CODE.slice(0, 7), null, ...CODE.slice(8)] as Cell[], RATER, HUMAN] }), /row 2 \(C01\): a code dimension needs Bands/],
      ['bands that make no sense', () => parse({ Dimensions: [DIM_HEADER, [...CODE.slice(0, 7), '1-5', ...CODE.slice(8)] as Cell[], RATER, HUMAN] }), /Bands must be "strict", "exact", or pairs like 1:5/],
      ['an unknown "Measured by"', () => parse({ Dimensions: [DIM_HEADER, [...HUMAN.slice(0, 4), 'robot', ...HUMAN.slice(5)] as Cell[]] }), /Measured by must be code, raters or human \(got "robot"\)/],
      ['a bad role', () => parse({ Sheets: [['Sheet', 'Role'], ['Tree', 'maybe']] }), /Sheets sheet, row 2: Role must be "judged" or "context"/],
      ['a setting that is missing', () => parse({ Scorecard: [['Setting', 'Value'], ['version', '1'], ['judges', 'D1']] }), /Scorecard sheet, setting "id"/],
      ['a judges line that is not D1 or D3', () => parse({ Scorecard: [['Setting', 'Value'], ['id', 'X'], ['version', '1'], ['judges', 'D2 scorecard']] }), /Scorecard sheet, setting "judges".*D1 \(schema\) or D3/],
    ])('%s', async (_name, run, message) => {
      await expect(run()).rejects.toThrow(message);
    });

    it('a file that is not a workbook', async () => {
      await expect(parseScorecardFile(Buffer.from('not a zip'), 'sc.xlsx')).rejects.toThrow(/not a valid \.xlsx/);
    });
  });

  describe('converting a YAML scorecard to Excel and back gives the identical scorecard and hash', () => {
    it.each(['talentra-schema-d2.yaml', 'talentra-step04-d4.yaml'])('%s', async (file) => {
      const yaml = await readFile(new URL(`../../samples/talentra/${file}`, import.meta.url), 'utf8');
      const original = parseScorecard(yaml, file);
      const excel = await parseScorecardFile(await scorecardToWorkbook(original.scorecard), 'converted.xlsx');
      expect(excel.scorecard).toEqual(original.scorecard);
      expect(excel.hash).toBe(original.hash);
    });
  });
});
