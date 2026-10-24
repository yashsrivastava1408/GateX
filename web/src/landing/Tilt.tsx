import { useRef, type ElementType, type PointerEvent, type ReactNode } from 'react';
import { usePrefersReducedMotion } from './hooks';

/**
 * A card that leans toward the pointer and catches a soft light where it is touched. Mouse only: touch and reduced-motion visitors get a still card.
 * The lean is set through CSS variables (--rx, --ry, --mx, --my) so React never re-renders while the pointer moves.
 */
export function Tilt({
  children,
  className = '',
  max = 7,
  glare = true,
  as: Tag = 'div',
  ...rest
}: {
  children: ReactNode;
  className?: string;
  max?: number;
  glare?: boolean;
  as?: ElementType;
} & Record<string, unknown>) {
  const ref = useRef<HTMLElement | null>(null);
  const raf = useRef(0);
  const reduced = usePrefersReducedMotion();

  const onMove = (e: PointerEvent) => {
    if (reduced || e.pointerType !== 'mouse') return;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      el.style.setProperty('--ry', `${((px - 0.5) * 2 * max).toFixed(2)}deg`);
      el.style.setProperty('--rx', `${(-(py - 0.5) * 2 * max).toFixed(2)}deg`);
      el.style.setProperty('--mx', `${(px * 100).toFixed(1)}%`);
      el.style.setProperty('--my', `${(py * 100).toFixed(1)}%`);
    });
  };
  const onLeave = () => {
    cancelAnimationFrame(raf.current);
    const el = ref.current;
    if (!el) return;
    el.style.setProperty('--rx', '0deg');
    el.style.setProperty('--ry', '0deg');
  };

  return (
    <Tag ref={ref} className={`tilt ${className}`} onPointerMove={onMove} onPointerLeave={onLeave} {...rest}>
      {children}
      {glare && <span className="glare" aria-hidden="true" />}
    </Tag>
  );
}
