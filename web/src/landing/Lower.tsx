import { useEffect, useState, type CSSProperties } from 'react';
import { LIcon } from './icons';
import { Reveal } from './Reveal';
import { Tilt } from './Tilt';
import { useCountUp, useInView } from './hooks';

/** Counts up after a delay, so a row of numbers settles one after another. */
function Count({ to, active, delay = 0 }: { to: number; active: boolean; delay?: number }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!active) {
      setOn(false);
      return;
    }
    const t = window.setTimeout(() => setOn(true), delay);
    return () => window.clearTimeout(t);
  }, [active, delay]);
  return <>{useCountUp(to, on, 1100)}</>;
}

const STEPS = [
  { v: 58, delta: '', label: 'Today', tone: 'red' },
  { v: 66, delta: '+8', label: 'Fix missing fields', tone: 'orange' },
  { v: 72, delta: '+6', label: 'Update references', tone: 'amber' },
  { v: 79, delta: '+7', label: 'Fix data formats', tone: 'teal' },
  { v: 81, delta: '+2', label: 'Resolve duplicates', tone: 'green' },
];
const BAR_PX = 4.6;
const barHeight = (v: number) => (v - 30) * BAR_PX;

/** Blocks that rise from today's score to the green zone, one fix at a time. */
export function PathToGreen() {
  const [ref, seen] = useInView<HTMLDivElement>();
  return (
    <section className="lp-section" id="path">
      <div className="lp-wrap">
        <Reveal as="header" className="section-head split">
          <div>
            <h2>Path to green</h2>
            <p>See how a few key fixes move the score.</p>
          </div>
          <span className="green-zone"><LIcon name="arrow" size={15} stroke={2} /> Green zone</span>
        </Reveal>
        <div className={`path3d ${seen ? 'in' : ''}`} ref={ref}>
          <div className="p3-bars">
            <span className="p3-line" style={{ bottom: `${barHeight(75)}px` }}><em>Green starts at 75</em></span>
            {STEPS.map((s, i) => (
              <div key={s.label} className="p3-col" style={{ '--i': i, '--h': `${barHeight(s.v)}px` } as CSSProperties}>
                <b className="p3-val"><Count to={s.v} active={seen} delay={i * 220 + 500} /></b>
                <div className={`bar3d ${s.tone}`}><i /></div>
                {i < STEPS.length - 1 && (
                  <svg className="p3-arrow" viewBox="0 0 40 12" width="40" height="12" aria-hidden="true"><path d="M0 6h34" /><path d="M29 1l6 5-6 5" /></svg>
                )}
              </div>
            ))}
          </div>
          <div className="p3-labels">
            {STEPS.map((s, i) => (
              <div key={s.label} style={{ '--i': i } as CSSProperties}>
                <strong>{s.delta || s.v}</strong>
                <span>{s.label}</span>
              </div>
            ))}
          </div>
        </div>
        <small className="sample">Sample result</small>
      </div>
    </section>
  );
}

const FORMATS = [
  { label: 'XLS', name: 'Excel', tone: 'green' },
  { label: 'CSV', name: 'CSV', tone: 'blue' },
  { label: 'PDF', name: 'PDF', tone: 'red' },
  { label: 'TXT', name: 'Text', tone: 'grey' },
];
const CONVERT_POINTS = ['Same scorecard used every time', 'Works with any layout', 'A note if it asks about things your file cannot hold'];

export function AnyScorecard() {
  const [ref, seen] = useInView<HTMLDivElement>();
  return (
    <section className="lp-section" id="scorecards">
      <div className="lp-wrap">
        <Reveal as="header" className="section-head">
          <h2>Any scorecard, any layout</h2>
          <p>Convert once, reuse every time.</p>
        </Reveal>
        <div ref={ref} className={`convert ${seen ? 'in' : ''}`}>
          <div className="formats">
            {FORMATS.map((f, i) => (
              <span key={f.label} className={`format ${f.tone}`} style={{ '--i': i } as CSSProperties}>
                <span className="format-face">
                  <b>{f.label}</b>
                </span>
                <em>{f.name}</em>
              </span>
            ))}
          </div>
          <svg className="convert-arrow" viewBox="0 0 120 30" width="120" height="30" aria-hidden="true">
            <path d="M2 15h104" /><path d="M94 4l14 11-14 11" />
          </svg>
          <Tilt className="scorecard-out" max={5}>
            <div className="so-head">
              <span className="tile-icon"><LIcon name="list" size={24} /></span>
              <span><strong>Scorecard</strong><small>Converted and ready</small></span>
            </div>
            <ul>
              {CONVERT_POINTS.map((c, i) => (
                <li key={c} style={{ '--i': i } as CSSProperties}>
                  <i><LIcon name="check" size={12} stroke={3} /></i>
                  {c}
                </li>
              ))}
            </ul>
          </Tilt>
        </div>
        <p className="fit-note"><LIcon name="alert" size={16} /> Before it scores, GateX tells you in plain words if a scorecard asks about something your file cannot hold, for example a built database when the file is a feature list. It never blocks the check.</p>
      </div>
    </section>
  );
}

const DETAILS = [
  { icon: 'people', k: 'Area', v: 'Customer Information' },
  { icon: 'link', k: 'Where', v: 'Sheet1!B12' },
  { icon: 'doc', k: 'What is wrong', v: 'Customer name is blank.' },
  { icon: 'fileCheck', k: 'What to do', v: 'Add the customer name.' },
];

export function Proof() {
  const [ref, seen] = useInView<HTMLDivElement>();
  const cols = ['A', 'B', 'C', 'D'];
  const rows = [10, 11, 12, 13, 14];
  return (
    <section className="lp-section" id="proof">
      <div className="lp-wrap">
        <Reveal as="header" className="section-head">
          <h2>Proof, not opinions</h2>
          <p>Every issue points to a real cell in your file.</p>
        </Reveal>
        <div ref={ref} className={`proof ${seen ? 'in' : ''}`}>
          <Tilt className="sheet-window" max={3}>
            <div className="sw-bar"><LIcon name="grid" size={16} /> Orders.xlsx <em>sample</em></div>
            <div className="sw-grid" aria-hidden="true">
              <span className="corner" />
              {cols.map((c) => <b key={c}>{c}</b>)}
              {rows.flatMap((r) => [
                <b key={`r${r}`}>{r}</b>,
                ...cols.map((c) => (
                  <span key={`${c}${r}`} className={c === 'B' && r === 12 ? 'hit' : r === 12 || c === 'B' ? 'scan' : ''}>
                    {!(c === 'B' && r === 12) && <i style={{ width: `${40 + ((r * 7 + c.charCodeAt(0) * 3) % 45)}%` }} />}
                  </span>
                )),
              ])}
              <span className="scanline" />
              <span className="magnifier"><LIcon name="magnifier" size={22} stroke={2} /></span>
            </div>
          </Tilt>
          <svg className="proof-line" viewBox="0 0 200 120" preserveAspectRatio="none" aria-hidden="true"><path d="M0 60 C 70 60, 80 20, 200 20" pathLength={1} /></svg>
          <Tilt className="issue-panel" max={3}>
            <div className="ip-head"><i /> Issue details</div>
            {DETAILS.map((d, i) => (
              <div key={d.k} className="ip-row" style={{ '--i': i } as CSSProperties}>
                <span><LIcon name={d.icon} size={17} /> {d.k}</span>
                <strong>{d.v}</strong>
              </div>
            ))}
          </Tilt>
          <span className="checked-badge"><LIcon name="check" size={15} stroke={2.8} /> Checked in the file</span>
        </div>
      </div>
    </section>
  );
}

const HISTORY = [
  { n: 5, v: 81, date: '16 Oct, 10:20' },
  { n: 4, v: 79, date: '15 Oct, 16:10' },
  { n: 3, v: 72, date: '14 Oct, 09:12' },
  { n: 2, v: 66, date: '13 Oct, 14:20' },
  { n: 1, v: 58, date: '12 Oct, 10:30' },
];
const verdictOf = (v: number) => (v >= 75 ? 'green' : v >= 60 ? 'amber' : 'red');
const POINTS = [...HISTORY].reverse();

/** The score rising round by round, with the history it came from. */
export function Iterate() {
  const [ref, seen] = useInView<HTMLDivElement>();
  const W = 560;
  const H = 290;
  const x = (i: number) => 52 + i * 112;
  const y = (v: number) => 250 - (v - 50) * 6.4;
  const d = POINTS.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.v)}`).join(' ');
  return (
    <section className="lp-section" id="iterate">
      <div className="lp-wrap">
        <Reveal as="header" className="section-head">
          <h2>Iterate until green</h2>
          <p>Run a check, fix what it found, then check again. Every round is saved, so you can watch the score move. <span className="sample-inline">Sample history.</span></p>
        </Reveal>
        <div ref={ref} className={`iterate ${seen ? 'in' : ''}`}>
          <Reveal className="iter-chart-shell" from="left">
            <svg viewBox={`0 0 ${W} ${H}`} className="iter-chart" role="img" aria-label="Sample: scores 58, 66, 72, 79 and 81 over five checks">
              <defs>
                <linearGradient id="iterLine" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#e0554f" /><stop offset=".45" stopColor="#e0b43c" /><stop offset="1" stopColor="#3fcf7b" /></linearGradient>
              </defs>
              <rect x="20" y={y(60)} width={W - 30} height={250 - y(60)} className="zone red" />
              <rect x="20" y={y(75)} width={W - 30} height={y(60) - y(75)} className="zone amber" />
              <rect x="20" y="20" width={W - 30} height={y(75) - 20} className="zone green" />
              <line x1="20" y1={y(75)} x2={W - 10} y2={y(75)} className="zone-line" />
              <line x1="20" y1={y(60)} x2={W - 10} y2={y(60)} className="zone-line" />
              <path d={d} className="iter-line" pathLength={1} />
              {POINTS.map((p, i) => (
                <g key={p.n} className="iter-dot" style={{ '--i': i } as CSSProperties}>
                  <circle cx={x(i)} cy={y(p.v)} r="7" className={verdictOf(p.v)} />
                  <text x={x(i)} y={y(p.v) - 16} textAnchor="middle" className="iter-val">{p.v}</text>
                  <text x={x(i)} y="272" textAnchor="middle" className="iter-x">Check {p.n}</text>
                  <text x={x(i)} y="287" textAnchor="middle" className="iter-d">{p.date.split(',')[0]}</text>
                </g>
              ))}
            </svg>
          </Reveal>
          <Reveal className="history-shell" from="right">
            <div className="history">
              <h3><LIcon name="history" size={18} /> Check history</h3>
              {HISTORY.map((h, i) => (
                <div key={h.n} className="h-row" style={{ '--i': i } as CSSProperties}>
                  <span className="h-n">{h.n}</span>
                  <b className={`h-score ${verdictOf(h.v)}`}>{h.v}</b>
                  <span className={`h-tag ${verdictOf(h.v)}`}>{verdictOf(h.v)[0]!.toUpperCase() + verdictOf(h.v).slice(1)}</span>
                  <span className="h-date">{h.date}</span>
                </div>
              ))}
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
