import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { PartialData, backoffMs, busyUntil, isRateLimited, setBusy, subscribeBusy } from './lib/rpc';

export interface Polled<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => void;
  updatedAt: number | undefined;
  /** The last attempt was rate-limited; a retry is scheduled with backoff. */
  busy: boolean;
}

/** Stable string key for a deps list (bigints included). */
export const depsKey = (deps: unknown[]): string => JSON.stringify(deps, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));

const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

interface St<T> {
  key: string;
  data?: T;
  error?: string;
  updatedAt?: number;
  busy?: boolean;
}

/**
 * Run `fn` now and then every `ms` (0 = only when `deps` change or on reload()).
 * - Data is keyed by `deps`: when they change (e.g. another pool) the old value is never returned,
 *   `data` is undefined until the new read lands.
 * - Polls only while the browser tab is visible; on return it refreshes if a poll was due.
 * - On error keeps the last good value for the same key and retries with exponential backoff
 *   (4 s … 60 s); a rate-limited error (-32005) also lights the global "RPC busy" hint.
 * - `enabled = false` stops polling and returns no data.
 */
export function usePoll<T>(fn: (signal: AbortSignal) => Promise<T>, deps: unknown[], ms: number, enabled = true): Polled<T> {
  const key = depsKey(deps);
  const id = useId();
  const [st, setSt] = useState<St<T>>({ key: '' });
  const [inflight, setInflight] = useState(false);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let seq = 0;
    let fails = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let due = false; // a poll came due while the tab was hidden
    let ctrl = new AbortController();

    const schedule = (delay: number) => {
      clearTimeout(timer);
      timer = setTimeout(run, delay);
    };
    async function run() {
      if (!alive) return;
      if (!visible()) {
        due = true;
        return;
      }
      due = false;
      const my = ++seq;
      ctrl.abort();
      ctrl = new AbortController();
      setInflight(true);
      try {
        const v = await fnRef.current(ctrl.signal);
        if (!alive || my !== seq) return;
        fails = 0;
        setBusy(id, undefined);
        setSt({ key, data: v, updatedAt: Date.now() });
        if (ms > 0) schedule(ms);
      } catch (e) {
        if (!alive || my !== seq || (e as Error).name === 'AbortError') return;
        fails++;
        const limited = isRateLimited(e);
        const delay = backoffMs(fails, ms);
        setBusy(id, limited ? Date.now() + delay : undefined);
        const msg = limited ? 'The public testnet RPC is rate-limiting requests; retrying.' : ((e as Error).message ?? String(e));
        if (e instanceof PartialData) {
          // usable data with a rate-limited part: show it, but keep the failure's backoff and busy hint
          setSt({ key, data: e.partial as T, updatedAt: Date.now(), error: msg, busy: limited });
        } else setSt((s) => ({ ...(s.key === key ? s : { key }), error: msg, busy: limited }));
        schedule(delay);
      } finally {
        if (alive && my === seq) setInflight(false);
      }
    }
    const onVisibility = () => {
      if (visible() && due) run();
    };
    document.addEventListener('visibilitychange', onVisibility);
    run();
    return () => {
      alive = false;
      ctrl.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      setBusy(id, undefined);
      setInflight(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick, enabled, ms]);

  const reload = useCallback(() => setTick((x) => x + 1), []);
  const mine = enabled && st.key === key;
  return {
    data: mine ? st.data : undefined,
    error: mine ? st.error : undefined,
    loading: enabled && (inflight || !mine),
    reload,
    updatedAt: mine ? st.updatedAt : undefined,
    busy: mine && !!st.busy,
  };
}

/** Retry time of the most delayed rate-limited poll, or undefined when the RPC is fine. */
export function useRpcBusy(): number | undefined {
  return useSyncExternalStore(subscribeBusy, busyUntil, busyUntil);
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
