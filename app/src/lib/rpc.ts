// RPC load control for the public testnet endpoint (rate-limited per IP, -32005 "rate limited").
// Measured 2026-10-01: the limit counts every JSON-RPC call, also the ones inside a JSON-RPC batch,
// so the levers are fewer calls (Multicall3, poll only the visible screen) and backing off on -32005.

/**
 * True for the testnet RPC's rate-limit answer (JSON-RPC code -32005) or an HTTP 429, anywhere in the
 * (viem) cause chain. Text matches only explicit forms ("HTTP 429", "status: 429", "-32005",
 * "rate limit(ed)"), never a bare "429": viem messages embed call args and hashes, and an address like
 * 0x…429111 in a genuine revert must not read as a rate limit.
 */
export function isRateLimited(e: unknown): boolean {
  let cur = e as { code?: unknown; status?: unknown; message?: unknown; details?: unknown; cause?: unknown } | undefined;
  for (let i = 0; cur && i < 10; i++) {
    if (cur.code === -32005 || cur.status === 429) return true;
    const text = `${typeof cur.message === 'string' ? cur.message : ''} ${typeof cur.details === 'string' ? cur.details : ''}`;
    if (RATE_LIMIT_TEXT.test(text)) return true;
    cur = cur.cause as typeof cur;
  }
  return false;
}
const RATE_LIMIT_TEXT = /\bHTTP 429\b|\bstatus:? 429\b|-32005\b|rate.?limit/i;

/** Delay before the next attempt after `fails` consecutive failures: 4 s, 8 s, 16 s, … capped at 60 s. */
export function backoffMs(fails: number, floorMs = 0): number {
  const exp = Math.min(60_000, 4_000 * 2 ** Math.max(0, fails - 1));
  return Math.max(exp, floorMs);
}

/**
 * Run a one-shot read, retrying ONLY rate-limit answers (-32005 / 429) with spaced, jittered delays
 * (default 1.5 s, 3 s, 6 s). Any other error (revert, bad address, network) is thrown at once, and the
 * last rate-limit error is rethrown after the final attempt, so callers still see the real reason.
 * Used for the max-payout cap (polled: one short retry, then usePoll's backoff) and the receipt view.
 * `signal` cancels a pending delay and any further attempt (a newer read replaced this one).
 */
export async function retryRateLimited<T>(
  fn: () => Promise<T>,
  opts: {
    delaysMs?: number[];
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    onRetry?: (attempt: number, e: unknown) => void;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const delays = opts.delaysMs ?? [1_500, 3_000, 6_000];
  const sleep = opts.sleep ?? abortableSleep;
  for (let attempt = 0; ; attempt++) {
    if (opts.signal?.aborted) throw abortError();
    try {
      return await fn();
    } catch (e) {
      if (!isRateLimited(e) || attempt >= delays.length || opts.signal?.aborted) throw e;
      opts.onRetry?.(attempt + 1, e);
      await sleep(delays[attempt] * (0.8 + Math.random() * 0.4), opts.signal);
    }
  }
}

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A lookup that runs outside usePoll (no timer of its own): retries only rate-limit errors, at most
 * `maxAttempts` attempts in total, then gives up with the last error. Returns a cancel function.
 */
export function lookupWithRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxAttempts: number;
    delayMs: (failedAttempts: number) => number;
    onSuccess: (v: T) => void;
    onGiveUp: (e: unknown, attempts: number) => void;
    onRetry?: (failedAttempts: number, e: unknown) => void;
  },
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = (attempt: number) => {
    fn().then(
      (v) => {
        if (!cancelled) opts.onSuccess(v);
      },
      (e) => {
        if (cancelled) return;
        if (!isRateLimited(e) || attempt >= opts.maxAttempts) return opts.onGiveUp(e, attempt);
        opts.onRetry?.(attempt, e);
        timer = setTimeout(() => run(attempt + 1), opts.delayMs(attempt));
      },
    );
  };
  run(1);
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}

/**
 * Thrown by a loader that produced usable data but was rate-limited on part of it (the positions load
 * when the cap read is throttled). usePoll shows `partial` AND counts the poll as failed, so its backoff
 * and the "RPC busy" hint engage instead of re-polling at full speed.
 */
export class PartialData<T> extends Error {
  readonly partial: T;
  constructor(partial: T, cause: unknown) {
    super('partial data: a read was rate-limited', { cause });
    this.name = 'PartialData';
    this.partial = partial;
  }
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
