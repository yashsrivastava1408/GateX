import { examinerLabel, type ConfigResponse } from '@ddd/shared';
import { api } from '../api';
import { Chip } from '../components/Chip';
import { Icon } from '../components/Icons';
import { Card, ErrorBanner, Loading, PageHeader } from '../components/Layout';
import { useDocumentTitle, useResource } from '../hooks';
import { hideModels } from '../present';

type Member = ConfigResponse['raters'][number];

const isReady = (m: Member) => m.keyPresent && m.approved;

function ExaminerCard({ member, role }: { member: Member; role: string }) {
  const ready = isReady(member);
  return (
    <div className={`model ${ready ? '' : 'model-warn'}`}>
      <div className="model-top">
        <span className="model-role">{role}</span>
      </div>
      <div className="model-name">{examinerLabel(member.id)}</div>
      <div className="model-chips">
        <Chip tone={ready ? 'accent' : 'red'}>{ready ? 'Ready' : 'Not ready'}</Chip>
      </div>
    </div>
  );
}

const RULES = [
  ['Three different examiners', 'Each one looks at your work in its own way, so they do not share the same blind spots.'],
  ['Marked alone', 'Each examiner sees only the scorecard, your file and any background notes you add. Never another examiner’s marks.'],
  ['Proof for every score', 'Every score and issue points at a real place in your file. If an examiner cannot show where, that point is dropped.'],
  ['The lower score wins a tie', 'If examiners are more than one point apart and the final reviewer cannot settle it from your file, the lower score is kept and marked uncertain.'],
  ['The result comes from fixed rules', 'Green, amber and red come from a fixed rule. No examiner decides the result.'],
  ['Your file is never changed', 'GateX only reads it, and checks afterwards that it is exactly the same. GateX reports; you fix.'],
];

export function ModelsPage() {
  useDocumentTitle('Examiners');
  const config = useResource(api.config, []);
  const c = config.data;

  return (
    <>
      <PageHeader eyebrow="Your team" title="Examiners">
        Three examiners and one final reviewer check every file. This page shows whether they are ready.
      </PageHeader>

      {config.error && <ErrorBanner message={config.error} onRetry={config.reload} />}
      {config.loading && <Loading />}

      {c && (
        <>
          {c.problems.map((p, i) => (
            <div key={i} className={`banner banner-${p.level === 'error' ? 'red' : 'amber'}`} role={p.level === 'error' ? 'alert' : 'status'}>
              <Icon name="alert" />
              <span>{hideModels(p.message)}</span>
            </div>
          ))}
          {c.ready && c.problems.length === 0 && (
            <div className="banner banner-accent">
              <Icon name="check" />
              <span>{c.mock ? 'Demo mode is on: answers are scripted. Good for a walk-through.' : 'Everyone is ready. You can start a check.'}</span>
            </div>
          )}

          <Card title="Three examiners" aside={<span className="faint">Each marks on its own</span>}>
            <div className="models">
              {c.raters.map((m) => (
                <ExaminerCard key={m.id} member={m} role="Marks your work" />
              ))}
            </div>
          </Card>

          <Card title="Final reviewer" aside={<span className="faint">Compares the marks, does not mark again</span>}>
            <div className="models models-one">
              <ExaminerCard member={c.consolidator} role="Settles any difference" />
            </div>
          </Card>

          <Card title="How GateX keeps checks fair">
            <dl className="rules">
              {RULES.map(([term, body]) => (
                <div key={term} className="rule">
                  <dt>
                    <Icon name="shield" size={15} /> {term}
                  </dt>
                  <dd>{body}</dd>
                </div>
              ))}
            </dl>
          </Card>

          <Card>
            <details className="fold">
              <summary>
                <span>Technical details</span>
                <Icon name="chevron" size={16} />
              </summary>
              <div className="fold-body">
                <div className="table-scroll">
                  <table className="table table-compact">
                    <thead>
                      <tr><th>Who</th><th>Access set</th><th>Approved</th><th className="num">Backups</th></tr>
                    </thead>
                    <tbody>
                      {[...c.raters, c.consolidator].map((m) => (
                        <tr key={m.id}>
                          <td>{examinerLabel(m.id)}</td>
                          <td>{m.keyPresent ? 'Yes' : 'No'}</td>
                          <td>{m.approved ? 'Yes' : 'No'}</td>
                          <td className="num">{m.fallbacks.length}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="note">An administrator sets up the examiners on the server. Changes need a server restart.</p>
              </div>
            </details>
          </Card>
        </>
      )}
    </>
  );
}
