import type { RunDetail } from '@ddd/shared';
import { Icon, type IconName } from '../../components/Icons';
import { plural } from '../../copy';

interface Step {
  tone: 'red' | 'amber' | 'accent' | 'green';
  icon: IconName;
  title: string;
  detail: string;
  tab?: string;
  cta?: string;
}

/** The answer to "what do I do now?", built from the report, with a way into each part of it. */
export function NextSteps({ run, onGo }: { run: RunDetail; onGo: (tab: string) => void }) {
  const report = run.report!;
  const { verdict, pathToGreen } = report;
  const unmeasured = report.notMeasurable;
  const blocking = verdict.blockingFindings.length;
  const failedGates = verdict.criticalGates.filter((g) => g.status === 'failed');
  const steps: Step[] = [];

  if (blocking > 0) {
    steps.push({ tone: 'red', icon: 'alert', title: `Fix the ${plural(blocking, 'must-fix issue')}`, detail: 'These matter most, so fix them first. They are marked “Must fix”.', tab: 'fix', cta: 'See them' });
  }
  if (failedGates.length > 0) {
    steps.push({
      tone: 'red', icon: 'flag',
      title: failedGates.length <= 2 ? `Raise ${failedGates.map((g) => g.name).join(' and ')} to 4 or more` : `Raise these ${failedGates.length} key checks to 4 or more`,
      detail: 'These key checks scored low. Until they reach 4, the result cannot be green.', tab: 'path', cta: 'See how',
    });
  }
  const improvements = pathToGreen.steps.filter((s) => s.reason === 'score').slice(0, 2);
  if (improvements.length > 0) {
    steps.push({
      tone: 'amber', icon: 'chart',
      title: improvements.map((s) => `Improve “${s.name}” from ${s.from} to ${s.to}`).join(', then '),
      detail: `That adds about ${improvements.reduce((n, s) => n + s.scoreGain, 0).toFixed(1)} points towards green.`, tab: 'path', cta: 'Full path',
    });
  }
  if (unmeasured.length > 0) {
    steps.push({
      tone: 'accent', icon: 'list',
      title: unmeasured.length <= 2 ? `Add what is missing for ${unmeasured.map((p) => p.name).join(' and ')} to your file` : `Add what is missing to your file for ${unmeasured.length} questions`,
      detail: unmeasured.some((n) => n.treatment === 'zero') ? 'They count as 0 until your file shows something for them.' : 'They are left out of the score until your file shows something for them.', tab: 'input', cta: 'See them',
    });
  }

  const clear = steps.length === 0;
  if (clear) {
    steps.push({ tone: 'green', icon: 'check', title: 'Nothing left to fix', detail: 'This passes. It can move on to the next step.' });
  }

  return (
    <section className="card next" aria-labelledby="next-title">
      <div className="card-head">
        <h2 id="next-title">What to do next</h2>
        {!clear && <span className="faint">{plural(steps.length, 'thing')} to do, in this order</span>}
      </div>
      <ol className="next-list">
        {steps.map((step, i) => (
          <li key={i} className={`next-step next-${step.tone}`}>
            <span className="next-icon">
              <Icon name={step.icon} size={18} />
            </span>
            <div className="next-body">
              <div className="next-title">
                {!clear && <span className="next-n">{i + 1}</span>}
                {step.title}
              </div>
              <div className="next-detail">{step.detail}</div>
            </div>
            {step.tab && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onGo(step.tab!)}>
                {step.cta} <Icon name="arrow" size={14} />
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
