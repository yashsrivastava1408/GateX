import type { RunDetail } from '@ddd/shared';
import { Chip } from '../../components/Chip';

/** Questions your file gave the examiners nothing to measure. */
export function NotMeasurable({ run }: { run: RunDetail }) {
  const items = run.report!.notMeasurable;
  if (items.length === 0) {
    return <p className="muted">Every question was scored, by the computer or the examiners.</p>;
  }
  const zero = items.some((i) => i.treatment === 'zero');
  return (
    <>
      <p className="muted lead">
        {zero
          ? 'The examiners found nothing in the file to measure these, so each counts as 0, as the scorecard asks. Add what they ask for to the file and check it again.'
          : 'The examiners found nothing in the file to measure these, so they are left out of the score and do not hold the result back. Add what they ask for to the file and check it again to have them scored.'}
      </p>
      <ul className="human">
        {items.map((item) => (
          <li key={item.dimensionId} className="human-item">
            <div className="human-head">
              <h3>{item.name}</h3>
              {item.critical && <span className="crit" title="Key check">★</span>}
              <Chip tone={item.treatment === 'zero' ? 'amber' : 'muted'}>{item.treatment === 'zero' ? 'Counts as 0' : 'Left out of the score'}</Chip>
              <span className="faint human-weight">importance {item.weight}</span>
            </div>
            <p className="human-why">{item.reason}</p>
          </li>
        ))}
      </ul>
    </>
  );
}
