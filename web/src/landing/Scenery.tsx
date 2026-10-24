import { useId, useMemo } from 'react';

/** A small seeded random, so the mountains are the same on every visit and on the server. */
function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function ridge(seed: number, base: number, amp: number, step = 46, width = 1440) {
  const rnd = seeded(seed);
  const pts: Array<[number, number]> = [[0, base]];
  for (let x = 0; x <= width + step; x += step) {
    const peak = Math.sin((x / width) * Math.PI * 2.4 + seed) * amp * 0.45 + rnd() * amp * 0.75;
    pts.push([x, base - peak]);
  }
  pts.push([width, 400], [0, 400]);
  return pts;
}

/** Layered mountains with a lit ridge line, drawn behind the hero and the closing call to action. */
export function Mountains({ className = '' }: { className?: string }) {
  const id = useId().replace(/:/g, '');
  const layers = useMemo(
    () => [
      { pts: ridge(7, 210, 120), fill: `url(#${id}b)`, stroke: 'rgba(150,120,255,.55)', w: 1.4, blur: true },
      { pts: ridge(19, 270, 100), fill: `url(#${id}m)`, stroke: 'rgba(170,140,255,.75)', w: 1.6, blur: true },
      { pts: ridge(31, 330, 70), fill: `url(#${id}f)`, stroke: 'rgba(190,170,255,.35)', w: 1, blur: false },
    ],
    [id],
  );
  const path = (pts: Array<[number, number]>) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(0)},${y.toFixed(0)}`).join(' ') + ' Z';
  const line = (pts: Array<[number, number]>) => pts.slice(1, -2).map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(0)},${y.toFixed(0)}`).join(' ');
  return (
    <svg className={`mountains ${className}`} viewBox="0 0 1440 400" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#3b2a8c" stopOpacity=".9" /><stop offset="1" stopColor="#120a35" /></linearGradient>
        <linearGradient id={`${id}m`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#261a68" /><stop offset="1" stopColor="#0b0724" /></linearGradient>
        <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#120c33" /><stop offset="1" stopColor="#05040f" /></linearGradient>
      </defs>
      {layers.map((l, i) => (
        <g key={i}>
          <path d={path(l.pts)} fill={l.fill} />
          {l.blur && <path d={line(l.pts)} fill="none" stroke={l.stroke} strokeWidth={l.w + 5} opacity=".22" />}
          <path d={line(l.pts)} fill="none" stroke={l.stroke} strokeWidth={l.w} />
        </g>
      ))}
    </svg>
  );
}

/** The glowing doorway the page is named after. `settled` turns its light from violet to green once a check has passed. */
export function GateArt({ settled = false, steps = false, className = '' }: { settled?: boolean; steps?: boolean; className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className={`gate-art ${settled ? 'settled' : ''} ${className}`} viewBox="0 0 400 480" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}s`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#46d3ff" /><stop offset=".5" stopColor="#7d8bff" /><stop offset="1" stopColor="#b07bff" /></linearGradient>
        <linearGradient id={`${id}ok`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#46e0b4" /><stop offset=".5" stopColor="#56c9ff" /><stop offset="1" stopColor="#8f8bff" /></linearGradient>
        <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#8a7bff" stopOpacity=".45" /><stop offset="1" stopColor="#3c2ba8" stopOpacity="0" /></linearGradient>
        <filter id={`${id}glow`} x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="9" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        <radialGradient id={`${id}floor`} cx=".5" cy=".5" r=".5"><stop offset="0" stopColor="#8f7bff" stopOpacity=".6" /><stop offset="1" stopColor="#8f7bff" stopOpacity="0" /></radialGradient>
      </defs>
      <ellipse className="gate-floor" cx="200" cy="452" rx="190" ry="26" fill={`url(#${id}floor)`} />
      <path className="gate-fill" d="M70 450 V170 L130 70 H270 L330 170 V450 Z" fill={`url(#${id}f)`} />
      <g filter={`url(#${id}glow)`}>
        <path className="gate-frame outer" pathLength={1} d="M50 456 V160 L122 46 H278 L350 160 V456" fill="none" stroke={`url(#${settled ? `${id}ok` : `${id}s`})`} strokeWidth="7" strokeLinejoin="round" strokeLinecap="round" />
        <path className="gate-frame inner" pathLength={1} d="M84 456 V176 L142 84 H258 L316 176 V456" fill="none" stroke={`url(#${settled ? `${id}ok` : `${id}s`})`} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" opacity=".7" />
      </g>
      {steps && [0, 1, 2, 3, 4].map((i) => <path key={i} className="gate-step" style={{ ['--i' as string]: i }} d={`M${96 - i * 10} ${458 + i * 5} H${304 + i * 10}`} stroke="#9a8bff" strokeOpacity={0.55 - i * 0.08} strokeWidth="5" strokeLinecap="round" />)}
    </svg>
  );
}
