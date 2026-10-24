import type { CSSProperties, ElementType, ReactNode } from 'react';
import { useInView } from './hooks';

/** Fades and rises into place when scrolled into view. `delay` (ms) staggers siblings. */
export function Reveal({
  children,
  delay = 0,
  as: Tag = 'div',
  className = '',
  from = 'up',
  ...rest
}: {
  children: ReactNode;
  delay?: number;
  as?: ElementType;
  className?: string;
  from?: 'up' | 'left' | 'right' | 'scale';
} & Record<string, unknown>) {
  const [ref, seen] = useInView<HTMLElement>();
  return (
    <Tag ref={ref} className={`reveal reveal-${from} ${seen ? 'in' : ''} ${className}`} style={{ '--d': `${delay}ms` } as CSSProperties} {...rest}>
      {children}
    </Tag>
  );
}
