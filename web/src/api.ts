import type {
  AccuracyReport,
  ConfigResponse,
  FeedbackLabel,
  FindingFeedback,
  HumanReview,
  LibraryCaseDetail,
  LibraryCaseSummary,
  PlantedResult,
  ReliabilityTable,
  Decision,
  ProjectHistory,
  Board,
  ProjectSummary,
  RunDetail,
} from '@ddd/shared';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new ApiError('Cannot reach the server. Is it running?', 0);
  }
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message = (body as { error?: string } | null)?.error ?? `The server answered ${response.status}.`;
    throw new ApiError(message, response.status);
  }
  return body as T;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export interface SubmitForm {
  workbook: File;
  scorecard: File;
  projectName: string;
  sources: string;
  instructions: string;
  /** Score every question once: faster, slightly less steady. */
  quick?: boolean;
  runTwice?: boolean;
  /** 1-5 and D1 (schema) or D3 (output): where the result sits on the status board. Empty means the scorecard's own. */
  step?: string;
  gate?: string;
}

interface ImportedQuestion {
  id: string;
  name: string;
  weight: number;
  critical: boolean;
  by: 'examiners' | 'code';
  reads: string[];
  how?: string;
  /** Present when the dimension is broken into sub-criteria, each scored on its own. */
  criteria?: Array<{ id: string; name: string; by: 'examiners' | 'code'; how?: string }>;
}

export interface ImportedScorecard {
  questions: ImportedQuestion[];
  yaml: string;
  uncertain: string[];
  adjustments: string[];
  summary: { dimensions: number; byExaminers: number; byCode: number; critical: number; weightTotal: number };
  sourceText: string;
  documentOutline: string | null;
  model: { id: string; provider: string; model: string };
  /** True when an earlier conversion of the same file was reused, with no model call. */
  cached: boolean;
}

export interface CheckedScorecard {
  yaml: string;
  summary: ImportedScorecard['summary'];
}

export const api = {
  config: () => request<ConfigResponse>('/api/config'),
  library: () => request<LibraryCaseSummary[]>('/api/library'),
  reliability: () => request<ReliabilityTable>('/api/library/reliability'),
  planted: () => request<PlantedResult[]>('/api/library/planted'),
  libraryCase: (id: string) => request<LibraryCaseDetail>(`/api/library/${id}`),
  projects: () => request<ProjectSummary[]>('/api/projects'),
  board: () => request<Board>('/api/board'),
  accuracy: () => request<AccuracyReport>('/api/accuracy'),
  humanReviews: (runId: string) => request<HumanReview[]>(`/api/runs/${runId}/human-review`),
  addHumanReview: (runId: string, body: { reviewer: string; scores: Record<string, number>; verdict?: 'green' | 'amber' | 'red' | null; note?: string }) =>
    request<HumanReview>(`/api/runs/${runId}/human-review`, json(body)),
  feedback: (runId: string) => request<FindingFeedback[]>(`/api/runs/${runId}/feedback`),
  addFeedback: (runId: string, findingId: string, body: { label: FeedbackLabel; who: string; note?: string }) =>
    request<FindingFeedback[]>(`/api/runs/${runId}/findings/${encodeURIComponent(findingId)}/feedback`, json(body)),
  project: (id: string) => request<ProjectHistory>(`/api/projects/${id}`),
  run: (id: string) => request<RunDetail>(`/api/runs/${id}`),

  submit(form: SubmitForm) {
    const body = new FormData();
    body.append('workbook', form.workbook);
    body.append('scorecard', form.scorecard);
    body.append('projectName', form.projectName);
    body.append('sources', form.sources);
    body.append('instructions', form.instructions);
    if (form.quick) body.append('quick', '1');
    if (form.runTwice) body.append('runTwice', '1');
    if (form.step) body.append('step', form.step);
    if (form.gate) body.append('gate', form.gate);
    return request<{ runId: string; projectId: string; iteration: number; status: string; queuePosition: number | null }>('/api/runs', { method: 'POST', body });
  },

  importScorecard(scorecard: File, document: File | null) {
    const body = new FormData();
    body.append('scorecard', scorecard);
    if (document) body.append('document', document);
    return request<ImportedScorecard>('/api/scorecards/import', { method: 'POST', body });
  },

  checkScorecard: (yaml: string) => request<CheckedScorecard>('/api/scorecards/check', json({ yaml })),

  cancelRun: (id: string) => request<RunDetail>(`/api/runs/${id}/cancel`, { method: 'POST' }),
  deleteRun: (id: string) => request<null>(`/api/runs/${id}`, { method: 'DELETE' }),
  deleteProject: (id: string) => request<null>(`/api/projects/${id}`, { method: 'DELETE' }),

  scorecardTemplateUrl: '/api/scorecard-template.xlsx',

  reportUrl: (runId: string, ext: 'xlsx' | 'pdf' | 'md' | 'json') => `/api/runs/${runId}/report.${ext}`,
};
