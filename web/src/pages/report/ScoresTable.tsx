import { bandOf, examinerLabel } from '@ddd/shared';
import { Fragment, useState } from 'react';
import type { DimensionResult, MeasuredBy, Report } from '@ddd/shared';
import { CellChip, Chip } from '../../components/Chip';
import { Hint } from '../../components/Hint';
import { Icon } from '../../components/Icons';
import { METHOD, TERMS, statusOf } from '../../copy';

const tone = (score: number | null) => (score === null ? 'none' : bandOf(score * 20) === 'green' ? 'hi' : bandOf(score * 20) === 'amber' ? 'mid' : 'lo');

function ScoreBar({ score }: { score: number | null }) {
  if (score === null) return <span className="faint">—</span>;
  return (
    <span className="scorebar" title={`${score} out of 5`}>
      <span className="scorebar-segs">
        {[1, 2, 3, 4, 5].map((n) => (
          <i key={n} className={n <= score ? `seg seg-on seg-${tone(score)}` : 'seg'} />
        ))}
      </span>
      <span className={`score-num score-${tone(score)}`}>{score}</span>
    </span>
  );
}

const GROUPS: MeasuredBy[] = ['code', 'raters', 'human'];

export function ScoresTable({ report }: { report: Report }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const raters = report.header.raters;
  const columns = raters.length + 5;
  // When the scorecard leaves unmeasurable questions out of the score, say so instead of showing a 0.
  const skipping = report.verdict.skipped.length > 0;

  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="table-scroll">
      <table className="table scores">
        <thead>
          <tr>
            <th>Area</th>
            <th className="num">Importance <Hint text={TERMS.importance.help} /></th>
            {raters.map((r) => (
              <th key={r.id} className="num">{examinerLabel(r.id)}</th>
            ))}
            <th>Final score <Hint text={TERMS.score.help} /></th>
            <th className="num">Disagreement <Hint text={TERMS.disagreement.help} align="right" /></th>
            <th>Status</th>
          </tr>
        </thead>
        {GROUPS.map((group) => {
          const rows = report.dimensions.filter((d) => d.measuredBy === group);
          if (rows.length === 0) return null;
          return (
            <tbody key={group} className={`group group-${group}`}>
              <tr className="group-row">
                <th colSpan={columns} scope="colgroup">
                  <span className="group-title">{group === 'human' && skipping ? 'Not measured' : METHOD[group].group}</span>
                  <span className="chip chip-sm chip-muted">{rows.length}</span>
                  <span className="group-blurb">{group === 'human' && skipping ? 'Nothing in the file could measure these, so they are left out of the score and do not hold the result back.' : METHOD[group].blurb}</span>
                </th>
              </tr>
              {rows.map((d) => (
                <Row key={d.id} d={d} raters={raters} columns={columns} expanded={open.has(d.id)} onToggle={() => toggle(d.id)} skipped={report.verdict.skipped.includes(d.id)} />
              ))}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}

function Row({ d, raters, columns, expanded, onToggle, skipped }: { d: DimensionResult; raters: Report['header']['raters']; columns: number; expanded: boolean; onToggle: () => void; skipped: boolean }) {
  const detail = Boolean(d.rationale || d.evidence.length > 0 || d.codeDetail || d.error || d.criteria?.length);
  const status = skipped ? { label: 'Not measured', tone: 'muted' as const, help: 'Nothing in the file could measure this, so it is left out of the score.' } : statusOf(d);
  return (
    <Fragment>
      <tr className={`${detail ? 'clickable' : ''} ${expanded ? 'row-open' : ''}`} onClick={detail ? onToggle : undefined}>
        <td>
          <div className="dim">
            <span className={`chev ${detail ? '' : 'chev-off'} ${expanded ? 'chev-open' : ''}`}>{detail && <Icon name="chevron" size={14} />}</span>
            <span className="dim-main">
              <span className="dim-name">{d.name}</span>
              {d.critical && <span className="crit" title="Key check: needs 4 or more">★</span>}
            </span>
          </div>
        </td>
        <td className="num faint">{d.weight}</td>
        {raters.map((r) => (
          <td key={r.id} className="num">{d.measuredBy === 'raters' ? <span className={`score-num score-${tone(d.raterScores[r.id] ?? null)}`}>{d.raterScores[r.id] ?? '—'}</span> : <span className="faint">·</span>}</td>
        ))}
        <td><ScoreBar score={d.consolidated} /></td>
        <td className="num">{d.spread === null ? <span className="faint">—</span> : <span className={d.spread > 1 ? 'down' : ''}>{d.spread}</span>}</td>
        <td><span title={status.help}><Chip tone={status.tone}>{status.label}</Chip></span></td>
      </tr>
      {expanded && (
        <tr className="row-detail">
          <td colSpan={columns}>
            <div className="detail">
              {d.codeDetail && <p><strong>Counted by the computer:</strong> {d.codeDetail.summary}.</p>}
              {d.criteria && d.criteria.length > 0 ? (
                <>
                  <p className="faint">Scored part by part. The score above combines the parts using the scorecard’s rule.</p>
                  <ul className="plain-list criteria-list">
                    {d.criteria.map((c) => (
                      <li key={c.id}>
                        <strong>{c.name}</strong>{' '}
                        <span className="faint">{c.kind === 'counted' ? 'counted by the computer' : 'examiners'}</span>
                        {': '}
                        {c.status === 'not_measurable' ? (
                          <span className="faint">not in the file</span>
                        ) : (
                          <span className={`score-num score-${tone(c.consolidated)}`}>{c.consolidated ?? '—'}</span>
                        )}
                        {c.codeDetail && <span className="faint"> ({c.codeDetail.passed} of {c.codeDetail.total})</span>}
                        {c.kind === 'judged' && c.spread !== null && c.spread > 1 && <span className="down"> · examiners {c.spread} apart</span>}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                d.rationale && <p>{d.rationale}</p>
              )}
              {d.error && <p className="down">{d.error}</p>}
              {d.evidence.length > 0 && (
                <p className="detail-evidence">
                  <span className="faint">Where to look</span>
                  {d.evidence.map((e, i) => (
                    <span key={i} className="evidence">
                      <CellChip sheet={e.sheet} cell={e.cell} />
                      {e.quote && <q>{e.quote}</q>}
                    </span>
                  ))}
                </p>
              )}
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}
