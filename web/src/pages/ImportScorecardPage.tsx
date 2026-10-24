import { Fragment, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, type ImportedScorecard } from '../api';
import { Chip } from '../components/Chip';
import { DropZone } from '../components/DropZone';
import { Icon } from '../components/Icons';
import { Card, ErrorBanner, PageHeader } from '../components/Layout';
import { useDocumentTitle } from '../hooks';
import { hideModels } from '../present';

const SOURCE_TYPES = ['.xlsx', '.pdf', '.yaml', '.yml', '.json', '.csv', '.txt', '.md'];

/**
 * Shows how a scorecard in another layout is converted. This step is optional: "Check a new file" accepts the same
 * scorecard directly and converts it the same way (the conversion is kept, so both use the identical scorecard).
 */
export function ImportScorecardPage() {
  useDocumentTitle('Convert a scorecard');
  const navigate = useNavigate();
  const [scorecard, setScorecard] = useState<File | null>(null);
  const [document, setDocument] = useState<File | null>(null);
  const [result, setResult] = useState<ImportedScorecard | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = async () => {
    if (!scorecard) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api.importScorecard(scorecard, document));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'We could not read this scorecard. Try another file or format.');
    }
    setBusy(false);
  };

  const converted = (text: string) => new File([text], `${(scorecard?.name ?? 'scorecard').replace(/\.[^.]+$/, '')}-converted.yaml`, { type: 'text/yaml' });
  const download = () => {
    if (!result) return;
    const file = converted(result.yaml);
    const url = URL.createObjectURL(file);
    Object.assign(window.document.createElement('a'), { href: url, download: file.name }).click();
    URL.revokeObjectURL(url);
  };
  // Converted against a file, the scorecard names that file's sheets and can be used as it is. Without one, hand over the original,
  // so it is converted against the file it will judge.
  const useIt = () => navigate('/new', { state: { scorecardFile: document && result ? converted(result.yaml) : scorecard } });

  return (
    <>
      <PageHeader
        eyebrow="Scorecards"
        title="Convert a scorecard"
        actions={<Link to="/new" className="btn btn-ghost"><Icon name="back" /> New check</Link>}
      >
        Any layout works: a workbook, a CSV, a PDF or a text list. GateX converts it, checks the result and is ready to use it straight away. There is nothing to approve. This page just shows you what GateX understood.
      </PageHeader>

      {error && <ErrorBanner message={error} />}

      <div className="stack">
        <Card title="Add your scorecard">
          <div className="drop-pair">
            <DropZone label="Scorecard in any layout" hint="Excel, PDF, YAML, JSON, CSV or text" accept={SOURCE_TYPES} file={scorecard} onFile={setScorecard} icon="list" />
            <DropZone label="The file it will be used on (recommended)" hint=".xlsx or .pdf · helps GateX match the real sheets and columns" accept={['.xlsx', '.pdf']} file={document} onFile={setDocument} icon="upload" />
          </div>
          <div className="actions-row">
            <button className="btn btn-primary" disabled={!scorecard || busy} onClick={() => void read()}>
              {busy ? 'Converting…' : 'Convert it'} <Icon name="arrow" />
            </button>
            <span className="field-hint">Takes up to about a minute. The same scorecard is only converted once.</span>
          </div>
        </Card>

        {result && (
          <>
            <Card title="What it understood">
              <div className="chip-row">
                <Chip tone="accent">{result.summary.dimensions} questions</Chip>
                <Chip tone="muted">{result.summary.byExaminers} marked by the examiners</Chip>
                {result.summary.byCode > 0 && <Chip tone="muted">{result.summary.byCode} counted by the computer</Chip>}
                <Chip tone="muted">{result.summary.critical} key checks</Chip>
                <Chip tone={result.summary.weightTotal === 100 ? 'muted' : 'amber'}>importance adds up to {result.summary.weightTotal}</Chip>
                {result.cached && <Chip tone="muted">reused an earlier conversion</Chip>}
              </div>
              {result.uncertain.length > 0 && (
                <div className="banner banner-amber">
                  <Icon name="alert" />
                  <div>
                    <strong>Worth knowing:</strong>
                    <ul className="plain-list">{result.uncertain.map((u) => <li key={u}>{hideModels(u)}</li>)}</ul>
                  </div>
                </div>
              )}
              {result.adjustments.length > 0 && (
                <details className="fold">
                  <summary>What GateX adjusted along the way ({result.adjustments.length})</summary>
                  <ul className="plain-list">{result.adjustments.map((a) => <li key={a}>{hideModels(a)}</li>)}</ul>
                </details>
              )}
              <p className="field-hint">Converted automatically by GateX.</p>
            </Card>

            <Card title="The questions">
              <div className="table-scroll">
                <table className="table import-table">
                  <thead>
                    <tr>
                      <th>Question</th>
                      <th>Marked by</th>
                      <th className="num">Importance</th>
                      <th>What it reads</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.questions.map((q) => (
                      <Fragment key={q.id}>
                        <tr>
                          <td>
                            {q.name}
                            {q.critical && <Chip tone="red">key check</Chip>}
                            {q.criteria && <Chip tone="muted">{q.criteria.length} parts</Chip>}
                          </td>
                          <td><Chip tone="accent">{q.by === 'code' ? 'Computer' : 'Examiners'}</Chip></td>
                          <td className="num">{q.weight}</td>
                          <td className="faint">{q.by === 'code' ? q.how ?? 'whole document' : q.reads.join(', ') || 'whole document'}</td>
                        </tr>
                        {q.criteria?.map((c) => (
                          <tr key={c.id} className="criterion-row">
                            <td style={{ paddingLeft: '2rem' }}>
                              {c.name}
                            </td>
                            <td><Chip tone="muted">{c.by === 'code' ? 'Computer' : 'Examiners'}</Chip></td>
                            <td className="num faint">—</td>
                            <td className="faint">{c.how ?? ''}</td>
                          </tr>
                        ))}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
              <details className="fold">
                <summary>Your original scorecard text</summary>
                <pre className="code-block" aria-label="Original scorecard text">{result.sourceText}</pre>
              </details>
              <details className="fold">
                <summary>The converted scorecard (text)</summary>
                <pre className="code-block" aria-label="Converted scorecard">{result.yaml}</pre>
              </details>
              <div className="actions-row">
                <button className="btn btn-secondary" onClick={download}><Icon name="download" /> Download converted scorecard</button>
                <button className="btn btn-primary" onClick={useIt}>Use it for a new check <Icon name="arrow" /></button>
              </div>
            </Card>
          </>
        )}
      </div>
    </>
  );
}
