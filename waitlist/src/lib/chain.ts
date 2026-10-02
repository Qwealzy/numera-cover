// Copied from site/src/lib/chain.ts (waitlist v2 build, 2026-10-02); keep in sync with the original.
// Browser-side, read-only JSON-RPC reads of the testnet pool (plain fetch, no library).
// Any failure yields null; the page then shows a dash, never a made-up number.

/** 4-byte selectors (`cast sig "totalAssets()"`, `cast sig "coverCount()"`). */
export const SEL = { totalAssets: '0x01e1d114', coverCount: '0xfeb0b8f5' } as const;

type Fetch = typeof fetch;

async function rpc(url: string, method: string, params: unknown[], fetchFn: Fetch, timeoutMs: number): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`http ${r.status}`);
    const j = (await r.json()) as { result?: unknown; error?: unknown };
    if (typeof j.result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(j.result)) throw new Error('bad result');
    return j.result;
  } finally {
    clearTimeout(t);
  }
}

/** One uint256 word -> bigint; anything else -> null. */
export function decodeUint(hex: string): bigint | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) return null;
  return BigInt(hex);
}

/** USDC (6 decimals) -> "1,971.24" (two decimals, rounded down; never rounds a balance up). */
export function formatUsdc(raw: bigint): string {
  const cents = raw / 10_000n;
  const whole = cents / 100n;
  const frac = (cents % 100n).toString().padStart(2, '0');
  return `${whole.toLocaleString('en-US')}.${frac}`;
}

export type PoolStats = { totalAssets: bigint | null; coverCount: bigint | null };

/**
 * Reads totalAssets and coverCount from `pool`, trying each RPC in order. An endpoint is used only after it
 * reports `chainId`; a wrong chain or any error moves on to the next one. All null when every endpoint fails.
 */
export async function readPoolStats(
  rpcs: readonly string[],
  chainId: number,
  pool: string,
  fetchFn: Fetch = fetch,
  timeoutMs = 6000,
): Promise<PoolStats> {
  for (const url of rpcs) {
    try {
      const id = await rpc(url, 'eth_chainId', [], fetchFn, timeoutMs);
      if (Number.parseInt(id, 16) !== chainId) continue;
      const call = (data: string) => rpc(url, 'eth_call', [{ to: pool, data }, 'latest'], fetchFn, timeoutMs);
      const [a, c] = await Promise.all([call(SEL.totalAssets), call(SEL.coverCount)]);
      const out = { totalAssets: decodeUint(a), coverCount: decodeUint(c) };
      if (out.totalAssets !== null || out.coverCount !== null) return out;
    } catch {
      // try the next endpoint
    }
  }
  return { totalAssets: null, coverCount: null };
}

// ---------------------------------------------------------------------------------------------------------
// Waitlist v2 additions (not in site/): the ledger reads and the oracle price. Same RPCs, same chain check,
// same rule: any failure yields null and the page shows a dash.

/** More 4-byte selectors (keccak checked with eth_utils in engine/.venv; content brief §3c). */
export const SEL2 = {
  totalAssets: '0x01e1d114',
  freeAssets: '0x11f240ac',
  lockedAssets: '0x274fc72a',
  coverCount: '0xfeb0b8f5',
  paused: '0x5c975abb',
  /** priceSource.oraclePx6(uint32) -> uint64 px6. Called on pools.hypercore.priceSource only. */
  oraclePx6: '0xb1d42205',
} as const;

/** ABI-encodes one uint32 argument after a selector. */
export function callData(selector: string, arg: number): string {
  if (!Number.isInteger(arg) || arg < 0 || arg > 0xffffffff) throw new Error('uint32 out of range');
  return selector + arg.toString(16).padStart(64, '0');
}

/** One bool word -> boolean; anything else -> null. */
export function decodeBool(hex: string): boolean | null {
  const v = decodeUint(hex);
  if (v === null || v > 1n) return null;
  return v === 1n;
}

export type Ledger = {
  totalAssets: bigint | null;
  freeAssets: bigint | null;
  lockedAssets: bigint | null;
  coverCount: bigint | null;
  paused: boolean | null;
};
const EMPTY_LEDGER: Ledger = { totalAssets: null, freeAssets: null, lockedAssets: null, coverCount: null, paused: null };

/** Picks the first endpoint that reports `chainId`; null when none does. */
async function pickRpc(rpcs: readonly string[], chainId: number, fetchFn: Fetch, timeoutMs: number, start = 0) {
  for (let i = start; i < rpcs.length; i++) {
    try {
      const id = await rpc(rpcs[i], 'eth_chainId', [], fetchFn, timeoutMs);
      if (Number.parseInt(id, 16) === chainId) return i;
    } catch {
      // next endpoint
    }
  }
  return -1;
}

/** Reads the five ledger fields of `pool`, failing over endpoint by endpoint (every field null on total failure). */
export async function readLedger(
  rpcs: readonly string[],
  chainId: number,
  pool: string,
  fetchFn: Fetch = fetch,
  timeoutMs = 6000,
): Promise<Ledger> {
  let i = 0;
  while (i < rpcs.length) {
    i = await pickRpc(rpcs, chainId, fetchFn, timeoutMs, i);
    if (i < 0) break;
    const url = rpcs[i];
    try {
      const call = (data: string) =>
        rpc(url, 'eth_call', [{ to: pool, data }, 'latest'], fetchFn, timeoutMs).catch(() => '');
      const [t, f, l, c, p] = await Promise.all([
        call(SEL2.totalAssets),
        call(SEL2.freeAssets),
        call(SEL2.lockedAssets),
        call(SEL2.coverCount),
        call(SEL2.paused),
      ]);
      const out: Ledger = {
        totalAssets: decodeUint(t),
        freeAssets: decodeUint(f),
        lockedAssets: decodeUint(l),
        coverCount: decodeUint(c),
        paused: decodeBool(p),
      };
      if (Object.values(out).some((v) => v !== null)) return out;
    } catch {
      // next endpoint
    }
    i++;
  }
  return { ...EMPTY_LEDGER };
}

/** oraclePx6(perp) on a price source -> px6 (USD × 1e6) or null. Never pass the MOCK price source. */
export async function readOraclePx6(
  rpcs: readonly string[],
  chainId: number,
  priceSource: string,
  perpIndex: number,
  fetchFn: Fetch = fetch,
  timeoutMs = 6000,
): Promise<bigint | null> {
  let i = 0;
  while (i < rpcs.length) {
    i = await pickRpc(rpcs, chainId, fetchFn, timeoutMs, i);
    if (i < 0) break;
    try {
      const r = await rpc(rpcs[i], 'eth_call', [{ to: priceSource, data: callData(SEL2.oraclePx6, perpIndex) }, 'latest'], fetchFn, timeoutMs);
      const v = decodeUint(r);
      if (v !== null && v > 0n && v < 2n ** 64n) return v;
    } catch {
      // next endpoint
    }
    i++;
  }
  return null;
}

/** Date -> "19:28:03" in UTC (the LIVE tags show the read time). */
export function utcTime(d: Date): string {
  return d.toISOString().slice(11, 19);
}
