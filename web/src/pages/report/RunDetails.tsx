import { costCell, costSentence, examinerLabel, type RunDetail } from '@ddd/shared';
import { useState } from 'react';
import { Chip } from '../../components/Chip';
import { CopyButton } from '../../components/CopyButton';
import { hideModels } from '../../present';
import { formatDate, formatDuration, shortHash, splitNote } from '../../format';

export function RunDetails({ run }: { run: RunDetail }) {
  const { header } = run.report!;
  const log = run.runLog;
  const rows: Array<[string, string, string?]> = [
    ['Check ID', header.runId, 'mono'],
    ['File checked', `${header.artifactName}`],
    ['File check code', header.artifactHash, 'mono'],
    ['Scorecard', `${header.scorecardName} v${header.scorecardVersion}`],
    ['Scorecard check code', header.scorecardHash, 'mono'],
    ['Scorecard source', header.scorecardApproval ?? 'as you added it'],
    ['Kind of check', header.gate === 'D1' ? 'Design check, marked against its scorecard' : 'Document check, marked against its scorecard'],
    ['Examiner guide version', header.promptVersion, 'mono'],
    ...(header.instructions ? ([['Your extra instructions', header.instructions], ['Instructions check code', header.instructionsHash ?? '', 'mono']] as Array<[string, string, string?]>) : []),
    ['Started', formatDate(header.startedAt)],
    ['Finished', formatDate(header.finishedAt)],
  ];

  return (
    <>
      <dl className="kv">
        {rows.map(([k, v, cls]) => (
          <div key={k} className="kv-row">
            <dt>{k}</dt>
            <dd className={cls}>
              {v}
              {cls === 'mono' && v.length > 20 && <CopyButton value={v} />}
            </dd>
          </div>
        ))}
      </dl>

      {log && (
        <div className="table-scroll subtle">
          <table className="table table-compact">
            <thead>
              <tr>
                <th>Who</th>
                <th>Job</th>
                <th>Status</th>
                <th className="num">Attempts</th>
                <th className="num">Size in / out</th>
                <th className="num">Time</th>
                <th className="num">Discarded</th>
                <th>Instructions check code</th>
              </tr>
            </thead>
            <tbody>
              {log.participants.map((p) => {
                return (
                  <tr key={p.id}>
                    <td>
                      {examinerLabel(p.id)}
                    </td>
                    <td className="faint">{p.role === 'consolidator' ? 'Reviews the marks' : 'Marks the work'}</td>
                    <td>{p.status === 'ok' ? <Chip tone="accent">Done</Chip> : <Chip tone="red">Failed</Chip>}{p.error && <div className="row-sub down">{hideModels(p.error)}</div>}</td>
                    <td className="num">{p.attempts}</td>
                    <td className="num mono">{p.inputTokens ?? '—'} / {p.outputTokens ?? '—'}</td>
                    <td className="num mono">{formatDuration(p.latencyMs)}</td>
                    <td className="num">{p.discarded}</td>
                    <td className="mono faint">{shortHash(log.promptHashes[p.id] ?? '')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {log && (
        <p className="note">
          Checked in {formatDuration(log.timings.checksMs)} · marked in {formatDuration(log.timings.ratingMs)} · reviewed in {formatDuration(log.timings.consolidationMs)} · {formatDuration(log.timings.totalMs)} in all.
          Marking setting {log.settings.temperature}, software {log.nodeVersion}.
        </p>
      )}

      {run.report!.cost && <RunCostTable cost={run.report!.cost} />}

      {run.report!.notes.length > 0 && (
        <div className="run-notes">
          <h3>Notes from this check</h3>
          <ul>
            {run.report!.notes.map((n, i) => (
              <Note key={i} text={n} />
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function RunCostTable({ cost }: { cost: NonNullable<RunDetail['report']>['cost'] & object }) {
  return (
    <div className="run-cost">
      <h3>What this check used</h3>
      <p className="note">{costSentence(cost)}</p>
      <div className="table-scroll subtle">
        <table className="table table-compact">
          <thead>
            <tr><th>Who</th><th className="num">Calls</th><th className="num">Tokens in</th><th className="num">Tokens out</th>{cost.totalCost !== null && <th className="num">Cost</th>}</tr>
          </thead>
          <tbody>
            {cost.lines.map((l, i) => (
              <tr key={i}>
                <td>{l.label}</td>
                <td className="num">{l.calls}</td>
                <td className="num mono">{l.inputTokens.toLocaleString('en-US')}</td>
                <td className="num mono">{l.outputTokens.toLocaleString('en-US')}</td>
                {cost.totalCost !== null && <td className="num mono">{costCell(l, cost.currency) || '—'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Note({ text }: { text: string }) {
  const [more, setMore] = useState(false);
  const { summary, rest } = splitNote(text);
  return (
    <li>
      {more || !rest ? hideModels(text) : hideModels(summary)}
      {rest && (
        <button type="button" className="link-btn" onClick={() => setMore(!more)}>
          {more ? 'Show less' : 'Show full message'}
        </button>
      )}
    </li>
  );
}
