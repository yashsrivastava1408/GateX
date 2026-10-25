import type { CSSProperties } from 'react';
import { LIcon } from './icons';
import { Reveal } from './Reveal';
import { useInView } from './hooks';

const CHECKED = [
  'Required fields', 'Unique IDs', 'Counts that add up', 'References that point somewhere', 'Totals and tallies', 'Wording and labels',
  'Data types', 'Duplicates', 'Blank cells', 'Formats',
];

/** A slow, endless strip of what GateX looks at. Pauses on hover; with reduced motion it is a still, wrapped list. */
export function Marquee() {
  return (
    <section className="lp-marquee" aria-label="What GateX checks">
      <p className="lp-eyebrow">What it looks at</p>
      <div className="marquee-mask">
        <ul className="marquee-track">
          {[0, 1].map((copy) =>
            CHECKED.map((c) => (
              <li key={`${copy}-${c}`} aria-hidden={copy === 1 ? true : undefined}>
                <i aria-hidden="true" />
                {c}
              </li>
            )),
          )}
        </ul>
      </div>
    </section>
  );
}

const CONFIRMED = [
  { title: 'Customer name is blank', where: 'Sheet1!B12', how: 'Found by an exact check of the file' },
  { title: 'Total does not match the rows', where: 'Orders!F40', how: 'Raised by two Examiners' },
  { title: 'Reference points to an empty cell', where: 'Data!D45', how: 'Proved by the cells it names' },
];
const LOOK = [
  { title: 'Label wording may be unclear', where: 'Notes!A3', how: 'One Examiner only, not provable' },
  { title: 'Date style differs from the rest', where: 'Orders!C9', how: 'One Examiner only, not provable' },
];

/** The two lists in a report: issues GateX stands behind, and a quieter list to glance at. They appear one by one. */
export function Tiers() {
  const [ref, seen] = useInView<HTMLDivElement>();
  return (
    <section className="lp-section tiers-section" aria-labelledby="tiers-h">
      <div className="lp-wrap">
        <Reveal as="header" className="section-head">
          <h2 id="tiers-h">Sure first, then worth a look</h2>
          <p>Issues GateX can stand behind come first. Single, unproven hunches are kept apart so they never crowd the list.</p>
        </Reveal>
        <div ref={ref} className={`tiers ${seen ? 'in' : ''}`}>
          <div className="tier tier-sure">
            <h3><span className="tier-ico"><LIcon name="check" size={16} stroke={2.8} /></span> Confirmed <em>{CONFIRMED.length}</em></h3>
            <ul>
              {CONFIRMED.map((c, i) => (
                <li key={c.title} style={{ '--i': i } as CSSProperties}>
                  <strong>{c.title}</strong>
                  <span>{c.where}</span>
                  <small>{c.how}</small>
                </li>
              ))}
            </ul>
          </div>
          <div className="tier tier-look">
            <h3><span className="tier-ico"><LIcon name="eye" size={16} stroke={2.2} /></span> Worth a look <em>{LOOK.length}</em></h3>
            <ul>
              {LOOK.map((c, i) => (
                <li key={c.title} style={{ '--i': i + CONFIRMED.length } as CSSProperties}>
                  <strong>{c.title}</strong>
                  <span>{c.where}</span>
                  <small>{c.how}</small>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <small className="sample">Sample issues</small>
      </div>
    </section>
  );
}
