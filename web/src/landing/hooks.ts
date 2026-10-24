import { useEffect, useRef, useState, type RefObject } from 'react';

/** True when the visitor asked their system for less motion. Everything animated falls back to its finished state. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => (typeof window === 'undefined' ? false : window.matchMedia('(prefers-reduced-motion: reduce)').matches));
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(query.matches);
    query.addEventListener('change', on);
    return () => query.removeEventListener('change', on);
  }, []);
  return reduced;
}

/** Becomes true (and stays true unless `once` is false) when the element scrolls into view. */
export function useInView<T extends Element>(options: { once?: boolean; margin?: string; threshold?: number } = {}): [RefObject<T | null>, boolean] {
  const { once = true, margin = '0px 0px -12% 0px', threshold = 0.1 } = options;
  const ref = useRef<T | null>(null);
  const reduced = usePrefersReducedMotion();
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (reduced) {
      setSeen(true);
      return;
    }
    const node = ref.current;
    if (!node) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        if (entry.isIntersecting) {
          setSeen(true);
          if (once) io.disconnect();
        } else if (!once) setSeen(false);
      },
      { rootMargin: margin, threshold },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [reduced, once, margin, threshold]);
  return [ref, seen];
}

/** Counts from 0 to `target` once `active` is true. */
export function useCountUp(target: number, active: boolean, duration = 1500, decimals = 0): number {
  const reduced = usePrefersReducedMotion();
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!active) {
      setValue(0);
      return;
    }
    if (reduced) {
      setValue(target);
      return;
    }
    let raf = 0;
    const started = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Number((target * eased).toFixed(decimals)));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, active, duration, decimals, reduced]);
  return value;
}

/**
 * Writes the pointer's position over an element as -1..1 into --px and --py on it, eased, so a scene can drift toward the pointer.
 * Does nothing for touch or reduced motion.
 */
export function usePointerParallax<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const reduced = usePrefersReducedMotion();
  useEffect(() => {
    const el = ref.current;
    if (!el || reduced || window.matchMedia('(pointer: coarse)').matches) return;
    let tx = 0;
    let ty = 0;
    let x = 0;
    let y = 0;
    let raf = 0;
    const tick = () => {
      x += (tx - x) * 0.07;
      y += (ty - y) * 0.07;
      el.style.setProperty('--px', x.toFixed(3));
      el.style.setProperty('--py', y.toFixed(3));
      raf = Math.abs(tx - x) + Math.abs(ty - y) > 0.002 ? requestAnimationFrame(tick) : 0;
    };
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      tx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width - 0.5) * 2));
      ty = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height - 0.5) * 2));
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const leave = () => {
      tx = 0;
      ty = 0;
      if (!raf) raf = requestAnimationFrame(tick);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', leave);
    return () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
      cancelAnimationFrame(raf);
    };
  }, [reduced]);
  return ref;
}

/** Scrolls to a y position with the browser's own smooth scrolling (native, so it follows the visitor's trackpad and system settings). */
export function scrollToY(y: number) {
  window.scrollTo({ top: y, behavior: 'smooth' });
}

export function scrollToId(id: string, offset = 72) {
  const node = document.getElementById(id);
  if (node) scrollToY(node.getBoundingClientRect().top + window.scrollY - offset);
}
