import { useMemo, useState } from 'react';
import { issueNumbers, severityLabel, type Finding, type Severity } from '@ddd/shared';
import { CellChip, SeverityChip } from '../../components/Chip';
import { FindingFeedback } from '../../components/FindingFeedback';
import { Icon } from '../../components/Icons';
import { EmptyState } from '../../components/Layout';
import { plural } from '../../copy';
import { mergeFindings } from '../../mergeFindings';

export function FindingsList({ findings, issues, names = {}, secondary = false }: { findings: Finding[]; issues?: Map<string, string>; names?: Record<string, string>; secondary?: boolean }) {
  const numbers = useMemo(() => issues ?? issueNumbers({ findings }), [issues, findings]);
  const [severity, setSeverity] = useState<Severity | 'ALL'>('ALL');
  const [dimension, setDimension] = useState('ALL');
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');

  const counts = useMemo(() => {
    const c: Record<Severity, number> = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    findings.forEach((f) => (c[f.severity] += 1));
    return c;
  }, [findings]);
  const dimensions = useMemo(() => [...new Set(findings.map((f) => f.dimensionId))], [findings]);

  if (findings.length === 0) {
    return <EmptyState icon="check" title="Nothing to fix">No issues were found.</EmptyState>;
  }

  const q = query.trim().toLowerCase();
  const shown = mergeFindings(
    findings.filter((f) => (severity === 'ALL' || f.severity === severity) && (dimension === 'ALL' || f.dimensionId === dimension)),
  ).filter((g) => !q || [g.main, ...g.also].some((f) => `${f.title} ${f.detail} ${f.fix}`.toLowerCase().includes(q)));
  const merged = findings.length - mergeFindings(findings).length;

  return (
    <>
      <div className="filters">
        <div className="segmented" role="group" aria-label="Filter by how urgent">
          <button type="button" className={severity === 'ALL' ? 'on' : ''} onClick={() => setSeverity('ALL')}>All <span>{findings.length}</span></button>
          {(['HIGH', 'MEDIUM', 'LOW'] as const).map((s) => (
            <button key={s} type="button" className={severity === s ? 'on' : ''} onClick={() => setSeverity(s)} disabled={counts[s] === 0}>
              {severityLabel(s)} <span>{counts[s]}</span>
            </button>
          ))}
        </div>
        {dimensions.length > 1 && (
          <select className="input input-sm" value={dimension} onChange={(e) => setDimension(e.target.value)} aria-label="Filter by area">
            <option value="ALL">All areas</option>
            {dimensions.map((d) => (
              <option key={d} value={d}>{names[d] ?? 'This area'}</option>
            ))}
          </select>
        )}
        <input className="input input-sm" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search issues" aria-label="Search issues" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Collapse all' : 'Expand all'}
        </button>
      </div>

      {merged > 0 && <p className="field-hint">{plural(merged, 'repeat')} folded into the issues below, so each one shows once.</p>}

      <ul className="findings">
        {shown.map((g) => { const f = g.main; return (
          <li key={`${f.id}-${expanded}`} className={`finding finding-${f.severity.toLowerCase()}${secondary ? ' finding-secondary' : ''}`}>
            <details open={expanded}>
              <summary className="finding-head">
                <SeverityChip severity={f.severity} />
                {f.severity === 'HIGH' && !secondary && <span className="blocks">Fix this first</span>}
                <span className="faint issue-no">{numbers.get(f.id)}</span>
                <h3>{f.title}</h3>
                {f.location && <CellChip sheet={f.location.sheet} cell={f.location.cell} />}
                <Icon name="chevron" size={16} />
              </summary>
              <div className="finding-body">
                {f.detail && <p className="finding-detail">{f.detail}</p>}
                <div className="finding-fix">
                  <span className="finding-fix-label">How to fix</span>
                  <span>{f.fix || 'Look at the place shown above and fix it there.'}</span>
                </div>
                <div className="finding-foot">
                  <span>About <strong>{names[f.dimensionId] ?? 'this area'}</strong></span>
                                    <span>{f.source === 'code' ? 'Found by the computer' : `Raised by ${g.reportedBy.join(', ')}`}{f.tierReason ? ` · ${f.tierReason}` : ''}</span>
                </div>
                <FindingFeedback findingId={f.id} />
                {g.also.length > 0 && (
                  <div className="finding-also">
                    <span className="finding-fix-label">Also noted</span>
                    <ul>
                      {g.also.map((o) => (
                        <li key={o.id}>{numbers.get(o.id)}: {o.title}{o.location ? ` (${o.location.sheet}, ${o.location.cell})` : ''}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </details>
          </li>
        ); })}
        {shown.length === 0 && <li className="muted">Nothing matches. Try another filter.</li>}
      </ul>
    </>
  );
}
