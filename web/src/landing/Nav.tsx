import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { LIcon } from './icons';
import { scrollToId, scrollToY } from './hooks';

const LINKS: Array<[string, string]> = [
  ['How it works', 'how'],
  ['What you get', 'report'],
  ['Scorecards', 'scorecards'],
  ['FAQ', 'faq'],
];

export function Wordmark({ size = 30 }: { size?: number }) {
  return (
    <span className="wordmark" style={{ fontSize: size }}>
      Gate<span>X</span>
    </span>
  );
}

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const bar = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const on = () => {
      setScrolled(window.scrollY > 24);
      const max = document.documentElement.scrollHeight - window.innerHeight;
      bar.current?.style.setProperty('--p', max > 0 ? Math.min(1, window.scrollY / max).toFixed(4) : '0');
    };
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  const go = (id: string) => {
    setOpen(false);
    scrollToId(id);
  };
  return (
    <header className={`lp-nav ${scrolled ? 'scrolled' : ''} ${open ? 'open' : ''}`}>
      <div className="lp-wrap lp-nav-row">
        <button type="button" className="lp-brand" aria-label="GateX, back to the top" onClick={() => scrollToY(0)}>
          <Wordmark />
        </button>
        <nav className="lp-links" aria-label="Page sections">
          {LINKS.map(([label, id]) => (
            <button key={id} type="button" onClick={() => go(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="lp-nav-actions">
          <button type="button" className="lp-btn lp-btn-ghost" onClick={() => go('report')}>
            See a sample report
          </button>
          <Link to="/new" className="lp-btn lp-btn-primary">
            Check a file
          </Link>
        </div>
        <button type="button" className="lp-burger" aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <LIcon name={open ? 'close' : 'menu'} size={24} />
        </button>
      </div>
      <span className="lp-progress" ref={bar} aria-hidden="true" />
      <div className="lp-mobile-menu" aria-hidden={!open}>
        {LINKS.map(([label, id]) => (
          <button key={id} type="button" onClick={() => go(id)} tabIndex={open ? 0 : -1}>
            {label}
          </button>
        ))}
        <Link to="/projects" tabIndex={open ? 0 : -1}>
          Open the dashboard
        </Link>
        <Link to="/new" className="lp-btn lp-btn-primary" tabIndex={open ? 0 : -1}>
          Check a file
        </Link>
      </div>
    </header>
  );
}
