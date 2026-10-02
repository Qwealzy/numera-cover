import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';
import { POOLS, perpIndexOf } from '../config';
import { fmtUsdc } from './format';
import type { ApiAccount } from './liq';
import { POLLED_CAP_RETRY_MS, capView, loadAccountCtx, loadPositions, readCaps, type LoadDeps, type PositionRow } from './positions';
import { PartialData, isRateLimited, retryRateLimited } from './rpc';
import { clearAbstractionCache, fetchAbstraction as realFetchAbstraction, spotCollateralTotal } from './info';

// Founder wallet test 2026-10-02: Info API BTC long 0.00117 @ 85065, 10x cross; position source
// position(wallet, BTC) -> (117, 99526050, 10), cap 9.952605 (docs/history/backlog-2026-10-01-02.md, app explorer + cap fix checkpoint).
const WALLET = getAddress('0x66DDA666bf32Cae48cf190bbAd04Effc90b7d5e7');
const BTC = perpIndexOf('BTC')!;
const account: ApiAccount = {
  marginSummary: { accountValue: '100', totalNtlPos: '99', totalRawUsd: '1', totalMarginUsed: '9.9' },
  crossMarginSummary: { accountValue: '100', totalNtlPos: '99', totalRawUsd: '1', totalMarginUsed: '9.9' },
  crossMaintenanceMarginUsed: '1.5',
  assetPositions: [
    {
      type: 'oneWay',
      position: {
        coin: 'BTC',
        szi: '0.00117',
        entryPx: '85065.0',
        positionValue: '99.0054',
        unrealizedPnl: '-0.5',
        liquidationPx: null,
        marginUsed: '9.9',
        maxLeverage: 40,
        leverage: { type: 'cross', value: 10 },
      },
    },
  ],
};
const okResult = { status: 'success' as const, result: [117n, 99526050n, 10] as const };
const rateLimited = () => Object.assign(new Error('HTTP request failed. Details: rate limited'), { code: -32005 });
const fetchAccount = (async () => account) as unknown as NonNullable<LoadDeps['fetchAccount']>;
const fetchAbstraction = async () => 'default';

function client(answers: (() => unknown)[]) {
  let n = 0;
  const multicall = vi.fn(async () => {
    const a = answers[Math.min(n++, answers.length - 1)]();
    if (a instanceof Error) throw a;
    return a;
  });
  return { multicall } as unknown as NonNullable<LoadDeps['client']> & { multicall: typeof multicall };
}

afterEach(() => vi.restoreAllMocks());

describe('retryRateLimited', () => {
  it('retries only rate-limit errors, then rethrows the real error', async () => {
    const sleep = vi.fn(async () => {});
    let n = 0;
    await expect(retryRateLimited(async () => (++n < 3 ? Promise.reject(rateLimited()) : 'ok'), { sleep })).resolves.toBe('ok');
    expect(sleep).toHaveBeenCalledTimes(2);
    const revert = new Error('execution reverted');
    let m = 0;
    await expect(retryRateLimited(async () => (++m, Promise.reject(revert)), { sleep })).rejects.toBe(revert);
    expect(m).toBe(1);
    await expect(retryRateLimited(async () => Promise.reject(rateLimited()), { sleep, delaysMs: [1, 1] })).rejects.toMatchObject({ code: -32005 });
  });
});

describe('max payout (cap) read', () => {
  it('a rate-limited first answer is retried and the cap arrives (9.952605)', async () => {
    const c = client([rateLimited, () => [okResult]]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rows = await loadPositions(POOLS.hypercore, WALLET, undefined, undefined, { client: c, fetchAccount, fetchAbstraction, retryDelaysMs: [0, 0] });
    expect(c.multicall).toHaveBeenCalledTimes(2);
    expect(rows[0].cap).toBe(9952605n);
    expect(rows[0].capError).toBeUndefined();
    expect(capView(rows[0], fmtUsdc).text).toBe(fmtUsdc(9952605n));
  });

  it('polled path makes ONE retry by default, then hands the rate limit to usePoll as PartialData (rows kept)', async () => {
    expect(POLLED_CAP_RETRY_MS).toHaveLength(1);
    const c = client([rateLimited]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = await loadPositions(POOLS.hypercore, WALLET, undefined, undefined, { client: c, fetchAccount, fetchAbstraction, retryDelaysMs: [0] }).catch((x) => x);
    expect(c.multicall).toHaveBeenCalledTimes(2); // 1 + one retry: at most 2 eth_calls per poll under a sustained limit
    expect(e).toBeInstanceOf(PartialData);
    expect(isRateLimited(e)).toBe(true); // usePoll: busy hint + backoff
    const rows = (e as PartialData<PositionRow[]>).partial;
    expect(rows).toHaveLength(1);
    expect(rows[0].cap).toBeUndefined();
    expect(rows[0].capError).toMatch(/rate-limited/);
    expect(rows[0].onchain).toEqual({ error: rows[0].capError });
    expect(err).toHaveBeenCalledOnce();
    const v = capView(rows[0], fmtUsdc);
    expect(v).toMatchObject({ text: 'unavailable (retry)', unavailable: true });
    expect(v.title).toMatch(/rate-limited/);
  });

  it('viem allowFailure turns a rate-limited eth_call into per-entry failures: those are retried too', async () => {
    // Shape seen in the browser 2026-10-02: multicall resolved, every entry failure "Request exceeds defined limit."
    const perEntryLimited = () => [{ status: 'failure', error: new Error('Request exceeds defined limit.', { cause: { code: -32005 } }) }];
    const c = client([perEntryLimited, () => [okResult]]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rows = await loadPositions(POOLS.hypercore, WALLET, undefined, undefined, { client: c, fetchAccount, fetchAbstraction, retryDelaysMs: [0, 0] });
    expect(c.multicall).toHaveBeenCalledTimes(2);
    expect(rows[0].cap).toBe(9952605n);

    const c2 = client([perEntryLimited]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const e2 = await loadPositions(POOLS.hypercore, WALLET, undefined, undefined, { client: c2, fetchAccount, fetchAbstraction, retryDelaysMs: [0, 0] }).catch((x) => x);
    expect(c2.multicall).toHaveBeenCalledTimes(3);
    expect((e2 as PartialData<PositionRow[]>).partial[0].capError).toBe('RPC rate-limited (-32005/429); retrying with backoff');
  });

  it('a non-rate-limit failure is not retried, is not PartialData, and its message is the tooltip', async () => {
    const c = client([() => new Error('fetch failed: ECONNRESET')]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await readCaps(POOLS.hypercore.positionSource, WALLET, [BTC], { client: c, retryDelaysMs: [0, 0] });
    expect(c.multicall).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ error: 'fetch failed: ECONNRESET', rateLimited: false });
    const rows = await loadPositions(POOLS.hypercore, WALLET, undefined, undefined, { client: client([() => new Error('boom')]), fetchAccount, fetchAbstraction });
    expect(rows[0].capError).toBe('boom');
  });

  it('an abort (user clicked retry) stops a chain waiting on a rate-limit retry: no further eth_call', async () => {
    const c = client([rateLimited, () => [okResult]]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctrl = new AbortController();
    const p = readCaps(POOLS.hypercore.positionSource, WALLET, [BTC], { client: c, retryDelaysMs: [5_000] }, ctrl.signal);
    await new Promise((r) => setTimeout(r, 10));
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(c.multicall).toHaveBeenCalledTimes(1);
  });

  it('a reverted entry inside the multicall becomes the row error', async () => {
    const c = client([() => [{ status: 'failure', error: new Error('execution reverted') }]]);
    const rows = await loadPositions(POOLS.hypercore, WALLET, undefined, undefined, { client: c, fetchAccount, fetchAbstraction });
    expect(rows[0].capError).toMatch(/position read failed: execution reverted/);
    expect(capView(rows[0], fmtUsdc).text).toBe('unavailable (retry)');
  });

  it('capView: unconfigured perp is n/a, not unavailable', () => {
    expect(capView({ cap: undefined, perpIndex: undefined }, fmtUsdc)).toMatchObject({ text: 'n/a', unavailable: false });
    expect(capView({ cap: undefined, perpIndex: BTC }, fmtUsdc).text).toBe('unavailable (retry)');
  });
});

describe('account mode (userAbstraction)', () => {
  const spot = {
    balances: [
      { coin: 'HYPE', token: 1105, total: '5', hold: '0' },
      { coin: 'USDC', token: 0, total: '800.232358', hold: '10.128456' },
    ],
  };

  it('unified account: rows carry the mode and the liq price uses the spot USDC total', async () => {
    const fetchSpotAccount = vi.fn(async () => spot);
    const rows = await loadPositions(POOLS.hypercore, WALLET, undefined, undefined, {
      client: client([() => [okResult]]),
      fetchAccount,
      fetchAbstraction: async () => 'unifiedAccount',
      fetchSpotAccount,
    });
    expect(rows[0].accountMode).toBe('unified');
    expect(rows[0].liq.formula).toBe('unified-cross');
    expect(rows[0].liq.inputs!.marginAvailable).toBeCloseTo(800.232358 - 1.5, 6);
    expect(fetchSpotAccount).toHaveBeenCalledOnce();
  });

  it('standard account: no spot read, perp cross formula', async () => {
    const fetchSpotAccount = vi.fn(async () => spot);
    const rows = await loadPositions(POOLS.hypercore, WALLET, undefined, undefined, { client: client([() => [okResult]]), fetchAccount, fetchAbstraction, fetchSpotAccount });
    expect(rows[0].accountMode).toBe('standard');
    expect(rows[0].liq.formula).toBe('cross');
    expect(fetchSpotAccount).not.toHaveBeenCalled();
  });

  it('a failed userAbstraction read falls back to the standard formula and leaves the mode unknown', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rows = await loadPositions(POOLS.hypercore, WALLET, undefined, undefined, {
      client: client([() => [okResult]]),
      fetchAccount,
      fetchAbstraction: async () => Promise.reject(new Error('Info API 500')),
    });
    expect(rows[0].accountMode).toBeUndefined();
    expect(rows[0].liq.formula).toBe('cross');
  });
});

describe('fetchAbstraction cache', () => {
  it('reads userAbstraction once per wallet (case-insensitive) and does not cache a failure', async () => {
    clearAbstractionCache();
    const bodies: string[] = [];
    let fail = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init: { body: string }) => {
        bodies.push(init.body);
        if (fail) return { ok: false, status: 500 };
        return { ok: true, json: async () => 'unifiedAccount' };
      }),
    );
    try {
      await expect(realFetchAbstraction(WALLET)).rejects.toThrow(/500/);
      fail = false;
      await expect(realFetchAbstraction(WALLET)).resolves.toBe('unifiedAccount');
      await expect(realFetchAbstraction(WALLET.toLowerCase())).resolves.toBe('unifiedAccount');
      expect(bodies).toHaveLength(2);
      expect(JSON.parse(bodies[1])).toEqual({ type: 'userAbstraction', user: WALLET });
    } finally {
      vi.unstubAllGlobals();
      clearAbstractionCache();
    }
  });

  it('spotCollateralTotal finds USDC by name', () => {
    expect(spotCollateralTotal({ balances: [{ coin: 'USDC', token: 0, total: '800.04', hold: '10.11' }] })).toBe(800.04);
    expect(spotCollateralTotal({ balances: [] })).toBeUndefined();
  });
});

// Live read against testnet 998 (read-only eth_call), skipped unless NUMERA_LIVE=1:
//   NUMERA_LIVE=1 npx vitest run src/lib/positions.test.ts
describe.skipIf(!process.env.NUMERA_LIVE)('live testnet', () => {
  it('founder wallet cap through the app function readCaps (the Protect "Max payout" path)', async () => {
    const r = await readCaps(POOLS.hypercore.positionSource, WALLET, [BTC]);
    if (!(r instanceof Map)) throw new Error(r.error);
    const p = r.get(BTC);
    console.log('[live] positionSource', POOLS.hypercore.positionSource, 'perp', BTC, 'result', p, 'cap', p && 'cap' in p ? fmtUsdc(p.cap) : p);
    expect(p).toMatchObject({ cap: 9952605n });
  }, 60_000);

  it('founder wallet liq price, perp-only (before) vs account-mode aware (after)', async () => {
    const info = await import('./info');
    const { positionLiq } = await import('./liq');
    const [acct, market, ctx] = await Promise.all([info.fetchAccount(WALLET), info.fetchMarket(), loadAccountCtx(WALLET, undefined)]);
    for (const { position: p } of acct.assetPositions) {
      const mark = Number(market.byName.get(p.coin)?.ctx.markPx ?? 0);
      const before = positionLiq(p, acct, mark);
      const after = positionLiq(p, acct, mark, ctx);
      console.log('[live]', p.coin, 'mode', ctx.mode, 'spot USDC total', ctx.spotCollateralTotal, 'mark', mark, 'api liquidationPx', p.liquidationPx);
      console.log('[live] before', before.formula, before.px, 'margin_available', before.inputs?.marginAvailable);
      console.log('[live] after ', after.formula, after.px, 'margin_available', after.inputs?.marginAvailable);
    }
  }, 60_000);
});
