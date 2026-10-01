// Read transport for the public testnet RPC with a CORS-enabled fallback.
// The official testnet RPC rate-limits per IP (-32005 "rate limited" / HTTP 429). viem's `fallback`
// moves a call that fails on the official URL (rate limit, 5xx, network error) to the next URL; reverts
// and user rejections are thrown at once (viem's default shouldThrow), never re-sent elsewhere.
// Wallet writes do not use this: they go through the injected wallet provider (lib/chain.ts).
import { fallback, http, type EIP1193RequestFn, type Transport } from 'viem';
import { isRateLimited } from './rpc';

/** Per host and JSON-RPC method: answered / rate-limited / other error. Read in the console as `__numeraRpc`. */
export type RpcStats = Record<string, Record<string, { ok: number; limited: number; error: number }>>;
const stats: RpcStats = {};
export const rpcStats = (): RpcStats => stats;
if (typeof window !== 'undefined') (window as unknown as { __numeraRpc?: RpcStats }).__numeraRpc = stats;

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
function count(url: string, method: string, outcome: 'ok' | 'limited' | 'error') {
  const h = (stats[hostOf(url)] ??= {});
  (h[method] ??= { ok: 0, limited: 0, error: 0 })[outcome]++;
}

/** Result of the one-time eth_chainId probe per fallback URL (module scope: viem re-creates transports per call). */
const chainChecks = new Map<string, Promise<void>>();
export const resetChainChecks = (): void => chainChecks.clear();

/**
 * Before its first use, a fallback URL must answer eth_chainId === `chainId` (998); otherwise every call
 * to it fails with a clear error and the app never reads from another chain. A rate-limited or failed
 * probe is not cached (probed again on the next call); a wrong chain id is cached for the page.
 */
function verifyChain(url: string, chainId: number, request: EIP1193RequestFn): Promise<void> {
  let p = chainChecks.get(url);
  if (!p) {
    p = (async () => {
      const hex = (await request({ method: 'eth_chainId' })) as string;
      const got = parseInt(hex, 16);
      if (got !== chainId) throw new Error(`RPC ${hostOf(url)} answered chain id ${got}, expected ${chainId}; not used.`);
    })();
    p.catch((e) => {
      if (!/expected \d+; not used/.test(String((e as Error)?.message))) chainChecks.delete(url);
    });
    chainChecks.set(url, p);
  }
  return p;
}

/** One http transport (no batching, no own retries) that counts calls and optionally checks chain id first. */
function countedHttp(url: string, expectChainId: number | undefined): Transport {
  const base = http(url, { batch: false, retryCount: 0 });
  return ((params) => {
    const t = base(params);
    const request = (async (args: { method: string; params?: unknown }) => {
      if (expectChainId !== undefined) await verifyChain(url, expectChainId, t.request as EIP1193RequestFn);
      try {
        const r = await (t.request as (a: unknown) => Promise<unknown>)(args);
        count(url, args.method, 'ok');
        return r;
      } catch (e) {
        count(url, args.method, isRateLimited(e) ? 'limited' : 'error');
        throw e;
      }
    }) as EIP1193RequestFn;
    return { ...t, request };
  }) as Transport;
}

/**
 * `urls[0]` is the primary (official RPC, chain id verified by scripts/dev.mjs); every further URL is a
 * fallback whose chain id is verified in the browser before its first use. No ranking: the primary is
 * always tried first, so a healthy official RPC serves everything.
 */
export function readTransport(
  urls: readonly string[],
  opts: { chainId: number; retryCount?: number; retryDelay?: number },
): Transport {
  if (urls.length === 0) throw new Error('readTransport: no RPC URL');
  const transports = urls.map((u, i) => countedHttp(u, i === 0 ? undefined : opts.chainId));
  if (transports.length === 1) {
    const only = transports[0];
    // retries (txPublicClient) are applied by viem's createTransport around this single transport
    return opts.retryCount ? fallback([only], { rank: false, retryCount: opts.retryCount, retryDelay: opts.retryDelay }) : only;
  }
  return fallback(transports, { rank: false, retryCount: opts.retryCount ?? 0, retryDelay: opts.retryDelay });
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
