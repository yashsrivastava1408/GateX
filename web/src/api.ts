import type {
  ConfigResponse,
  LibraryCaseDetail,
  LibraryCaseSummary,
  PlantedResult,
  ReliabilityTable,
  Decision,
  ProjectHistory,
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
    return request<{ runId: string; projectId: string; iteration: number }>('/api/runs', { method: 'POST', body });
  },

  importScorecard(scorecard: File, document: File | null) {
    const body = new FormData();
    body.append('scorecard', scorecard);
    if (document) body.append('document', document);
    return request<ImportedScorecard>('/api/scorecards/import', { method: 'POST', body });
  },

  checkScorecard: (yaml: string) => request<CheckedScorecard>('/api/scorecards/check', json({ yaml })),

  deleteRun: (id: string) => request<null>(`/api/runs/${id}`, { method: 'DELETE' }),
  deleteProject: (id: string) => request<null>(`/api/projects/${id}`, { method: 'DELETE' }),

  scorecardTemplateUrl: '/api/scorecard-template.xlsx',

  reportUrl: (runId: string, ext: 'xlsx' | 'pdf' | 'md' | 'json') => `/api/runs/${runId}/report.${ext}`,
};
