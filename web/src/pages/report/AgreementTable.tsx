import type { Report } from '@ddd/shared';
import { Chip } from '../../components/Chip';
import { Hint } from '../../components/Hint';
import { examinerLabel } from '@ddd/shared';
import { RESOLUTION, TERMS } from '../../copy';

export function AgreementTable({ report }: { report: Report }) {
  const raters = report.header.raters;
  if (report.agreement.length === 0) {
    return <p className="muted pad">The examiners did not mark anything in this check, so there is nothing for them to agree on.</p>;
  }
  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th>Area</th>
            {raters.map((r) => (
              <th key={r.id} className="num">{examinerLabel(r.id)}</th>
            ))}
            <th className="num">Disagreement <Hint text={TERMS.disagreement.help} /></th>
            <th>Outcome</th>
            <th>What happened</th>
          </tr>
        </thead>
        <tbody>
          {report.agreement.map((a) => (
            <tr key={a.dimensionId}>
              <td>{a.name}</td>
              {raters.map((r) => (
                <td key={r.id} className="num mono">{a.scores[r.id] ?? '—'}</td>
              ))}
              <td className="num mono"><span className={a.spread !== null && a.spread > 1 ? 'down' : ''}>{a.spread ?? '—'}</span></td>
              <td>
                <Chip tone={a.flagged ? 'amber' : RESOLUTION[a.resolution].tone}>{RESOLUTION[a.resolution].label}</Chip>
              </td>
              <td className="muted">{a.note}{a.flagged && <strong className="flagged"> Worth a look.</strong>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
