import { useEffect, useState } from 'react';
import type { Decision } from '@ddd/shared';

const TONE: Record<Decision, string> = { green: 'var(--green)', amber: 'var(--amber)', red: 'var(--red)' };

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** True shortly after mounting, so a CSS transition has a starting point to animate from. */
function useMounted(): boolean {
  const [on, setOn] = useState(reducedMotion());
  useEffect(() => {
    if (on) return;
    const timer = setTimeout(() => setOn(true), 40);
    return () => clearTimeout(timer);
  }, [on]);
  return on;
}

/** Counts a number up to its target, easing out, and lands exactly on the target. */
function useCountUp(target: number, ms = 1000): number {
  const [value, setValue] = useState(reducedMotion() ? target : 0);
  useEffect(() => {
    if (reducedMotion()) {
      setValue(target);
      return;
    }
    const step = 20;
    const steps = Math.max(1, Math.round(ms / step));
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      setValue(i >= steps ? target : target * (1 - Math.pow(1 - i / steps, 3)));
      if (i >= steps) clearInterval(timer);
    }, step);
    return () => clearInterval(timer);
  }, [target, ms]);
  return value;
}

/** The weighted score as a ring, coloured by the decision. It draws itself in and counts up. */
export function ScoreRing({ score, decision, size = 124 }: { score: number; decision: Decision; size?: number }) {
  const stroke = 10;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const mounted = useMounted();
  const shown = useCountUp(score);
  const filled = mounted ? (Math.max(0, Math.min(100, score)) / 100) * circumference : 0;
  return (
    <div className="ring" style={{ width: size, height: size }} role="img" aria-label={`Score ${score} out of 100, ${decision}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <defs>
          <filter id="score-ring-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="rgba(255, 255, 255, 0.06)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={TONE[decision]}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference - filled}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          className="ring-arc"
          filter="url(#score-ring-glow)"
        />
      </svg>
      <div className="ring-text">
        <span className="ring-score">{shown.toFixed(1)}</span>
        <span className="ring-of">of 100</span>
      </div>
    </div>
  );
}

/** A 0-100 track with the refine and accept thresholds marked and the score on it. */
export function ThresholdBar({ score, refine, accept, decision, range }: { score: number; refine: number; accept: number; decision: Decision; range?: { low: number; high: number } }) {
  const at = (v: number) => `${Math.max(0, Math.min(100, v))}%`;
  const mounted = useMounted();
  return (
    <div className="threshold" aria-hidden="true">
      <div className="threshold-track">
        <span className="threshold-zone zone-red" style={{ width: at(refine) }} />
        <span className="threshold-zone zone-amber" style={{ left: at(refine), width: at(accept - refine) }} />
        <span className="threshold-zone zone-green" style={{ left: at(accept), width: at(100 - accept) }} />
        {range && <span className="threshold-range" style={{ left: at(range.low), width: at(range.high - range.low) }} />}
        <span className="threshold-marker" style={{ left: mounted ? at(score) : '0%', background: TONE[decision], color: TONE[decision] }} />
      </div>
      <div className="threshold-labels">
        <span style={{ left: '0%' }}>0</span>
        <span style={{ left: at(refine) }}>{refine}</span>
        <span style={{ left: at(accept) }}>{accept}</span>
        <span style={{ left: '100%' }}>100</span>
      </div>
    </div>
  );
}
