import PDFDocument from 'pdfkit';
import { BRAND, bandOf, type Decision, type Report, type Severity } from '@ddd/shared';
import { buildView, formatNumber, BAND_WORD, LOOK_TITLE, type ViewIssue } from './view.js';

// GateX palette. Green, amber and red are used only for verdict bands, scores and issue priority.
const NAVY = '#0f1a30';
const NAVY_SOFT = '#9fb0cf';
const INK = '#1c2433';
const MUTED = '#667085';
const LINE = '#e3e7ee';
const PANEL = '#f5f7fb';
const TEAL = '#0e9aa7';
const VIOLET = '#6d55e8';
const BAND: Record<Decision, string> = { green: '#2e9e5b', amber: '#dd9a1c', red: '#cc4540' };
const BAND_TINT: Record<Decision, string> = { green: '#e8f6ee', amber: '#fdf3de', red: '#fbe9e8' };
const SEV: Record<Severity, string> = { HIGH: '#cc4540', MEDIUM: '#dd9a1c', LOW: '#4f7fc4' };
const SEV_TINT: Record<Severity, string> = { HIGH: '#fdf1f0', MEDIUM: '#fffaf0', LOW: '#f3f7fd' };
const EXAMINER_COLOURS = [TEAL, VIOLET, '#e0559b', '#7a8699'];

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MX = 40;
const CW = PAGE_W - MX * 2;
const TOP = 52;
const BOTTOM = PAGE_H - 54;

/** The built-in PDF fonts only cover Latin-1, so swap the few symbols the report uses. */
const latin = (text: string | number | null | undefined) =>
  String(text ?? '')
    .replace(/[→]/g, '->').replace(/[≥]/g, '>=').replace(/[≤]/g, '<=').replace(/[≠]/g, '!=').replace(/[×]/g, 'x')
    .replace(/[·•]/g, '-').replace(/[…]/g, '...').replace(/[§]/g, 'Sec. ').replace(/[★]/g, '*')
    .replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, '-')
    .replace(/[^\x09\x0a\x20-\x7e\xa0-\xff]/g, '');

const bandColour = (score5: number | null) => (score5 === null ? MUTED : BAND[bandOf(score5 * 20)]);

/** A simple, chart-led report people can read in a few minutes. */
export function renderPdf(input: Report): Promise<Buffer> {
  const v = buildView(input);
  const doc = new PDFDocument({
    size: 'A4', margin: 0, bufferPages: true, autoFirstPage: true,
    info: { Title: latin(`${BRAND.name} report - ${v.fileName}`), Author: BRAND.name, Subject: BRAND.tagline },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  let y = 0;

  /* ----------------------------- drawing helpers ----------------------------- */
  const font = (size: number, bold = false) => doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
  const measure = (text: string, size: number, width: number, bold = false, gap = 2) => {
    font(size, bold);
    return doc.heightOfString(latin(text), { width, lineGap: gap });
  };
  const textWidth = (text: string, size: number, bold = false) => font(size, bold).widthOfString(latin(text));
  /** Draws text at (x, yy) and returns its height. */
  const write = (text: string, x: number, yy: number, o: { size?: number; bold?: boolean; color?: string; width?: number; align?: 'left' | 'center' | 'right'; gap?: number } = {}) => {
    const size = o.size ?? 10;
    const width = o.width ?? CW;
    font(size, o.bold).fillColor(o.color ?? INK);
    const h = doc.heightOfString(latin(text), { width, lineGap: o.gap ?? 2 });
    doc.text(latin(text), x, yy, { width, align: o.align ?? 'left', lineGap: o.gap ?? 2 });
    return h;
  };
  const oneLine = (text: string, size: number, width: number, bold = false) => {
    if (textWidth(text, size, bold) <= width) return text;
    let t = text;
    while (t.length > 1 && textWidth(`${t}...`, size, bold) > width) t = t.slice(0, -1);
    return `${t.trimEnd()}...`;
  };
  const pill = (text: string, x: number, yy: number, fill: string, o: { size?: number; color?: string; h?: number; padX?: number } = {}) => {
    const size = o.size ?? 8.5;
    const h = o.h ?? 15;
    const w = textWidth(text, size, true) + (o.padX ?? 10) * 2;
    doc.roundedRect(x, yy, w, h, h / 2).fill(fill);
    font(size, true).fillColor(o.color ?? '#ffffff').text(latin(text), x, yy + (h - size) / 2 + 0.6, { width: w, align: 'center', lineBreak: false });
    return w;
  };
  const newPage = () => {
    doc.addPage();
    y = TOP;
  };
  const ensure = (needed: number) => {
    if (y + needed > BOTTOM) newPage();
  };
  const section = (title: string, subtitle?: string, minAfter = 90) => {
    ensure(48 + minAfter);
    doc.roundedRect(MX, y + 1, 4, subtitle ? 32 : 20, 2).fill(TEAL);
    write(title, MX + 14, y, { size: 16, bold: true, color: NAVY, width: CW - 14 });
    y += 24;
    if (subtitle) {
      y += write(subtitle, MX + 14, y - 2, { size: 10, color: MUTED, width: CW - 14 });
      y += 4;
    }
    y += 8;
  };
  const arcPath = (cx: number, cy: number, r: number, fromDeg: number, toDeg: number) => {
    const rad = (d: number) => ((d - 90) * Math.PI) / 180;
    const x1 = cx + r * Math.cos(rad(fromDeg)), y1 = cy + r * Math.sin(rad(fromDeg));
    const x2 = cx + r * Math.cos(rad(toDeg)), y2 = cy + r * Math.sin(rad(toDeg));
    return `M ${x1} ${y1} A ${r} ${r} 0 ${toDeg - fromDeg > 180 ? 1 : 0} 1 ${x2} ${y2}`;
  };

  /* ----------------------------- page 1: at a glance ----------------------------- */
  doc.rect(0, 0, PAGE_W, 112).fill(NAVY);
  doc.rect(0, 112, PAGE_W, 4).fill(TEAL);
  write(BRAND.name, MX, 28, { size: 32, bold: true, color: '#ffffff', width: 300 });
  write(BRAND.tagline, MX, 70, { size: 11.5, color: NAVY_SOFT, width: 340 });
  write('CHECK REPORT', PAGE_W - MX - 200, 34, { size: 9, bold: true, color: TEAL, width: 200, align: 'right' });
  write(v.finished, PAGE_W - MX - 200, 50, { size: 11, color: '#ffffff', width: 200, align: 'right' });
  write(`Check ${v.checkNumber}`, PAGE_W - MX - 200, 68, { size: 11, color: NAVY_SOFT, width: 200, align: 'right' });

  y = 138;
  write('FILE CHECKED', MX, y, { size: 8.5, bold: true, color: MUTED });
  y += 13;
  y += write(v.fileName, MX, y, { size: 15, bold: true, color: NAVY });
  y += 3;
  y += write(`Scorecard: ${v.scorecard}`, MX, y, { size: 10, color: MUTED });
  y += 16;

  // Verdict card
  const cardH = 150;
  doc.roundedRect(MX, y, CW, cardH, 10).fill(BAND_TINT[v.decision]);
  doc.roundedRect(MX, y, 6, cardH, 3).fill(BAND[v.decision]);
  const gcx = MX + 88, gcy = y + cardH / 2, gr = 52;
  doc.lineWidth(11).lineCap('round').strokeColor('#ffffff').path(arcPath(gcx, gcy, gr, 0, 359.9)).stroke();
  const sweep = Math.max(2, Math.min(359.5, (v.score / 100) * 360));
  doc.lineWidth(11).lineCap('round').strokeColor(BAND[v.decision]).path(arcPath(gcx, gcy, gr, 0, sweep)).stroke();
  doc.lineCap('butt');
  write(formatNumber(v.score), gcx - 45, gcy - 20, { size: 32, bold: true, color: NAVY, width: 90, align: 'center' });
  write('out of 100', gcx - 45, gcy + 15, { size: 9.5, color: MUTED, width: 90, align: 'center' });
  const rx = MX + 176;
  pill(BAND_WORD[v.decision], rx, y + 22, BAND[v.decision], { size: 10, h: 20, padX: 14 });
  write(v.headline, rx, y + 50, { size: 26, bold: true, color: NAVY, width: CW - 190 });
  write(v.subline, rx, y + 88, { size: 10.5, color: INK, width: CW - 196 });
  y += cardH + 16;

  // Band bar with the score marker
  const barX = MX, barW = CW, barH = 12;
  const xAt = (s: number) => barX + (s / 100) * barW;
  const { accept, refine } = v.thresholds;
  doc.save();
  doc.roundedRect(barX, y + 14, barW, barH, 6).clip();
  doc.rect(xAt(0), y + 14, xAt(refine) - xAt(0), barH).fill(BAND.red);
  doc.rect(xAt(refine), y + 14, xAt(accept) - xAt(refine), barH).fill(BAND.amber);
  doc.rect(xAt(accept), y + 14, xAt(100) - xAt(accept), barH).fill(BAND.green);
  doc.restore();
  const mx = xAt(Math.max(0, Math.min(100, v.score)));
  doc.polygon([mx - 6, y + 2], [mx + 6, y + 2], [mx, y + 13]).fill(NAVY);
  doc.circle(mx, y + 20, 8).lineWidth(2.5).fillAndStroke('#ffffff', NAVY);
  for (const [label, at] of [['0', 0], [String(refine), refine], [String(accept), accept], ['100', 100]] as const) {
    write(label, xAt(at) - 15, y + 31, { size: 9, color: MUTED, width: 30, align: 'center' });
  }
  write('Red', xAt(refine / 2) - 20, y + 31, { size: 9, bold: true, color: BAND.red, width: 40, align: 'center' });
  write('Amber', xAt((refine + accept) / 2) - 20, y + 31, { size: 9, bold: true, color: BAND.amber, width: 40, align: 'center' });
  write('Green', xAt((accept + 100) / 2) - 20, y + 31, { size: 9, bold: true, color: BAND.green, width: 40, align: 'center' });
  y += 56;
  if (v.twoRuns) {
    write(v.twoRuns.line, MX, y, { size: 10, bold: true, color: v.twoRuns.unstable ? BAND.amber : MUTED, width: CW });
    y += 22;
  }

  // What this means
  write('What this means', MX, y, { size: 14, bold: true, color: NAVY });
  y += 22;
  for (const sentence of v.meaning) {
    const h = measure(sentence, 10.5, CW - 18, false, 2.5);
    doc.circle(MX + 4, y + 6, 2.6).fill(sentence.startsWith('The score is') ? BAND[v.decision] : TEAL);
    write(sentence, MX + 18, y, { size: 10.5, width: CW - 18, gap: 2.5 });
    y += h + 7;
  }
  y += 8;

  // Key numbers
  ensure(86);
  const tileW = (CW - 24) / 3;
  const tiles: Array<{ title: string; draw: (x: number, ty: number) => void }> = [
    {
      title: 'ISSUES TO FIX',
      draw: (x, ty) => {
        let cx = x + 14;
        for (const sev of ['HIGH', 'MEDIUM', 'LOW'] as const) {
          write(String(v.bySeverity[sev].length), cx, ty + 28, { size: 24, bold: true, color: SEV[sev], width: 40 });
          write(sev === 'HIGH' ? 'Must fix' : sev === 'MEDIUM' ? 'Should fix' : 'Nice to fix', cx, ty + 58, { size: 8.5, color: MUTED, width: 60 });
          cx += 56;
        }
      },
    },
    {
      title: 'KEY CHECKS PASSED',
      draw: (x, ty) => {
        write(String(v.keyChecks.passed), x + 14, ty + 26, { size: 28, bold: true, color: v.keyChecks.passed === v.keyChecks.total ? BAND.green : BAND.amber, width: 50 });
        write(`of ${v.keyChecks.total}`, x + 14 + textWidth(String(v.keyChecks.passed), 28, true) + 6, ty + 40, { size: 11, color: MUTED, width: 60 });
        write('Must score 4 or more', x + 14, ty + 62, { size: 8.5, color: MUTED, width: tileW - 20 });
      },
    },
    {
      title: 'AREAS SCORING 4 OR MORE',
      draw: (x, ty) => {
        write(String(v.areasAtFour.count), x + 14, ty + 26, { size: 28, bold: true, color: TEAL, width: 50 });
        write(`of ${v.areasAtFour.of}`, x + 14 + textWidth(String(v.areasAtFour.count), 28, true) + 6, ty + 40, { size: 11, color: MUTED, width: 60 });
        write('Pass mark is 4 out of 5', x + 14, ty + 62, { size: 8.5, color: MUTED, width: tileW - 20 });
      },
    },
  ];
  tiles.forEach((t, i) => {
    const x = MX + i * (tileW + 12);
    doc.roundedRect(x, y, tileW, 80, 8).fill(PANEL);
    write(t.title, x + 14, y + 12, { size: 8, bold: true, color: MUTED, width: tileW - 20 });
    t.draw(x, y);
  });
  y += 80;
  if (v.lookIssues.length > 0) {
    y += 8;
    write(`${v.lookIssues.length} more suggestion${v.lookIssues.length === 1 ? '' : 's'} from a single examiner ${v.lookIssues.length === 1 ? 'is' : 'are'} listed under "${LOOK_TITLE}" near the end. They are not counted above.`, MX, y, { size: 9, color: MUTED, width: CW });
    y += 14;
  }

  /* ----------------------------- how each area scored ----------------------------- */
  newPage();
  section('How each area scored', 'Each bar is one area, scored out of 5. The vertical line is the pass mark of 4.');
  {
    const labelW = 205, barStart = MX + labelW + 8, barLen = 175, scoreX = barStart + barLen + 10;
    // Legend
    let lx = MX;
    for (const [label, colour] of [['Green: 3.75 and above', BAND.green], ['Amber: 3 to 3.74', BAND.amber], ['Red: below 3', BAND.red]] as const) {
      doc.roundedRect(lx, y + 0.5, 10, 10, 2).fill(colour);
      lx += 15 + write(label, lx + 15, y, { size: 9, color: MUTED, width: 150 }) * 0 + textWidth(label, 9) + 14;
    }
    y += 24;
    const top = y;
    const rows = v.areas;
    const rowH = (a: (typeof rows)[number]) => Math.max(25, measure(a.name, 10, labelW, false, 1) + 12);
    const total = rows.reduce((n, a) => n + rowH(a), 0);
    ensure(total + 20);
    const chartTop = y;
    for (const a of rows) {
      const h = rowH(a);
      const th = measure(a.name, 10, labelW, false, 1);
      write(a.name, MX, y + (h - th) / 2, { size: 10, width: labelW, gap: 1 });
      doc.roundedRect(barStart, y + h / 2 - 6, barLen, 12, 6).fill('#edf0f5');
      if (a.score !== null) {
        doc.roundedRect(barStart, y + h / 2 - 6, Math.max(8, (a.score / 5) * barLen), 12, 6).fill(bandColour(a.score));
        write(`${formatNumber(a.score)} / 5`, scoreX, y + h / 2 - 6, { size: 10.5, bold: true, color: bandColour(a.score), width: 48 });
      } else {
        write('Not scored', scoreX, y + h / 2 - 6, { size: 9, color: MUTED, width: 60 });
      }
      if (a.critical) pill('Key check', MX + CW - 60, y + h / 2 - 7.5, '#ece9fd', { size: 8, color: VIOLET, h: 15, padX: 8 });
      doc.moveTo(MX, y + h).lineTo(MX + CW, y + h).lineWidth(0.5).strokeColor(LINE).stroke();
      y += h;
    }
    const passX = barStart + (4 / 5) * barLen;
    doc.moveTo(passX, chartTop - 4).lineTo(passX, y).lineWidth(1.4).dash(3, { space: 2 }).strokeColor(NAVY).stroke().undash();
    write('Pass mark 4', passX - 30, chartTop - 16, { size: 8.5, bold: true, color: NAVY, width: 60, align: 'center' });
    void top;
    y += 14;
  }

  /* ----------------------------- issues by priority + where ----------------------------- */
  {
    const total = v.issues.length;
    const where = v.issuesByArea.slice(0, 8);
    const wNameW = 185;
    const rowHeights = where.map((w) => Math.max(21, measure(w.area, 9.5, wNameW, false, 1) + 9));
    const rowsH = Math.max(205, 24 + rowHeights.reduce((n, h) => n + h, 0) + 14);
    section('Issues at a glance', total === 0 ? 'No issues were raised.' : `${total} issue${total === 1 ? '' : 's'} found, by priority and by area.`, rowsH - 12);
    if (total > 0) {
      const cx = MX + 66, cy = y + 62, r = 48;
      let start = 0;
      for (const sev of ['HIGH', 'MEDIUM', 'LOW'] as const) {
        const n = v.bySeverity[sev].length;
        if (n === 0) continue;
        const sweep = (n / total) * 360;
        doc.lineWidth(20).lineCap('butt').strokeColor(SEV[sev]).path(arcPath(cx, cy, r, start, start + Math.min(sweep, 359.9) - (n === total ? 0 : 1.2))).stroke();
        start += sweep;
      }
      write(String(total), cx - 30, cy - 15, { size: 24, bold: true, color: NAVY, width: 60, align: 'center' });
      write('issues', cx - 30, cy + 10, { size: 9, color: MUTED, width: 60, align: 'center' });
      let ly = y + 130;
      for (const sev of ['HIGH', 'MEDIUM', 'LOW'] as const) {
        doc.roundedRect(MX + 10, ly + 1, 11, 11, 3).fill(SEV[sev]);
        write(String(v.bySeverity[sev].length), MX + 28, ly, { size: 10.5, bold: true, color: SEV[sev], width: 20 });
        write(sev === 'HIGH' ? 'Must fix' : sev === 'MEDIUM' ? 'Should fix' : 'Nice to fix', MX + 50, ly, { size: 10.5, width: 90 });
        ly += 20;
      }
      // Where the issues are
      const wx = MX + 180, ww = CW - 180;
      write('Where the issues are', wx, y, { size: 11, bold: true, color: NAVY, width: ww });
      let wy = y + 24;
      const max = Math.max(...where.map((w) => w.count));
      where.forEach((w, i) => {
        const rh = rowHeights[i]!;
        const th = measure(w.area, 9.5, wNameW, false, 1);
        write(w.area, wx, wy + (rh - th) / 2 - 1, { size: 9.5, width: wNameW, gap: 1 });
        const len = ((ww - wNameW - 40) * w.count) / max;
        doc.roundedRect(wx + wNameW + 8, wy + rh / 2 - 6, Math.max(5, len), 10, 3).fill(TEAL);
        write(String(w.count), wx + wNameW + 14 + Math.max(5, len), wy + rh / 2 - 6, { size: 9.5, bold: true, color: INK, width: 24 });
        wy += rh;
      });
      if (v.issuesByArea.length > where.length) write(`and ${v.issuesByArea.length - where.length} more area${v.issuesByArea.length - where.length === 1 ? '' : 's'}`, wx, wy + 2, { size: 9, color: MUTED, width: ww });
      y += rowsH + 6;
    }
  }

  /* ----------------------------- what to fix first ----------------------------- */
  if (v.issues.length > 0) {
    newPage();
    section('What to fix first', 'Work from the top. Issue numbers match the Excel and Markdown downloads.');
    const card = (i: ViewIssue, mode: 'full' | 'medium' | 'compact') => {
      const pad = 12, inner = CW - pad * 2 - 6;
      const hTitle = measure(i.title, 11, inner, true);
      const hDetail = mode === 'full' && i.detail ? measure(i.detail, 10, inner) : 0;
      const hFix = measure(i.fix, 10, inner - (mode === 'compact' ? 0 : 0));
      const hWhere = i.where ? 14 : 0;
      const total = pad + 20 + hTitle + 4 + hWhere + (hDetail ? hDetail + 6 : 0) + 14 + hFix + pad - (mode === 'compact' ? 0 : 0);
      ensure(total + 10);
      doc.roundedRect(MX, y, CW, total, 8).fill(SEV_TINT[i.severity]);
      doc.roundedRect(MX, y, 5, total, 2.5).fill(SEV[i.severity]);
      let ty = y + pad;
      const tx = MX + pad + 6;
      const w1 = pill(i.label, tx, ty - 2, NAVY, { size: 8.5, h: 16 });
      const w2 = pill(i.severityWord, tx + w1 + 6, ty - 2, SEV[i.severity], { size: 8.5, h: 16 });
      write(oneLine(i.area, 9.5, CW - pad * 2 - w1 - w2 - 24), tx + w1 + w2 + 14, ty + 1.5, { size: 9.5, color: MUTED, width: CW - pad * 2 - w1 - w2 - 18 });
      ty += 22;
      write(i.title, tx, ty, { size: 11, bold: true, color: NAVY, width: inner });
      ty += hTitle + 4;
      if (i.where) {
        write(`Where: ${i.where}`, tx, ty, { size: 9, color: MUTED, width: inner });
        ty += 14;
      }
      if (hDetail) {
        write(i.detail, tx, ty, { size: 10, color: INK, width: inner });
        ty += hDetail + 6;
      }
      write('WHAT TO DO', tx, ty + 1, { size: 8, bold: true, color: SEV[i.severity], width: 100 });
      ty += 13;
      write(i.fix, tx, ty, { size: 10, width: inner });
      y += total + 10;
    };
    const groups: Array<[Severity, string, 'full' | 'medium' | 'compact']> = [['HIGH', 'Must fix', 'full'], ['MEDIUM', 'Should fix', 'medium'], ['LOW', 'Nice to fix', 'compact']];
    for (const [sev, label, mode] of groups) {
      const items = v.bySeverity[sev];
      if (items.length === 0) continue;
      ensure(40 + 80);
      doc.circle(MX + 6, y + 8, 5).fill(SEV[sev]);
      write(`${label} (${items.length})`, MX + 18, y, { size: 13, bold: true, color: NAVY, width: 300 });
      y += 26;
      for (const i of items) card(i, mode);
      y += 6;
    }
  }

  /* ----------------------------- path to green ----------------------------- */
  {
    const steps = v.path.steps;
    section('Your path to green', steps.length === 0 ? undefined : 'Your score after each fix, in order.', 120);
    if (steps.length > 0) {
      const points: Array<{ label: string; score: number }> = [{ label: 'Today', score: v.score }];
      let running = v.score;
      steps.forEach((s, idx) => {
        running = idx === steps.length - 1 ? v.path.resultingScore : Math.min(100, running + s.gain);
        points.push({ label: `After step ${s.order}`, score: running });
      });
      const lo = Math.max(0, Math.floor((Math.min(...points.map((p) => p.score), v.thresholds.refine) - 10) / 10) * 10);
      const labelW = 80, x0 = MX + labelW + 6, len = CW - labelW - 60;
      const at = (s: number) => x0 + ((s - lo) / (100 - lo)) * len;
      const chartH = points.length * 28 + 22;
      ensure(chartH + 20);
      const top = y;
      doc.rect(at(lo), top, at(v.thresholds.refine) - at(lo), chartH - 20).fill('#fdf0ef');
      doc.rect(at(v.thresholds.refine), top, at(v.thresholds.accept) - at(v.thresholds.refine), chartH - 20).fill('#fef8ea');
      doc.rect(at(v.thresholds.accept), top, at(100) - at(v.thresholds.accept), chartH - 20).fill('#edf8f1');
      points.forEach((p, i) => {
        const ry = top + i * 28 + 6;
        write(p.label, MX, ry + 2, { size: 10, bold: i === 0, width: labelW });
        doc.roundedRect(x0, ry, Math.max(6, at(p.score) - x0), 16, 4).fill(BAND[bandOf(p.score)]);
        write(formatNumber(p.score), at(p.score) + 6, ry + 2, { size: 10.5, bold: true, color: NAVY, width: 40 });
      });
      for (const mark of [lo, v.thresholds.refine, v.thresholds.accept, 100]) {
        write(String(mark), at(mark) - 15, top + chartH - 17, { size: 8.5, color: MUTED, width: 30, align: 'center' });
      }
      y += chartH + 12;
      for (const s of steps) {
        const text = `Raise "${s.area}" from ${s.from} to ${s.to} out of 5 (about +${s.gain} points).${s.fixes.length ? ` Fixes ${s.fixes.map((f) => f.toLowerCase()).join(', ')}.` : ''}`;
        const h = measure(text, 10.5, CW - 34, false, 2);
        ensure(h + 12);
        doc.circle(MX + 10, y + 8, 10).fill(TEAL);
        write(String(s.order), MX, y + 3.5, { size: 10, bold: true, color: '#ffffff', width: 20, align: 'center' });
        write(text, MX + 28, y, { size: 10.5, width: CW - 34 });
        y += Math.max(h, 18) + 8;
      }
    }
    if (v.path.note) {
      const h = measure(v.path.note, 10.5, CW - 28, false, 2);
      ensure(h + 24);
      y += 4;
      doc.roundedRect(MX, y, CW, h + 18, 8).fill(PANEL);
      write(v.path.note, MX + 14, y + 9, { size: 10.5, width: CW - 28 });
      y += h + 30;
    } else y += 10;
  }

  /* ----------------------------- strengths ----------------------------- */
  if (v.strengths.length > 0) {
    section('What is already good', undefined, 70);
    for (const s of v.strengths) {
      const meta = [s.area, s.where].filter(Boolean).join('  |  ');
      const h = measure(s.text, 10.5, CW - 28, false, 2);
      const total = h + (meta ? 14 : 0) + 6;
      ensure(total + 8);
      doc.circle(MX + 7, y + 7, 7).fill('#dff3e6');
      doc.moveTo(MX + 3.5, y + 7.2).lineTo(MX + 6.3, y + 10).lineTo(MX + 10.8, y + 4.6).lineWidth(1.6).strokeColor(BAND.green).stroke();
      write(s.text, MX + 24, y, { size: 10.5, width: CW - 28 });
      if (meta) write(meta, MX + 24, y + h + 2, { size: 9, color: MUTED, width: CW - 28 });
      y += total + 6;
    }
    y += 8;
  }

  /* ----------------------------- how the examiners compared ----------------------------- */
  if (v.examinerRows.length > 0) {
    section('How the examiners compared', 'Each dot is one examiner\'s score for that area, out of 5. Dots close together mean they agreed.', 120);
    const labelW = 200, x0 = MX + labelW + 14, len = 190;
    let lx = x0;
    v.examiners.forEach((name, i) => {
      doc.circle(lx + 5, y + 6, 5).fill(EXAMINER_COLOURS[i % EXAMINER_COLOURS.length]!);
      write(name, lx + 14, y, { size: 9.5, color: INK, width: 70 });
      lx += 14 + textWidth(name, 9.5) + 18;
    });
    y += 22;
    const rowFor = (r: (typeof v.examinerRows)[number]) => 26 + (r.note ? measure(r.note, 9.5, CW - 8, false, 1) + 4 : 0);
    ensure(rowFor(v.examinerRows[0]!) + 20);
    const axis = () => {
      for (let n = 0; n <= 5; n++) write(String(n), x0 + (n / 5) * len - 10, y, { size: 8.5, color: MUTED, width: 20, align: 'center' });
      y += 14;
    };
    axis();
    for (const r of v.examinerRows) {
      const h = rowFor(r);
      if (y + h > BOTTOM) {
        newPage();
        axis();
      }
      write(oneLine(r.area, 10, labelW), MX, y + 5, { size: 10, width: labelW + 6 });
      const cyy = y + 12;
      doc.moveTo(x0, cyy).lineTo(x0 + len, cyy).lineWidth(3).lineCap('round').strokeColor('#e3e7ee').stroke().lineCap('butt');
      for (let n = 0; n <= 5; n++) doc.moveTo(x0 + (n / 5) * len, cyy - 5).lineTo(x0 + (n / 5) * len, cyy + 5).lineWidth(0.6).strokeColor('#c9cfda').stroke();
      const seen = new Map<number, number>();
      r.scores.forEach((s, i) => {
        if (s.score === null) return;
        const k = seen.get(s.score) ?? 0;
        seen.set(s.score, k + 1);
        doc.circle(x0 + (s.score / 5) * len + (k ? k * 3 : 0), cyy - (k ? k * 3 : 0), 5.2).lineWidth(1).fillAndStroke(EXAMINER_COLOURS[i % EXAMINER_COLOURS.length]!, '#ffffff');
      });
      const missing = r.scores.filter((s) => s.score === null).length;
      if (missing > 0) write(`${missing} no score`, x0 + len + 14, y + 6, { size: 8.5, color: MUTED, width: 60 });
      if (r.note) write(r.note, MX, y + 24, { size: 9.5, color: r.disagreed ? '#a6671a' : MUTED, width: CW - 8, gap: 1 });
      doc.moveTo(MX, y + h - 2).lineTo(MX + CW, y + h - 2).lineWidth(0.4).strokeColor(LINE).stroke();
      y += h;
    }
    y += 16;
  }

  /* ----------------------------- not checked ----------------------------- */
  {
    section('Not checked from the file', undefined, 30);
    if (v.leftOut.length === 0) {
      write('Nothing was left out. Every area could be checked from the file.', MX, y, { size: 10.5, width: CW });
      y += 26;
    } else {
      for (const n of v.leftOut) {
        const h = measure(n.reason, 10, CW - 20, false, 2);
        ensure(h + 40);
        write(n.name, MX, y, { size: 11, bold: true, color: NAVY, width: CW - 120 });
        pill(n.treatment, MX + CW - textWidth(n.treatment, 8.5, true) - 20, y, '#ece9fd', { size: 8.5, color: VIOLET });
        y += 17;
        write(n.reason, MX + 10, y, { size: 10, color: INK, width: CW - 20 });
        y += h + 14;
      }
    }
  }

  /* ----------------------------- worth a look (secondary, never counted above) ----------------------------- */
  if (v.lookIssues.length > 0) {
    newPage();
    section(`${LOOK_TITLE} (${v.lookIssues.length})`, v.lookNote, 90);
    const pad = 10;
    const inner = CW - pad * 2 - 4;
    for (const i of v.lookIssues) {
      const hTitle = measure(i.title, 10, inner, true);
      const hDetail = i.detail ? measure(i.detail, 9, inner) : 0;
      const hFix = measure(`Suggested: ${i.fix}`, 9, inner);
      const total = pad + 14 + hTitle + 3 + (i.where ? 12 : 0) + (hDetail ? hDetail + 4 : 0) + hFix + pad;
      ensure(total + 8);
      doc.roundedRect(MX, y, CW, total, 6).fill(PANEL);
      doc.roundedRect(MX, y, 4, total, 2).fill('#9aa4b5');
      let ty = y + pad;
      const tx = MX + pad + 4;
      const w1 = pill(i.label, tx, ty - 2, '#7a8699', { size: 8, h: 14 });
      write(oneLine(`${i.area}  |  ${i.severityWord} (the examiner's view)`, 9, inner - w1 - 10), tx + w1 + 8, ty, { size: 9, color: MUTED, width: inner - w1 - 8 });
      ty += 16;
      write(i.title, tx, ty, { size: 10, bold: true, color: NAVY, width: inner });
      ty += hTitle + 3;
      if (i.where) { write(`Where: ${i.where}`, tx, ty, { size: 8.5, color: MUTED, width: inner }); ty += 12; }
      if (hDetail) { write(i.detail, tx, ty, { size: 9, color: INK, width: inner }); ty += hDetail + 4; }
      write(`Suggested: ${i.fix}`, tx, ty, { size: 9, color: MUTED, width: inner });
      y += total + 8;
    }
    y += 6;
  }

  /* ----------------------------- about this check ----------------------------- */
  y += 10;
  section('About this check', undefined, 190);
  const about: Array<[string, string]> = [
    ['File', v.fileName],
    ['Scorecard', `${v.scorecard}${v.report.header.scorecardVersion ? ` (version ${v.report.header.scorecardVersion})` : ''}`],
    ['Checked on', v.finishedLong],
    ['Check number', String(v.checkNumber)],
    ['Who marked it', `${v.examinerCount} examiners (${v.examiners.join(', ')}) and a Final reviewer`],
    ...(v.cost ? [['What it used', `${v.cost.sentence}\n${v.cost.lines.map((l) => `${l.label}: ${l.tokensIn.toLocaleString('en-US')} in, ${l.tokensOut.toLocaleString('en-US')} out${l.price ? ` (${l.price})` : ''}`).join('\n')}`] as [string, string]] : []),
  ];
  for (const [k, val] of about) {
    const h = measure(val, 11, CW - 130, false, 2);
    write(k.toUpperCase(), MX, y + 2, { size: 8.5, bold: true, color: MUTED, width: 110 });
    write(val, MX + 130, y, { size: 11, width: CW - 130 });
    y += h + 8;
    doc.moveTo(MX, y).lineTo(MX + CW, y).lineWidth(0.5).strokeColor(LINE).stroke();
    y += 10;
  }

  /* ----------------------------- header strip + footer on every page ----------------------------- */
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    if (i > 0) {
      doc.rect(0, 0, PAGE_W, 26).fill(NAVY);
      doc.rect(0, 26, PAGE_W, 2).fill(TEAL);
      write(BRAND.name, MX, 8, { size: 11, bold: true, color: '#ffffff', width: 100 });
      write(BRAND.tagline, PAGE_W - MX - 260, 9, { size: 8.5, color: NAVY_SOFT, width: 260, align: 'right' });
    }
    doc.moveTo(MX, PAGE_H - 40).lineTo(MX + CW, PAGE_H - 40).lineWidth(0.5).strokeColor(LINE).stroke();
    const left = `${BRAND.name}   |   ${oneLine(v.fileName, 8.5, 260)}`;
    write(left, MX, PAGE_H - 31, { size: 8.5, color: MUTED, width: 330 });
    write(`${v.finished}   |   Page ${i + 1} of ${range.count}`, PAGE_W - MX - 200, PAGE_H - 31, { size: 8.5, color: MUTED, width: 200, align: 'right' });
  }
  doc.end();
  return done;
}
