import type { RunStatus, RunSummary } from '@ddd/shared';
import { LINE } from './copy';

/** True while the run still changes by itself (waiting, starting or running), so a page should keep refreshing. */
export const isActive = (status: RunStatus): boolean => status === 'waiting' || status === 'queued' || status === 'running';

/** True once marking has begun. A waiting run has not. */
export const isStarted = (status: RunStatus): boolean => status === 'queued' || status === 'running';

/** The chip text and colour for a run that has no verdict (yet). Null for a finished run, which shows its verdict instead. */
export function pendingChip(run: Pick<RunSummary, 'status' | 'queuePosition'>): { label: string; tone: 'accent' | 'red' | 'muted' | 'amber' } | null {
  switch (run.status) {
    case 'waiting':
      return { label: LINE.waitingLabel(run.queuePosition), tone: 'amber' };
    case 'queued':
    case 'running':
      return { label: LINE.running, tone: 'accent' };
    case 'failed':
      return { label: 'Failed', tone: 'red' };
    case 'cancelled':
      return { label: LINE.cancelled, tone: 'muted' };
    default:
      return null;
  }
}
