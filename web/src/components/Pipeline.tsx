import { useEffect, useState } from 'react';
import { examinerLabel, type ParticipantProgress, type RunDetail, type RunStage } from '@ddd/shared';
import { hideModels } from '../present';
import { STATUS_LABEL, formatDuration } from '../format';
import { STAGES } from '../copy';
import { Icon } from './Icons';

const STEPS = STAGES;

const ORDER: RunStage[] = ['queued', 'reading', 'checks', 'rating', 'consolidating', 'reporting', 'done'];

function Participant({ p }: { p: ParticipantProgress }) {
  return (
    <div className={`participant participant-${p.status}`} title={p.error ? hideModels(p.error) : examinerLabel(p.id)}>
      <span className="participant-id">{p.role === 'consolidator' ? 'F' : examinerLabel(p.id).replace('Examiner ', '')}</span>
      <span className="participant-body">
        <span className="participant-model">{examinerLabel(p.id)}</span>
        <span className="participant-meta">{p.role === 'consolidator' ? 'Compares the marks' : 'Marks on its own'}</span>
      </span>
      <span className="participant-status">
        {p.status === 'running' && <span className="spinner spinner-sm" />}
        {p.status === 'ok' && <Icon name="check" size={14} />}
        {p.status === 'failed' && <Icon name="x" size={14} />}
        {STATUS_LABEL[p.status]}
        {p.latencyMs !== undefined && p.status !== 'running' && <span className="faint"> · {formatDuration(p.latencyMs)}</span>}
      </span>
    </div>
  );
}

/** Counts up from when the run was submitted, once a second, until it ends. */
function useElapsed(run: RunDetail): number {
  const live = run.status === 'queued' || run.status === 'running';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  const end = live ? now : run.finishedAt ? Date.parse(run.finishedAt) : now;
  return Math.max(0, end - Date.parse(run.createdAt));
}

function Summary({ run }: { run: RunDetail }) {
  const elapsed = useElapsed(run);
  const participants = run.progress?.participants ?? [];
  const finished = participants.filter((p) => p.status === 'ok').length;
  const failed = participants.filter((p) => p.status === 'failed').length;
  const stageIndex = Math.max(0, ORDER.indexOf(run.stage));
  const percent = run.status === 'done' ? 100 : Math.round((stageIndex / (ORDER.length - 1)) * 100);
  return (
    <div className="run-summary">
      <div className="run-summary-row">
        <span className="run-summary-stage">
          Step {Math.min(stageIndex + 1, STEPS.length)} of {STEPS.length}
        </span>
        {participants.length > 0 && (
          <span className="run-summary-models">
            {finished} of {participants.length} done{failed > 0 && <span className="run-summary-fail"> · {failed} failed</span>}
          </span>
        )}
        <span className="run-summary-time mono">{formatDuration(elapsed)}</span>
      </div>
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Check progress">
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export function Pipeline({ run }: { run: RunDetail }) {
  const at = ORDER.indexOf(run.stage);
  const failed = run.status === 'failed';
  const participants = run.progress?.participants ?? [];

  return (
    <>
    {!failed && <Summary run={run} />}
    <ol className="pipeline">
      {STEPS.map((step, index) => {
        const position = ORDER.indexOf(step.stage);
        const state = failed ? 'idle' : run.status === 'done' || at > position ? 'done' : at === position ? 'active' : 'idle';
        const members =
          step.stage === 'rating'
            ? participants.filter((p) => p.role === 'rater')
            : step.stage === 'consolidating'
              ? participants.filter((p) => p.role === 'consolidator')
              : [];
        return (
          <li key={step.stage} className={`pipe pipe-${state}`}>
            <span className="pipe-node">
              {state === 'done' ? <Icon name="check" size={14} strokeWidth={2.6} /> : state === 'active' ? <span className="pulse" /> : index + 1}
            </span>
            <div className="pipe-body">
              <div className="pipe-title">{step.title}</div>
              <div className="pipe-detail">{step.detail}</div>
              {members.length > 0 && (
                <div className="participants">
                  {members.map((p) => (
                    <Participant key={p.id} p={p} />
                  ))}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
    </>
  );
}
