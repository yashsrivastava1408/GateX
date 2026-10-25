import { BRAND, type Report } from '@ddd/shared';
import { BAND_WORD, LOOK_NOTE, LOOK_TITLE, buildView, formatNumber } from './view.js';

const cell = (text: string | number | null | undefined) => String(text ?? '-').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const score = (value: number | null) => (value === null ? '-' : formatNumber(value));
const tag = { HIGH: 'Must fix', MEDIUM: 'Should fix', LOW: 'Nice to fix' } as const;

/** A short briefing that goes next to the workbook: the headline, what it means, what to fix first, then the detail. */
export function renderMarkdown(input: Report): string {
  const v = buildView(input);
  const out: string[] = [];

  out.push(`# ${BRAND.name} report: ${v.fileName}`, '', `_${BRAND.tagline}_`, '');
  out.push(`**${BAND_WORD[v.decision]} - ${v.headline}** | Score **${formatNumber(v.score)} out of 100**`, '');
  out.push(`${v.subline} (Green needs ${v.thresholds.accept} or more. Amber is ${v.thresholds.refine} to ${v.thresholds.accept - 1}. Red is below ${v.thresholds.refine}.)`, '');
  if (v.twoRuns) out.push(`**${v.twoRuns.line}**`, '');
  out.push(`| | |`, `|---|---|`, `| File | ${cell(v.fileName)} |`, `| Scorecard | ${cell(v.scorecard)} |`, `| Checked on | ${v.finishedLong} |`, `| Check number | ${v.checkNumber} |`);
  if (v.report.header.instructions) out.push(`| Extra instructions | ${cell(v.report.header.instructions)} |`);
  out.push('');

  out.push('## What this means', '', ...v.meaning.map((m) => `- ${m}`), '');
  out.push(
    `**Key numbers:** ${v.bySeverity.HIGH.length} must fix, ${v.bySeverity.MEDIUM.length} should fix, ${v.bySeverity.LOW.length} nice to fix | ` +
      `${v.keyChecks.passed} of ${v.keyChecks.total} key checks passed | ${v.areasAtFour.count} of ${v.areasAtFour.of} areas scored 4 or more`,
    '',
  );

  out.push('## What to fix first', '');
  if (v.issues.length === 0) out.push(v.lookIssues.length > 0 ? 'Nothing confirmed to fix. See "Worth a look" below for single-examiner suggestions.' : 'Nothing to fix. No issues were raised.', '');
  for (const sev of ['HIGH', 'MEDIUM', 'LOW'] as const) {
    const items = v.bySeverity[sev];
    if (items.length === 0) continue;
    out.push(`### ${tag[sev]} (${items.length})`, '');
    for (const i of items) {
      out.push(`**${i.label}** - ${i.title}`, `- Area: ${i.area}`);
      if (i.where) out.push(`- Where: ${i.where}`);
      if (i.detail) out.push(`- What is wrong: ${i.detail}`);
      out.push(`- What to do: ${i.fix}`, '');
    }
  }
  if (input.droppedFindings && input.droppedFindings.length > 0) {
    // Counted as a number only: the examiners' dropped claims are not issues.
    out.push(`_${input.droppedFindings.length} claim${input.droppedFindings.length === 1 ? ' was' : 's were'} set aside because the file plainly contradicts ${input.droppedFindings.length === 1 ? 'it' : 'them'}._`, '');
  }

  out.push('## How each area scored', '', '| Area | Score out of 5 | Result | Key check |', '|---|---|---|---|');
  for (const a of v.areas) {
    out.push(`| ${cell(a.name)} | ${score(a.score)} | ${a.score === null ? 'Not scored' : a.passed ? 'Pass' : 'Below the pass mark of 4'} | ${a.critical ? 'Yes' : ''} |`);
  }
  out.push('');

  out.push('## Your path to green', '');
  if (v.path.steps.length === 0) out.push(v.path.note, '');
  else {
    v.path.steps.forEach((s) => out.push(`${s.order}. Raise "${s.area}" from ${s.from} to ${s.to} out of 5 (about +${s.gain} points).${s.fixes.length ? ` Fixes ${s.fixes.map((f) => f.toLowerCase()).join(', ')}.` : ''}`));
    out.push('', v.path.note, `After these fixes the score would be ${formatNumber(v.path.resultingScore)} (${BAND_WORD[v.path.resultingDecision]}).`, '');
  }

  out.push('## What is already good', '');
  out.push(...(v.strengths.length > 0 ? v.strengths.map((s) => `- ${s.text}${s.where ? ` (${s.where})` : ''}`) : ['None recorded.']), '');

  out.push('## How the examiners compared', '');
  if (v.examinerRows.length === 0) out.push('No area was marked by examiners.', '');
  else {
    out.push(`| Area | ${v.examiners.join(' | ')} | Note |`, `|---|${v.examiners.map(() => '---').join('|')}|---|`);
    for (const r of v.examinerRows) out.push(`| ${cell(r.area)} | ${r.scores.map((s) => score(s.score)).join(' | ')} | ${cell(r.note)} |`);
    out.push('');
  }

  out.push('## Not checked from the file', '');
  if (v.leftOut.length === 0) out.push('Nothing was left out. Every area could be checked from the file.', '');
  else out.push(...v.leftOut.map((n) => `- **${n.name}**${n.critical ? ' (key check)' : ''}: ${n.reason} ${n.treatment}.`), '');

  if (v.lookIssues.length > 0) {
    // Apart from the issues, last in the list: single-examiner judgement calls, never counted in the numbers above.
    out.push(`## ${LOOK_TITLE} (${v.lookIssues.length})`, '', `_${LOOK_NOTE}_`, '', '<details>', `<summary>Show the ${v.lookIssues.length} item${v.lookIssues.length === 1 ? '' : 's'}</summary>`, '');
    for (const i of v.lookIssues) {
      out.push(`**${i.label}** - ${i.title}`, `- Area: ${i.area}`);
      if (i.where) out.push(`- Where: ${i.where}`);
      if (i.detail) out.push(`- What the examiner said: ${i.detail}`);
      out.push(`- What they suggest: ${i.fix}`, '');
    }
    out.push('</details>', '');
  }
  if (v.cost) {
    out.push('## What this check used', '', v.cost.sentence, '');
    out.push(`| Who | Calls | Tokens in | Tokens out |${v.cost.hasPrices ? ' Cost |' : ''}`, `|---|---|---|---|${v.cost.hasPrices ? '---|' : ''}`);
    for (const l of v.cost.lines) out.push(`| ${cell(l.label)} | ${l.calls} | ${l.tokensIn.toLocaleString('en-US')} | ${l.tokensOut.toLocaleString('en-US')} |${v.cost.hasPrices ? ` ${l.price || '-'} |` : ''}`);
    out.push('');
  }

  out.push('## About this check', '', `- File: ${v.fileName}`, `- Scorecard: ${v.scorecard}`, `- Checked on: ${v.finishedLong}`, `- Marked by: ${v.examinerCount} examiners (${v.examiners.join(', ')}) and a Final reviewer`, '');
  return out.join('\n');
}
