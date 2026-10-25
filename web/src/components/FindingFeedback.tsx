import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { FeedbackLabel, FindingFeedback as Mark } from '@ddd/shared';
import { api } from '../api';
import { FEEDBACK } from '../humanCopy';
import { useWho } from '../who';
import { useToast } from './Toast';

/** One list of marks per run, shared by every issue on the page so the page makes one request, not one per issue. */
const cache = new Map<string, Promise<Mark[]>>();
const listeners = new Set<() => void>();
const marksOf = (runId: string): Promise<Mark[]> => {
  if (!cache.has(runId)) cache.set(runId, api.feedback(runId).catch(() => []));
  return cache.get(runId)!;
};
const refresh = (runId: string, marks: Mark[]) => {
  cache.set(runId, Promise.resolve(marks));
  listeners.forEach((l) => l());
};

/** Right / wrong / unclear on one issue, from a person. The marks count as human labels on the Accuracy page and never change the report. */
export function FindingFeedback({ findingId }: { findingId: string }) {
  const { id: runId = '' } = useParams();
  const toast = useToast();
  const [who, setWho] = useWho();
  const [marks, setMarks] = useState<Mark[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!runId) return;
    let live = true;
    const load = () => void marksOf(runId).then((m) => live && setMarks(m));
    load();
    listeners.add(load);
    return () => {
      live = false;
      listeners.delete(load);
    };
  }, [runId]);

  if (!runId) return null;
  const own = marks.filter((m) => m.findingId === findingId);
  const mine = own.find((m) => m.who.trim().toLowerCase() === who.trim().toLowerCase())?.label;
  const count = (label: FeedbackLabel) => own.filter((m) => m.label === label).length;

  const mark = async (label: FeedbackLabel) => {
    if (!who.trim()) {
      toast(FEEDBACK.needName, 'bad');
      return;
    }
    setBusy(true);
    try {
      refresh(runId, await api.addFeedback(runId, findingId, { label, who: who.trim() }));
      toast(FEEDBACK.thanks);
    } catch (error) {
      toast(error instanceof Error && error.message ? error.message : 'Could not save your mark.', 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="finding-feedback" onClick={(e) => e.stopPropagation()}>
      <span className="finding-fix-label">{FEEDBACK.ask}</span>
      <div className="segmented" role="group" aria-label={FEEDBACK.ask}>
        {(['right', 'wrong', 'unclear'] as const).map((label) => (
          <button key={label} type="button" className={mine === label ? 'on' : ''} disabled={busy} onClick={() => mark(label)}>
            {FEEDBACK[label]}
          </button>
        ))}
      </div>
      <input className="input input-sm feedback-name" value={who} onChange={(e) => setWho(e.target.value)} placeholder={FEEDBACK.name} aria-label={FEEDBACK.name} autoComplete="name" />
      <span className="faint">{FEEDBACK.counts(count('right'), count('wrong'), count('unclear'))}</span>
    </div>
  );
}
