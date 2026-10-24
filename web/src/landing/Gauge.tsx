import { useCountUp } from './hooks';

/** The score ring: the arc draws clockwise and the number counts up while `active`. */
export function Gauge({ value, active, size = 220, label = 'out of 100', duration = 1800 }: { value: number; active: boolean; size?: number; label?: string; duration?: number }) {
  const shown = useCountUp(value, active, duration, 0);
  const r = 86;
  const c = 2 * Math.PI * r;
  const arc = c * 0.75; // a 270 degree ring, open at the bottom
  const filled = arc * (shown / 100);
  return (
    <div className="gauge" style={{ width: size, height: size }}>
      <svg viewBox="0 0 200 200" width={size} height={size} aria-hidden="true">
        <defs>
          <linearGradient id="gaugeGrad" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stopColor="#19b5c4" />
            <stop offset="0.35" stopColor="#2fa05a" />
            <stop offset="0.65" stopColor="#e0b43c" />
            <stop offset="1" stopColor="#a06bff" />
          </linearGradient>
        </defs>
        <g transform="rotate(135 100 100)">
          <circle cx="100" cy="100" r={r} fill="none" stroke="rgba(150,160,255,.14)" strokeWidth="13" strokeLinecap="round" strokeDasharray={`${arc} ${c}`} />
          <circle cx="100" cy="100" r={r} fill="none" stroke="url(#gaugeGrad)" strokeWidth="13" strokeLinecap="round" strokeDasharray={`${filled} ${c}`} className="gauge-arc" />
        </g>
      </svg>
      <div className="gauge-text">
        <strong>{active ? shown : '\u2013\u2013'}</strong>
        <span>{active ? label : 'checking'}</span>
      </div>
    </div>
  );
}
