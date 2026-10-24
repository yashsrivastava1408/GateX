import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from './types.js';

/**
 * A scripted provider for tests and offline demos. It reads the real prompt, so the
 * whole pipeline (prompt building, parsing, evidence checking, consolidation) runs
 * exactly as it would against a live model. The model name picks the behaviour:
 *
 *   raters:         mock-strict (3) · mock-mid (4) · mock-lenient (5) · mock-low (1)
 *                   mock-alarmist (scores 5 but raises a HIGH finding) · mock-garbage (not JSON) ·
 *                   mock-nocite (no evidence) · mock-abstain · mock-down
 *   consolidators:  mock-consolidator · mock-consolidator-unresolved · mock-consolidator-greedy · mock-consolidator-down
 */

interface Cell {
  sheet: string;
  cell: string;
  quote: string;
}

const FIXED_SCORES: Record<string, number> = {
  'mock-strict': 3,
  'mock-mid': 4,
  'mock-lenient': 5,
  'mock-low': 1,
  'mock-nocite': 4,
  'mock-alarmist': 5,
};

function section(prompt: string, tag: string): string {
  const match = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(prompt);
  return match?.[1] ?? '';
}

function firstCells(artifact: string, count: number): Cell[] {
  const cells: Cell[] = [];
  let sheet = '';
  for (const line of artifact.split('\n')) {
    const header = /^## Sheet: (.+?) \(/.exec(line);
    if (header) {
      sheet = header[1]!;
      continue;
    }
    for (const match of line.matchAll(/([A-Z]+\d+)=("(?:[^"\\]|\\.)*")/g)) {
      const text = JSON.parse(match[2]!) as string;
      if (text.length > 2 && !text.endsWith('…')) {
        cells.push({ sheet, cell: match[1]!, quote: text.slice(0, 30) });
        if (cells.length >= count) return cells;
      }
    }
  }
  return cells;
}

interface PromptDimension {
  id: string;
}

export class MockProvider implements LlmProvider {
  readonly name = 'mock';

  constructor(private readonly delayMs = 0) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (request.model.endsWith('-down')) throw new LlmError(`${request.model} is unavailable`, 400);

    const text = request.system.includes('SCORECARD_IMPORT')
      ? this.importDraft()
      : request.system.includes('You check claims that something is missing')
        ? this.presence(request)
        : request.system.includes('You are the consolidator')
        ? this.consolidate(request)
        : this.rate(request);
    return { text, inputTokens: Math.ceil(request.user.length / 4), outputTokens: Math.ceil(text.length / 4) };
  }

  /** The "is it really missing?" check: every claim is answered "not present", except one whose text says "(mock-present)", which cites the first cell of its first row. */
  private presence(request: LlmRequest): string {
    const results = [...request.user.matchAll(/<claim id="([^"]+)">\n([\s\S]*?)<\/claim>/g)].map((m) => {
      const first = /\[([^\]]+)\] ([A-Z]+\d+)=("(?:[^"\\]|\\.)*")/.exec(m[2]!);
      if (m[2]!.includes('(mock-present)') && first) return { id: m[1], present: true, cell: `${first[1]}!${first[2]}`, quote: (JSON.parse(first[3]!) as string).slice(0, 30) };
      return { id: m[1], present: false, cell: '', quote: '' };
    });
    return JSON.stringify({ results });
  }

  /** A small fixed draft, so the import screen can be shown without a live model. */
  private importDraft(): string {
    const anchors = { '0': 'Absent or contradicted.', '1': 'Mentioned only.', '2': 'A major element is missing.', '3': 'A gap that could change an outcome.', '4': 'A minor gap that cannot change an outcome.', '5': 'Fully specified.' };
    return JSON.stringify({
      scorecard: {
        id: 'SC-MOCK-IMPORT',
        name: 'Imported sample (mock model)',
        version: '1.0',
        judges: 'D1 schema design',
        thresholds: { accept: 90, refine: 75 },
        red_at_or_below: 2,
        artifact: { sheets: [{ name: 'Sheet1', header_row: 1 }], context_sheets: [] },
        dimensions: [
          { id: 'G01', name: 'Purpose and scope are clear', weight: 40, critical: false, measured_by: 'raters', measure: 'Does the opening say what the document is for?', anchors, reads: ['Page 1-2'] },
          { id: 'G02', name: 'Definitions are complete', weight: 40, critical: true, measured_by: 'raters', measure: 'Is every field defined?', anchors },
          { id: 'G03', name: 'Author understanding', weight: 20, critical: false, measured_by: 'raters', measure: 'Could the author defend the design?', criteria: [{ id: 'G03-C01', name: 'Author interview', kind: 'unmeasurable' }, { id: 'G03-C02', name: 'Decisions explained', kind: 'judged' }] },
        ],
      },
      uncertain: ['This is the mock model: the draft is a fixed sample and does not come from your file.'],
      adjustments: [],
    });
  }

  private rate(request: LlmRequest): string {
    if (request.model === 'mock-garbage') return 'I think the schema is fine overall.';
    const scorecard = JSON.parse(section(request.user, 'scorecard')) as { dimensions: PromptDimension[] };
    const cells = firstCells(section(request.user, 'artifact'), 3);
    const anchor = cells[0];
    const dimensions = scorecard.dimensions.map((dim, index) => {
      if (request.model === 'mock-abstain') {
        return { id: dim.id, score: null, not_measurable: true, rationale: 'The artifact cannot show this.', evidence: [] };
      }
      const score = FIXED_SCORES[request.model] ?? 4;
      const cell = cells[index % Math.max(cells.length, 1)];
      return {
        id: dim.id,
        score,
        not_measurable: false,
        anchor: `anchor for ${score}`,
        rationale: `${request.model} scored ${dim.id} ${score}.`,
        evidence: request.model === 'mock-nocite' || !cell ? [] : [cell],
      };
    });
    const alarmist = request.model === 'mock-alarmist';
    const findings = scorecard.dimensions
      .filter((_, index) => anchor && (alarmist ? index === 0 : (FIXED_SCORES[request.model] ?? 4) < 5))
      .map((dim) => ({
        dimension: dim.id,
        severity: alarmist ? 'HIGH' : (FIXED_SCORES[request.model] ?? 4) <= 3 ? 'MEDIUM' : 'LOW',
        title: `Improve ${dim.id}`,
        detail: `Could be clearer for ${dim.id}.`,
        location: { sheet: anchor!.sheet, cell: anchor!.cell },
        fix: 'Tighten the wording.',
        return_to: 'Define',
      }));
    const strengths = anchor
      ? [{ dimension: scorecard.dimensions[0]?.id ?? '', text: 'Consistent structure.', location: { sheet: anchor.sheet, cell: anchor.cell } }]
      : [];
    return JSON.stringify({ dimensions, findings, strengths });
  }

  private consolidate(request: LlmRequest): string {
    const results = JSON.parse(section(request.user, 'rater_results')) as {
      dimensions: Array<{ id: string; ratings: Array<{ score: number; evidence: Cell[] }> }>;
      findings: Array<{ ref: string; dimension: string; severity: string; title: string; detail: string; location: Cell | null; fix: string }>;
      strengths: Array<{ dimension: string; text: string; location: Cell | null }>;
    };

    const dimensions = results.dimensions.map((dim) => {
      const scores = dim.ratings.map((r) => r.score).sort((a, b) => a - b);
      const low = scores[0] ?? 0;
      const high = scores[scores.length - 1] ?? 0;
      const median = scores[Math.floor(scores.length / 2)] ?? 0;
      const chosen = request.model === 'mock-consolidator-greedy' ? 5 : median;
      const unresolved = request.model === 'mock-consolidator-unresolved' && high - low > 1;
      return {
        id: dim.id,
        score: chosen,
        resolved: !unresolved,
        basis: high - low > 1 ? 'claims_checked' : 'agreement',
        rationale: `Reconciled ${scores.join(', ')}.`,
        evidence: dim.ratings.flatMap((r) => r.evidence).slice(0, 1),
      };
    });

    const byDimension = new Map<string, typeof results.findings>();
    for (const finding of results.findings) {
      byDimension.set(finding.dimension, [...(byDimension.get(finding.dimension) ?? []), finding]);
    }
    const findings = [...byDimension.entries()].map(([dimension, group]) => ({
      from: group.map((f) => f.ref),
      dimension,
      severity: group[0]!.severity,
      title: group[0]!.title,
      detail: group[0]!.detail,
      location: group[0]!.location,
      fix: group[0]!.fix,
      return_to: 'Define',
    }));

    return JSON.stringify({ dimensions, findings, strengths: results.strengths.slice(0, 2) });
  }
}
