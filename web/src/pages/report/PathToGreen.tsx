import type { PathToGreen as Path } from '@ddd/shared';
import { DecisionChip } from '../../components/Chip';
import { Icon } from '../../components/Icons';

export function PathToGreen({ path, issues }: { path: Path; issues: Map<string, string> }) {
  return (
    <>
      {path.steps.length > 0 && (
        <ol className="path">
          {path.steps.map((s) => (
            <li key={s.dimensionId} className="path-step">
              <span className="path-n">{s.order}</span>
              <div className="path-body">
                <div className="path-title">
                  {s.name}
                  {s.reason === 'critical gate' && <span className="crit" title="Raises a key check">★</span>}
                </div>
                <div className="path-sub">
                  {s.reason === 'critical gate' ? 'Fix early: a key check needs 4 or more.' : 'Adds the most points for the least effort.'}
                  {s.findingIds.length > 0 && <> Also fixes {s.findingIds.map((id) => issues.get(id)?.toLowerCase() ?? 'an issue').join(', ')}.</>}
                </div>
              </div>
              <span className="path-move mono">
                {s.from} <Icon name="arrow" size={13} /> {s.to}
              </span>
              <span className="path-gain mono up">+{s.scoreGain.toFixed(1)}</span>
            </li>
          ))}
        </ol>
      )}

      {path.blockingFindingIds.length > 0 && (
        <div className="path-person path-block">
          <Icon name="flag" />
          <div>
            <strong>Fix these must-fix issues first</strong>
            <p className="path-block-ids">
              {path.blockingFindingIds.map((id) => (
                <a key={id} className="mono finding-link" href="#fix">{issues.get(id) ?? 'An issue'}</a>
              ))}
            </p>
          </div>
        </div>
      )}

      <div className="path-result">
        <span>{path.note}</span>
        {(path.steps.length > 0 || path.blockingFindingIds.length > 0) && (
          <span className="path-outcome">
            Expected result <span className="mono">{path.resultingScore.toFixed(1)}</span> <DecisionChip decision={path.resultingDecision} size="sm" />
          </span>
        )}
      </div>
    </>
  );
}
