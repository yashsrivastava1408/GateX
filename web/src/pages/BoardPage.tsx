import { Link } from 'react-router-dom';
import type { Board, BoardStep, ScorecardBox, VerdictBox } from '@ddd/shared';
import { api } from '../api';
import { Stat } from '../components/Stat';
import { Icon } from '../components/Icons';
import { Card, EmptyState, ErrorBanner, Loading, PageHeader } from '../components/Layout';
import { formatScore } from '../format';
import { useDocumentTitle, useResource } from '../hooks';

const VERDICT_WORD = { green: 'Green', amber: 'Amber', red: 'Red' } as const;

function Verdict({ box, label }: { box: VerdictBox; label: string }) {
  if (box.state === 'not_started') return <span className="board-box board-none">Not started</span>;
  if (box.state === 'in_progress') {
    return (
      <Link to={`/runs/${box.runId}`} className="board-box board-none" title={box.projectName} aria-label={`${label}: checking now. Open ${box.projectName}`}>
        Checking now
      </Link>
    );
  }
  return (
    <Link
      to={`/runs/${box.runId}`}
      className={`board-box board-${box.state}`}
      title={`${box.projectName}: open the report`}
      aria-label={`${label}: ${VERDICT_WORD[box.state]}, ${formatScore(box.score)} out of 100. Open the report for ${box.projectName}`}
    >
      <strong>{VERDICT_WORD[box.state]}</strong>
      <small>{formatScore(box.score)}</small>
    </Link>
  );
}

function Scorecard({ box }: { box: ScorecardBox }) {
  return box.state === 'frozen' ? (
    <span className="board-box board-frozen" title={`Used by ${box.projectName}`}>Frozen</span>
  ) : (
    <span className="board-box board-none">Not started</span>
  );
}

const STATUS_WORD = { complete: 'Complete', open: 'Open', not_started: 'Not started' } as const;

function Row({ step }: { step: BoardStep }) {
  return (
    <tr>
      <th scope="row" data-label="Step">
        <div className="board-step">
          <span className="board-n">{String(step.n).padStart(2, '0')}</span>
          <span>{step.name}</span>
        </div>
      </th>
      <td data-label="D1 · Schema design"><Verdict box={step.d1} label={`Step ${step.n}, schema design`} /></td>
      <td data-label="D2 · Schema scorecard"><Scorecard box={step.d2} /></td>
      <td data-label="D3 · Output document"><Verdict box={step.d3} label={`Step ${step.n}, output document`} /></td>
      <td data-label="D4 · Output scorecard"><Scorecard box={step.d4} /></td>
      <td data-label="Step status"><span className={`board-status board-status-${step.status}`}>{STATUS_WORD[step.status]}</span></td>
    </tr>
  );
}

function BoardTable({ board }: { board: Board }) {
  return (
    <div className="table-scroll">
      <table className="board">
        <caption className="sr-only">Five steps, each with a schema design, a schema scorecard, an output document and an output scorecard</caption>
        <thead>
          <tr>
            <th scope="col">Step</th>
            <th scope="col">D1 · Schema design</th>
            <th scope="col">D2 · Schema scorecard</th>
            <th scope="col">D3 · Output document</th>
            <th scope="col">D4 · Output scorecard</th>
            <th scope="col">Step status</th>
          </tr>
        </thead>
        <tbody>
          {board.steps.map((s) => <Row key={s.n} step={s} />)}
        </tbody>
      </table>
    </div>
  );
}

function Legend() {
  return (
    <ul className="board-legend" aria-label="How to read the boxes">
      <li><span className="board-box board-green">Green</span> score 75 or more</li>
      <li><span className="board-box board-amber">Amber</span> score 60 to 74</li>
      <li><span className="board-box board-red">Red</span> score below 60</li>
      <li><span className="board-box board-frozen">Frozen</span> a scorecard has been used</li>
      <li><span className="board-box board-none">Not started</span> nothing checked yet</li>
    </ul>
  );
}

export function BoardPage() {
  useDocumentTitle('Status board');
  const board = useResource(api.board, [], () => 5000);
  const data = board.data;
  const empty = data ? data.steps.every((s) => s.status === 'not_started') : false;
  const complete = data ? data.steps.filter((s) => s.status === 'complete').length : 0;
  const open = data ? data.steps.filter((s) => s.status === 'open').length : 0;
  const greens = data ? data.steps.reduce((n, s) => n + (s.d1.state === 'green' ? 1 : 0) + (s.d3.state === 'green' ? 1 : 0), 0) : 0;

  return (
    <>
      <PageHeader eyebrow="Track" title="Status board" actions={<Link to="/new" className="btn btn-primary"><Icon name="plus" /> New check</Link>}>
        Every step has four deliverables. D1 and D3 show GateX’s latest result. D2 and D4 show Frozen once a scorecard has been used to check one. A step is Complete when both results are green and both scorecards are frozen.
      </PageHeader>
      {board.error && <ErrorBanner message={board.error} onRetry={board.reload} />}
      {board.loading && !data && <Loading label="Loading the board" />}
      {data && empty && (
        <EmptyState icon="flag" title="Nothing is on the board yet" action={<Link to="/new" className="btn btn-primary">Check a file</Link>}>
          When you start a check, choose its step and whether the file is a schema (D1) or an output (D3). Its result appears here.
        </EmptyState>
      )}
      {data && !empty && (
        <>
          <div className="stats">
            <Stat label="Steps complete" value={`${complete} of ${data.steps.length}`} hint="both results green, both scorecards frozen" />
            <Stat label="Steps open" value={open} hint="checked, not finished yet" />
            <Stat label="Green results" value={greens} hint="of the D1 and D3 boxes" />
            <Stat label="Not on the board" value={data.unplaced} hint={data.unplaced === 1 ? 'project checked without a step' : 'projects checked without a step'} />
          </div>
          <Card flush>
            <BoardTable board={data} />
          </Card>
          <Legend />
          {data.unplaced > 0 && (
            <p className="field-hint board-note">
              {data.unplaced === 1 ? 'One project was' : `${data.unplaced} projects were`} checked without a step, so {data.unplaced === 1 ? 'it is' : 'they are'} not shown here. Pick a step on the <Link to="/new">next check</Link> to place it.
            </p>
          )}
        </>
      )}
    </>
  );
}
