import type { RunDetail } from '@ddd/shared';
import { Chip, DecisionChip } from '../../components/Chip';
import { ScoreRing, ThresholdBar } from '../../components/Charts';
import { Hint } from '../../components/Hint';
import { Icon } from '../../components/Icons';
import { TERMS, VERDICT, friendlyReason } from '../../copy';
import { formatScore } from '../../format';

/** The result, decided by the fixed rule. Nothing here waits for, or asks for, a person. */
export function VerdictHero({ run }: { run: RunDetail }) {
  const { verdict } = run.report!;
  // Only runs made by older versions can carry an override; it is still shown so the record is honest.
  const { override } = verdict;
  const copy = VERDICT[verdict.decision];

  return (
    <section id="verdict" className={`hero hero-${verdict.decision}`} aria-labelledby="hero-title">
      <div className="hero-main">
        <ScoreRing score={verdict.weightedScore} decision={verdict.decision} />
        <div className="hero-copy">
          <div className="hero-top">
            <DecisionChip decision={verdict.decision} size="lg" />
            {override && <Chip tone="amber">Changed by {override.by}</Chip>}
            {verdict.scoreRange && <Chip tone="amber">{`Close to the line · about ${formatScore(verdict.scoreRange.low)} to ${formatScore(verdict.scoreRange.high)}`}</Chip>}
          </div>
          <h2 id="hero-title" className="hero-title">{copy.headline}</h2>
          <p className="hero-line">{copy.body}</p>

          <div className="hero-why">
            <h3>Why this result</h3>
            <ul className="reasons">
              {verdict.reasons.map((reason, i) => (
                <li key={i}>{friendlyReason(reason)}</li>
              ))}
            </ul>
          </div>

          <ThresholdBar score={verdict.weightedScore} refine={verdict.thresholds.refine} accept={verdict.thresholds.accept} decision={verdict.decision} />
          <div className="threshold-caption">
            <span><i className="swatch swatch-red" /> Red below {verdict.thresholds.refine}</span>
            <span><i className="swatch swatch-amber" /> Amber {verdict.thresholds.refine} to {verdict.thresholds.accept - 1}</span>
            <span><i className="swatch swatch-green" /> Green {verdict.thresholds.accept}+</span>
          </div>
        </div>
      </div>

      <aside className="hero-side" aria-label="Key checks">
        <h3>
          <span>{TERMS.mustPass.label} <Hint text={TERMS.mustPass.help} align="left" /></span>
          <span className="faint">need 4 of 5</span>
        </h3>
        {verdict.criticalGates.length === 0 ? (
          <p className="muted">This scorecard has no key checks.</p>
        ) : (
          <ul className="gates">
            {verdict.criticalGates.map((g) => {
              // The computer-counted half of a check is shown as a small line under its check.
              const sub = /\s*\(numbers to check\)$/.test(g.name);
              return (
              <li key={g.dimensionId} className={`gate gate-${g.status}${sub ? ' gate-sub' : ''}`}>
                <span className="gate-icon">
                  <Icon name={g.status === 'passed' ? 'check' : g.status === 'failed' ? 'x' : 'clock'} size={13} strokeWidth={2.6} />
                </span>
                <span className="gate-name">{sub ? 'Numbers to check' : g.name}</span>
                <span className="gate-score">{g.score === null ? 'not in the file' : `${g.score} / 5`}</span>
              </li>
              );
            })}
          </ul>
        )}
        <p className="hero-side-note">Decided by a fixed rule from the scores. Nothing to approve.</p>
      </aside>

      {override && (
        <div className="hero-notes">
          <div className="banner banner-amber">
            <Icon name="flag" />
            <span>
              The first result was <strong>{verdict.agentDecision.toUpperCase()}</strong>. {override.by} changed it to <strong>{override.decision.toUpperCase()}</strong>: {override.reason}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
