import type { ReactNode } from 'react';

const PATHS: Record<string, ReactNode> = {
  search: (<><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.6-4.6" /></>),
  people: (<><circle cx="9" cy="8" r="3" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><circle cx="17.5" cy="9" r="2.4" /><path d="M16.5 14.2c2.7.4 4.5 2.5 4.5 5.8" /></>),
  shield: (<><path d="M12 3l7 3v5c0 5-3.2 8.5-7 10-3.8-1.5-7-5-7-10V6z" /><path d="M9 12l2 2 4-4" /></>),
  fileCheck: (<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 14.5l2 2 4-4" /></>),
  upload: (<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M12 17v-6" /><path d="M9.5 13.5L12 11l2.5 2.5" /></>),
  list: (<><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6l1.2 1.2L7.2 5M4 12l1.2 1.2L7.2 11M4 18l1.2 1.2L7.2 17" /></>),
  gauge: (<><path d="M4 17a8 8 0 1 1 16 0" /><path d="M12 17l3.6-5" /><circle cx="12" cy="17" r="1.2" /></>),
  eye: (<><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>),
  spark: (<><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /><path d="M19 17l.7 1.8L21.5 19.5l-1.8.7L19 22l-.7-1.8-1.8-.7 1.8-.7z" /></>),
  alert: (<><path d="M12 3l10 18H2z" /><path d="M12 10v4.5" /><path d="M12 17.6v.1" /></>),
  link: (<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>),
  doc: (<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h6" /></>),
  download: (<><path d="M12 4v10" /><path d="M8 10.5l4 4 4-4" /><path d="M5 20h14" /></>),
  check: <path d="M5 12.5l4.5 4.5L19 7" />,
  arrow: (<><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></>),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  chevron: <path d="M7 10l5 5 5-5" />,
  grid: (<><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M3.5 10h17M3.5 15h17M9.5 4.5v15" /></>),
  repeat: (<><path d="M4 12a8 8 0 0 1 13.7-5.6L20 8" /><path d="M20 4v4h-4" /><path d="M20 12a8 8 0 0 1-13.7 5.6L4 16" /><path d="M4 20v-4h4" /></>),
  clock: (<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.2 2" /></>),
  gear: (<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>),
  magnifier: (<><circle cx="10.5" cy="10.5" r="6.5" /><path d="M20 20l-4.8-4.8" /><path d="M8 10.5h5M10.5 8v5" /></>),
  history: (<><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" /></>),
  flag: (<><path d="M5 21V4" /><path d="M5 4h11l-1.8 4L16 12H5" /></>),
  scale: (<><path d="M12 4v16M7 20h10" /><path d="M5 8h14" /><path d="M5 8l-2.5 6a3 3 0 0 0 5 0z" /><path d="M19 8l-2.5 6a3 3 0 0 0 5 0z" /></>),
  lock: (<><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></>),
};

export type LandingIconName = keyof typeof PATHS;

export function LIcon({ name, size = 22, stroke = 1.6 }: { name: string; size?: number; stroke?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
