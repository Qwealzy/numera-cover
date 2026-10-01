// Read transport for the public testnet RPC with a CORS-enabled fallback and a circuit breaker.
// The official testnet RPC rate-limits per IP (-32005 "rate limited" / HTTP 429), and the keeper and engine
// share that IP. A call the official RPC rate-limits (or fails with a network/5xx error) moves to the next
// URL; reverts and user rejections are thrown at once, never re-sent elsewhere. After a rate limit the
// official RPC is skipped for a jittered window (30 s, doubling to 120 s while it keeps limiting, reset on
// success); one probe call per elapsed window may try it again. Wallet writes do not use this transport:
// they go through the injected wallet provider (lib/chain.ts).
import { BaseError, ExecutionRevertedError, createTransport, http, type EIP1193RequestFn, type Transport } from 'viem';
import { isRateLimited } from './rpc';

/** viem's shortMessage, else the first line of the message (local copy: pool.ts imports chain.ts). */
const firstLine = (e: unknown): string => {
  const x = e as { shortMessage?: unknown; message?: unknown } | undefined;
  const s = typeof x?.shortMessage === 'string' ? x.shortMessage : typeof x?.message === 'string' ? x.message : String(e);
  return s.split('\n')[0] || 'unknown error';
};

// ---------------------------------------------------------------- errors

/**
 * JSON-RPC code for "this fallback serves another chain". Not a code viem maps or retries (buildRequest's
 * shouldRetry only retries -1, -32005, -32603, 429, -32007), so a wrong chain is never re-sent.
 */
export const WRONG_CHAIN_CODE = -32098;
export class WrongChainRpcError extends BaseError {
  readonly code = WRONG_CHAIN_CODE;
  constructor(host: string, got: number, expected: number) {
    super(`RPC ${host} answered chain id ${got}, expected ${expected}; not used.`, { name: 'WrongChainRpcError' });
  }
}

/**
 * The official RPC was rate-limited (now, or its breaker is open) and every fallback failed too. Carries the
 * -32005 code so isRateLimited / viem retries / usePoll backoff keep working; `cause` is the fallback's error
 * and `primary` the official RPC's own error (undefined when the breaker skipped it).
 */
export class PrimaryRateLimitedError extends BaseError {
  readonly code = -32005;
  readonly primary: unknown;
  constructor(primary: unknown, fallbackError: unknown) {
    super(`Official RPC rate-limited${primary ? '' : ' (breaker open)'}; fallback failed: ${firstLine(fallbackError)}`, {
      cause: fallbackError instanceof Error ? fallbackError : undefined,
      name: 'PrimaryRateLimitedError',
    });
    this.primary = primary;
  }
}

/** Errors that mean "the node answered, the call itself is bad": never re-sent to another URL. */
export function isFinalError(e: unknown): boolean {
  let cur = e as { code?: unknown; message?: unknown; cause?: unknown } | undefined;
  for (let i = 0; cur && i < 10; i++) {
    const code = cur.code;
    if (code === 3 || code === -32003 || code === 4001 || code === 5000) return true;
    if (typeof cur.message === 'string' && ExecutionRevertedError.nodeMessage.test(cur.message)) return true;
    cur = cur.cause as typeof cur;
  }
  return false;
}

// ---------------------------------------------------------------- stats (window.__numeraRpc)

type Outcome = 'ok' | 'limited' | 'error' | 'skipped';
/** Per host and JSON-RPC method: answered / rate-limited / other error / skipped by the breaker. */
export type RpcStats = Record<string, Record<string, Record<Outcome, number>>>;
const stats: RpcStats = {};
export const rpcStats = (): RpcStats => stats;

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
function count(url: string, method: string, outcome: Outcome) {
  const h = (stats[hostOf(url)] ??= {});
  (h[method] ??= { ok: 0, limited: 0, error: 0, skipped: 0 })[outcome]++;
}

// ---------------------------------------------------------------- breaker on the primary

export const BREAKER_BASE_MS = 30_000;
export const BREAKER_MAX_MS = 120_000;
interface Breaker {
  windowMs: number; // 0 = closed
  openUntil: number;
  probing: boolean;
  trips: number;
}
const breakers = new Map<string, Breaker>();
const breakerOf = (url: string): Breaker => {
  let b = breakers.get(url);
  if (!b) breakers.set(url, (b = { windowMs: 0, openUntil: 0, probing: false, trips: 0 }));
  return b;
};
let random = Math.random;
let now = () => Date.now();
/** Test hook: deterministic jitter / clock. */
export function setBreakerClock(clock: { now?: () => number; random?: () => number }): void {
  if (clock.now) now = clock.now;
  if (clock.random) random = clock.random;
}

function trip(b: Breaker) {
  b.windowMs = b.windowMs ? Math.min(BREAKER_MAX_MS, b.windowMs * 2) : BREAKER_BASE_MS;
  b.openUntil = now() + Math.round(b.windowMs * (0.8 + random() * 0.4));
  b.probing = false;
  b.trips++;
}
function reset(b: Breaker) {
  b.windowMs = 0;
  b.openUntil = 0;
  b.probing = false;
}
/** 'skip' while open; 'probe' for the one call allowed once the window elapsed; 'use' when closed. */
function admit(b: Breaker): 'use' | 'skip' | 'probe' {
  if (!b.windowMs) return 'use';
  if (now() < b.openUntil || b.probing) return 'skip';
  b.probing = true;
  return 'probe';
}

export type BreakerState = { host: string; state: 'closed' | 'open' | 'half-open'; windowMs: number; openForMs: number; trips: number };
export function breakerState(): BreakerState[] {
  return [...breakers].map(([url, b]) => ({
    host: hostOf(url),
    state: !b.windowMs ? 'closed' : now() < b.openUntil ? 'open' : 'half-open',
    windowMs: b.windowMs,
    openForMs: Math.max(0, b.openUntil - now()),
    trips: b.trips,
  }));
}

if (typeof window !== 'undefined')
  (window as unknown as { __numeraRpc?: unknown }).__numeraRpc = {
    hosts: stats,
    get breaker() {
      return breakerState();
    },
  };

// ---------------------------------------------------------------- chain-id guard for fallbacks

/** One eth_chainId probe per fallback URL (module scope). A wrong chain is remembered for the page. */
const chainChecks = new Map<string, Promise<void>>();
const wrongChain = new Map<string, WrongChainRpcError>();
/** Test hook: forget breakers, probes and wrong-chain marks. */
export function resetTransportState(): void {
  chainChecks.clear();
  wrongChain.clear();
  breakers.clear();
}
/** @deprecated name kept for older tests */
export const resetChainChecks = resetTransportState;

function verifyChain(url: string, chainId: number, request: EIP1193RequestFn): Promise<void> {
  let p = chainChecks.get(url);
  if (!p) {
    p = (async () => {
      const hex = (await request({ method: 'eth_chainId' })) as string;
      const got = parseInt(hex, 16);
      if (got !== chainId) {
        const err = new WrongChainRpcError(hostOf(url), got, chainId);
        wrongChain.set(url, err);
        throw err;
      }
    })();
    // a failed or rate-limited probe is not cached: the next call probes again
    p.catch((e) => {
      if (!(e instanceof WrongChainRpcError)) chainChecks.delete(url);
    });
    chainChecks.set(url, p);
  }
  return p;
}

// ---------------------------------------------------------------- transport

/**
 * `urls[0]` is the primary (official RPC, chain id verified by scripts/dev.mjs); every further URL is a
 * fallback whose chain id is verified in the browser before its first use. The primary is tried first
 * unless its breaker is open (and a usable fallback exists). `retryCount` / `retryDelay` are viem's
 * retries around the whole sequence (txPublicClient); they apply only to retryable codes (-32005 etc.),
 * never to a revert or a wrong chain id.
 */
export function readTransport(urls: readonly string[], opts: { chainId: number; retryCount?: number; retryDelay?: number }): Transport {
  if (urls.length === 0) throw new Error('readTransport: no RPC URL');
  const [primary, ...fallbacks] = urls;
  const factories = urls.map((u) => http(u, { batch: false, retryCount: 0 }));
  return (({ chain, timeout }) => {
    const reqs = factories.map((f) => f({ chain, timeout, retryCount: 0 }).request as EIP1193RequestFn);
    const call = async (i: number, method: string, params: unknown) => {
      const url = urls[i];
      try {
        const r = await (reqs[i] as (a: unknown) => Promise<unknown>)({ method, params });
        count(url, method, 'ok');
        return r;
      } catch (e) {
        count(url, method, isRateLimited(e) ? 'limited' : 'error');
        throw e;
      }
    };
    const request = async ({ method, params }: { method: string; params?: unknown }) => {
      const usable = fallbacks.map((u, k) => ({ url: u, i: k + 1 })).filter((f) => !wrongChain.has(f.url));
      const b = breakerOf(primary);
      let primaryErr: unknown;
      let primaryLimited = false;
      const gate = usable.length ? admit(b) : 'use';
      if (gate === 'skip') {
        count(primary, method, 'skipped');
        primaryLimited = true;
      } else {
        try {
          const r = await call(0, method, params);
          reset(b);
          return r;
        } catch (e) {
          if (isFinalError(e) || !usable.length) {
            if (gate === 'probe') b.probing = false;
            if (isFinalError(e)) throw e;
            const limitedNow = isRateLimited(e);
            if (limitedNow) trip(b);
            // every fallback was ruled out (wrong chain): keep the rate-limit signal AND say why
            const ruledOut = fallbacks.map((u) => wrongChain.get(u)).find(Boolean);
            if (limitedNow && ruledOut) throw new PrimaryRateLimitedError(e, ruledOut);
            throw e;
          }
          primaryErr = e;
          primaryLimited = isRateLimited(e);
          if (primaryLimited) trip(b);
          else if (gate === 'probe') b.probing = false; // not a rate limit: keep the window, allow another probe
        }
      }
      let lastErr: unknown = primaryErr;
      for (const f of usable) {
        try {
          await verifyChain(f.url, opts.chainId, reqs[f.i]);
          return await call(f.i, method, params);
        } catch (e) {
          if (isFinalError(e)) throw e;
          lastErr = e;
        }
      }
      if (primaryLimited) throw new PrimaryRateLimitedError(primaryErr, lastErr);
      throw lastErr;
    };
    return createTransport({
      key: 'numera-read',
      name: 'Numera read (official RPC + fallback)',
      type: 'numera-read',
      request: request as EIP1193RequestFn,
      retryCount: opts.retryCount ?? 0,
      retryDelay: opts.retryDelay,
      timeout,
    });
  }) as Transport;
}

/**
 * Parse VITE_RPC_FALLBACK_URLS (comma-separated; empty string = no fallback). Unset: the default list,
 * but only when the primary is the default official RPC (a custom VITE_RPC_URL, e.g. a local node, gets no
 * implicit testnet fallback). The primary itself is never repeated as a fallback.
 */
export function fallbackUrls(primary: string, defaultPrimary: string, raw: string | undefined, defaults: readonly string[]): string[] {
  const list = raw !== undefined ? raw.split(',') : primary === defaultPrimary ? [...defaults] : [];
  const seen = new Set([primary.replace(/\/+$/, '')]);
  const out: string[] = [];
  for (const u of list.map((s) => s.trim().replace(/\/+$/, ''))) {
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}
