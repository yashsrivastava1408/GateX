import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ProjectSummary } from '@ddd/shared';
import { api } from '../api';
import { Chip, DecisionChip } from '../components/Chip';
import { Stat } from '../components/Stat';
import { isActive, pendingChip } from '../runStatus';
import { ConfirmDelete } from '../components/ConfirmDelete';
import { Icon } from '../components/Icons';
import { useToast } from '../components/Toast';
import { Card, EmptyState, ErrorBanner, Loading, PageHeader } from '../components/Layout';
import { formatScore, timeAgo } from '../format';
import { useDocumentTitle, useResource } from '../hooks';

function LatestChip({ project }: { project: ProjectSummary }) {
  const latest = project.latest;
  if (!latest) return <span className="faint">—</span>;
  const pending = pendingChip(latest);
  if (pending) return <Chip tone={pending.tone}>{pending.label}</Chip>;
  return <DecisionChip decision={latest.finalDecision} size="sm" />;
}

function HowItWorks() {
  const steps = [
    { n: '1', title: 'Add your file and its scorecard', body: 'Your Excel or PDF file, and the scorecard that says how it is marked. GateX never changes them.' },
    { n: '2', title: 'Three examiners and a final reviewer', body: 'The computer counts what it can. Three examiners mark the rest on their own, and the final reviewer compares their marks.' },
    { n: '3', title: 'Get your report', body: 'Fixed rules decide the result. The report lists what to fix, in order, and you can download it as PDF or Excel.' },
  ];
  return (
    <div className="how">
      {steps.map((s) => (
        <div key={s.n} className="how-step">
          <span className="how-n">{s.n}</span>
          <h3>{s.title}</h3>
          <p>{s.body}</p>
        </div>
      ))}
    </div>
  );
}

export function ProjectsPage() {
  useDocumentTitle('Projects');
  const navigate = useNavigate();
  const toast = useToast();
  const [removing, setRemoving] = useState<ProjectSummary | null>(null);
  const projects = useResource(api.projects, [], (list) => (list.some((p) => p.latest && isActive(p.latest.status)) ? 2000 : null));
  const list = projects.data ?? [];

  const evaluations = list.reduce((sum, p) => sum + p.runCount, 0);
  const green = list.filter((p) => p.latest?.finalDecision === 'green').length;
  const attention = list.filter((p) => p.latest?.finalDecision === 'amber' || p.latest?.finalDecision === 'red').length;

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title="Projects"
        actions={
          <Link to="/new" className="btn btn-primary">
            <Icon name="plus" /> New check
          </Link>
        }
      >
        Each file you check lives in a project. Open one to see its reports.
      </PageHeader>

      {removing && (
        <ConfirmDelete
          title={`Delete “${removing.name}”?`}
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await api.deleteProject(removing.id);
            setRemoving(null);
            projects.reload();
            toast('Project deleted');
          }}
        >
          The project and its {removing.runCount} saved {removing.runCount === 1 ? 'report' : 'reports'}, with their scores, issues and files, are removed for good. This cannot be undone.
        </ConfirmDelete>
      )}

      {projects.error && <ErrorBanner message={projects.error} onRetry={projects.reload} />}
      {projects.loading && <Loading label="Loading projects" />}

      {!projects.loading && !projects.error && list.length === 0 && (
        <Card>
          <EmptyState
            icon="chart"
            title="Nothing checked yet"
            action={
              <Link to="/new" className="btn btn-primary">
                <Icon name="plus" /> Check your first file
              </Link>
            }
          >
            Add your file and its scorecard to get a result (green, amber or red) and the steps to improve it.
          </EmptyState>
          <HowItWorks />
        </Card>
      )}

      {list.length > 0 && (
        <>
          <div className="stats">
            <Stat label="Projects" value={list.length} hint="files you are tracking" />
            <Stat label="Checks" value={evaluations} hint="rounds checked so far" />
            <Stat label="Green" value={green} hint="latest round passed" />
            <Stat label="Needs attention" value={attention} hint="still need a fix" />
          </div>

          <Card flush>
            <div className="table-scroll">
            <table className="table table-hover table-fit">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Latest result</th>
                  <th className="num">Score</th>
                  <th className="num">Checks</th>
                  <th>Scorecard</th>
                  <th>Updated</th>
                  <th><span className="sr-only">Delete</span></th>
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.id} onClick={() => navigate(`/projects/${p.id}`)} className="clickable">
                    <td>
                      <Link to={`/projects/${p.id}`} className="row-title" onClick={(e) => e.stopPropagation()}>
                        {p.name}
                      </Link>
                      {p.step && <div className="row-sub">Step {p.step}</div>}
                    </td>
                    <td>
                      <LatestChip project={p} />
                    </td>
                    <td className="num mono">{formatScore(p.latest?.weightedScore)}</td>
                    <td className="num">{p.runCount}</td>
                    <td className="mono faint">{p.latest?.scorecardId ?? '—'}</td>
                    <td className="faint nowrap">{timeAgo(p.latest?.createdAt)}</td>
                    <td className="num">
                      <button type="button" className="btn btn-ghost btn-sm row-delete" aria-label={`Delete ${p.name}`} onClick={(e) => { e.stopPropagation(); setRemoving(p); }}>
                        <Icon name="trash" size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </Card>
        </>
      )}
    </>
  );
}
