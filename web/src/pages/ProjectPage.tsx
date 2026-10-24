import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { Chip, DecisionChip } from '../components/Chip';
import { ConfirmDelete } from '../components/ConfirmDelete';
import { useToast } from '../components/Toast';
import { Icon } from '../components/Icons';
import { Card, ErrorBanner, Loading, PageHeader } from '../components/Layout';
import { formatDate, formatScore } from '../format';
import { useDocumentTitle, useResource } from '../hooks';

export function ProjectPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [removing, setRemoving] = useState<{ kind: 'project' } | { kind: 'run'; id: string } | null>(null);
  const history = useResource(() => api.project(id), [id], (h) => (h.runs.some((r) => r.status === 'queued' || r.status === 'running') ? 2000 : null));
  const h = history.data;
  useDocumentTitle(h?.project.name ?? 'Project');

  if (history.loading) return <Loading />;
  if (history.error || !h) return <ErrorBanner message={history.error ?? 'Project not found.'} onRetry={history.reload} />;

  const done = h.runs.filter((r) => r.status === 'done');
  const latest = done[done.length - 1];
  const accept = h.thresholds?.accept ?? 75;

  return (
    <>
      <PageHeader
        eyebrow={<Link to="/" className="crumb"><Icon name="back" size={13} /> Projects</Link>}
        title={h.project.name}
        actions={
          <>
          <button type="button" className="btn btn-ghost" onClick={() => setRemoving({ kind: 'project' })}>
            <Icon name="trash" /> Delete project
          </button>
          <Link to={`/new?project=${encodeURIComponent(h.project.name)}`} className="btn btn-primary">
            <Icon name="plus" /> New check
          </Link>
          </>
        }
      >
        {h.project.step ? `Step ${h.project.step} · ` : ''}
        {h.runs.length} report{h.runs.length === 1 ? '' : 's'}
      </PageHeader>

      {latest && (
        <div className="stats">
          <div className="stat">
            <span className="stat-label">Latest result</span>
            <span className="stat-value"><DecisionChip decision={latest.finalDecision} size="lg" /></span>
            <span className="stat-hint">{formatDate(latest.createdAt)}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Score</span>
            <span className="stat-value mono">{formatScore(latest.weightedScore)}</span>
            <span className="stat-hint">green at {accept}</span>
          </div>
        </div>
      )}

      <Card title="Reports" flush>
        <div className="table-scroll">
        <table className="table table-hover table-fit">
          <thead>
            <tr>
              <th>Report</th>
              <th>File</th>
              <th>Result</th>
              <th className="num">Score</th>
              <th><span className="sr-only">Delete</span></th>
            </tr>
          </thead>
          <tbody>
            {[...h.runs].reverse().map((r) => {
              return (
                <tr key={r.id} className="clickable" onClick={() => navigate(`/runs/${r.id}`)}>
                  <td><Link to={`/runs/${r.id}`} className="row-title" onClick={(e) => e.stopPropagation()}>{formatDate(r.createdAt)}</Link></td>
                  <td className="mono faint truncate">{r.artifactName}</td>
                  <td>
                    {r.status === 'failed' ? <Chip tone="red">Failed</Chip> : r.status !== 'done' ? <Chip tone="accent">In progress</Chip> : <DecisionChip decision={r.finalDecision} size="sm" />}
                  </td>
                  <td className="num mono">{formatScore(r.weightedScore)}</td>
                  <td className="num">
                    {r.status !== 'queued' && r.status !== 'running' && (
                      <button type="button" className="btn btn-ghost btn-sm row-delete" aria-label="Delete this report" onClick={(e) => { e.stopPropagation(); setRemoving({ kind: 'run', id: r.id }); }}>
                        <Icon name="trash" size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </Card>

      {removing && (
        <ConfirmDelete
          title={removing.kind === 'project' ? `Delete “${h.project.name}”?` : 'Delete this report?'}
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            if (removing.kind === 'project') {
              await api.deleteProject(h.project.id);
              toast('Project deleted');
              navigate('/');
            } else {
              await api.deleteRun(removing.id);
              toast('Report deleted');
              // Deleting a project's last report removes the project too.
              if (h.runs.length === 1) {
                navigate('/');
              } else {
                setRemoving(null);
                history.reload();
              }
            }
          }}
        >
          {removing.kind === 'project'
            ? `The project and its ${h.runs.length} saved ${h.runs.length === 1 ? 'report' : 'reports'}, with their scores, issues and files, are removed for good. This cannot be undone.`
            : 'The scores, issues and saved report files for this check are removed for good. This cannot be undone.'}
        </ConfirmDelete>
      )}
    </>
  );
}
