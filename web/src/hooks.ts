import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

export interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  setData: (data: T) => void;
}

/**
 * Loads data and keeps it fresh. When `poll` returns a number, the data is reloaded
 * every that many milliseconds until it returns null (used while a run is in progress).
 */
export function useResource<T>(load: () => Promise<T>, deps: unknown[], poll?: (data: T) => number | null): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const pollRef = useRef(poll);
  pollRef.current = poll;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = async (first: boolean) => {
      if (first) setLoading(true);
      try {
        const next = await loadRef.current();
        if (cancelled) return;
        setData(next);
        setError(null);
        const wait = pollRef.current?.(next) ?? null;
        if (wait !== null) timer = setTimeout(() => void run(false), wait);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : 'Something went wrong.');
        if (pollRef.current) timer = setTimeout(() => void run(false), 4000);
      } finally {
        if (!cancelled && first) setLoading(false);
      }
    };
    void run(true);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · GateX`;
  }, [title]);
}

export type Theme = 'dark' | 'light';

/** The colour theme. index.html sets it before the first paint; this changes it and remembers the choice. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'));
  const toggle = useCallback(() => {
    const next: Theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try {
      localStorage.setItem('ddd-theme', next);
    } catch {
      /* private mode: the choice lasts until the tab closes */
    }
  }, []);
  return [theme, toggle];
}
