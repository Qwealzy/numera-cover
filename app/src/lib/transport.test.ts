import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPublicClient } from 'viem';
import { BREAKER_BASE_MS, BREAKER_MAX_MS, breakerState, fallbackUrls, readTransport, resetTransportState, rpcStats, setBreakerClock } from './transport';
import { isRateLimited } from './rpc';
import { firstLine } from './pool';

const OFFICIAL = 'https://rpc.hyperliquid-testnet.xyz/evm';
const LINK = 'https://rpcs.chain.link/hyperevm/testnet';
const OFF = 'rpc.hyperliquid-testnet.xyz';
const LNK = 'rpcs.chain.link';
const chain = { id: 998, name: 't', nativeCurrency: { name: 'H', symbol: 'H', decimals: 18 }, rpcUrls: { default: { http: [OFFICIAL] } } } as const;
const POOL = '0xda611e1a07260005ea5641e9fe633cd4d10c341e' as const;

type Answer = { result?: unknown; error?: { code: number; message: string }; status?: number } | 'network';
/** Fake fetch: per host, a function from JSON-RPC method to the answer. Records every call as host:method. */
function fakeFetch(answers: Record<string, (method: string) => Answer>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const host = new URL(url).host;
      const body = JSON.parse(String(init?.body));
      calls.push(`${host}:${body.method}`);
      const a = answers[host](body.method);
      if (a === 'network') throw new TypeError('Failed to fetch');
      const payload = { jsonrpc: '2.0', id: body.id, ...('error' in a ? { error: a.error } : { result: a.result }) };
      return new Response(JSON.stringify(payload), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}
const limited = { error: { code: -32005, message: 'rate limited' } };
const chainOk = (result: unknown) => (m: string): Answer => (m === 'eth_chainId' ? { result: '0x3e6' } : { result });
const client = (retryCount = 0) =>
  createPublicClient({ chain, transport: readTransport([OFFICIAL, LINK], { chainId: 998, retryCount, retryDelay: 1 }) });
/** Every message in the error's cause chain. */
function chainText(e: unknown): string {
  const out: string[] = [];
  let cur = e as { message?: string; cause?: unknown } | undefined;
  for (let i = 0; cur && i < 12; i++, cur = cur.cause as typeof cur) out.push(String(cur.message));
  return out.join(' || ');
}
async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

let t = 1_000_000;
beforeEach(() => {
  resetTransportState();
  t = 1_000_000;
  setBreakerClock({ now: () => t, random: () => 0.5 }); // jitter factor 0.8 + 0.5 * 0.4 = 1.0
});
afterEach(() => vi.unstubAllGlobals());

describe('readTransport: official RPC first, fallback on rate limit', () => {
  it('a -32005 on the official RPC moves the call to the second URL (chain id checked once)', async () => {
    const calls = fakeFetch({ [OFF]: () => limited, [LNK]: chainOk([]) });
    const c = client();
    expect(await c.getLogs({ address: POOL, fromBlock: 1n, toBlock: 2n })).toEqual([]);
    expect(await c.getLogs({ address: POOL, fromBlock: 1n, toBlock: 2n })).toEqual([]);
    expect(calls).toEqual([
      `${OFF}:eth_getLogs`,
      `${LNK}:eth_chainId`,
      `${LNK}:eth_getLogs`,
      `${LNK}:eth_getLogs`, // breaker open: the official RPC is skipped, the chain id not probed again
    ]);
    expect(rpcStats()[LNK].eth_getLogs.ok).toBeGreaterThanOrEqual(2);
    expect(rpcStats()[OFF].eth_getLogs.skipped).toBeGreaterThanOrEqual(1);
  });

  it('an HTTP 429 and a network error also move to the fallback; a healthy official RPC serves alone', async () => {
    let mode: 'http429' | 'network' | 'ok' = 'network';
    const calls = fakeFetch({
      [OFF]: () => (mode === 'http429' ? { ...limited, status: 429 } : mode === 'network' ? 'network' : { result: '0x10' }),
      [LNK]: chainOk('0x11'),
    });
    const c = client();
    expect(await c.getBlockNumber({ cacheTime: 0 })).toBe(0x11n);
    expect(breakerState()[0].state).toBe('closed'); // a network error does not trip the breaker
    mode = 'http429';
    expect(await c.getBlockNumber({ cacheTime: 0 })).toBe(0x11n);
    expect(breakerState()[0].state).toBe('open');
    mode = 'ok';
    t += BREAKER_BASE_MS + 1; // probe succeeds -> closed
    calls.length = 0;
    expect(await c.getBlockNumber({ cacheTime: 0 })).toBe(0x10n);
    expect(await c.getBlockNumber({ cacheTime: 0 })).toBe(0x10n);
    expect(calls).toEqual([`${OFF}:eth_blockNumber`, `${OFF}:eth_blockNumber`]);
    expect(breakerState()[0].state).toBe('closed');
  });

  it('a revert is thrown at once, not re-sent to the fallback', async () => {
    const calls = fakeFetch({ [OFF]: () => ({ error: { code: 3, message: 'execution reverted' } }), [LNK]: chainOk('0x1') });
    await expect(client().call({ to: POOL, data: '0x' })).rejects.toThrow();
    expect(calls).toEqual([`${OFF}:eth_call`]);
  });
});

describe('breaker on the official RPC (F2)', () => {
  it('skips the official RPC for ~30 s after a -32005, one probe per elapsed window, doubling to 120 s, reset on success', async () => {
    let off: Answer = limited;
    const calls = fakeFetch({ [OFF]: () => off, [LNK]: chainOk('0x11') });
    const c = client();
    const offCalls = () => calls.filter((x) => x.startsWith(OFF)).length;
    await c.getBlockNumber({ cacheTime: 0 }); // trips: window 30 s
    expect(breakerState()[0]).toMatchObject({ host: OFF, state: 'open', windowMs: BREAKER_BASE_MS, trips: 1 });
    t += BREAKER_BASE_MS - 1;
    await c.getBlockNumber({ cacheTime: 0 });
    expect(offCalls()).toBe(1); // still open: skipped
    t += 2; // window elapsed: exactly one concurrent call probes, the other goes straight to the fallback
    await Promise.all([c.request({ method: 'eth_blockNumber' }), c.request({ method: 'eth_blockNumber' })]); // client.request: no dedupe
    expect(offCalls()).toBe(2);
    expect(breakerState()[0]).toMatchObject({ state: 'open', windowMs: 2 * BREAKER_BASE_MS, trips: 2 });
    for (const w of [4 * BREAKER_BASE_MS, BREAKER_MAX_MS, BREAKER_MAX_MS]) {
      t += 2 * BREAKER_MAX_MS;
      await c.getBlockNumber({ cacheTime: 0 });
      expect(breakerState()[0].windowMs).toBe(Math.min(w, BREAKER_MAX_MS));
    }
    expect(rpcStats()[OFF].eth_blockNumber.skipped).toBeGreaterThanOrEqual(2);
    off = { result: '0x10' };
    t += 2 * BREAKER_MAX_MS;
    expect(await c.getBlockNumber({ cacheTime: 0 })).toBe(0x10n);
    expect(breakerState()[0]).toMatchObject({ state: 'closed', windowMs: 0 });
  });

  it('jitter: the window is 0.8x to 1.2x', async () => {
    fakeFetch({ [OFF]: () => limited, [LNK]: chainOk('0x11') });
    setBreakerClock({ random: () => 0 });
    await client().getBlockNumber({ cacheTime: 0 });
    expect(breakerState()[0].openForMs).toBe(0.8 * BREAKER_BASE_MS);
  });
});

describe('fallback also failing keeps the rate-limit signal (F1)', () => {
  it('official -32005 + fallback unreachable: rethrown as rate-limited, fallback error as cause', async () => {
    fakeFetch({ [OFF]: () => limited, [LNK]: (m) => (m === 'eth_chainId' ? { result: '0x3e6' } : 'network') });
    const e = await caught(client().getBlockNumber({ cacheTime: 0 }));
    expect(isRateLimited(e)).toBe(true);
    expect(chainText(e)).toMatch(/fallback failed: HTTP request failed/);
    // and while the breaker is open (official skipped) the same holds
    const e2 = await caught(client().getBlockNumber({ cacheTime: 0 }));
    expect(isRateLimited(e2)).toBe(true);
    expect(chainText(e2)).toMatch(/breaker open/);
  });

  it('official -32005 + fallback on another chain: rate-limited with the chain-id message; probe never retried', async () => {
    const calls = fakeFetch({ [OFF]: () => limited, [LNK]: (m) => (m === 'eth_chainId' ? { result: '0x3e7' } : { result: '0x99' }) });
    const e = await caught(client(3).getBlockNumber({ cacheTime: 0 })); // txPublicClient-style retries
    expect(isRateLimited(e)).toBe(true);
    expect(chainText(e)).toMatch(/chain id 999, expected 998; not used/);
    expect(calls.filter((x) => x === `${LNK}:eth_chainId`)).toHaveLength(1);
    expect(calls.filter((x) => x === `${LNK}:eth_blockNumber`)).toEqual([]);
  });

  it('official network error + fallback on another chain: WrongChainRpcError, readable, not retried', async () => {
    const calls = fakeFetch({ [OFF]: () => 'network', [LNK]: (m) => (m === 'eth_chainId' ? { result: '0x3e7' } : { result: '0x99' }) });
    const e = await caught(client(3).getBlockNumber({ cacheTime: 0 }));
    expect(firstLine(e)).toBe('RPC rpcs.chain.link answered chain id 999, expected 998; not used.');
    expect(isRateLimited(e)).toBe(false);
    expect(calls).toEqual([`${OFF}:eth_blockNumber`, `${LNK}:eth_chainId`]); // 2 calls, no viem retries
  });

  it('a failed chain-id probe is not cached: the next call probes again (F5)', async () => {
    let probe: Answer = 'network';
    const calls = fakeFetch({ [OFF]: () => limited, [LNK]: (m) => (m === 'eth_chainId' ? probe : { result: '0x11' }) });
    const c = client();
    expect(isRateLimited(await caught(c.getBlockNumber({ cacheTime: 0 })))).toBe(true);
    probe = { result: '0x3e6' };
    expect(await c.getBlockNumber({ cacheTime: 0 })).toBe(0x11n);
    expect(calls.filter((x) => x === `${LNK}:eth_chainId`)).toHaveLength(2);
  });
});

describe('fallbackUrls (VITE_RPC_FALLBACK_URLS)', () => {
  const defaults = [LINK];
  it('unset: default list for the default primary, none for a custom primary', () => {
    expect(fallbackUrls(OFFICIAL, OFFICIAL, undefined, defaults)).toEqual([LINK]);
    expect(fallbackUrls('http://127.0.0.1:8545', OFFICIAL, undefined, defaults)).toEqual([]);
  });
  it('empty disables; comma list is trimmed, deduplicated, primary dropped', () => {
    expect(fallbackUrls(OFFICIAL, OFFICIAL, '', defaults)).toEqual([]);
    expect(fallbackUrls(OFFICIAL, OFFICIAL, ' https://a.example/rpc/ , ,https://a.example/rpc,' + OFFICIAL, defaults)).toEqual(['https://a.example/rpc']);
  });
});
