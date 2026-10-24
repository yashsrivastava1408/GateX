import ExcelJS from 'exceljs';
import { BRAND, bandOf, type Decision, type Report, type Severity } from '@ddd/shared';
import { BAND_WORD, buildView, formatNumber } from './view.js';

const NAVY = 'FF0F1A30';
const solid = (argb: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
// Strong fills for the verdict, soft fills for scores and priorities. Green, amber and red follow the one score rule.
const STRONG: Record<Decision, string> = { green: 'FF2E9E5B', amber: 'FFDD9A1C', red: 'FFCC4540' };
const SOFT: Record<Decision, string> = { green: 'FFDDF1E5', amber: 'FFFCEFD0', red: 'FFF8D9D7' };
const SEV_SOFT: Record<Severity, string> = { HIGH: 'FFF8D9D7', MEDIUM: 'FFFCEFD0', LOW: 'FFDCE8F8' };

function sheet(workbook: ExcelJS.Workbook, name: string, columns: Array<{ header: string; width: number }>) {
  const ws = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.header, width: c.width }));
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = solid(NAVY);
  header.height = 22;
  return ws;
}

/** The report as a workbook with plainly named sheets: Summary, Areas, Issues, Strengths, Examiners, Path to green, Not checked. */
export async function renderXlsx(input: Report): Promise<Buffer> {
  const v = buildView(input);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = BRAND.name;
  workbook.title = `${BRAND.name} report - ${v.fileName}`;

  const s = sheet(workbook, 'Summary', [{ header: BRAND.name, width: 26 }, { header: BRAND.tagline, width: 28 }, { header: '', width: 90 }]);
  const verdictRow = s.addRow(['Result', `${BAND_WORD[v.decision]} - ${v.headline}`, v.subline]);
  verdictRow.getCell(2).fill = solid(STRONG[v.decision]);
  verdictRow.getCell(2).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  s.addRow(['Score', `${formatNumber(v.score)} out of 100`, `Green needs ${v.thresholds.accept} or more. Amber is ${v.thresholds.refine} to ${v.thresholds.accept - 1}. Red is below ${v.thresholds.refine}.`]);
  if (v.twoRuns) {
    s.addRow(['Run 1 score', formatNumber(v.twoRuns.first), '']);
    s.addRow(['Run 2 score', formatNumber(v.twoRuns.second), '']);
    s.addRow(['Average (shown above)', formatNumber(v.twoRuns.average), `The two runs differ by ${formatNumber(v.twoRuns.gap)} points.`]);
    if (v.twoRuns.unstable) {
      const r = s.addRow(['Needs attention', 'Result is unstable', 'Treat it as a range: the two runs are 8 or more points apart, or landed on different colours.']);
      r.getCell(2).fill = solid(SEV_SOFT.MEDIUM);
      r.getCell(2).font = { bold: true };
    }
  }
  s.addRow(['File', v.fileName, '']);
  s.addRow(['Scorecard', v.scorecard, '']);
  s.addRow(['Checked on', v.finishedLong, '']);
  s.addRow(['Check number', v.checkNumber, '']);
  s.addRow(['Marked by', `${v.examinerCount} examiners and a Final reviewer`, v.examiners.join(', ')]);
  if (v.report.header.instructions) s.addRow(['Extra instructions', v.report.header.instructions, '']);
  s.addRow([]);
  s.addRow(['What this means']).font = { bold: true };
  for (const m of v.meaning) s.addRow(['', '', m]);
  s.addRow([]);
  s.addRow(['Key numbers']).font = { bold: true };
  s.addRow(['Must fix', v.bySeverity.HIGH.length, 'Issues to fix first']).getCell(2).fill = solid(SEV_SOFT.HIGH);
  s.addRow(['Should fix', v.bySeverity.MEDIUM.length, '']).getCell(2).fill = solid(SEV_SOFT.MEDIUM);
  s.addRow(['Nice to fix', v.bySeverity.LOW.length, '']).getCell(2).fill = solid(SEV_SOFT.LOW);
  s.addRow(['Key checks passed', `${v.keyChecks.passed} of ${v.keyChecks.total}`, 'A key check must score 4 or more']);
  s.addRow(['Areas scoring 4 or more', `${v.areasAtFour.count} of ${v.areasAtFour.of}`, 'The pass mark is 4 out of 5']);

  const a = sheet(workbook, 'Areas', [
    { header: 'Area', width: 46 }, { header: 'Score out of 5', width: 15 }, { header: 'Result', width: 26 }, { header: 'Key check', width: 11 }
  ]);
  for (const area of v.areas) {
    const row = a.addRow([area.name, area.score ?? '', area.score === null ? 'Not scored' : area.passed ? 'Pass' : 'Below the pass mark of 4', area.critical ? 'Yes' : '']);
    if (area.band) {
      row.getCell(2).fill = solid(SOFT[area.band]);
      row.getCell(2).font = { bold: true };
    }
  }

  const i = sheet(workbook, 'Issues', [
    { header: 'Issue', width: 10 }, { header: 'Priority', width: 13 }, { header: 'Area', width: 38 }, { header: 'Where in the file', width: 30 },
    { header: 'What is wrong', width: 55 }, { header: 'More detail', width: 60 }, { header: 'What to do', width: 60 }, { header: 'Done', width: 8 },
  ]);
  for (const issue of v.issues) {
    const row = i.addRow([issue.label, issue.severityWord, issue.area, issue.where, issue.title, issue.detail, issue.fix, '']);
    row.getCell(2).fill = solid(SEV_SOFT[issue.severity]);
    row.getCell(2).font = { bold: true };
  }
  i.autoFilter = { from: 'A1', to: 'H1' };

  const st = sheet(workbook, 'Strengths', [{ header: 'Area', width: 40 }, { header: 'What is good', width: 90 }, { header: 'Where in the file', width: 30 }]);
  for (const item of v.strengths) st.addRow([item.area, item.text, item.where]);

  const e = sheet(workbook, 'Examiners', [
    { header: 'Area', width: 46 }, ...v.examiners.map((name) => ({ header: name, width: 12 })), { header: 'Note', width: 80 },
  ]);
  for (const r of v.examinerRows) {
    const row = e.addRow([r.area, ...r.scores.map((x) => x.score ?? ''), r.note]);
    r.scores.forEach((x, idx) => {
      if (x.score !== null) row.getCell(2 + idx).fill = solid(SOFT[bandOf(x.score * 20)]);
    });
    if (r.disagreed) row.getCell(2 + v.examiners.length).font = { color: { argb: 'FFA6671A' } };
  }

  const p = sheet(workbook, 'Path to green', [{ header: 'Step', width: 8 }, { header: 'Area', width: 46 }, { header: 'From', width: 8 }, { header: 'To', width: 8 }, { header: 'Points gained', width: 14 }, { header: 'Fixes', width: 30 }]);
  for (const step of v.path.steps) p.addRow([step.order, step.area, step.from, step.to, step.gain, step.fixes.join(', ')]);
  p.addRow([]);
  p.addRow(['', v.path.note]);
  p.addRow(['', `After these fixes the score would be ${formatNumber(v.path.resultingScore)} (${BAND_WORD[v.path.resultingDecision]}).`]);

  const n = sheet(workbook, 'Not checked', [{ header: 'Area', width: 46 }, { header: 'Key check', width: 11 }, { header: 'Why', width: 80 }, { header: 'In the score', width: 28 }]);
  for (const item of v.leftOut) n.addRow([item.name, item.critical ? 'Yes' : '', item.reason, item.treatment]);

  for (const ws of workbook.worksheets) {
    ws.eachRow((row) => row.eachCell((c) => { c.alignment = { vertical: 'top', wrapText: true }; }));
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
