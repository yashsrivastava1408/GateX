import { z } from 'zod';
import type { CriterionSpec, Scorecard } from './types.js';

/**
 * Parses the scorecard file format (PDF page 17) into the domain `Scorecard`.
 * The file keeps the PDF's snake_case; the domain object is camelCase.
 * Accepted PDF shortcuts: `judges: "D1 schema · Step 01"`, `measurable_by_agent: false`,
 * `thresholds: { accept, refine }`, anchors keyed 0-5.
 *
 * Scoring is fully automatic: nothing waits for a person. A question written for a person
 * (`measured_by: human`) is scored by the examiners from what the file shows, and a scorecard is
 * frozen by its hash when the work is submitted, so `frozen` and `approval` are informational.
 */

/** The 0 to 5 scale used when a question has no anchors of its own. */
export const STANDARD_ANCHORS: Readonly<Record<string, string>> = Object.freeze({
  '0': 'None of what the question asks for is in the file.',
  '1': 'A few items meet it; most do not.',
  '2': 'About half of the items meet it, or there are serious gaps.',
  '3': 'Most items meet it, with clear gaps left.',
  '4': 'Nearly all items meet it, with one minor gap.',
  '5': 'Every item meets it, with nothing missing.',
});

const RETURN_TO = ['Discover', 'Define', 'Generate', 'Analyse', 'Validate', 'Refine'] as const;

const bandSchema = z.object({
  min: z.number().min(0).max(1),
  score: z.number().int().min(0).max(5),
});

const checkSchema = z.object({
  id: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
  bands: z.array(bandSchema).min(1),
  fix: z.string().optional(),
});

const anchorsSchema = z.record(z.string(), z.string()).superRefine((anchors, ctx) => {
  for (const level of ['0', '1', '2', '3', '4', '5']) {
    if (!anchors[level]) {
      ctx.addIssue({ code: 'custom', message: `anchor for score ${level} is missing` });
    }
  }
});

/** The ratio bands GS-1 and most rubrics state: 5 at 98% or more, 4 at 90%, 3 at 75%, 2 at 50%, 1 above 0, else 0. */
export const RATIO_BANDS: ReadonlyArray<{ min: number; score: number }> = Object.freeze([
  { min: 0.98, score: 5 },
  { min: 0.9, score: 4 },
  { min: 0.75, score: 3 },
  { min: 0.5, score: 2 },
  { min: 0.0001, score: 1 },
]);

/** Anchors for a share the examiners have to estimate, worded on the same ratio bands. */
export const RATIO_ANCHORS: Readonly<Record<string, string>> = Object.freeze({
  '0': 'None of the items meet it.',
  '1': 'Some items meet it, but under half.',
  '2': 'Half to three quarters of the items meet it (50-74%).',
  '3': 'Three quarters or more meet it (75-89%).',
  '4': 'Nearly all meet it (90-97%).',
  '5': 'All or virtually all meet it (98% or more).',
});

const criterionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_.-]+$/, 'use letters, digits, ., - or _').optional(),
  name: z.string().min(1),
  // "unmeasurable" (evidence from outside the file) is judged: the examiners score what the file records about it.
  kind: z.enum(['judged', 'counted', 'unmeasurable']).default('judged'),
  measure: z.string().optional(),
  anchors: anchorsSchema.optional(),
  check: checkSchema.extend({ bands: z.array(bandSchema).min(1).optional() }).optional(),
  weight: z.number().positive().optional(),
});

const aggregateSchema = z.object({
  rule: z.enum(['mean_floor', 'mean', 'weighted']).default('mean'),
  zero_caps_at: z.number().int().min(0).max(5).optional(),
  unmeasured_caps_at: z.number().int().min(0).max(5).optional(),
});

const sheetSchema = z.preprocess(
  (value) => (typeof value === 'string' ? { name: value } : value),
  z.object({
    name: z.string().min(1),
    header_row: z.number().int().min(1).default(1),
    columns: z.array(z.string().min(1)).min(1).optional(),
  }),
);

const dimensionSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]+$/, 'use letters, digits, - or _'),
    name: z.string().min(1),
    weight: z.number().positive(),
    critical: z.boolean().default(false),
    measured_by: z.enum(['code', 'raters', 'human']).optional(),
    measurable_by_agent: z.boolean().optional(),
    description: z.string().optional(),
    measure: z.string().optional(),
    anchors: anchorsSchema.optional(),
    check: checkSchema.optional(),
    needs: z.string().optional(),
    return_to: z.enum(RETURN_TO).optional(),
    reads: z.array(z.string().min(1)).optional(),
    criteria: z.array(criterionSchema).min(1).optional(),
  })
  .superRefine((dim, ctx) => {
    // A dimension scored criterion by criterion needs neither its own check nor its own anchors.
    if (dim.criteria) return;
    const measuredBy = resolveMeasuredBy(dim);
    if (measuredBy === 'code' && !dim.check) {
      ctx.addIssue({ code: 'custom', message: 'a code dimension needs a `check`' });
    }
    if (measuredBy === 'raters' && !dim.anchors) {
      ctx.addIssue({ code: 'custom', message: 'a rater dimension needs `anchors` for scores 0-5' });
    }
  });

function resolveMeasuredBy(dim: {
  measured_by?: 'code' | 'raters' | 'human';
  measurable_by_agent?: boolean;
  check?: unknown;
}): 'code' | 'raters' | 'human' {
  if (dim.measured_by) return dim.measured_by;
  if (dim.measurable_by_agent === false) return 'human';
  return dim.check ? 'code' : 'raters';
}

export const scorecardFileSchema = z
  .object({
    scorecard: z.object({
      id: z.string().min(1),
      name: z.string().optional(),
      version: z.union([z.string(), z.number()]).transform(String),
      judges: z.string().refine((v) => /^(D1|D3)\b/.test(v.trim()), {
        message: 'judges must start with D1 (schema) or D3 (output)',
      }),
      step: z.string().optional(),
      frozen: z.boolean().default(false),
      approval: z.string().optional(),
      thresholds: z
        .object({ accept: z.number().min(0).max(100), refine: z.number().min(0).max(100) })
        .default({ accept: 75, refine: 60 }),
      red_at_or_below: z.number().int().min(0).max(4).optional(),
      // "person" is the old name for leaving a question out; nobody is ever waited for.
      unmeasured: z
        .enum(['skip', 'zero', 'person'])
        .default('skip')
        .transform((v): 'skip' | 'zero' => (v === 'zero' ? 'zero' : 'skip')),
      artifact: z.object({
        sheets: z.array(sheetSchema).min(1),
        context_sheets: z.array(sheetSchema).default([]),
      }),
      dimensions: z.array(dimensionSchema).min(1),
      aggregate: aggregateSchema.optional(),
    }),
  })
  .superRefine(({ scorecard }, ctx) => {
    const seen = new Set<string>();
    for (const dim of scorecard.dimensions) {
      if (seen.has(dim.id)) {
        ctx.addIssue({ code: 'custom', message: `duplicate dimension id ${dim.id}` });
      }
      seen.add(dim.id);
    }
    // Criterion ids share one namespace with dimension ids: the examiners and the report refer to both by id.
    for (const dim of scorecard.dimensions) {
      (dim.criteria ?? []).forEach((c, i) => {
        const id = criterionId(dim.id, c.id, i);
        if (seen.has(id)) ctx.addIssue({ code: 'custom', message: `duplicate id ${id} (criterion of ${dim.id})` });
        seen.add(id);
      });
    }
    if (scorecard.thresholds.refine >= scorecard.thresholds.accept) {
      ctx.addIssue({ code: 'custom', message: 'thresholds.refine must be below thresholds.accept' });
    }
  });

export type ScorecardFile = z.infer<typeof scorecardFileSchema>;

type FileDimension = ScorecardFile['scorecard']['dimensions'][number];
type FileCriterion = NonNullable<FileDimension['criteria']>[number];

const criterionId = (dimId: string, given: string | undefined, index: number) => given ?? `${dimId}-C${String(index + 1).padStart(2, '0')}`;
const numericAnchors = (anchors: Record<string, string>) => Object.fromEntries(Object.entries(anchors).map(([k, v]) => [Number(k), v]));

function toCriterion(dimId: string, c: FileCriterion, index: number): CriterionSpec {
  const id = criterionId(dimId, c.id, index);
  // A counted criterion with no exact count is estimated by the examiners on the ratio bands.
  if (c.kind === 'counted' && c.check) {
    const bands = [...(c.check.bands ?? RATIO_BANDS)].sort((a, b) => b.min - a.min);
    return {
      id, name: c.name, kind: 'counted',
      ...(c.measure ? { measure: c.measure } : {}),
      check: { id: c.check.id, params: c.check.params, bands, ...(c.check.fix ? { fix: c.check.fix } : {}) },
      ...(c.weight ? { weight: c.weight } : {}),
    };
  }
  const estimated = c.kind === 'counted';
  const outside = c.kind === 'unmeasurable';
  const measure = [c.measure ?? c.name, estimated ? 'Estimate the share of items that meet it.' : '', outside ? 'Judge only what the file itself records about it.' : '']
    .filter(Boolean)
    .join(' ');
  return {
    id, name: c.name, kind: 'judged', measure,
    ...(c.anchors ? { anchors: numericAnchors(c.anchors) } : estimated ? { anchors: numericAnchors(RATIO_ANCHORS) } : {}),
    ...(c.weight ? { weight: c.weight } : {}),
    ...(outside ? { outside: true } : {}),
  };
}

/** What the examiners are asked, for a question first written for a person. */
function examinerMeasure(d: FileDimension): string {
  const asked = [d.measure, d.needs].filter((t): t is string => Boolean(t && t.trim())).map((t) => t.trim());
  const what = asked.length > 0 ? asked.join(' ') : d.name;
  return `${what} Score only what the file itself shows for this. If the file holds no evidence for it at all, mark it not measurable.`;
}

export function toScorecard(file: ScorecardFile): Scorecard {
  const sc = file.scorecard;
  const sheet = (s: { name: string; header_row: number; columns?: string[] }) => ({
    name: s.name,
    headerRow: s.header_row,
    ...(s.columns ? { columns: s.columns } : {}),
  });
  return {
    id: sc.id,
    name: sc.name ?? sc.id,
    version: sc.version,
    gate: /^D3/.test(sc.judges.trim()) ? 'D3' : 'D1',
    step: sc.step,
    // Frozen by its hash the moment it is read; nobody has to sign it off.
    frozen: true,
    approval: sc.approval,
    thresholds: sc.thresholds,
    ...(sc.red_at_or_below !== undefined ? { redAtOrBelow: sc.red_at_or_below } : {}),
    unmeasured: sc.unmeasured,
    ...(sc.aggregate
      ? {
          aggregate: {
            rule: sc.aggregate.rule,
            ...(sc.aggregate.zero_caps_at !== undefined ? { zeroCapsAt: sc.aggregate.zero_caps_at } : {}),
            ...(sc.aggregate.unmeasured_caps_at !== undefined ? { unmeasuredCapsAt: sc.aggregate.unmeasured_caps_at } : {}),
          },
        }
      : {}),
    artifact: { sheets: sc.artifact.sheets.map(sheet), context: sc.artifact.context_sheets.map(sheet) },
    dimensions: sc.dimensions.map((d) => {
      const criteria = d.criteria?.map((c, i) => toCriterion(d.id, c, i));
      // With criteria, the dimension goes to the examiners if any criterion is judged, else it is counted by code.
      const declared = criteria ? (criteria.some((c) => c.kind === 'judged') ? 'raters' : 'code') : resolveMeasuredBy(d);
      // Nothing is held for a person: such a question goes to the examiners, on the standard scale unless it has anchors.
      const forPerson = !criteria && declared === 'human';
      const anchors = d.anchors ?? (forPerson ? STANDARD_ANCHORS : undefined);
      return {
        id: d.id,
        name: d.name,
        weight: d.weight,
        critical: d.critical,
        measuredBy: forPerson ? ('raters' as const) : declared,
        description: d.description,
        measure: forPerson ? examinerMeasure(d) : d.measure,
        anchors: anchors
          ? Object.fromEntries(Object.entries(anchors).map(([k, v]) => [Number(k), v]))
          : undefined,
        check: d.check
          ? {
              id: d.check.id,
              params: d.check.params,
              bands: [...d.check.bands].sort((a, b) => b.min - a.min),
              fix: d.check.fix,
            }
          : undefined,
        ...(d.needs ? { needs: d.needs } : {}),
        returnTo: d.return_to,
        reads: d.reads,
        ...(criteria ? { criteria } : {}),
      };
    }),
  };
}
