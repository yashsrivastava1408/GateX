import { SEVERITY_LABEL as SHARED_SEVERITY, type Decision, type ParticipantStatus, type Severity } from '@ddd/shared';

export const DECISION_LABEL: Record<Decision, string> = { green: 'Green', amber: 'Amber', red: 'Red' };

export const SEVERITY_LABEL: Record<Severity, string> = SHARED_SEVERITY;

export const STATUS_LABEL: Record<ParticipantStatus, string> = {
  waiting: 'Waiting',
  running: 'Marking',
  ok: 'Done',
  failed: 'Failed',
};

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function timeAgo(value: string | null | undefined, now = Date.now()): string {
  if (!value) return '—';
  const seconds = Math.max(0, Math.round((now - new Date(value).getTime()) / 1000));
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 7 * 86_400) return `${Math.round(seconds / 86_400)} d ago`;
  return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function formatScore(score: number | null | undefined): string {
  return score === null || score === undefined ? '—' : score.toFixed(1);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function shortHash(hash: string): string {
  return hash.slice(0, 10);
}

export function location(loc: { sheet: string; cell: string } | null | undefined): string {
  return loc ? `${loc.sheet}!${loc.cell}` : '—';
}

/**
 * Provider messages can run to several lines of links and quota numbers. Show the first sentence in full view and keep
 * the rest one click away.
 */
export function splitNote(note: string, max = 170): { summary: string; rest: string | null } {
  const flat = note.replace(/\s+/g, ' ').trim();
  const sentenceEnd = flat.search(/[.!?](\s|$)/);
  let summary = sentenceEnd > 0 && sentenceEnd < max ? flat.slice(0, sentenceEnd + 1) : flat.slice(0, max);
  if (summary.length < flat.length && !/[.!?]$/.test(summary)) summary = `${summary.trimEnd()}…`;
  return { summary, rest: flat.length > summary.length ? flat : null };
}
