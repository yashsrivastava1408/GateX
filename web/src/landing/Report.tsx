import { useState, type CSSProperties } from 'react';
import { LIcon } from './icons';
import { Reveal } from './Reveal';
import { Tilt } from './Tilt';
import { useInView, usePointerParallax } from './hooks';

const FEATURES = [
  { icon: 'doc', title: 'Executive summary', text: 'Clear overview' },
  { icon: 'grid', title: 'Scores by area', text: 'Detailed breakdown' },
  { icon: 'alert', title: 'Issues by priority', text: 'What to fix first' },
  { icon: 'gauge', title: 'Path to green', text: 'Smallest set of fixes' },
];

function PageSummary() {
  return (
    <div className="pg">
      <b className="pg-h">Executive summary</b>
      <span className="pg-line" /><span className="pg-line" /><span className="pg-line short" />
      <span className="pg-chip"><i />Must fix 5</span>
      <span className="pg-line" /><span className="pg-line short" /><span className="pg-line" />
    </div>
  );
}
function PageBars() {
  const rows = [86, 64, 92, 48, 74, 58, 80, 70];
  return (
    <div className="pg">
      <b className="pg-h">Score by area</b>
      {rows.map((w, i) => (
        <span key={i} className="pg-bar"><i style={{ width: `${w}%`, background: w < 55 ? '#cc4440' : w < 70 ? '#e0971e' : '#4f6dff' }} /></span>
      ))}
    </div>
  );
}
function PageCover() {
  return (
    <div className="pg pg-cover">
      <b className="pg-logo">Gate<span>X</span></b>
      <i className="pg-title">Quality Review Report</i>
      <svg viewBox="0 0 120 120" className="pg-ring" aria-hidden="true">
        <circle cx="60" cy="60" r="44" fill="none" stroke="rgba(120,130,200,.25)" strokeWidth="9" />
        <circle cx="60" cy="60" r="44" fill="none" stroke="url(#coverGrad)" strokeWidth="9" strokeLinecap="round" strokeDasharray="224 276" transform="rotate(-90 60 60)" />
        <defs><linearGradient id="coverGrad" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stopColor="#19b5c4" /><stop offset=".6" stopColor="#2fa05a" /><stop offset="1" stopColor="#e0b43c" /></linearGradient></defs>
      </svg>
      <strong className="pg-score">81</strong>
      <small className="pg-sub">out of 100</small>
      <span className="pg-badge"><LIcon name="check" size={9} stroke={3} /> Looks good</span>
    </div>
  );
}
function PageIssues() {
  return (
    <div className="pg">
      <b className="pg-h">Issues by priority</b>
      <svg viewBox="0 0 120 120" className="pg-donut" aria-hidden="true">
        <circle cx="60" cy="60" r="38" fill="none" stroke="#cc4440" strokeWidth="18" strokeDasharray="50 239" transform="rotate(-90 60 60)" />
        <circle cx="60" cy="60" r="38" fill="none" stroke="#e0971e" strokeWidth="18" strokeDasharray="120 239" strokeDashoffset="-50" transform="rotate(-90 60 60)" />
        <circle cx="60" cy="60" r="38" fill="none" stroke="#4f8bd6" strokeWidth="18" strokeDasharray="69 239" strokeDashoffset="-170" transform="rotate(-90 60 60)" />
      </svg>
      <strong className="pg-donut-n">24</strong>
      <small className="pg-donut-l">issues</small>
      <ul className="pg-legend">
        <li><i style={{ background: '#cc4440' }} />Must fix <b>5</b></li>
        <li><i style={{ background: '#e0971e' }} />Should fix <b>12</b></li>
        <li><i style={{ background: '#4f8bd6' }} />Nice to fix <b>7</b></li>
      </ul>
    </div>
  );
}
function PagePath() {
  return (
    <div className="pg">
      <b className="pg-h">Path to green</b>
      <div className="pg-cols">
        {[34, 44, 56, 72, 88].map((h, i) => <i key={i} style={{ height: `${h}%`, background: i === 4 ? '#2fa05a' : '#19b5c4' }} />)}
      </div>
    </div>
  );
}

type Format = 'pdf' | 'xlsx' | 'md';
const PAGES = [PageSummary, PageBars, PageCover, PageIssues, PagePath];

export function ReportShowcase() {
  const [stage, open] = useInView<HTMLDivElement>({ margin: '0px 0px 0px 0px', threshold: 0.03 });
  const parallax = usePointerParallax<HTMLDivElement>();
  const [format, setFormat] = useState<Format>('pdf');

  return (
    <section className="lp-section report" id="report">
      <div className="lp-wrap">
        <Reveal as="header" className="section-head">
          <p className="lp-eyebrow">A clear, visual report</p>
          <h2>The report you get</h2>
          <p>A designed report with exact proof, charts and a path to green.</p>
        </Reveal>
        <Reveal className="format-buttons" role="tablist" aria-label="Report format">
          {([['pdf', 'PDF Report', 'doc'], ['xlsx', 'Excel File', 'grid'], ['md', 'Markdown', 'list']] as const).map(([id, label, icon]) => (
            <button key={id} type="button" role="tab" aria-selected={format === id} className={`format-btn ${format === id ? 'is-on' : ''}`} onClick={() => setFormat(id)}>
              <span className="format-ico"><LIcon name={icon} size={20} /></span> {label}
            </button>
          ))}
        </Reveal>

        <div className="report-stage-wrap" ref={parallax}>
          <div className={`report-stage ${open ? 'open' : ''}`} ref={stage}>
            <div className="stage-floor" aria-hidden="true" />
            <div className={`stage-pane ${format === 'pdf' ? 'show' : ''}`}>
              {PAGES.map((Page, i) => {
                const k = i - 2;
                const a = Math.abs(k);
                return (
                  <div
                    key={i}
                    className={`lp-page ${k === 0 ? 'center' : ''}`}
                    style={{
                      '--tx': `${k * 52}%`,
                      '--ty': `${-a * 6}px`,
                      '--tz': `${k === 0 ? 60 : -a * 70}px`,
                      '--ry': `${-k * 15}deg`,
                      '--sc': k === 0 ? 1.2 : 1 - a * 0.05,
                      '--z': 10 - a,
                      '--dl': `${a * 140}ms`,
                    } as CSSProperties}
                  >
                    <Page />
                  </div>
                );
              })}
            </div>
            <div className={`stage-pane ${format === 'xlsx' ? 'show' : ''}`}>
              <div className="sheet-preview">
                {['Area', 'Score', 'Issues', 'Status'].map((h) => <b key={h}>{h}</b>)}
                {[['Required fields', '5/5', '0', 'Pass'], ['Unique IDs', '4/5', '2', 'Pass'], ['Valid references', '3/5', '5', 'Fix'], ['Data types', '2/5', '9', 'Fix'], ['Format', '4/5', '3', 'Pass']].flatMap((row, r) =>
                  row.map((cell, c) => <span key={`${r}-${c}`} className={c === 3 ? (cell === 'Pass' ? 'g' : 'a') : ''}>{cell}</span>),
                )}
              </div>
            </div>
            <div className={`stage-pane ${format === 'md' ? 'show' : ''}`}>
              <div className="md-preview">
                <p><b># GateX report</b></p>
                <p>GREEN - Looks good | Score 81 out of 100</p>
                <p><b>## What this means</b></p>
                <p>- The score is in the green range.</p>
                <p>- 5 must-fix issues need attention.</p>
                <p><b>## Fix first</b></p>
                <p>- Issue 1: Missing required field</p>
                <p>- Issue 2: Invalid reference</p>
              </div>
            </div>
          </div>
        </div>

        <div className="feature-row">
          {FEATURES.map((f, i) => (
            <Reveal key={f.title} delay={i * 90} className={`feature ${open ? 'is-on' : ''}`}>
              <span className="feature-ico"><LIcon name={f.icon} size={20} /></span>
              <span><strong>{f.title}</strong><em>{f.text}</em></span>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

type Tone = 'red' | 'amber' | 'blue';
const FIXES: Array<{ tone: Tone; label: string; icon: string; title: string; where: string; text: string; fix: string }> = [
  { tone: 'red', label: 'Must fix', icon: 'alert', title: 'Missing required field', where: 'Sheet1!B12', text: 'Customer name is blank.', fix: 'Add the customer name.' },
  { tone: 'amber', label: 'Should fix', icon: 'link', title: 'Invalid reference', where: 'Data!D45', text: 'Reference points to an empty cell.', fix: 'Update the reference.' },
  { tone: 'blue', label: 'Nice to fix', icon: 'doc', title: 'Inconsistent format', where: 'Data!F8', text: 'Date format is not consistent.', fix: 'Use YYYY-MM-DD format.' },
  { tone: 'amber', label: 'Should fix', icon: 'gear', title: 'Duplicate ID', where: 'Sheet2!C18', text: 'Repeated customer ID found.', fix: 'Keep unique IDs.' },
];
const FILTERS: Array<{ id: 'all' | Tone; label: string }> = [
  { id: 'all', label: 'All (24)' },
  { id: 'red', label: 'Must fix (5)' },
  { id: 'amber', label: 'Should fix (12)' },
  { id: 'blue', label: 'Nice to fix (7)' },
];

export function FixFirst() {
  const [filter, setFilter] = useState<'all' | Tone>('all');
  return (
    <section className="lp-section" id="fix">
      <div className="lp-wrap">
        <div className="fix-head">
          <Reveal as="header" className="section-head left">
            <h2>What to fix first</h2>
            <p>Clear, prioritised issues with exact locations.</p>
          </Reveal>
          <Reveal delay={100} className="chips" role="tablist" aria-label="Filter issues">
            {FILTERS.map((f) => (
              <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={`chip ${f.id} ${filter === f.id ? 'is-on' : ''}`} onClick={() => setFilter(f.id)}>
                {f.label}
              </button>
            ))}
          </Reveal>
        </div>
        <div className="fix-list">
          {FIXES.map((f, i) => (
            <div key={f.title} className={`fix-row-shell ${filter === 'all' || filter === f.tone ? 'show' : ''}`}>
              <div>
                <Reveal delay={i * 110} className="fix-reveal">
                  <Tilt className={`fix-row ${f.tone}`} max={3}>
                    <span className="fix-ico"><LIcon name={f.icon} size={26} /></span>
                    <div className="fix-main">
                      <span className="fix-tag">{f.label}</span>
                      <h3>{f.title}</h3>
                      <code>{f.where}</code>
                      <p>{f.text}</p>
                    </div>
                    <div className="fix-do">
                      <i />
                      <span><em>What to do</em>{f.fix}</span>
                      <LIcon name="chevron" size={18} />
                    </div>
                  </Tilt>
                </Reveal>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
