import { useCallback, useState } from 'react';

const KEY = 'gatex-name';

const read = (): string => {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
};

/** The name a person types once and GateX remembers in this browser, so a review and issue marks carry it. A convenience only: nothing depends on it being saved. */
export function useWho(): [string, (name: string) => void] {
  const [who, setWho] = useState(read);
  const set = useCallback((name: string) => {
    setWho(name);
    try {
      localStorage.setItem(KEY, name);
    } catch {
      // private window or blocked storage: the name still works until the page is closed
    }
  }, []);
  return [who, set];
}
