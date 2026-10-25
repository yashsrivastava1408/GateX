import { Link } from 'react-router-dom';
import type { AccuracyReport, MeasureResult, SourceNote } from '@ddd/shared';
import { api } from '../api';
import { Chip } from '../components/Chip';
import { Card, ErrorBanner, Loading, PageHeader } from '../components/Layout';
import { useDocumentTitle, useResource } from '../hooks';
import { ACCURACY } from '../humanCopy';

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 1000) / 10}%`);
const TONE = { pass: 'green', fail: 'red', not_enough_data: 'muted' } as const;

function Measure({ m, standin = false }: { m: MeasureResult; standin?: boolean }) {
  return (
    <article className={`measure measure-${m.status}${standin ? ' measure-standin' : ''}`}>
      <header className="measure-head">
        <h3>{m.title}</h3>
        <Chip tone={TONE[m.status]}>{ACCURACY.status[m.status]}</Chip>
      </header>
      <div className="measure-value">{pct(m.value)}</div>
      <p className="measure-plain">{m.plain}</p>
      <dl className="measure-facts">
        <div><dt>{ACCURACY.target}</dt><dd>{m.target}</dd></div>
        {m.counted && <div><dt>Counted</dt><dd>{m.counted}</dd></div>}
        {m.origin && <div><dt>Labels from</dt><dd>{m.origin}</dd></div>}
        <div><dt>Data</dt><dd>{ACCURACY.has(m.n, m.files)}{m.status === 'not_enough_data' ? `, ${ACCURACY.needs(m.needs.n, m.needs.files)}` : ''}</dd></div>
      </dl>
      {m.byStep.length > 0 && (
        <details className="measure-steps">
          <summary>{ACCURACY.byStep}</summary>
          <table>
            <tbody>
              {m.byStep.map((s) => (
                <tr key={s.step}>
                  <td>{s.step}</td>
                  <td>{pct(s.value)}</td>
                  <td className="faint">{ACCURACY.has(s.n, s.files)}</td>
                  <td><Chip tone={TONE[s.status]}>{ACCURACY.status[s.status]}</Chip></td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </article>
  );
}

function Group({ title, hint, children, empty, standin = false }: { title: string; hint: string; children: React.ReactNode; empty?: string; standin?: boolean }) {
  return (
    <section className={`accuracy-group${standin ? ' accuracy-standin' : ''}`}>
      <div className="accuracy-group-head">
        <h2>{title}</h2>
        <p className="field-hint">{hint}</p>
      </div>
      {empty && <div className="banner banner-accent" role="status"><span>{empty}</span></div>}
      <div className="measure-grid">{children}</div>
    </section>
  );
}

function Sources({ sources }: { sources: SourceNote[] }) {
  return (
    <Card title={ACCURACY.sourcesTitle}>
      <ul className="source-list">
        {sources.map((s) => (
          <li key={s.id}>
            <div className="source-head">
              <Chip tone={s.kind === 'human' ? 'green' : s.kind === 'self' ? 'accent' : 'amber'}>{ACCURACY.source[s.kind]}</Chip>
              <strong>{s.title}</strong>
              <span className="faint">{s.count}</span>
            </div>
            <p className="faint">{s.note}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Page({ report }: { report: AccuracyReport }) {
  const peopleHasData = report.humanTotals.scores + report.humanTotals.verdicts + report.humanTotals.labels > 0;
  // A figure with no data at all is not worth a card in the AI section: the sources list says what is missing.
  const standin = report.aiStandin.filter((m) => m.n > 0);
  return (
    <>
      <p className="accuracy-totals">{ACCURACY.totals(report.humanTotals)}</p>
      <Group title={ACCURACY.peopleTitle} hint={ACCURACY.peopleHint} empty={peopleHasData ? undefined : ACCURACY.peopleNone}>
        {report.human.map((m) => <Measure key={`${m.id}-${m.origin ?? ''}`} m={m} />)}
      </Group>
      <Group title={ACCURACY.selfTitle} hint={ACCURACY.selfHint}>
        {report.self.map((m) => <Measure key={m.id} m={m} />)}
      </Group>
      <Group title={ACCURACY.standinTitle} hint={ACCURACY.standinHint} standin>
        {standin.map((m) => <Measure key={`${m.id}-${m.origin ?? ''}`} m={m} standin />)}
      </Group>
      <Sources sources={report.sources} />
      <p className="faint accuracy-foot">Worked out from saved checks and marks, with no AI call. Updated {new Date(report.generatedAt).toLocaleString()}.</p>
    </>
  );
}

export function AccuracyPage() {
  useDocumentTitle(ACCURACY.title);
  const accuracy = useResource(api.accuracy, []);
  return (
    <>
      <PageHeader eyebrow={ACCURACY.eyebrow} title={ACCURACY.title} actions={<Link to="/projects" className="btn btn-secondary">Open a check to add marks</Link>}>
        {ACCURACY.intro}
      </PageHeader>
      {accuracy.error && <ErrorBanner message={accuracy.error} onRetry={accuracy.reload} />}
      {accuracy.loading && !accuracy.data && <Loading label="Working out the figures" />}
      {accuracy.data && <Page report={accuracy.data} />}
    </>
  );
}
