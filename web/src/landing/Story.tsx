import { useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { CLOSE_TO_LINE } from '@ddd/shared';
import { LIcon } from './icons';
import { Reveal } from './Reveal';
import { Tilt } from './Tilt';
import { useInView } from './hooks';

const WHY = [
  {
    icon: 'lock',
    title: 'The target is fixed first',
    text: 'The scorecard is frozen and hashed before anything is marked, so the bar cannot move to suit the result.',
  },
  {
    icon: 'people',
    title: 'Not the author, and not one opinion',
    text: 'Three Examiners from different makers mark on their own. A Final reviewer settles differences. Nobody marks their own work.',
  },
  {
    icon: 'search',
    title: 'A mark you can question',
    text: 'Every mark and every issue points to a real cell or page. No place to point to, no mark.',
  },
];

/** Why a check comes first. Short and plain: the three ideas the Level 1 evaluator is built on. */
export function WhyCheck() {
  return (
    <section className="lp-section why" id="why">
      <div className="lp-wrap">
        <Reveal as="header" className="section-head">
          <p className="lp-eyebrow">The Level 1 evaluator</p>
          <h2>Check the work before anyone builds on it</h2>
          <p>GateX only evaluates. It reads your file, marks it against the scorecard and shows its proof. It never writes or fixes anything, and people keep the final call.</p>
        </Reveal>
        <div className="why-grid">
          {WHY.map((w, i) => (
            <Reveal key={w.title} delay={i * 110} className="why-shell">
              <Tilt className="why-card" max={4}>
                <span className="why-ico"><LIcon name={w.icon} size={26} stroke={1.5} /></span>
                <h3>{w.title}</h3>
                <p>{w.text}</p>
              </Tilt>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

type Box = { s: 'green' | 'amber' | 'red' | 'none' | 'frozen'; v?: number };
const BOARD: Array<{ n: string; name: string; d1: Box; d2: Box; d3: Box; d4: Box; status: 'Complete' | 'Open' | 'Not started' }> = [
  { n: '01', name: 'Requirement Analysis', d1: { s: 'green', v: 88 }, d2: { s: 'frozen' }, d3: { s: 'green', v: 91 }, d4: { s: 'frozen' }, status: 'Complete' },
  { n: '02', name: 'Stakeholders, Personas and Roles', d1: { s: 'green', v: 82 }, d2: { s: 'frozen' }, d3: { s: 'amber', v: 68 }, d4: { s: 'frozen' }, status: 'Open' },
  { n: '03', name: 'Feature Discovery', d1: { s: 'amber', v: 71 }, d2: { s: 'frozen' }, d3: { s: 'none' }, d4: { s: 'none' }, status: 'Open' },
  { n: '04', name: 'NFR Discovery', d1: { s: 'red', v: 54 }, d2: { s: 'frozen' }, d3: { s: 'none' }, d4: { s: 'none' }, status: 'Open' },
  { n: '05', name: 'Business Workflow Analysis', d1: { s: 'none' }, d2: { s: 'none' }, d3: { s: 'none' }, d4: { s: 'none' }, status: 'Not started' },
];
const WORD = { green: 'Green', amber: 'Amber', red: 'Red', frozen: 'Frozen', none: 'Not started' } as const;

function BoardBox({ box }: { box: Box }) {
  return (
    <span className={`lb-box lb-${box.s}`}>
      <b>{WORD[box.s]}</b>
      {box.v !== undefined && <small>{box.v}</small>}
    </span>
  );
}

/** The gate tracker from the Roadmap: five steps, four boxes each. Every number here is an example. */
export function StatusBoardSection() {
  const [ref, seen] = useInView<HTMLDivElement>();
  return (
    <section className="lp-section" id="board">
      <div className="lp-wrap">
        <Reveal as="header" className="section-head split">
          <div>
            <p className="lp-eyebrow">One view for everyone</p>
            <h2>The status board</h2>
            <p>Every step has four deliverables. See which are green and which are still open, without opening each report.</p>
          </div>
          <Link to="/board" className="lp-btn lp-btn-ghost">Open the board <LIcon name="arrow" size={16} stroke={2} /></Link>
        </Reveal>
        <div ref={ref} className={`lb ${seen ? 'in' : ''}`}>
          <table className="lb-table">
            <thead>
              <tr>
                <th scope="col">Step</th>
                <th scope="col">D1 · Schema design</th>
                <th scope="col">D2 · Schema scorecard</th>
                <th scope="col">D3 · Output document</th>
                <th scope="col">D4 · Output scorecard</th>
                <th scope="col">Step status</th>
              </tr>
            </thead>
            <tbody>
              {BOARD.map((r, i) => (
                <tr key={r.n} style={{ '--i': i } as CSSProperties}>
                  <th scope="row" data-label="Step"><span className="lb-n">{r.n}</span>{r.name}</th>
                  <td data-label="D1 · Schema design"><BoardBox box={r.d1} /></td>
                  <td data-label="D2 · Schema scorecard"><BoardBox box={r.d2} /></td>
                  <td data-label="D3 · Output document"><BoardBox box={r.d3} /></td>
                  <td data-label="D4 · Output scorecard"><BoardBox box={r.d4} /></td>
                  <td data-label="Step status"><span className={`lb-status ${r.status === 'Complete' ? 'ok' : r.status === 'Open' ? 'open' : ''}`}>{r.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="lb-notes">
          <li><LIcon name="check" size={14} stroke={2.8} /> D1 and D3 show the latest finished check, coloured by the score alone.</li>
          <li><LIcon name="check" size={14} stroke={2.8} /> D2 and D4 read Frozen once a scorecard has been used to check one.</li>
          <li><LIcon name="check" size={14} stroke={2.8} /> A step is Complete only when both results are green and both scorecards are frozen.</li>
        </ul>
        <small className="sample">Example board, with sample numbers.</small>
      </div>
    </section>
  );
}

type Mark = 'right' | 'wrong' | 'unclear' | null;
const MARKS: Array<[Exclude<Mark, null>, string]> = [['right', 'Right'], ['wrong', 'Wrong'], ['unclear', 'Unclear']];
const TILES = [
  { title: 'Scores close to a person', target: 'at least 90%' },
  { title: 'Same colour as a person', target: 'at least 95%' },
  { title: 'Green when a person says not green', target: '0%' },
];
const COMPARE = [
  { area: 'Tree depth', gate: 5, person: 3 },
  { area: 'Every node is defined', gate: 4, person: 4 },
  { area: 'Path ids are unique', gate: 5, person: 4 },
];

/** How GateX is held to account: people give their own marks and tick issues, and the accuracy page says "not enough data" until there are enough. */
export function PeopleProof() {
  const [mark, setMark] = useState<Mark>(null);
  const [ref, seen] = useInView<HTMLDivElement>();
  return (
    <section className="lp-section people" id="people">
      <div className="lp-wrap">
        <Reveal as="header" className="section-head">
          <p className="lp-eyebrow">Held to account</p>
          <h2>Checked against people, not just by itself</h2>
          <p>A score is only worth believing if it matches what a careful person would say. GateX gives people a place to show where it does not.</p>
        </Reveal>
        <div ref={ref} className={`people-grid ${seen ? 'in' : ''}`}>
          <div className="people-copy">
            <ol className="people-steps">
              <li><span>1</span><div><strong>A person marks the same file</strong><p>On any report, “Compare with a person” takes their own 0 to 5 mark for each area and shows the gap beside GateX’s.</p></div></li>
              <li><span>2</span><div><strong>People tick the issues</strong><p>Each issue has Right, Wrong and Unclear buttons, so wrong findings are counted, not guessed.</p></div></li>
              <li><span>3</span><div><strong>The Accuracy page adds it up</strong><p>It reports how close GateX is to people, with the target and the number of checks behind every figure. With too little data it says “Not enough data yet” instead of showing a number.</p></div></li>
            </ol>
            <p className="people-note">Targets come from the Level 1 Roadmap and are starting values for the team to confirm. Marks from an AI are kept apart and labelled, never counted as a person’s.</p>
            <Link to="/accuracy" className="lp-btn lp-btn-ghost">See the Accuracy page <LIcon name="arrow" size={16} stroke={2} /></Link>
          </div>
          <div className="people-demo">
            <Tilt className="pd-card" max={3}>
              <div className="pd-head"><LIcon name="scale" size={18} /> Accuracy <em>Example screen</em></div>
              <div className="pd-tiles">
                {TILES.map((t) => (
                  <div key={t.title} className="pd-tile">
                    <strong>{t.title}</strong>
                    <span className="pd-pill">Not enough data yet</span>
                    <small>Target {t.target}</small>
                  </div>
                ))}
              </div>
              <div className="pd-sub">Compare with a person</div>
              <div className="pd-table" role="table" aria-label="Example: GateX and a person, side by side">
                <div className="pd-row pd-th" role="row"><span role="columnheader">Area</span><span role="columnheader">GateX</span><span role="columnheader">Person</span><span role="columnheader">Gap</span></div>
                {COMPARE.map((c) => (
                  <div key={c.area} className="pd-row" role="row">
                    <span role="cell">{c.area}</span><span role="cell">{c.gate}</span><span role="cell">{c.person}</span>
                    <span role="cell" className={Math.abs(c.gate - c.person) > 1 ? 'gap big' : 'gap'}>{Math.abs(c.gate - c.person)}</span>
                  </div>
                ))}
              </div>
              <div className="pd-sub">Is this issue right?</div>
              <p className="pd-issue">“Customer name is blank” <code>Sheet1!B12</code></p>
              <div className="pd-marks" role="group" aria-label="Example: mark this issue">
                {MARKS.map(([id, label]) => (
                  <button key={id} type="button" className={`pd-mark ${id} ${mark === id ? 'on' : ''}`} aria-pressed={mark === id} onClick={() => setMark(mark === id ? null : id)}>{label}</button>
                ))}
              </div>
            </Tilt>
          </div>
        </div>
      </div>
    </section>
  );
}

/** The colour line a score is close to (within CLOSE_TO_LINE points of 75 or 60), or null when it is not close to either. */
export function closeLineFor(value: number): 75 | 60 | null {
  return Math.abs(value - 75) <= CLOSE_TO_LINE ? 75 : Math.abs(value - 60) <= CLOSE_TO_LINE ? 60 : null;
}

/** A short plain note under the colour bar: what GateX does near a colour line. */
export function CloseToLineNote({ value }: { value: number }) {
  const line = closeLineFor(value);
  return (
    <p className={`close-note ${line ? 'on' : ''}`} aria-live="polite">
      {line
        ? `Close to the ${line} line: the report would show “about ${Math.max(0, Math.round(value - 2))} to ${Math.min(100, Math.round(value + 2))}”, because the same file can move a little between checks. The colour still comes from the score alone.`
        : `Within ${CLOSE_TO_LINE} points of 60 or 75, the report also gives a range, because the same file can move a little between checks. The colour still comes from the score alone.`}
    </p>
  );
}
