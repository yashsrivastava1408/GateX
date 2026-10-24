import { useState } from 'react';
import { Link } from 'react-router-dom';
import { LIcon } from './icons';
import { Reveal } from './Reveal';
import { Wordmark } from './Nav';
import { GateArt, Mountains } from './Scenery';
import { scrollToId, scrollToY } from './hooks';

const FAQ = [
  { q: 'What do I need to start?', a: 'A file to check (Excel, CSV or PDF) and a scorecard. The scorecard can be in any layout: Excel, CSV, PDF or plain text. GateX converts it for you the first time and reuses it every time after.' },
  { q: 'Who decides green, amber or red?', a: 'A fixed rule decides, from the score: below 60 is red, 60 to 74 is amber and 75 and above is green. No AI picks the colour.' },
  { q: 'Do the Examiners see each other’s marks?', a: 'No. Each Examiner marks on its own and sees only the scorecard and your file. The Final reviewer then compares the three sets of marks and settles any difference.' },
  { q: 'Does GateX change my file?', a: 'Never. GateX only reads your file, and checks afterwards that it is exactly the same as when it started.' },
  { q: 'How do I know a score is fair?', a: 'Every score and every issue points to a real cell in your file. If an Examiner cannot show where, that point is dropped. Code also counts what can be counted exactly, such as blank cells and repeated IDs.' },
  { q: 'What do I get at the end?', a: 'A result with a score and colour, the issues in priority order (Must fix, Should fix, Nice to fix), a path to green, and a report as a designed PDF, an Excel file and a Markdown file.' },
  { q: 'Can I check again after I fix things?', a: 'Yes. Every check is saved in the project history, so you can see the score rise with each round until it is green.' },
];

export function Faq() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <section className="lp-section faq" id="faq">
      <div className="lp-wrap faq-wrap">
        <Reveal as="header" className="section-head">
          <h2>Questions, answered</h2>
          <p>Short, plain answers.</p>
        </Reveal>
        <div className="faq-list">
          {FAQ.map((item, i) => (
            <Reveal key={item.q} delay={i * 60} className={`faq-item ${open === i ? 'open' : ''}`}>
              <button type="button" aria-expanded={open === i} aria-controls={`faq-${i}`} onClick={() => setOpen(open === i ? null : i)}>
                <span>{item.q}</span>
                <LIcon name="chevron" size={20} />
              </button>
              <div className="faq-body" id={`faq-${i}`} role="region">
                <div><p>{item.a}</p></div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

export function FinalCta() {
  return (
    <section className="lp-section cta">
      <Mountains className="cta-mountains" />
      <div className="lp-wrap cta-grid">
        <Reveal from="left" className="cta-art">
          <GateArt steps settled />
        </Reveal>
        <Reveal from="right" className="cta-copy">
          <p className="lp-eyebrow">Get a clear result</p>
          <h2>Ready to see if <span className="grad">it passes?</span></h2>
          <p>Upload your file and scorecard and get a clear result with exact proof and a path to green.</p>
          <div className="hero-cta">
            <Link to="/new" className="lp-btn lp-btn-primary lp-btn-lg">
              Check a file <LIcon name="arrow" size={18} stroke={2} />
            </Link>
            <Link to="/projects" className="lp-btn lp-btn-ghost lp-btn-lg">
              Open the dashboard
            </Link>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="lp-footer">
      <div className="lp-wrap footer-row">
        <div>
          <Wordmark size={26} />
          <p>Checks your work against a scorecard.</p>
        </div>
        <nav aria-label="Footer">
          <button type="button" onClick={() => scrollToId('how')}>How it works</button>
          <button type="button" onClick={() => scrollToId('report')}>What you get</button>
          <button type="button" onClick={() => scrollToId('scorecards')}>Scorecards</button>
          <button type="button" onClick={() => scrollToId('faq')}>FAQ</button>
          <Link to="/projects">Dashboard</Link>
          <button type="button" onClick={() => scrollToY(0)}>Back to top</button>
        </nav>
      </div>
      <div className="lp-wrap footer-small">GateX advises. You make the final call. &copy; {new Date().getFullYear()} GateX.</div>
    </footer>
  );
}
