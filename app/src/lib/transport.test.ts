import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPublicClient } from 'viem';
import { fallbackUrls, readTransport, resetChainChecks, rpcStats } from './transport';

const OFFICIAL = 'https://rpc.hyperliquid-testnet.xyz/evm';
const LINK = 'https://rpcs.chain.link/hyperevm/testnet';
const chain = { id: 998, name: 't', nativeCurrency: { name: 'H', symbol: 'H', decimals: 18 }, rpcUrls: { default: { http: [OFFICIAL] } } } as const;

type Answer = { result?: unknown; error?: { code: number; message: string }; status?: number } | 'network';
/** Fake fetch: per host, a function from JSON-RPC method to the answer. Records every call as host:method. */
function fakeFetch(answers: Record<string, (method: string) => Answer>) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(url).host;
    const body = JSON.parse(String(init?.body));
    calls.push(`${host}:${body.method}`);
    const a = answers[host](body.method);
    if (a === 'network') throw new TypeError('Failed to fetch');
    const payload = { jsonrpc: '2.0', id: body.id, ...('error' in a ? { error: a.error } : { result: a.result }) };
    return new Response(JSON.stringify(payload), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

const limited = { error: { code: -32005, message: 'rate limited' } };

describe('readTransport: official RPC first, fallback on rate limit', () => {
  beforeEach(() => resetChainChecks());
  afterEach(() => vi.unstubAllGlobals());

  it('a -32005 on the official RPC moves the call to the second URL (chain id checked once)', async () => {
    const calls = fakeFetch({
      'rpc.hyperliquid-testnet.xyz': () => limited,
      'rpcs.chain.link': (m) => (m === 'eth_chainId' ? { result: '0x3e6' } : { result: [] }),
    });
    const client = createPublicClient({ chain, transport: readTransport([OFFICIAL, LINK], { chainId: 998 }) });
    const logs = await client.getLogs({ address: '0xda611e1a07260005ea5641e9fe633cd4d10c341e', fromBlock: 1n, toBlock: 2n });
    expect(logs).toEqual([]);
    await client.getLogs({ address: '0xda611e1a07260005ea5641e9fe633cd4d10c341e', fromBlock: 1n, toBlock: 2n });
    expect(calls).toEqual([
      'rpc.hyperliquid-testnet.xyz:eth_getLogs',
      'rpcs.chain.link:eth_chainId',
      'rpcs.chain.link:eth_getLogs',
      'rpc.hyperliquid-testnet.xyz:eth_getLogs', // no ranking: the official RPC is always tried first
      'rpcs.chain.link:eth_getLogs', // chain id not probed again
    ]);
    expect(rpcStats()['rpcs.chain.link'].eth_getLogs.ok).toBeGreaterThanOrEqual(2);
    expect(rpcStats()['rpc.hyperliquid-testnet.xyz'].eth_getLogs.limited).toBeGreaterThanOrEqual(2);
  });

  it('an HTTP 429 and a network error also move to the fallback; a healthy official RPC serves alone', async () => {
    let mode: 'http429' | 'network' | 'ok' = 'http429';
    const calls = fakeFetch({
      'rpc.hyperliquid-testnet.xyz': () => (mode === 'http429' ? { ...limited, status: 429 } : mode === 'network' ? 'network' : { result: '0x10' }),
      'rpcs.chain.link': (m) => (m === 'eth_chainId' ? { result: '0x3e6' } : { result: '0x11' }),
    });
    const client = createPublicClient({ chain, transport: readTransport([OFFICIAL, LINK], { chainId: 998 }) });
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(0x11n);
    mode = 'network';
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(0x11n);
    mode = 'ok';
    calls.length = 0;
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(0x10n);
    expect(calls).toEqual(['rpc.hyperliquid-testnet.xyz:eth_blockNumber']);
  });

  it('a fallback that answers another chain id is never read from', async () => {
    const calls = fakeFetch({
      'rpc.hyperliquid-testnet.xyz': () => limited,
      'rpcs.chain.link': (m) => (m === 'eth_chainId' ? { result: '0x3e7' } : { result: '0x99' }), // 999
    });
    const client = createPublicClient({ chain, transport: readTransport([OFFICIAL, LINK], { chainId: 998 }) });
    await expect(client.getBlockNumber({ cacheTime: 0 })).rejects.toThrow(/chain id 999, expected 998/);
    await expect(client.getBlockNumber({ cacheTime: 0 })).rejects.toThrow(/chain id 999, expected 998/);
    expect(calls.filter((c) => c === 'rpcs.chain.link:eth_blockNumber')).toEqual([]);
    expect(calls.filter((c) => c === 'rpcs.chain.link:eth_chainId')).toHaveLength(1); // wrong chain cached
  });

  it('a revert is thrown at once, not re-sent to the fallback', async () => {
    const calls = fakeFetch({
      'rpc.hyperliquid-testnet.xyz': () => ({ error: { code: 3, message: 'execution reverted' } }),
      'rpcs.chain.link': () => ({ result: '0x3e6' }),
    });
    const client = createPublicClient({ chain, transport: readTransport([OFFICIAL, LINK], { chainId: 998 }) });
    await expect(client.call({ to: '0xda611e1a07260005ea5641e9fe633cd4d10c341e', data: '0x' })).rejects.toThrow();
    expect(calls).toEqual(['rpc.hyperliquid-testnet.xyz:eth_call']);
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
