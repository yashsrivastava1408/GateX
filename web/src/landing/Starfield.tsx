import { useEffect, useRef } from 'react';
import { usePrefersReducedMotion } from './hooks';

/** A quiet field of twinkling stars behind the hero. It drifts a little as the page scrolls and stops when it is off screen. */
export function Starfield() {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const reduced = usePrefersReducedMotion();
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let w = 0;
    let h = 0;
    let raf = 0;
    let visible = true;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const stars = Array.from({ length: 80 }, () => ({ x: Math.random(), y: Math.random(), r: Math.random() * 1.3 + 0.25, a: Math.random() * Math.PI * 2, s: Math.random() * 0.02 + 0.006, depth: Math.random() * 0.8 + 0.2 }));
    const resize = () => {
      const box = canvas.parentElement?.getBoundingClientRect();
      w = box?.width ?? window.innerWidth;
      h = box?.height ?? 700;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    let lastDraw = 0;
    const draw = (now = 0) => {
      if (!reduced && now - lastDraw < 33 && lastDraw !== 0) {
        raf = requestAnimationFrame(draw);
        return;
      }
      lastDraw = now || 1;
      ctx.clearRect(0, 0, w, h);
      const shift = window.scrollY * 0.08;
      for (const s of stars) {
        s.a += s.s;
        const alpha = reduced ? 0.55 : 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(s.a));
        ctx.fillStyle = `rgba(190,200,255,${alpha})`;
        ctx.beginPath();
        ctx.arc(s.x * w, ((s.y * h - shift * s.depth) % h + h) % h, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      if (!reduced && visible) raf = requestAnimationFrame(draw);
    };
    resize();
    draw();
    const io = new IntersectionObserver(([e]) => {
      visible = Boolean(e?.isIntersecting);
      if (visible && !reduced) {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(draw);
      }
    });
    io.observe(canvas);
    window.addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, [reduced]);
  return <canvas ref={ref} className="lp-stars" aria-hidden="true" />;
}
