import { useEffect } from 'react';
import { Nav } from '../landing/Nav';
import { Hero } from '../landing/Hero';
import { FixFirst, ReportShowcase } from '../landing/Report';
import { HowItWorks, ResultExplained, TrustStrip } from '../landing/Process';
import { AnyScorecard, Iterate, PathToGreen, Proof } from '../landing/Lower';
import { Faq, FinalCta, Footer } from '../landing/Closing';
import '../styles/landing.css';

/** The first page a visitor sees: what GateX does, shown rather than told. The dashboard lives at /projects. */
export function LandingPage() {
  useEffect(() => {
    const previous = document.title;
    document.title = 'GateX · Checks your work against a scorecard';
    return () => {
      document.title = previous;
    };
  }, []);
  return (
    <div className="lp">
      <Nav />
      <main>
        <Hero />
        <TrustStrip />
        <HowItWorks />
        <ResultExplained />
        <ReportShowcase />
        <FixFirst />
        <PathToGreen />
        <AnyScorecard />
        <Proof />
        <Iterate />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
