import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { LIcon } from './icons';
import { Reveal } from './Reveal';
import { Tilt } from './Tilt';
import { useInView, usePrefersReducedMotion } from './hooks';

const TRUST = [
  { icon: 'search', title: 'Every score has proof', text: 'Points to the exact cell' },
  { icon: 'people', title: 'Three independent Examiners', text: 'Mark on their own' },
  { icon: 'shield', title: 'Result from a fixed rule', text: 'Green, amber or red' },
  { icon: 'fileCheck', title: 'Your file is never changed', text: 'You stay in control' },
];

export function TrustStrip() {
  return (
    <section className="lp-trust" aria-label="Why you can rely on a check">
      <div className="lp-wrap">
        <Reveal className="trust-panel" from="up">
          {TRUST.map((t, i) => (
            <div key={t.title} className="trust-item" style={{ '--i': i } as React.CSSProperties}>
              <span className="tile-icon"><LIcon name={t.icon} size={24} /></span>
              <span>
                <strong>{t.title}</strong>
                <em>{t.text}</em>
              </span>
            </div>
          ))}
        </Reveal>
      </div>
    </section>
  );
}

const STEPS = [
  { icon: 'upload', title: 'Add your file and scorecard', text: 'Upload your file and a scorecard in any layout.' },
  { icon: 'people', title: 'Examiners mark it on their own', text: 'Three independent AI Examiners check the work.' },
  { icon: 'list', title: 'Final reviewer settles differences', text: 'Compares the marks and resolves any differences.' },
  { icon: 'gear', title: 'A fixed rule gives the result', text: 'You get a score, colour and a clear plan to reach green.' },
];

export function HowItWorks() {
  const [ref, seen] = useInView<HTMLDivElement>({ once: false, threshold: 0.3 });
  const reduced = usePrefersReducedMotion();
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (!seen || reduced) return;
    const t = window.setInterval(() => setActive((a) => (a + 1) % STEPS.length), 2200);
    return () => window.clearInterval(t);
  }, [seen, reduced]);
  return (
    <section className="lp-section" id="how">
      <div className="lp-wrap">
        <Reveal as="header" className="section-head">
          <p className="lp-eyebrow">A simple, clear process</p>
          <h2>How GateX works</h2>
          <p>From your file to a clear result.</p>
        </Reveal>
        <div className="lp-steps" ref={ref}>
          {STEPS.map((s, i) => (
            <div key={s.title} className="step-wrap">
              <Reveal delay={i * 130} className="step-shell">
                <Tilt className={`lp-step ${active === i && !reduced ? 'is-active' : ''}`} max={6}>
                  <span className="lp-step-n">{i + 1}</span>
                  <span className="step-icon"><LIcon name={s.icon} size={28} stroke={1.5} /></span>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                </Tilt>
              </Reveal>
              {i < STEPS.length - 1 && (
                <Reveal delay={i * 130 + 260} className="step-arrow" aria-hidden="true">
                  <svg viewBox="0 0 48 12" width="48" height="12"><path d="M0 6h42" pathLength={1} /><path d="M37 1l6 5-6 5" pathLength={1} /></svg>
                </Reveal>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const CHECKS = [
  { label: 'Required fields', at: 40 },
  { label: 'Unique IDs', at: 50 },
  { label: 'Correct counts', at: 60 },
  { label: 'Valid references', at: 70 },
  { label: 'Data types', at: 85 },
];

const BANDS = [
  { id: 'red', icon: 'close', title: 'Red', range: 'Below 60', line1: 'Needs major fixes.', line2: 'Focus on must fix issues.' },
  { id: 'amber', icon: 'alert', title: 'Amber', range: '60 to 74', line1: 'Some issues to fix.', line2: 'Follow the path to green.' },
  { id: 'green', icon: 'check', title: 'Green', range: '75 and above', line1: 'Looks good.', line2: 'Your file is ready to pass.' },
];

/** The colour bands and the score marker. It slides to 81 on its own; the visitor can drag it and watch the rule apply. */
export function ResultExplained() {
  const [ref, seen] = useInView<HTMLDivElement>();
  const reduced = usePrefersReducedMotion();
  const [value, setValue] = useState(0);
  const touched = useRef(false);
  const dragging = useRef(false);
  const bar = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!seen || touched.current) return;
    if (reduced) {
      setValue(81);
      return;
    }
    let raf = 0;
    const started = performance.now();
    const tick = (now: number) => {
      if (touched.current) return;
      const t = Math.min(1, (now - started) / 2400);
      setValue(Math.round(81 * (1 - Math.pow(1 - t, 3))));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [seen, reduced]);

  const setFromPointer = (e: PointerEvent) => {
    const r = bar.current?.getBoundingClientRect();
    if (!r) return;
    touched.current = true;
    setValue(Math.round(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100))));
  };
  const onKey = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    touched.current = true;
    setValue((v) => Math.min(100, Math.max(0, v + step * (e.shiftKey ? 5 : 1))));
  };
  const verdict = value >= 75 ? 'green' : value >= 60 ? 'amber' : 'red';
  const passed = CHECKS.filter((c) => value >= c.at).length;

  return (
    <section className="lp-section result" id="result" ref={ref}>
      <div className="lp-wrap">
        <div className="result-grid">
          <Reveal as="header" className="section-head left">
            <h2>The result, explained</h2>
            <p>A fixed rule decides the colour from the score. Drag the marker to see how.</p>
          </Reveal>
          <Reveal delay={120} className="band-wrap">
            <div
              className="band"
              ref={bar}
              role="slider"
              tabIndex={0}
              aria-label="Score"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={value}
              aria-valuetext={`${value} out of 100, ${verdict}`}
              onKeyDown={onKey}
              onPointerDown={(e) => {
                dragging.current = true;
                e.currentTarget.setPointerCapture(e.pointerId);
                setFromPointer(e);
              }}
              onPointerMove={(e) => dragging.current && setFromPointer(e)}
              onPointerUp={() => (dragging.current = false)}
              onPointerCancel={() => (dragging.current = false)}
            >
              <div className="band-track" />
              <div className="band-marker" style={{ left: `${value}%` }}>
                <span className={`band-bubble ${verdict}`}>{value}</span>
                <span className="band-knob" />
              </div>
            </div>
            <div className="band-ticks" aria-hidden="true">
              <span style={{ left: '0%' }}>0</span>
              <span style={{ left: '60%' }}>60</span>
              <span style={{ left: '75%' }}>75</span>
              <span style={{ left: '100%' }}>100</span>
            </div>
          </Reveal>
          <Reveal delay={240} from="right" className="checks-shell">
            <Tilt className="checks-card" max={4}>
              <h3>
                Key checks <span>({passed}/{CHECKS.length})</span>
              </h3>
              <ul>
                {CHECKS.map((c) => (
                  <li key={c.label} className={value >= c.at ? 'ok' : ''}>
                    <i>{value >= c.at && <LIcon name="check" size={13} stroke={2.8} />}</i>
                    <span>{c.label}</span>
                    <LIcon name="chevron" size={16} />
                  </li>
                ))}
              </ul>
            </Tilt>
          </Reveal>
        </div>
        <div className="band-cards">
          {BANDS.map((b, i) => (
            <Reveal key={b.id} delay={i * 120} className="band-card-shell">
              <Tilt className={`band-card ${b.id} ${verdict === b.id ? 'lit' : ''}`} max={6}>
                <span className="band-ico"><LIcon name={b.icon} size={22} stroke={2.2} /></span>
                <span>
                  <strong>{b.title} <em>{'—'} {b.range}</em></strong>
                  <small>{b.line1}</small>
                  <small>{b.line2}</small>
                </span>
              </Tilt>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
