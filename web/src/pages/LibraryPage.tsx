import { Link, useParams } from 'react-router-dom';
import { examinerLabel, type LibraryCaseDetail, LibraryCaseSummary, LibraryRunSummary, PlantedResult, ReliabilityTable, ReviewVerdict } from '@ddd/shared';
import { api } from '../api';
import { Chip, SeverityChip } from '../components/Chip';
import { Card, EmptyState, ErrorBanner, Loading, PageHeader } from '../components/Layout';
import { formatDate, formatScore, location } from '../format';
import { useDocumentTitle, useResource } from '../hooks';

const VERDICT_LABEL: Record<ReviewVerdict, string> = {
  real: 'Correct',
  partly: 'Partly right',
  wrong: 'Wrong',
  vague: 'Vague',
  duplicate: 'Repeat',
  unchecked: 'Not checked',
  unreviewed: 'Not reviewed',
};
const VERDICT_TONE: Record<ReviewVerdict, 'green' | 'amber' | 'red' | 'muted' | 'blue'> = {
  real: 'green',
  partly: 'green',
  wrong: 'red',
  vague: 'amber',
  duplicate: 'muted',
  unchecked: 'muted',
  unreviewed: 'muted',
};
const ORDER: ReviewVerdict[] = ['real', 'partly', 'wrong', 'vague', 'duplicate', 'unchecked', 'unreviewed'];
const percent = (value: number | null) => (value === null ? '—' : `${Math.round(value * 100)}%`);

function Counts({ run }: { run: LibraryRunSummary }) {
  return (
    <div className="library-counts">
      {ORDER.filter((v) => run.counts[v] > 0).map((v) => (
        <Chip key={v} tone={VERDICT_TONE[v]}>
          {run.counts[v]} {VERDICT_LABEL[v].toLowerCase()}
        </Chip>
      ))}
    </div>
  );
}

function RunsTable({ runs }: { runs: LibraryRunSummary[] }) {
  return (
    <div className="table-scroll">
      <table className="table table-fit">
        <thead>
          <tr>
            <th>Check</th>
            <th className="num">Score</th>
            <th className="num">Issues</th>
            <th className="num" title="Correct or partly right, as a share of the issues checked against the real file">Useful</th>
            <th>How they were rated</th>
            <th>Questions not scored</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.runDir}>
              <td>
                {run.label}
                <div className="muted small">guide {run.promptVersion.replace('l1-prompts/', '')}</div>
              </td>
              <td className="num">{formatScore(run.weightedScore)} <span className={`dot dot-${run.decision}`} /></td>
              <td className="num">{run.findings}</td>
              <td className="num">{percent(run.usableShare)}</td>
              <td><Counts run={run} /></td>
              <td>{run.unscored.length > 0 ? run.unscored.length : 'none'}</td>
              <td>{formatDate(run.finishedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Reliability({ table }: { table: ReliabilityTable }) {
  const families = Object.entries(table.families);
  if (families.length === 0) return null;
  const share = (t: { n: number; useful: number }) => (t.n === 0 ? '—' : `${Math.round((100 * t.useful) / t.n)}% (${t.useful} of ${t.n})`);
  return (
    <Card title="How often the examiners are right" flush>
      <p className="muted small library-note">
        Measured from issues checked against the real files. When one examiner raises an issue alone and its lone issues are right less than{' '}
        {Math.round(table.thresholds.dropBelow * 100)}% of the time (after {table.thresholds.minSamples} checked), that issue is set aside. A second examiner agreeing keeps it.
      </p>
      <div className="table-scroll">
        <table className="table table-fit">
          <thead>
            <tr><th>Examiner group</th><th className="num">Right when alone</th><th className="num">Right in any finding</th><th>What happens</th></tr>
          </thead>
          <tbody>
            {families.map(([family, r], index) => {
              const filtered = r.solo.n >= table.thresholds.minSamples && r.solo.useful / r.solo.n < table.thresholds.dropBelow;
              return (
                <tr key={family}>
                  <td>Group {index + 1}</td>
                  <td className="num">{share(r.solo)}</td>
                  <td className="num">{share(r.any)}</td>
                  <td>{filtered ? <Chip tone="red">Lone issues set aside</Chip> : <Chip tone="green">Lone issues kept</Chip>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const DEFECT_LABEL: Record<string, string> = {
  blank_definition: 'Blank definition',
  blank_reason: 'Blank reason',
  blank_type: 'Blank data type',
  duplicate_id: 'Repeated ID',
  broken_parent: 'Broken link to a parent',
  invalid_required: 'Invalid "Required" value',
  vague_definition: 'Vague definition',
  wrong_count: 'Wrong child count',
};

function Planted({ results }: { results: PlantedResult[] }) {
  if (results.length === 0) return null;
  return (
    <Card title="Planted-defect tests: does it find mistakes we put in on purpose?" flush>
      <p className="muted small library-note">
        A good file is broken in known ways, run through the app, and scored against what was planted. The answer key is what we changed. "In the report" counts mistakes an issue in the final report points at. The examiners and the computer’s row-by-row sweep are counted separately.
      </p>
      <div className="table-scroll">
        <table className="table table-fit">
          <thead>
            <tr><th>Test</th><th>Who marked</th><th className="num">In the report</th><th className="num">By the examiners</th><th className="num">By the computer sweep</th><th className="num">Other issues</th><th>Each examiner finds</th></tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.label}>
                <td>{r.label}<div className="muted small">{r.workbook} · {formatDate(r.runAt)}</div></td>
                <td className="small">{r.models.map((m) => examinerLabel(m.id)).join(' · ')}</td>
                <td className="num">{r.caught} of {r.planted}</td>
                <td className="num">{r.caughtByExaminers ?? r.caughtRaw} of {r.planted}</td>
                <td className="num">{r.caughtByCode ?? 0} of {r.planted}</td>
                <td className="num">{r.otherInReport}</td>
                <td className="small">{Object.entries(r.perExaminer).map(([id, v]) => `${examinerLabel(id)}: ${v.caught}/${r.planted}`).join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="library-details">
        <summary>Which mistakes were found, by test</summary>
        <div className="table-scroll">
          <table className="table table-fit">
            <thead>
              <tr><th>Mistake</th>{results.map((r) => <th key={r.label} className="small">{r.label}</th>)}</tr>
            </thead>
            <tbody>
              {results[0]!.defects.map((d) => (
                <tr key={d.id}>
                  <td>{DEFECT_LABEL[d.kind] ?? d.kind} <span className="muted small mono">{d.cell}</span></td>
                  {results.map((r) => {
                    const x = r.defects.find((y) => y.id === d.id);
                    return <td key={r.label}>{!x ? '—' : x.caught ? <Chip tone="green">Found</Chip> : x.caughtRaw ? <Chip tone="amber">Set aside</Chip> : <Chip tone="red">Missed</Chip>}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Card>
  );
}

function CaseList({ cases }: { cases: LibraryCaseSummary[] }) {
  if (cases.length === 0) {
    return <EmptyState icon="folder" title="No test pairs yet">Add a file pair to the test library to see it here.</EmptyState>;
  }
  return (
    <div className="library-grid">
      {cases.map((c) => {
        const latest = c.runs[c.runs.length - 1];
        return (
          <Link key={c.id} to={`/library/${c.id}`} className="card library-card">
            <div className="eyebrow">{c.step}</div>
            <h3>{c.title}</h3>
            <p className="muted small">{c.workbook} against {c.scorecard}</p>
            {latest ? (
              <>
                <div className="library-figures">
                  <div><span className="figure">{formatScore(latest.weightedScore)}</span><span className="muted small"> score</span></div>
                  <div><span className="figure">{percent(latest.usableShare)}</span><span className="muted small"> of issues useful</span></div>
                  <div><span className="figure">{latest.findings}</span><span className="muted small"> issues</span></div>
                </div>
                <Counts run={latest} />
              </>
            ) : (
              <p className="muted small">No finished check yet.</p>
            )}
            <p className="muted small">{c.runs.length} check{c.runs.length === 1 ? '' : 's'}</p>
          </Link>
        );
      })}
    </div>
  );
}

function CaseDetail({ detail }: { detail: LibraryCaseDetail }) {
  const rows = [...detail.findingsOfLatest].sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict));
  return (
    <>
      <PageHeader eyebrow={detail.step} title={detail.title} actions={<Link className="btn btn-secondary" to="/library">All test pairs</Link>}>
        {detail.workbook} checked against {detail.scorecard}. {detail.notes}
      </PageHeader>
      <Card title="Checks on this pair" flush>
        <RunsTable runs={detail.runs} />
      </Card>
      <Card title="Issues from the newest check, compared with the real file" flush>
        <div className="table-scroll">
          <table className="table table-fit">
            <thead>
              <tr><th>Rating</th><th>Issue</th><th>Where</th><th>Why</th></tr>
            </thead>
            <tbody>
              {rows.map((f, i) => (
                <tr key={f.id}>
                  <td>
                    <Chip tone={VERDICT_TONE[f.verdict]}>{VERDICT_LABEL[f.verdict]}</Chip>
                    {f.inherited && <div className="muted small">carried over</div>}
                  </td>
                  <td>
                    <strong>Issue {i + 1}</strong> {f.title} <SeverityChip severity={f.severity} />
                    <div className="muted small">reported by {f.reportedBy.map(examinerLabel).join(', ') || '—'}</div>
                  </td>
                  <td className="mono small">{location(f.location)}</td>
                  <td className="small">{f.note || <span className="muted">Not compared with the real file yet.</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

export function LibraryPage() {
  const { id } = useParams();
  useDocumentTitle('Test library');
  const list = useResource(api.library, [id]);
  const detail = useResource(() => (id ? api.libraryCase(id) : Promise.resolve(null)), [id]);
  const reliability = useResource(api.reliability, []);
  const planted = useResource(api.planted, []);

  if (id) {
    if (detail.loading) return <Loading />;
    if (detail.error || !detail.data) return <ErrorBanner message={detail.error ?? 'Test pair not found.'} onRetry={detail.reload} />;
    return <CaseDetail detail={detail.data} />;
  }
  return (
    <>
      <PageHeader eyebrow="Quality" title="Test library">
        Real files GateX has checked. Each issue was compared with the real file, so you can see whether GateX is getting better.
      </PageHeader>
      {list.error && <ErrorBanner message={list.error} onRetry={list.reload} />}
      {list.loading && <Loading />}
      {list.data && <CaseList cases={list.data} />}
      {planted.data && <Planted results={planted.data} />}
      {reliability.data && <Reliability table={reliability.data} />}
    </>
  );
}
