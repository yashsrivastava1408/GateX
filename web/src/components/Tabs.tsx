import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface TabSpec {
  id: string;
  label: string;
  /** A number shown on the tab, for example how many problems there are. */
  count?: number;
  /** Colours the count: red for things that block, amber for things worth a look. */
  tone?: 'red' | 'amber' | 'accent';
}

/** Keeps the open tab in the address (#findings), so a link or a refresh lands on the same tab. */
export function useHashTab(valid: string[], fallback: string): [string, (id: string) => void] {
  const read = () => {
    const id = window.location.hash.replace('#', '');
    return valid.includes(id) ? id : fallback;
  };
  const [active, setActive] = useState(read);
  useEffect(() => {
    const onHash = () => setActive(read());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valid.join('|'), fallback]);
  const choose = useCallback((id: string) => {
    setActive(id);
    window.history.replaceState(null, '', `#${id}`);
  }, []);
  return [active, choose];
}

export function Tabs({ tabs, active, onChange, label, children }: { tabs: TabSpec[]; active: string; onChange: (id: string) => void; label: string; children: ReactNode }) {
  const list = useRef<HTMLDivElement>(null);

  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = tabs.length - 1;
    const next = event.key === 'ArrowRight' ? (index === last ? 0 : index + 1) : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? last : null;
    if (next === null) return;
    event.preventDefault();
    onChange(tabs[next]!.id);
    list.current?.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus();
  };

  return (
    <div className="tabs">
      <div className="tablist" role="tablist" aria-label={label} ref={list}>
        {tabs.map((tab, i) => (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            aria-controls={`panel-${tab.id}`}
            tabIndex={active === tab.id ? 0 : -1}
            className={`tab ${active === tab.id ? 'tab-active' : ''}`}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {tab.label}
            {tab.count !== undefined && <span className={`tab-count ${tab.tone ? `tab-count-${tab.tone}` : ''}`}>{tab.count}</span>}
          </button>
        ))}
      </div>
      <div key={active} id={`panel-${active}`} role="tabpanel" aria-labelledby={`tab-${active}`} className="tabpanel">
        {children}
      </div>
    </div>
  );
}
