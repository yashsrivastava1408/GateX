import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { RunDetail } from '@ddd/shared';
import { api } from '../api';
import { Chip, DecisionChip } from '../components/Chip';
import { ConfirmDelete } from '../components/ConfirmDelete';
import { Icon } from '../components/Icons';
import { Card, ErrorBanner, Loading, PageHeader } from '../components/Layout';
import { Menu } from '../components/Menu';
import { Pipeline } from '../components/Pipeline';
import { useToast } from '../components/Toast';
import { formatDate } from '../format';
import { hideModels } from '../present';
import { summaryText } from '../reportSummary';
import { useDocumentTitle, useResource } from '../hooks';
import { ReportView } from './report/ReportView';

const isLive = (run: RunDetail) => run.status === 'queued' || run.status === 'running';

export function RunPage() {
  const { id = '' } = useParams();
  const run = useResource(() => api.run(id), [id], (r) => (isLive(r) ? 1500 : null));
  const r = run.data;
  const toast = useToast();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const copySummary = async () => {
    try {
      await navigator.clipboard.writeText(summaryText(r!));
      toast('Summary copied');
    } catch {
      toast('Could not copy. Your browser blocked it.', 'bad');
    }
  };
  useDocumentTitle(r ? r.projectName : 'Check');

  if (run.loading) return <Loading label="Loading your check" />;
  if (run.error && !r) return <ErrorBanner message={run.error} onRetry={run.reload} />;
  if (!r) return null;

  return (
    <>
      <PageHeader
        eyebrow={
          <Link to={`/projects/${r.projectId}`} className="crumb">
            <Icon name="back" size={13} /> {r.projectName}
          </Link>
        }
        title={
          <span className="title-row">
            Your result
            {r.status === 'done' && <DecisionChip decision={r.finalDecision} size="md" />}
            {isLive(r) && <Chip tone="accent">In progress</Chip>}
            {r.status === 'failed' && <Chip tone="red">Failed</Chip>}
          </span>
        }
        actions={
          <>
            {r.status === 'done' && (
              <button type="button" className="btn btn-secondary" onClick={copySummary}>
                <Icon name="copy" /> Copy summary
              </button>
            )}
            {r.status === 'done' && (
              <Menu
                label="Download report"
                icon="download"
                items={[
                  { label: 'PDF', hint: 'Easy to print, starts with what to improve', href: api.reportUrl(r.id, 'pdf'), icon: 'download' },
                  { label: 'Excel', hint: 'A to-do sheet and the full report', href: api.reportUrl(r.id, 'xlsx'), icon: 'sheet' },
                  { label: 'Markdown', hint: 'Easy to read and paste', href: api.reportUrl(r.id, 'md'), icon: 'copy' },
                  { label: 'JSON', hint: 'For other tools and programs', href: api.reportUrl(r.id, 'json'), icon: 'info' },
                ]}
              />
            )}
            {!isLive(r) && (
              <button type="button" className="btn btn-ghost" onClick={() => setDeleting(true)}>
                <Icon name="trash" /> Delete
              </button>
            )}
            {r.status === 'failed' && (
              <Link to={`/new?project=${encodeURIComponent(r.projectName)}`} className="btn btn-primary">
                <Icon name="refresh" /> Try again
              </Link>
            )}
          </>
        }
      >
        <div className="meta-row">
          <span className="meta"><Icon name="sheet" size={14} /> {r.artifactName}</span>
          <span className="meta"><Icon name="scale" size={14} /> {r.scorecardId}</span>
          <span className="meta"><Icon name="info" size={14} /> {r.gate === 'D3' ? 'Document' : 'Design'}</span>
          <span className="meta"><Icon name="clock" size={14} /> {formatDate(r.createdAt)}</span>
        </div>
      </PageHeader>

      {r.status === 'failed' && (
        <div className="banner banner-red" role="alert">
          <Icon name="alert" />
          <span><strong>This check could not finish.</strong> {r.error ? hideModels(r.error) : ''}</span>
        </div>
      )}

      {r.status !== 'done' && (
        <Card title={isLive(r) ? 'Working on it' : 'Where it stopped'} aside={isLive(r) ? <span className="faint">Updates live</span> : undefined}>
          <Pipeline run={r} />
        </Card>
      )}

      {deleting && (
        <ConfirmDelete
          title="Delete this report?"
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await api.deleteRun(r.id);
            toast('Report deleted');
            navigate('/');
          }}
        >
          The scores, issues and saved report files for this check are removed for good. This cannot be undone.
        </ConfirmDelete>
      )}

      {r.status === 'done' && r.report && (
        <ReportView run={r} />
      )}
    </>
  );
}
