// RPC load control for the public testnet endpoint (rate-limited per IP, -32005 "rate limited").
// Measured 2026-10-01: the limit counts every JSON-RPC call, also the ones inside a JSON-RPC batch,
// so the levers are fewer calls (Multicall3, poll only the visible screen) and backing off on -32005.

/** True for the testnet RPC's rate-limit answer (code -32005) or an HTTP 429, anywhere in the cause chain. */
export function isRateLimited(e: unknown): boolean {
  let cur = e as { code?: unknown; status?: unknown; message?: unknown; details?: unknown; cause?: unknown } | undefined;
  for (let i = 0; cur && i < 8; i++) {
    if (cur.code === -32005 || cur.status === 429) return true;
    const text = `${typeof cur.message === 'string' ? cur.message : ''} ${typeof cur.details === 'string' ? cur.details : ''}`;
    if (/rate limit|exceeds defined limit|-32005|429|too many requests/i.test(text)) return true;
    cur = cur.cause as typeof cur;
  }
  return false;
}

/** Delay before the next attempt after `fails` consecutive failures: 4 s, 8 s, 16 s, … capped at 60 s. */
export function backoffMs(fails: number, floorMs = 0): number {
  const exp = Math.min(60_000, 4_000 * 2 ** Math.max(0, fails - 1));
  return Math.max(exp, floorMs);
}

// ---------------------------------------------------------------- dedupe identical reads

interface Entry {
  p: Promise<unknown>;
  at: number;
  done: boolean;
}
const cache = new Map<string, Entry>();

/**
 * Share one in-flight request per `key`, and reuse its result for `ttlMs` after it resolves (React
 * StrictMode double effects, two screens reading the same thing, quick tab switches). Failures are not
 * cached. `invalidate()` drops everything, e.g. right after the user's own transaction.
 */
export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const e = cache.get(key);
  if (e && (!e.done || Date.now() - e.at < ttlMs)) return e.p as Promise<T>;
  const entry: Entry = { p: Promise.resolve(), at: Date.now(), done: false };
  entry.p = fn().then(
    (v) => {
      entry.done = true;
      entry.at = Date.now();
      return v;
    },
    (err) => {
      if (cache.get(key) === entry) cache.delete(key);
      throw err;
    },
  );
  cache.set(key, entry);
  return entry.p as Promise<T>;
}

export function invalidate(prefix = ''): void {
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k);
}

// ---------------------------------------------------------------- "RPC busy" indicator

const busy = new Map<string, number>(); // poll id → retry time (ms epoch)
const listeners = new Set<() => void>();
let snapshot: number | undefined;

function emit() {
  snapshot = busy.size ? Math.max(...busy.values()) : undefined;
  listeners.forEach((l) => l());
}

export function setBusy(id: string, retryAt: number | undefined): void {
  if (retryAt === undefined) {
    if (!busy.delete(id)) return;
  } else busy.set(id, retryAt);
  emit();
}

export function subscribeBusy(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Latest scheduled retry time among rate-limited polls, or undefined when none is rate-limited. */
export const busyUntil = (): number | undefined => snapshot;
