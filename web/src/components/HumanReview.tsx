import { useState } from 'react';
import { bandOf, verdictFromScores, type Decision, type HumanReview as Review, type RunDetail } from '@ddd/shared';
import { api } from '../api';
import { REVIEW } from '../humanCopy';
import { formatDate, formatScore } from '../format';
import { useResource } from '../hooks';
import { useWho } from '../who';
import { DecisionChip } from './Chip';
import { Card } from './Layout';
import { useToast } from './Toast';

const MARKS = [0, 1, 2, 3, 4, 5];

function Gap({ gatex, person }: { gatex: number | null; person: number | undefined }) {
  if (person === undefined || gatex === null) return <span className="faint">—</span>;
  const diff = person - gatex;
  const near = Math.abs(diff) <= 1;
  return <span className={near ? 'gap-near' : 'gap-far'}>{diff === 0 ? REVIEW.close : `${diff > 0 ? '+' : ''}${diff.toFixed(1)} · ${near ? REVIEW.close : REVIEW.far}`}</span>;
}

/** Shadow mode: a person marks each area without GateX's marks beside them, and the two are compared. Never changes the check. */
export function HumanReview({ run }: { run: RunDetail }) {
  const report = run.report;
  const toast = useToast();
  const [who, setWho] = useWho();
  const reviews = useResource(() => api.humanReviews(run.id), [run.id]);
  const [marks, setMarks] = useState<Record<string, number>>({});
  const [colour, setColour] = useState<'' | Decision>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  if (!report || run.status !== 'done') return null;

  const dims = report.dimensions.filter((d) => d.status === 'scored' && typeof d.consolidated === 'number');
  if (dims.length === 0) return null;
  const given = Object.keys(marks).length;
  const own = verdictFromScores(dims.map((d) => ({ weight: d.weight, score: marks[d.id] ?? null })));

  const save = async () => {
    if (given === 0 || !who.trim()) {
      toast(REVIEW.need, 'bad');
      return;
    }
    setBusy(true);
    try {
      await api.addHumanReview(run.id, { reviewer: who.trim(), scores: marks, verdict: colour || null, note });
      toast(REVIEW.saved);
      setMarks({});
      setNote('');
      setColour('');
      reviews.reload();
    } catch (error) {
      toast(error instanceof Error && error.message ? error.message : 'Could not save your marks.', 'bad');
    } finally {
      setBusy(false);
    }
  };

  const earlier: Review[] = reviews.data ?? [];
  return (
    <Card title={REVIEW.title} aside={<span className="faint">{REVIEW.markHint}</span>}>
      <p className="field-hint">{REVIEW.hint}</p>
      <div className="review-grid">
        <label className="field">
          <span className="field-label">{REVIEW.name}</span>
          <input className="input input-sm" value={who} onChange={(e) => setWho(e.target.value)} autoComplete="name" />
        </label>
        <label className="field">
          <span className="field-label">{REVIEW.colour}</span>
          <select className="input input-sm" value={colour} onChange={(e) => setColour(e.target.value as '' | Decision)}>
            <option value="">{REVIEW.colourAuto}{own ? ` (${own})` : ''}</option>
            <option value="green">Green</option>
            <option value="amber">Amber</option>
            <option value="red">Red</option>
          </select>
        </label>
      </div>
      <div className="table-scroll">
        <table className="review-table">
          <thead>
            <tr><th>Area</th><th>{REVIEW.you}</th></tr>
          </thead>
          <tbody>
            {dims.map((d) => (
              <tr key={d.id}>
                <td>{d.name}{d.critical && <span className="faint"> · key check</span>}</td>
                <td>
                  <div className="segmented" role="group" aria-label={`Your mark for ${d.name}`}>
                    {MARKS.map((m) => (
                      <button key={m} type="button" className={marks[d.id] === m ? 'on' : ''} onClick={() => setMarks((x) => ({ ...x, [d.id]: m }))}>{m}</button>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <label className="field">
        <span className="field-label">{REVIEW.note}</span>
        <input className="input input-sm" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="review-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{REVIEW.save}</button>
        <span className="faint">{given} of {dims.length} areas marked</span>
      </div>

      {earlier.length > 0 && (
        <details className="review-earlier" open>
          <summary><strong>{REVIEW.earlier}</strong> <span className="faint">({earlier.length})</span></summary>
          {earlier.map((r) => (
            <div key={r.id} className="review-one">
              <div className="review-head">
                <strong>{r.reviewer}</strong>
                <span className="faint">{formatDate(r.createdAt)}</span>
                {(r.verdict ?? verdictFromScores(dims.map((d) => ({ weight: d.weight, score: r.scores[d.id] ?? null })))) && (
                  <DecisionChip decision={r.verdict ?? verdictFromScores(dims.map((d) => ({ weight: d.weight, score: r.scores[d.id] ?? null })))} size="sm" />
                )}
                <span className="faint">GateX: <DecisionChip decision={run.agentDecision ?? (run.weightedScore === null ? null : bandOf(run.weightedScore))} size="sm" /> {formatScore(run.weightedScore)}</span>
              </div>
              <table className="review-table">
                <thead><tr><th>Area</th><th>{REVIEW.gatex}</th><th>{r.reviewer}</th><th>{REVIEW.gap}</th></tr></thead>
                <tbody>
                  {dims.filter((d) => r.scores[d.id] !== undefined).map((d) => (
                    <tr key={d.id}>
                      <td>{d.name}</td>
                      <td>{formatScore(d.consolidated)}</td>
                      <td>{r.scores[d.id]}</td>
                      <td><Gap gatex={d.consolidated} person={r.scores[d.id]} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {r.note && <p className="faint">“{r.note}”</p>}
            </div>
          ))}
        </details>
      )}
    </Card>
  );
}
