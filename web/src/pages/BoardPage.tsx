import { Link } from 'react-router-dom';
import type { Board, BoardStep, ScorecardBox, VerdictBox } from '@ddd/shared';
import { api } from '../api';
import { Icon } from '../components/Icons';
import { Card, EmptyState, ErrorBanner, Loading, PageHeader } from '../components/Layout';
import { formatScore } from '../format';
import { useDocumentTitle, useResource } from '../hooks';

const VERDICT_WORD = { green: 'Green', amber: 'Amber', red: 'Red' } as const;

function Verdict({ box }: { box: VerdictBox }) {
  if (box.state === 'not_started') return <span className="board-box board-none">Not started</span>;
  if (box.state === 'in_progress') {
    return (
      <Link to={`/runs/${box.runId}`} className="board-box board-none" title={box.projectName}>
        Checking now
      </Link>
    );
  }
  return (
    <Link to={`/runs/${box.runId}`} className={`board-box board-${box.state}`} title={`${box.projectName}: open the report`}>
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
      <td>
        <div className="board-step">
          <span className="board-n">{String(step.n).padStart(2, '0')}</span>
          <span>{step.name}</span>
        </div>
      </td>
      <td><Verdict box={step.d1} /></td>
      <td><Scorecard box={step.d2} /></td>
      <td><Verdict box={step.d3} /></td>
      <td><Scorecard box={step.d4} /></td>
      <td><span className={`board-status board-status-${step.status}`}>{STATUS_WORD[step.status]}</span></td>
    </tr>
  );
}

function BoardTable({ board }: { board: Board }) {
  return (
    <div className="table-scroll">
      <table className="board">
        <thead>
          <tr>
            <th>Step</th>
            <th>D1 · Schema design</th>
            <th>D2 · Schema scorecard</th>
            <th>D3 · Output document</th>
            <th>D4 · Output scorecard</th>
            <th>Step status</th>
          </tr>
        </thead>
        <tbody>
          {board.steps.map((s) => <Row key={s.n} step={s} />)}
        </tbody>
      </table>
    </div>
  );
}

export function BoardPage() {
  useDocumentTitle('Status board');
  const board = useResource(api.board, [], () => 5000);
  const empty = board.data ? board.data.steps.every((s) => s.status === 'not_started') : false;

  return (
    <>
      <PageHeader eyebrow="Overview" title="Status board" actions={<Link to="/new" className="btn btn-primary"><Icon name="plus" /> New check</Link>}>
        Every step has four deliverables. D1 and D3 show GateX’s latest result. D2 and D4 show Frozen once a scorecard has been used to check one. A step is Complete when both results are green and both scorecards are frozen.
      </PageHeader>
      {board.error && <ErrorBanner message={board.error} />}
      {!board.data && !board.error && <Loading />}
      {board.data && empty && (
        <EmptyState icon="flag" title="Nothing is on the board yet" action={<Link to="/new" className="btn btn-primary">Check a file</Link>}>
          When you start a check, choose its step and whether the file is a schema (D1) or an output (D3). Its result appears here.
        </EmptyState>
      )}
      {board.data && !empty && (
        <Card>
          <BoardTable board={board.data} />
          {board.data.unplaced > 0 && (
            <p className="field-hint board-note">
              {board.data.unplaced} {board.data.unplaced === 1 ? 'project was' : 'projects were'} checked without a step, so {board.data.unplaced === 1 ? 'it is' : 'they are'} not shown here.
            </p>
          )}
        </Card>
      )}
    </>
  );
}
