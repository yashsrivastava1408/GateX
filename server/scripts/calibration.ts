import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import YAML from 'yaml';
import { WorkbookModel } from '../src/excel/workbook.js';
import { toCsv } from '../src/library/spotCheck.js';
import { LABELS, pct, scoreForm, type CalibrationKey } from './calibrationLib.js';

/**
 * The calibration pack: a form for a person to score 5 file + scorecard pairs, so we can see how close the tool is to a human.
 *
 *   npm run calibration:make               writes data/calibration-pack/ (README.txt, calibration-form.csv, answer-key.json); the form has none of our scores or labels
 *   npm run calibration:read -- --file <filled form csv>
 *                                          reports how close the tool's per-criterion scores are to the person's (mean absolute difference, share within 1,
 *                                          bias up or down) and how often the finding labels agree
 *
 * Nothing here calls a model. The tool's scores and our labels come from the finished runs in data/ and are kept only in answer-key.json.
 * Our labels were written by an AI agent; a person's form is the first human check of them.
 */
const { positionals, values } = parseArgs({ allowPositionals: true, options: { file: { type: 'string' }, seed: { type: 'string' } } });
const base = process.env.INIT_CWD ?? process.cwd();
const root = path.resolve(import.meta.dirname, '../..');
const packDir = path.join(root, 'data/calibration-pack');

const CRITERIA_PER_PAIR = 10;
const FINDINGS_PER_PAIR = 15;

/** Five pairs that differ in file type and size: a PDF template, a 36-sheet workbook, a mid workbook, a CSV and a second PDF. */
const PAIRS = [
  { key: 'DOCKET', input: 'docket/schema.pdf', scorecard: 'docket/scorecard.xlsx', mainRun: 'live-docket-r3' },
  { key: 'STEP2', input: 'step2-v32/Talentra_Step2_Master_Schema_v3.2_Reconciled.xlsx', scorecard: 'step2-v32/Talentra_Step2_Master_Scorecard_v3.2_Reconciled.xlsx', mainRun: 'live-v32-run3' },
  { key: 'STEP3', input: 'step3/Feature_Discovery_Schema_3A.xlsx', scorecard: 'step3/03_feature_discovery.xlsx', mainRun: 'live-step3-run1' },
  { key: 'STEP4', input: 'step4/schema.csv', scorecard: 'step4/scorecard.csv', mainRun: 'live-step4' },
  { key: 'STEP5', input: 'step5/Step5_D1_Schema_Definition.pdf', scorecard: 'step5/Step5_D2_Scorecards.xlsx', mainRun: 'live-step5' },
] as const;

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(items: T[], next: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const oneLine = (t: string) => t.replace(/\s+/g, ' ').trim();

/* ------------------------------ reading the finished runs ------------------------------ */

interface RunCriterion {
  id: string; name: string; kind: string; status: string; consolidated: number | null; spread: number | null; confidence?: string; flagged?: boolean;
}
interface RunDimension { id: string; name: string; weight: number; critical: boolean; criteria?: RunCriterion[] }
interface RunFinding {
  id: string; severity: string; title: string; detail?: string; fix?: string; dimensionId: string; location?: { sheet: string; cell: string }; source?: string;
}
interface Report { header: { scorecardId: string }; dimensions: RunDimension[]; findings: RunFinding[]; droppedFindings?: RunFinding[] }
interface YamlCriterion { id: string; name: string; measure?: string; anchors?: Record<string, string> }
interface YamlDimension { id: string; name: string; measure?: string; anchors?: Record<string, string>; reads?: string[]; criteria?: YamlCriterion[] }

async function loadReport(run: string): Promise<Report> {
  return JSON.parse(await readFile(path.join(root, 'data', run, 'report.json'), 'utf8')) as Report;
}

/** The converted scorecard that holds the text of each criterion: the saved conversion with the same id that has every criterion of the run. */
async function scorecardText(report: Report): Promise<Map<string, { dim: YamlDimension; crit: YamlCriterion }>> {
  const wanted = report.dimensions.flatMap((d) => (d.criteria ?? []).map((c) => c.id));
  const dir = path.join(root, 'data/scorecards');
  for (const f of await readdir(dir)) {
    if (!f.endsWith('.json')) continue;
    const parsed = YAML.parse((JSON.parse(await readFile(path.join(dir, f), 'utf8')) as { result: { yaml: string } }).result.yaml) as { scorecard: { id: string; dimensions: YamlDimension[] } };
    if (parsed.scorecard.id !== report.header.scorecardId) continue;
    const map = new Map<string, { dim: YamlDimension; crit: YamlCriterion }>();
    for (const dim of parsed.scorecard.dimensions) for (const crit of dim.criteria ?? []) map.set(crit.id, { dim, crit });
    if (wanted.every((id) => map.has(id))) return map;
  }
  throw new Error(`No saved scorecard in data/scorecards matches ${report.header.scorecardId}.`);
}

/** Where examiners disagreed, where one examiner alone backed the mark, and where a heavy or critical dimension rides on it. */
function risk(d: RunDimension, c: RunCriterion): number {
  return (c.spread ?? 0) * 2 + (c.confidence === 'single' ? 2 : 0) + (c.flagged ? 1 : 0) + (d.critical ? 1.5 : 0) + d.weight / 10 + (c.consolidated !== null && c.consolidated >= 2 && c.consolidated <= 4 ? 1 : 0);
}

const anchorText = (a: Record<string, string> | undefined) => (a ? Object.keys(a).sort().map((k) => `${k} = ${oneLine(a[k]!)}`).join(' | ') : '');

/* ------------------------------ make ------------------------------ */

async function make() {
  const next = rng(Number(values.seed ?? 20261024));
  const runs: Array<[string, string, string]> = JSON.parse(await readFile(path.join(root, 'data/replay-runs.json'), 'utf8'));
  const header = ['id', 'part', 'pair', 'file to open', 'item', 'what to check', 'where to look', 'text in that cell', 'score', 'real', 'partly', 'wrong', 'vague', 'cell evidence', 'notes'];
  const rows: string[][] = [];
  const key: CalibrationKey & { note: string; criteria: Array<CalibrationKey['criteria'][number] & { dimensionId: string; run: string; raterScores: unknown; confidence: string | undefined }>; findings: Array<CalibrationKey['findings'][number] & { run: string; findingId: string; ourNote: string }> } = {
    note: 'OUR scores and labels (the tool and an AI agent). Do not open this before filling the form.', criteria: [], findings: [],
  };
  const guide: Array<{ pair: string; files: string[]; sheets: string[] }> = [];

  for (const pair of PAIRS) {
    const wb = await WorkbookModel.load(path.join(root, 'data/inputs', pair.input));
    const sheetsToOpen = new Set<string>();

    /* criteria */
    const report = await loadReport(pair.mainRun);
    const text = await scorecardText(report);
    const candidates = report.dimensions.flatMap((d) => (d.criteria ?? []).filter((c) => c.kind === 'judged' && c.status === 'scored' && c.consolidated !== null).map((c) => ({ d, c, r: risk(d, c) })));
    candidates.sort((a, b) => b.r - a.r || a.c.id.localeCompare(b.c.id));
    const picked: typeof candidates = [];
    const perDim = new Map<string, number>();
    for (const cand of candidates) { // at most 3 per dimension so one weak area does not fill the list
      if (picked.length >= CRITERIA_PER_PAIR) break;
      if ((perDim.get(cand.d.id) ?? 0) >= 3) continue;
      perDim.set(cand.d.id, (perDim.get(cand.d.id) ?? 0) + 1);
      picked.push(cand);
    }
    for (const cand of candidates) if (picked.length < CRITERIA_PER_PAIR && !picked.includes(cand)) picked.push(cand);
    picked.sort((a, b) => a.c.id.localeCompare(b.c.id));
    picked.forEach(({ d, c }, i) => {
      const id = `${pair.key}-C${String(i + 1).padStart(2, '0')}`;
      const t = text.get(c.id)!;
      const reads = t.dim.reads ?? [];
      reads.forEach((s) => sheetsToOpen.add(s.replace(/\[.*\]$/, '')));
      const anchors = anchorText(t.crit.anchors ?? t.dim.anchors);
      rows.push([id, 'CRITERION', pair.key, `data/inputs/${pair.input}`, `${d.name}: ${c.name}`, oneLine(`${t.crit.measure ?? t.dim.measure ?? ''} Score 0 to 5. ${anchors}`), reads.join('; '), '', '', '', '', '', '', '', '']);
      key.criteria.push({ id, pair: pair.key, criterionId: c.id, dimensionId: d.id, name: `${d.name}: ${c.name}`, toolScore: c.consolidated!, run: pair.mainRun, raterScores: (c as unknown as { raterScores?: unknown }).raterScores, confidence: c.confidence });
    });

    /* findings: every distinct wording the tool produced for this file, balanced over our labels, then the ones the app would not show */
    const forFile = runs.filter(([, input]) => input === pair.input).sort((a, b) => Number(b[0] === pair.mainRun) - Number(a[0] === pair.mainRun));
    const seen = new Set<string>();
    type Item = { f: RunFinding; run: string; label: string | null; note: string; shown: boolean };
    const shownItems: Item[] = [];
    const hiddenItems: Item[] = [];
    for (const [run, , labelFile] of forFile) {
      const rep = await loadReport(run);
      const labels = new Map((JSON.parse(await readFile(path.join(root, 'data', labelFile), 'utf8')) as { labels: Array<{ id: string; verdict: string; note: string }> }).labels.map((l) => [l.id, l]));
      for (const f of rep.findings) {
        const k = norm(f.title);
        if (seen.has(k)) continue;
        const l = labels.get(f.id);
        if (!l || !(LABELS as readonly string[]).includes(l.verdict)) continue;
        seen.add(k);
        shownItems.push({ f, run, label: l.verdict, note: l.note, shown: true });
      }
      for (const f of rep.droppedFindings ?? []) {
        const k = norm(f.title);
        if (seen.has(k)) continue;
        seen.add(k);
        hiddenItems.push({ f, run, label: null, note: '', shown: false });
      }
    }
    const buckets = LABELS.map((a) => shuffle(shownItems.filter((s) => s.label === a), next));
    const chosen: Item[] = [];
    while (chosen.length < FINDINGS_PER_PAIR && buckets.some((b) => b.length > 0)) for (const b of buckets) if (b.length > 0 && chosen.length < FINDINGS_PER_PAIR) chosen.push(b.shift()!);
    for (const h of shuffle(hiddenItems, next)) if (chosen.length < FINDINGS_PER_PAIR) chosen.push(h);
    shuffle(chosen, next).forEach((it, i) => {
      const id = `${pair.key}-F${String(i + 1).padStart(2, '0')}`;
      const loc = it.f.location;
      if (loc) sheetsToOpen.add(loc.sheet);
      const cellText = loc ? oneLine(wb.cellText(loc.sheet, loc.cell) ?? '').slice(0, 200) : '';
      const detail = it.f.detail ? oneLine(it.f.detail.replace(/\s*\[(?:Also reported as|Fact check):.*$/s, '')) : '';
      rows.push([id, 'FINDING', pair.key, `data/inputs/${pair.input}`, `${it.f.severity}: ${it.f.title}`, detail || '(title only)', loc ? `${loc.sheet} ! ${loc.cell}` : '(no cell cited)', cellText, '', '', '', '', '', '', '']);
      key.findings.push({ id, pair: pair.key, ourLabel: it.label, shownByTool: it.shown, run: it.run, findingId: it.f.id, ourNote: it.note });
    });
    guide.push({ pair: pair.key, files: [`data/inputs/${pair.input}`, `data/inputs/${pair.scorecard}`], sheets: [...sheetsToOpen] });
    const nFind = key.findings.filter((f) => f.pair === pair.key).length;
    console.log(`${pair.key}: ${picked.length} criteria, ${nFind} findings${nFind < FINDINGS_PER_PAIR ? ` (only ${nFind} distinct findings exist for this file)` : ''}`);
  }

  await mkdir(packDir, { recursive: true });
  await writeFile(path.join(packDir, 'calibration-form.csv'), '﻿' + toCsv([header, ...rows]));
  await writeFile(path.join(packDir, 'answer-key.json'), JSON.stringify(key, null, 1));
  await writeFile(path.join(packDir, 'README.txt'), readme(guide));
  console.log(`Wrote ${rows.length} rows to data/calibration-pack/calibration-form.csv, the key to answer-key.json and README.txt`);
}

function readme(guide: Array<{ pair: string; files: string[]; sheets: string[] }>): string {
  const list = guide.map((g) => `  ${g.pair}\n    file:      ${g.files[0]}\n    scorecard: ${g.files[1]}\n    open:      ${g.sheets.length ? g.sheets.join('; ') : '(whole file)'}`).join('\n');
  return `CALIBRATION PACK: how close is GateX to a person? (about 3 hours, can be split over days)

What this is
GateX scores a file against a scorecard and lists findings. So far only AI agents have judged whether those scores and findings are right.
This pack asks you to score 5 files the way a careful reviewer would. We then compare your scores with the tool's.

What to do
1. Open calibration-form.csv in Excel or Google Sheets. Do NOT open answer-key.json. It holds the tool's scores and our labels.
2. The form has two kinds of rows, grouped by pair (DOCKET, STEP2, STEP3, STEP4, STEP5).
   CRITERION rows: about 10 per pair. Read "what to check", open the file at "where to look", and put a whole number 0 to 5 in "score"
   (the 0-to-5 meanings are in the row). In "cell evidence" write the cell or page that made you decide (for example "Actor_Register!G5" or "Page 12").
   If you cannot decide, leave the row blank; do not guess.
   FINDING rows: up to 15 per pair. Open the file at the cited cell, judge the finding as written, and put an x in ONE of
     real    true, specific and worth fixing
     partly  something to it, but overstated, only partly right, or the file already says it
     wrong   the file shows the opposite, or the numbers are not as the finding says
     vague   names nothing you can check, or is not a defect of the file
3. Do not change the id column, the column order or the headings. Save as CSV (comma separated) under any name and send it back.

Which files to open
${list}

Tips
- A PDF has no cells: "Page 12 ! A3" means the table text on page 12.
- To search a workbook as text: npm run dump -- --workbook <file.xlsx> --out <folder>
- Score what the file shows, not what you think the authors meant. Do not look at GateX reports for these files first.

Reading it back (done by whoever runs GateX)
  npm run calibration:read -- --file <the filled form csv>
It prints, per pair and overall: the mean absolute difference between the tool's score and yours, the share of criteria within 1 point,
whether the tool scores higher or lower than you on average, and how often your finding labels match ours.

What the numbers can and cannot say
Criteria were picked where the tool was least sure (examiners disagreed, or only one backed the score, or the dimension is heavy), so the
gap you see is for hard cases, not for an average run. Some pairs have fewer than 15 findings because that is all the tool produced.
Our labels were written by an AI agent; your form is the first human check of them.

Making a fresh pack: npm run calibration:make (this overwrites the form and the key).
`;
}

/* ------------------------------ read ------------------------------ */

async function read() {
  const file = path.resolve(base, values.file ?? 'data/calibration-pack/calibration-form.csv');
  const key = JSON.parse(await readFile(path.join(packDir, 'answer-key.json'), 'utf8')) as CalibrationKey;
  const r = scoreForm(await readFile(file, 'utf8'), key);
  const f1 = (x: number) => x.toFixed(2);
  const signed = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`;
  console.log(`Criteria asked ${r.criteriaAsked}; scored ${r.criteriaScored}. Findings asked ${r.findingsAsked}; labelled ${r.findingsLabelled}. Left out ${r.skipped.length}${r.skipped.length ? ` (${r.skipped.slice(0, 12).map((s) => `${s.id}: ${s.why}`).join('; ')}${r.skipped.length > 12 ? '; ...' : ''})` : ''}`);
  if (r.scores) {
    const s = r.scores;
    console.log(`\nScores: the tool against the person (${s.n} criteria)`);
    console.log(`  mean absolute difference:  ${f1(s.meanAbsDiff)} points`);
    console.log(`  within 1 point:            ${pct(Math.round(s.within1 * s.n), s.n)}`);
    console.log(`  exactly the same:          ${pct(Math.round(s.exact * s.n), s.n)}`);
    console.log(`  bias (tool minus person):  ${signed(s.bias)} -> ${Math.abs(s.bias) < 0.25 ? 'no clear lean' : s.bias > 0 ? 'the tool scores HIGHER than the person' : 'the tool scores LOWER than the person'} (higher in ${s.toolHigher}, lower in ${s.toolLower})`);
    console.log(`\nBy pair`);
    for (const [p, v] of Object.entries(r.scoresByPair)) console.log(`  ${p.padEnd(7)} n ${String(v.n).padStart(2)}  mean abs diff ${f1(v.meanAbsDiff)}  within 1: ${pct(Math.round(v.within1 * v.n), v.n)}  bias ${signed(v.bias)}`);
    if (r.noEvidence > 0) console.log(`\n${r.noEvidence} of ${r.criteriaScored} scored criteria have no cell evidence in the form.`);
    if (r.bigMisses.length > 0) {
      console.log(`\nCriteria where the tool and the person differ by 2 or more`);
      for (const m of r.bigMisses) console.log(`  ${m.id} (${m.criterion}) tool ${m.tool}, person ${m.human}`);
    }
  } else console.log('\nNo criterion scores to compare yet.');
  const l = r.labels;
  if (l.n > 0) {
    console.log(`\nFinding labels against ours (${l.n} findings we had labelled)`);
    console.log(`  exactly the same label:              ${l.exact} of ${l.n} = ${pct(l.exact, l.n)}`);
    console.log(`  same on useful (real/partly) or not: ${l.usefulAgree} of ${l.n} = ${pct(l.usefulAgree, l.n)}`);
    console.log(`  useful: ours ${pct(l.ours.useful, l.n)}, the person's ${pct(l.theirs.useful, l.n)}`);
    console.log(`  wrong:  ours ${pct(l.ours.wrong, l.n)}, the person's ${pct(l.theirs.wrong, l.n)}`);
    console.log(`\nOur label (rows) against the person's (columns)`);
    console.log('           ' + LABELS.map((a) => a.padStart(7)).join(''));
    for (const o of LABELS) console.log(`  ${o.padEnd(8)} ` + LABELS.map((t) => String(l.matrix[o]![t]).padStart(7)).join(''));
    if (r.labelDisagreements.length > 0) console.log(`\nDifferent label: ${r.labelDisagreements.map((d) => `${d.id} ours ${d.ours}/theirs ${d.theirs}`).join('; ')}`);
  } else console.log('\nNo finding labels to compare yet.');
  if (r.unlabelled.n > 0) console.log(`\n${r.unlabelled.n} findings we never labelled (the app would not show them): the person found ${r.unlabelled.useful} useful and ${r.unlabelled.wrong} wrong. If many are useful, the filter drops good findings.`);
  console.log("\nOur scores and labels come from the tool and an AI agent. The person's form is the first human check of them.");
}

const command = positionals[0];
if (command === 'make') await make();
else if (command === 'read') await read();
else { console.error('Usage: calibration.ts make | read [--file <csv>]'); process.exit(1); }
