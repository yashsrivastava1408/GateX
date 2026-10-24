import { useEffect, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { LIcon } from './icons';
import { Gauge } from './Gauge';
import { GateArt, Mountains } from './Scenery';
import { Starfield } from './Starfield';
import { scrollToId, usePrefersReducedMotion } from './hooks';

const SPARKS = Array.from({ length: 8 }, (_, i) => ({ x: (i * 53 + 11) % 100, y: (i * 37 + 7) % 90, d: (i % 5) * 0.9, s: 2 + (i % 3) }));

/**
 * The picture of a check, as a place: a glowing gate with the file and scorecard going in, three Examiners marking beside it, the Final reviewer
 * settling, and the score arriving. It plays through once as the page opens and then stays settled on the result.
 */
function Scene() {
  const reduced = usePrefersReducedMotion();
  const [phase, setPhase] = useState(reduced ? 4 : 0);

  // 0 waiting, 1 examiners checking, 2 examiners done, 3 final reviewer comparing, 4 settled with the score.
  useEffect(() => {
    if (reduced) {
      setPhase(4);
      return;
    }
    const timers = ([[500, 1], [2100, 2], [2900, 3], [3700, 4]] as const).map(([ms, p]) => window.setTimeout(() => setPhase(p), ms));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [reduced]);

  const examiners = [
    { n: 1, tone: 'cyan' },
    { n: 2, tone: 'violet' },
    { n: 3, tone: 'teal' },
  ];

  return (
    <div className={`scene phase-${phase}`}>
      <GateArt settled={phase >= 4} className="scene-gate" />
      {SPARKS.map((s, i) => (
        <i key={i} className="spark" style={{ left: `${s.x}%`, top: `${s.y}%`, width: s.s, height: s.s, animationDelay: `${s.d}s` }} />
      ))}

      <div className="sc sc-file">
        <div className="sc-in">
          <span className="sc-ico green"><LIcon name="grid" size={22} /></span>
          <span><strong>Your file</strong><em>Schema.xlsx</em><small>12 sheets</small></span>
        </div>
      </div>
      <div className="sc sc-card">
        <div className="sc-in">
          <span className="sc-ico red"><LIcon name="list" size={22} /></span>
          <span><strong>Scorecard</strong><em>Quality Checklist</em><small>58 rules</small></span>
        </div>
      </div>

      {examiners.map((e) => (
        <div key={e.n} className={`sc sc-examiner sc-ex-${e.n} ${phase === 1 ? 'busy' : ''} ${phase >= 2 ? 'done' : ''}`}>
          <div className="sc-in">
            <span className={`sc-ico round ${e.tone}`}><LIcon name="spark" size={22} /></span>
            <span>
              <strong>Examiner {e.n}</strong>
              <small className="status">
                {phase < 1 ? 'Waiting' : phase === 1 ? 'Checking' : 'Done'}
                {phase === 1 && <i className="dots" aria-hidden="true"><b /><b /><b /></i>}
                {phase >= 2 && <LIcon name="check" size={12} stroke={2.6} />}
              </small>
            </span>
          </div>
        </div>
      ))}

      <div className={`sc sc-reviewer ${phase === 3 ? 'busy' : ''} ${phase >= 4 ? 'done' : ''}`}>
        <div className="sc-in">
          <span className="sc-ico round violet"><LIcon name="eye" size={22} /></span>
          <span>
            <strong>Final reviewer</strong>
            <small className="status">
              {phase < 3 ? 'Waiting' : phase === 3 ? 'Comparing marks' : 'Settled'}
              {phase === 3 && <i className="dots" aria-hidden="true"><b /><b /><b /></i>}
              {phase >= 4 && <LIcon name="check" size={12} stroke={2.6} />}
            </small>
          </span>
        </div>
      </div>

      <div className="sc sc-result">
        <Gauge value={81} active={phase >= 4} size={188} duration={1100} />
        <span className={`verdict-badge ${phase >= 4 ? 'show' : ''}`}>
          <LIcon name="check" size={16} stroke={2.6} /> Looks good
        </span>
      </div>
    </div>
  );
}

export function Hero() {
  return (
    <section className="lp-hero" id="top">
      <Starfield />
      <div className="lp-orb orb-a" />
      <div className="lp-orb orb-b" />
      <Mountains className="hero-mountains" />
      <div className="lp-wrap hero-grid">
        <div className="lp-hero-copy">
          <p className="lp-eyebrow rise" style={{ '--d': '60ms' } as CSSProperties}>Checks your work against a scorecard.</p>
          <h1 className="rise" style={{ '--d': '160ms' } as CSSProperties}>
            Know if it&rsquo;s ready <span className="grad">to pass the gate.</span>
          </h1>
          <p className="lede rise" style={{ '--d': '300ms' } as CSSProperties}>
            Upload your file and scorecard. Three AI Examiners check it, a Final reviewer settles differences, and you get a clear result with exact proof and a path to green.
          </p>
          <div className="hero-cta rise" style={{ '--d': '420ms' } as CSSProperties}>
            <Link to="/new" className="lp-btn lp-btn-primary lp-btn-lg">
              Check a file <LIcon name="arrow" size={18} stroke={2} />
            </Link>
            <button type="button" className="lp-btn lp-btn-ghost lp-btn-lg" onClick={() => scrollToId('report')}>
              See a sample report
            </button>
          </div>
          <p className="hero-note rise" style={{ '--d': '520ms' } as CSSProperties}>
            <span>Excel, CSV, PDF or text</span>
            <span>No changes to your file</span>
          </p>
        </div>
        <div className="hero-visual rise" style={{ '--d': '380ms' } as CSSProperties}>
          <Scene />
        </div>
      </div>
    </section>
  );
}
