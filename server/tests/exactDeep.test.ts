import { describe, expect, it } from 'vitest';
import type { DimensionSpec } from '@ddd/shared';
import { WorkbookModel } from '../src/excel/workbook.js';
import { profileWorkbook } from '../src/excel/profile.js';
import { ABOUT_A_MECHANISM, FAMILIES, exactCeilings, exactCeilingsFor } from '../src/agent/exactScore.js';
import { statedChildLimit, statedIdPattern, sweepCrossReferences, sweepDeep, sweepIdFormats, sweepNearMissValues, sweepOrphanRows, sweepRestatedReasons, sweepWidth } from '../src/agent/sweepDeep.js';
import { sweepAll } from '../src/agent/sweep.js';
import { makeWorkbook } from './helpers.js';

const crit = (id: string, name: string, extra: Partial<DimensionSpec> = {}): DimensionSpec => ({ id, name, weight: 1, critical: false, measuredBy: 'raters', ...extra }) as DimensionSpec;
const csvOf = (r: Array<Array<string | number>>) => Buffer.from(r.map((row) => row.join(',')).join('\n') + '\n', 'utf8');
const load = (r: Array<Array<string | number>>) => WorkbookModel.load(csvOf(r));
const asks = (id: string, text: string) => FAMILIES.find((f) => f.id === id)!.asks(text);
const pad = (n: number, w = 3) => String(n).padStart(w, '0');

/** 60 NFR rows: id, name, definition, reason, priority, parent. */
function nfrRegister(mutate: (rows: Array<Array<string | number>>) => void = () => undefined): Array<Array<string | number>> {
  const rows: Array<Array<string | number>> = [['Id', 'Name', 'Definition', 'Reason', 'Priority', 'Status']];
  for (let i = 1; i <= 60; i++) rows.push([`NFR-${pad(i)}`, `Requirement ${i}`, `The system shall do thing number ${i} within a stated limit.`, `Because users need thing ${i} to be dependable.`, i % 3 ? 'High' : 'Medium', i % 2 ? 'Open' : 'Closed']);
  mutate(rows);
  return rows;
}

describe('which criteria the new rules recognise', () => {
  it('an id pattern', () => {
    for (const t of ['NFR ids follow NFR-nnn and are unique', 'ID pattern and placement', 'Ids match the stated pattern', 'Every id is well-formed', 'Naming convention is followed']) expect(asks('idformat', t), t).toBe(true);
    for (const t of ['Every id is explained', 'Identifiers appear in the glossary', 'Pattern of work is described']) expect(asks('idformat', t), t).toBe(false);
  });
  it('a child limit, only when the criterion says one', () => {
    expect(statedChildLimit('No section or parameter has more than 10 children')).toBe(10);
    expect(statedChildLimit('Parents with 15 children or fewer')).toBe(15);
    expect(statedChildLimit('Do all parents have ≤ 15 children')).toBe(15);
    expect(statedChildLimit('Parents ≤ 15 children (64) + deliverables 2–4 deep (3)')).toBe(15);
    expect(statedChildLimit('The children counts match the rows')).toBeNull();
    expect(statedChildLimit('Every table stays small')).toBeNull();
  });
  it('reasons that only restate, filled cells, orphans and foreign keys', () => {
    expect(asks('restate', 'Reasons that do not restate the definition')).toBe(true);
    expect(asks('restate', 'Reason present: fields with a Why that is not a restatement')).toBe(true);
    expect(asks('restate', 'The reason is convincing')).toBe(false);
    for (const t of ['Definition present: fields with a What-to-write definition', 'Cell fill: filled cells across 476 fields', 'Fields with a type', 'Atomic leaves with definition, type, reason']) expect(asks('empty', t), t).toBe(true);
    for (const t of ['No orphan rows', 'Every role is a foreign key into Roles', 'Every row has a parent', 'Cross-sheet references resolve']) expect(asks('reference', t), t).toBe(true);
  });
  it('keeps wording about a limit, a choice, or a mechanism out of the fill count', () => {
    expect(asks('empty', 'Every table stays small: tables with at most 40 columns')).toBe(false);
    expect(asks('empty', 'Every rule states missing behaviour or a schema-wide rule covers it explicitly')).toBe(false);
    expect(asks('empty', 'Every set has an UNKNOWN code or a schema-wide documented equivalent')).toBe(false);
    expect(ABOUT_A_MECHANISM.test('Gate detects missing, zero-actor, invalid, duplicate and orphan requirements')).toBe(true);
    expect(ABOUT_A_MECHANISM.test('Ids are unique')).toBe(false);
  });
});

describe('id pattern', () => {
  it('reads the pattern a criterion states', () => {
    expect(statedIdPattern('NFR ids follow NFR-nnn and are unique')).toMatchObject({ prefix: 'NFR-', digits: 3 });
    expect(statedIdPattern('ids look like WF-00')).toMatchObject({ prefix: 'WF-', digits: 2 });
    expect(statedIdPattern('Ids follow a pattern')).toBeNull();
    expect(statedIdPattern('Written in pre-nnn style')).toBeNull();
  });

  it('counts the ids that break a stated pattern, and nothing in a clean register', async () => {
    const q = [crit('SC-03', 'NFR ids follow NFR-nnn')];
    expect(exactCeilingsFor(q, await load(nfrRegister())).size).toBe(0);
    const wb = await load(nfrRegister((r) => { r[10]![0] = 'NFR-10'; r[30]![0] = 'nfr-031'; }));
    const c = exactCeilingsFor(q, wb).get('SC-03')!;
    expect(c).toMatchObject({ family: 'idformat', mistakes: 2, looked: 60 });
    expect(c.ceiling).toBe(2); // 2 of 60 is 96.7% clean
    expect(c.summary).toContain('Sheet1!A11, Sheet1!A31');
  });

  it('without a stated pattern, flags only an id that differs from the shape nearly all share', async () => {
    const wb = await load(nfrRegister((r) => { r[20]![0] = 'REQ-021'; }));
    const profile = profileWorkbook(wb);
    const out = sweepIdFormats(wb, profile, null, { all: true });
    expect(out.found).toHaveLength(1);
    expect(out.found[0]!.location.cell).toBe('A21');
    // The count growing past its zero padding is not a slip.
    const grown = await load(nfrRegister((r) => { r[60]![0] = 'NFR-1000'; }));
    expect(sweepIdFormats(grown, profileWorkbook(grown), null, { all: true }).found).toEqual([]);
  });

  it('is silent when the column is not governed by the pattern (few ids start with the prefix; path ids; mixed prefixes)', async () => {
    const pattern = statedIdPattern('ids follow NFR-nnn');
    const other = await load(nfrRegister((r) => { for (let i = 1; i <= 60; i++) r[i]![0] = `REQ-${i}`; }));
    expect(sweepIdFormats(other, profileWorkbook(other), pattern, { all: true }).found).toEqual([]);
    const paths = await load([['Path id', 'Name'], ...Array.from({ length: 40 }, (_, i) => [i % 3 ? `1.${i}` : `1.${i}.1`, `n${i}`])]);
    expect(sweepIdFormats(paths, profileWorkbook(paths), null, { all: true }).found).toEqual([]);
    const mixed = await load(nfrRegister((r) => { for (let i = 1; i <= 60; i++) r[i]![0] = i % 2 ? `WF-${pad(i)}` : `KPI-${pad(i)}`; }));
    expect(sweepIdFormats(mixed, profileWorkbook(mixed), null, { all: true }).found).toEqual([]);
  });

  it('does not count a question that talks about something else', async () => {
    const wb = await load(nfrRegister((r) => { r[10]![0] = 'NFR-10'; }));
    expect(exactCeilingsFor([crit('Q', 'Every id is explained in the glossary')], wb).size).toBe(0);
  });
});

describe('references across sheets, orphan rows', () => {
  const sheets = (mut: (perm: Array<Array<string | number>>) => void = () => undefined) => {
    const roles: Array<Array<string | number>> = [['Role id', 'Role name'], ...Array.from({ length: 15 }, (_, i) => [`ROLE-${pad(i + 1, 2)}`, `Role ${i + 1}`])];
    const perm: Array<Array<string | number>> = [['Permission id', 'Role', 'Action'], ...Array.from({ length: 40 }, (_, i) => [`PERM-${pad(i + 1)}`, `ROLE-${pad((i % 15) + 1, 2)}`, i % 2 ? 'Read' : 'Write'])];
    mut(perm);
    return makeWorkbook({ Roles: roles, Permissions: perm });
  };

  it('flags a value that is not an id of the sheet the rest of the column points at', async () => {
    const clean = await WorkbookModel.load(await sheets());
    expect(sweepCrossReferences(clean, profileWorkbook(clean), { all: true })).toEqual([]);
    const wb = await WorkbookModel.load(await sheets((p) => { p[7]![1] = 'ROLE-99'; }));
    const found = sweepCrossReferences(wb, profileWorkbook(wb), { all: true });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'cross_reference', location: { sheet: 'Permissions', cell: 'B8' } });
    // It counts for a criterion that names the column (or the sheet), not for an unrelated one.
    const c = exactCeilings([crit('R1', 'Every role in the permissions resolves'), crit('R2', 'Every cited standard resolves')], found, { rows: 0, ids: 0, references: 40, childCounts: 0, obligations: 0, tallies: 0 });
    expect(c.get('R1')).toMatchObject({ family: 'reference', mistakes: 1 });
    expect(c.has('R2')).toBe(false);
  });

  it('stays silent when the column only happens to hold some of another sheet\'s ids', async () => {
    const wb = await WorkbookModel.load(await sheets((p) => { for (let i = 1; i <= 20; i++) p[i]![1] = i % 3 ? `ROLE-${pad(i, 2)}` : `OTHER-${i}`; }));
    expect(sweepCrossReferences(wb, profileWorkbook(wb), { all: true })).toEqual([]);
  });

  it('finds a row whose parent row is missing, in a register of path ids', async () => {
    const rows: Array<Array<string | number>> = [['Path id', 'Name']];
    for (let a = 1; a <= 3; a++) {
      rows.push([`${a}`, `L1 ${a}`]);
      for (let b = 1; b <= 3; b++) {
        rows.push([`${a}.${b}`, `L2 ${a}.${b}`]);
        for (let c = 1; c <= 2; c++) rows.push([`${a}.${b}.${c}`, `L3 ${a}.${b}.${c}`]);
      }
    }
    const clean = await load(rows);
    expect(sweepOrphanRows(clean, profileWorkbook(clean), { all: true })).toEqual([]);
    const broken = rows.filter((r) => r[0] !== '2.2');
    const wb = await load(broken);
    const found = sweepOrphanRows(wb, profileWorkbook(wb), { all: true });
    expect(found.map((f) => f.title)).toEqual(['Row 2.2.1 has no parent row (Sheet1)', 'Row 2.2.2 has no parent row (Sheet1)']);
    expect(exactCeilings([crit('O', 'No orphan rows')], found, { rows: 0, ids: 0, references: 20, childCounts: 0, obligations: 0, tallies: 0 }).get('O')).toMatchObject({ family: 'reference', mistakes: 2 });
  });

  it('does not call a sheet orphaned when its parents live on another sheet', async () => {
    const rows: Array<Array<string | number>> = [['Path id', 'Name'], ...Array.from({ length: 30 }, (_, i) => [`${(i % 5) + 1}.${i + 1}.1`, `n${i}`])];
    const wb = await load(rows);
    expect(sweepOrphanRows(wb, profileWorkbook(wb), { all: true })).toEqual([]);
  });
});

describe('values that are a slip of the usual ones', () => {
  it('flags "high" among "High", and leaves two real values alone', async () => {
    const wb = await load(nfrRegister((r) => { r[12]![4] = 'high'; r[40]![4] = 'Hihg'; }));
    const found = sweepNearMissValues(wb, profileWorkbook(wb), { all: true });
    // Only the case variant: a one-letter slip is flagged for values of six letters or more.
    expect(found.map((f) => f.location.cell)).toEqual(['E13']);
    const odd = await load(nfrRegister((r) => { r[12]![5] = 'Pending'; }));
    expect(sweepNearMissValues(odd, profileWorkbook(odd), { all: true })).toEqual([]);
  });
  it('counts for a criterion that names the column', async () => {
    const wb = await load(nfrRegister((r) => { r[12]![4] = 'high'; }));
    expect(exactCeilingsFor([crit('P', 'Priority holds only allowed values'), crit('S', 'Status holds only allowed values')], wb).get('P')).toMatchObject({ family: 'allowed', mistakes: 1 });
    expect(exactCeilingsFor([crit('S', 'Status holds only allowed values')], wb).has('S')).toBe(false);
  });
});

describe('parents with too many children', () => {
  const tree = (kids: number) => {
    const rows: Array<Array<string | number>> = [['Path id', 'Name'], ['1', 'Root']];
    for (let i = 1; i <= kids; i++) rows.push([`1.${i}`, `Child ${i}`]);
    for (let g = 1; g <= 3; g++) for (let i = 1; i <= 2; i++) rows.push([`1.${g}.${i}`, `Grand ${g}.${i}`]);
    return rows;
  };
  it('counts a parent over the stated limit and nothing when none is', async () => {
    const wb = await load(tree(12));
    const out = sweepWidth(wb, profileWorkbook(wb), 10, { all: true });
    expect(out.found.map((f) => f.title)).toEqual(['1 has 12 children, over the limit of 10 (Sheet1)']);
    expect(sweepWidth(wb, profileWorkbook(wb), 12, { all: true }).found).toEqual([]);
    expect(exactCeilingsFor([crit('SD-02', 'No section or parameter has more than 10 children')], wb).get('SD-02')).toMatchObject({ family: 'width', mistakes: 1 });
    expect(exactCeilingsFor([crit('X', 'Sections are small')], wb).size).toBe(0);
  });
  it('reads a Parent id column too', async () => {
    const rows: Array<Array<string | number>> = [['Id', 'Name', 'Parent id'], ['A-001', 'Top', ''], ...Array.from({ length: 16 }, (_, i) => [`A-${pad(i + 2)}`, `Kid ${i}`, 'A-001']), ...Array.from({ length: 4 }, (_, i) => [`B-${pad(i + 1)}`, `Other ${i}`, 'A-002'])];
    const wb = await load(rows);
    expect(sweepWidth(wb, profileWorkbook(wb), 15, { all: true }).found).toHaveLength(1);
  });
});

describe('reasons that only repeat the definition', () => {
  it('flags a reason copied from the definition, not one that merely shares words', async () => {
    const wb = await load(nfrRegister((r) => { r[5]![3] = r[5]![2]!; r[9]![3] = `${r[9]![2]} Needed for users.`; r[14]![3] = 'The system shall do thing at some other time, which matters for audit.'; }));
    const found = sweepRestatedReasons(wb, profileWorkbook(wb), { all: true });
    expect(found.map((f) => f.location.cell)).toEqual(['D6', 'D10']);
    const c = exactCeilingsFor([crit('R', 'Reason states purpose', { measure: 'Reasons that do not restate the definition' })], wb).get('R')!;
    expect(c).toMatchObject({ family: 'restate', mistakes: 2 });
  });
  it('finds nothing in the clean register, and no deep check lists a report issue', async () => {
    const wb = await load(nfrRegister());
    expect(sweepDeep(wb, profileWorkbook(wb), { all: true })).toEqual([]);
    const broken = await load(nfrRegister((r) => { r[5]![3] = r[5]![2]!; r[10]![0] = 'nfr-1'; }));
    // The ordinary sweep (what the report lists) is unchanged by the deep kinds.
    expect(sweepAll(broken, { all: true }).filter((f) => ['bad_id_format', 'cross_reference', 'orphan_row', 'near_miss_value', 'too_wide', 'restated_reason'].includes(f.kind))).toEqual([]);
  });
});

describe('a register with the new kinds of mistake planted scores at least 10 points below the clean one', () => {
  const scorecard = () =>
    ({
      id: 'T', name: 'T', version: '1', gate: 'D1', step: 4, passBar: 75,
      dimensions: [
        { id: 'ID', name: 'Identity', weight: 20, critical: true, measuredBy: 'raters', criteria: [{ id: 'ID-01', name: 'NFR ids follow NFR-nnn and are unique', kind: 'judged' }, { id: 'ID-02', name: 'Ideas are original', kind: 'judged' }] },
        { id: 'RS', name: 'Reasons', weight: 20, critical: false, measuredBy: 'raters', criteria: [{ id: 'RS-01', name: 'Reasons that do not restate the definition', kind: 'judged' }, { id: 'RS-02', name: 'Priority holds only allowed values', kind: 'judged' }] },
        { id: 'CP', name: 'Completeness', weight: 20, critical: false, measuredBy: 'raters', criteria: [{ id: 'CP-01', name: 'No blank cells: every field has a value', kind: 'judged' }] },
      ],
    }) as unknown as import('@ddd/shared').Scorecard;

  const score = async (rows: Array<Array<string | number>>): Promise<number> => {
    const { expandCriteria, collapseCriteria } = await import('../src/agent/aggregate.js');
    const { applyExactCeilings } = await import('../src/agent/exactScore.js');
    const sc = scorecard();
    const working = expandCriteria(sc);
    const rated = working.dimensions.map((q) => ({ id: q.id, name: q.name, weight: q.weight, critical: q.critical, measuredBy: 'raters' as const, status: 'scored' as const, raterScores: { A: 5, B: 5, C: 5 }, consolidated: 5, spread: 0, resolution: 'agreement' as const, flagged: false, rationale: 'r.', evidence: [] }));
    const exact = applyExactCeilings(rated, exactCeilingsFor(working.dimensions, await load(rows)));
    const dims = collapseCriteria(sc, exact.results);
    return (dims.reduce((s, d) => s + (d.weight * (d.consolidated ?? 0)) / 5, 0) / dims.reduce((s, d) => s + d.weight, 0)) * 100;
  };

  it('even when every examiner gives a clean 5', async () => {
    const clean = await score(nfrRegister());
    const planted = await score(
      nfrRegister((r) => {
        r[10]![0] = 'NFR-10'; r[11]![0] = 'nfr-011'; r[12]![0] = 'NFR_012';
        r[20]![3] = r[20]![2]!; r[21]![3] = r[21]![2]!; r[22]![3] = r[22]![2]!;
        r[30]![4] = 'high'; r[31]![4] = 'medium';
        r[40]![3] = ''; r[41]![3] = ''; r[42]![3] = '';
      }),
    );
    expect(clean).toBe(100);
    expect(clean - planted).toBeGreaterThanOrEqual(10);
  });
});
