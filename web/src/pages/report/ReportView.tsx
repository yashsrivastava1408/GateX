import { useMemo } from 'react';
import { issueNumbers, type RunDetail } from '@ddd/shared';
import { Icon } from '../../components/Icons';
import { Card } from '../../components/Layout';
import { presentRun } from '../../present';
import { Tabs, useHashTab, type TabSpec } from '../../components/Tabs';
import { AgreementTable } from './AgreementTable';
import { FindingsList } from './FindingsList';
import { NextSteps } from './NextSteps';
import { NotMeasurable } from './NotMeasurable';
import { PathToGreen } from './PathToGreen';
import { RunDetails } from './RunDetails';
import { ScoresTable } from './ScoresTable';
import { StrengthsList } from './StrengthsList';
import { VerdictHero } from './VerdictHero';

const TAB_IDS = ['scores', 'fix', 'agreement', 'input', 'path', 'strengths', 'tech'];

export function ReportView({ run: saved }: { run: RunDetail }) {
  // The page shows names, issue numbers and examiner labels; the saved report keeps the codes.
  const run = useMemo(() => presentRun(saved), [saved]);
  const report = run.report!;
  const issues = useMemo(() => issueNumbers(report), [report]);
  // How much of the scorecard's weight has a score, so a high number built on a small part is not mistaken for a result.
  const totalWeight = report.dimensions.reduce((sum, d) => sum + d.weight, 0);
  const scoredWeight = report.dimensions.filter((d) => d.status === 'scored').reduce((sum, d) => sum + d.weight, 0);
  const coverage = totalWeight > 0 ? Math.round((scoredWeight / totalWeight) * 100) : 100;
  const unmeasured = report.notMeasurable.length;
  const flagged = report.agreement.filter((a) => a.flagged).length;
  const blocking = report.verdict.blockingFindings.length;
  const [tab, setTab] = useHashTab(TAB_IDS, report.findings.length > 0 ? 'fix' : 'scores');

  const tabs: TabSpec[] = [
    { id: 'scores', label: 'Scores', count: report.dimensions.length },
    { id: 'fix', label: 'What to fix', count: report.findings.length || undefined, tone: blocking > 0 ? 'red' : 'accent' },
    { id: 'agreement', label: 'Examiner agreement', count: flagged || undefined, tone: 'amber' },
    { id: 'input', label: 'Not in the file', count: unmeasured || undefined },
    { id: 'path', label: 'Path to green' },
    { id: 'strengths', label: 'Strengths', count: report.strengths.length || undefined },
    { id: 'tech', label: 'Technical details' },
  ];

  return (
    <>
      {coverage < 50 && (
        <div className={`banner ${coverage === 0 ? 'banner-red' : 'banner-amber'}`} role="alert">
          <Icon name="alert" />
          <span>
            {coverage === 0 ? (
              <>
                <strong>Nothing was scored.</strong> The examiners found nothing in this file that the scorecard asks about, so the 0 below is not a real
                result. Check that the scorecard fits this file, or see “Not in the file”.
              </>
            ) : (
              <>
                <strong>Only {coverage}% of this scorecard was scored.</strong> The number below covers just that part: your file has nothing for the rest, so it cannot be green yet.
                See “Not in the file” for what to add.
              </>
            )}
          </span>
        </div>
      )}
      <VerdictHero run={run} />
      <NextSteps run={run} onGo={setTab} />

      <Tabs tabs={tabs} active={tab} onChange={setTab} label="Report sections">
        {tab === 'scores' && (
          <Card title="Scores" aside={<span className="faint">Click a row to see why it got that score</span>} flush>
            <ScoresTable report={report} />
          </Card>
        )}
        {tab === 'fix' && (
          <Card title="What to fix" aside={<span className="faint">Most serious first</span>}>
            <FindingsList findings={report.findings} issues={issues} names={Object.fromEntries(report.dimensions.map((d) => [d.id, d.name]))} />
          </Card>
        )}
        {tab === 'agreement' && (
          <Card title="Did the examiners agree?" aside={<span className="faint">When they agree you can trust the score more</span>} flush>
            <AgreementTable report={report} />
          </Card>
        )}
        {tab === 'input' && (
          <Card title="Not in the file" aside={<span className="faint">Your file had nothing to measure these</span>}>
            <NotMeasurable run={run} />
          </Card>
        )}
        {tab === 'path' && (
          <Card title="Path to green" aside={<span className="faint">The fewest fixes that change the result</span>}>
            <PathToGreen path={report.pathToGreen} issues={issues} />
          </Card>
        )}
        {tab === 'strengths' && (
          <Card title="What is already good" aside={<span className="faint">Keep these in the next version</span>}>
            <StrengthsList strengths={report.strengths} names={Object.fromEntries(report.dimensions.map((d) => [d.id, d.name]))} />
          </Card>
        )}
        {tab === 'tech' && (
          <Card title="Technical details" aside={<span className="faint">Facts about this check, if you need them</span>}>
            <RunDetails run={run} />
          </Card>
        )}
      </Tabs>
    </>
  );
}
