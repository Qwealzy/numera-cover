import { useCallback, useEffect, useRef, useState } from 'react';

export interface Polled<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => void;
  updatedAt: number | undefined;
}

/**
 * Run `fn` now and every `ms` while mounted; re-run when `deps` change. Keeps the last good value on
 * error. `fn` receives an AbortSignal; pass `ms = 0` to disable polling. `enabled = false` clears data.
 */
export function usePoll<T>(fn: (signal: AbortSignal) => Promise<T>, deps: unknown[], ms: number, enabled = true): Polled<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number>();
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) {
      setData(undefined);
      setError(undefined);
      return;
    }
    let alive = true;
    let ctrl = new AbortController();
    const run = async () => {
      ctrl.abort();
      ctrl = new AbortController();
      setLoading(true);
      try {
        const v = await fnRef.current(ctrl.signal);
        if (!alive) return;
        setData(v);
        setError(undefined);
        setUpdatedAt(Date.now());
      } catch (e) {
        if (!alive || (e as Error).name === 'AbortError') return;
        setError((e as Error).message ?? String(e));
      } finally {
        if (alive) setLoading(false);
      }
    };
    run();
    const t = ms > 0 ? setInterval(run, ms) : undefined;
    return () => {
      alive = false;
      ctrl.abort();
      if (t) clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, enabled, ms]);

  const reload = useCallback(() => setTick((x) => x + 1), []);
  return { data, error, loading, reload, updatedAt };
}

/** Current unix seconds, ticking every `ms`. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
