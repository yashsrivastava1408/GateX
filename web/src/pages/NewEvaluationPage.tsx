import { useMemo, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { examinerLabel } from '@ddd/shared';
import { hideModels } from '../present';
import { Chip } from '../components/Chip';
import { DropZone } from '../components/DropZone';
import { Icon } from '../components/Icons';
import { Card, ErrorBanner, PageHeader } from '../components/Layout';
import { useDocumentTitle, useResource } from '../hooks';

const hasExtension = (file: File | null, extensions: string[]) => !file || extensions.some((e) => file.name.toLowerCase().endsWith(e));
/** A scorecard can come in any of these; one not in this app's layout is converted automatically. */
const SCORECARD_TYPES = ['.xlsx', '.yaml', '.yml', '.json', '.csv', '.pdf', '.txt', '.md'];

function StepTitle({ n, text, optional = false }: { n: number; text: string; optional?: boolean }) {
  return (
    <span className="step-title">
      <span className="step-n">{n}</span>
      {text}
      {optional && <span className="optional">optional</span>}
    </span>
  );
}

function Check({ done, text }: { done: boolean; text: string }) {
  return (
    <li className={done ? 'check check-done' : 'check'}>
      <span className="check-icon">{done && <Icon name="check" size={12} strokeWidth={3} />}</span>
      {text}
    </li>
  );
}

export function NewEvaluationPage() {
  useDocumentTitle('New check');
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const handedOver = (useLocation().state as { scorecardFile?: File } | null)?.scorecardFile ?? null;
  const config = useResource(api.config, []);
  const projects = useResource(api.projects, []);

  const [projectName, setProjectName] = useState(params.get('project') ?? '');
  const [workbook, setWorkbook] = useState<File | null>(null);
  const [scorecard, setScorecard] = useState<File | null>(handedOver);
  const [sources, setSources] = useState('');
  const [instructions, setInstructions] = useState('');
  const [quick, setQuick] = useState(false);
  const [runTwice, setRunTwice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const existing = useMemo(() => projects.data?.find((p) => p.name.toLowerCase() === projectName.trim().toLowerCase()), [projects.data, projectName]);
  const workbookOk = hasExtension(workbook, ['.xlsx', '.csv', '.pdf']);
  const scorecardOk = hasExtension(scorecard, SCORECARD_TYPES);
  const ready = config.data?.ready ?? false;
  const canSubmit = Boolean(workbook && scorecard && workbookOk && scorecardOk && ready && !busy);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!workbook || !scorecard) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.submit({ workbook, scorecard, projectName: projectName.trim(), sources, instructions, quick, runTwice });
      navigate(`/runs/${created.runId}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Your check could not start. Please try again.');
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="New check"
        title="Check a new file"
        actions={
          <Link to="/projects" className="btn btn-ghost">
            <Icon name="back" /> Projects
          </Link>
        }
      >
        Add your Excel or PDF file and the scorecard to mark it against. Any layout works. Your result comes back on its own, with nothing to approve, and your files are never changed.
      </PageHeader>

      {error && <ErrorBanner message={error} />}

      <form className="split" onSubmit={submit}>
        <div className="stack">
          <Card title={<StepTitle n={1} text="Name the project" />}>
            <div className="field">
              <label className="field-label sr-only" htmlFor="project">Project name</label>
              <input
                id="project"
                className="input"
                list="project-names"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="Leave blank to use the file’s name"
                autoComplete="off"
              />
              <datalist id="project-names">
                {(projects.data ?? []).map((p) => (
                  <option key={p.id} value={p.name} />
                ))}
              </datalist>
              <span className="field-hint">
                {existing ? (
                  <>
                    <Chip tone="accent">Check {existing.runCount + 1}</Chip> This is saved with the earlier checks in <strong>{existing.name}</strong>.
                  </>
                ) : (
                  'Use the same name again to keep checks of the same file together.'
                )}
              </span>
            </div>
          </Card>

          <Card title={<StepTitle n={2} text="Add your files" />} aside={<span className="faint">Nothing in them is ever changed</span>}>
            <div className="drop-pair">
              <DropZone label="Your file" hint=".xlsx, .csv or .pdf · the file you want checked" accept={['.xlsx', '.csv', '.pdf']} file={workbook} onFile={setWorkbook} icon="upload" error={workbookOk ? null : 'This has to be an .xlsx, .csv or .pdf file.'} />
              <DropZone label="Scorecard" hint="any layout · Excel, CSV, PDF, YAML, JSON or text" accept={SCORECARD_TYPES} file={scorecard} onFile={setScorecard} icon="list" error={scorecardOk ? null : 'Use an .xlsx, .csv, .pdf, .yaml, .json, .txt or .md scorecard.'} />
            </div>
            <div className="help-pair">
              <a className="help-card" href={api.scorecardTemplateUrl} download>
                <Icon name="download" size={16} />
                <span>
                  <strong>No scorecard yet?</strong>
                  <small>Download the Excel template, fill it in and add it here.</small>
                </span>
              </a>
              <Link className="help-card" to="/import-scorecard">
                <Icon name="sheet" size={16} />
                <span>
                  <strong>Scorecard in another layout?</strong>
                  <small>Just add it here and GateX converts it. You can preview what it understood first.</small>
                </span>
              </Link>
            </div>
          </Card>

          <Card title={<StepTitle n={3} text="Guide the examiners" optional />}>
            <details className="fold" open={Boolean(instructions || sources)}>
              <summary>
                <span>Add instructions or background notes</span>
                <Icon name="chevron" size={16} />
              </summary>
              <div className="fold-body">
                <div className="field">
                  <label className="field-label" htmlFor="instructions">Anything the examiners should know</label>
                  <textarea
                    id="instructions"
                    className="input textarea"
                    rows={4}
                    maxLength={4000}
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    placeholder="For example: Pay special attention to the Definition column. Treat the Example column as out of scope."
                  />
                  <span className="field-hint">
                    Everyone on the team reads this, and it is saved with your result. It helps them know what to focus on.
                    <span className="faint counter">{instructions.length} / 4000</span>
                  </span>
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="sources">Background notes</label>
                  <textarea id="sources" className="input textarea" rows={5} value={sources} onChange={(e) => setSources(e.target.value)} placeholder="Paste the brief or requirements your work should be judged against." />
                </div>
              </div>
            </details>
          </Card>
        </div>

        <aside className="stack aside-sticky">
          <Card title="Ready to start?">
            <ul className="checklist">
              <Check done={Boolean(workbook && workbookOk)} text="Your file is added" />
              <Check done={Boolean(scorecard && scorecardOk)} text="Your scorecard is added" />
              <Check done={ready} text="The examiners are ready" />
            </ul>
            <label className="check-row">
              <input type="checkbox" checked={quick} onChange={(e) => setQuick(e.target.checked)} />
              <span>
                <strong>Quick check</strong>
                <small className="faint">Marks each question once and skips the second look at each finding, so it finishes sooner.</small>
              </span>
            </label>
            <label className="check-row">
              <input type="checkbox" checked={runTwice} onChange={(e) => setRunTwice(e.target.checked)} />
              <span>
                <strong>Check twice for a steadier score</strong>
                <small className="faint">Does the whole check two times and shows the average. It takes about twice as long. If the two results are far apart, the report says so.</small>
              </span>
            </label>
            <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={!canSubmit}>
              {busy ? (<><span className="spinner spinner-sm" /> Starting…</>) : (<>Start the check <Icon name="arrow" /></>)}
            </button>
            {busy && <p className="field-hint center">If your scorecard needs converting, that happens first and can take up to a minute.</p>}
            {!ready && config.data && <p className="field-hint center">The examiners are not ready yet. See the red notes below.</p>}
          </Card>

          <Card title="Who will mark it" aside={config.data?.mock ? <Chip tone="amber">Demo</Chip> : undefined}>
            {config.data && (
              <ul className="roster roster-compact">
                {[...config.data.raters, config.data.consolidator].map((m, i) => (
                  <li key={m.id} className="roster-item">
                    <span className={`roster-id ${i === 3 ? 'roster-id-k' : ''}`}>{i === 3 ? 'F' : i + 1}</span>
                    <span className="roster-body">
                      <span className="roster-model">{examinerLabel(m.id)}</span>
                      <span className="roster-meta">{i === 3 ? 'compares the marks' : 'marks on its own'}</span>
                    </span>
                    <span className={`dot ${m.keyPresent && m.approved ? 'dot-accent' : 'dot-red'}`} title={m.keyPresent && m.approved ? 'Ready' : 'Not ready'} />
                  </li>
                ))}
              </ul>
            )}
            {config.data && config.data.problems.filter((p) => p.level === 'error').map((p, i) => (
              <div key={i} className="banner banner-red"><Icon name="alert" /><span>{hideModels(p.message)}</span></div>
            ))}
            {config.error && <ErrorBanner message={config.error} onRetry={config.reload} />}
            <Link to="/models" className="link-quiet">Examiner status <Icon name="arrow" size={13} /></Link>
          </Card>

          <Card title="What happens next">
            <ol className="timeline">
              <li><Icon name="lock" size={15} /><span>Your files are kept safe so nothing can change. A scorecard in another layout is converted first.</span></li>
              <li><Icon name="chart" size={15} /><span>The computer counts what can be counted.</span></li>
              <li><Icon name="user" size={15} /><span>Three examiners mark the rest, then the final reviewer checks their marks.</span></li>
              <li><Icon name="flag" size={15} /><span>Fixed rules decide the result, and you get a report with the steps to green.</span></li>
            </ol>
          </Card>
        </aside>
      </form>
    </>
  );
}
