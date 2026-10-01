import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';
import { POOLS, perpIndexOf } from '../config';
import { fmtUsdc } from './format';
import type { ApiAccount } from './liq';
import { capView, loadPositions, readCaps, type LoadDeps } from './positions';
import { retryRateLimited } from './rpc';

// Founder wallet test 2026-10-02: Info API BTC long 0.00117 @ 85065, 10x cross; position source
// position(wallet, BTC) -> (117, 99526050, 10), cap 9.952605 (backlog.md checkpoint).
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
    const rows = await loadPositions(POOLS.hypercore, WALLET, undefined, undefined, { client: c, fetchAccount, retryDelaysMs: [0, 0] });
    expect(c.multicall).toHaveBeenCalledTimes(2);
    expect(rows[0].cap).toBe(9952605n);
    expect(rows[0].capError).toBeUndefined();
    expect(capView(rows[0], fmtUsdc).text).toBe(fmtUsdc(9952605n));
  });

  it('when the read keeps failing: rows still load, cap shows "unavailable (retry)" with the reason, error is logged', async () => {
    const c = client([rateLimited]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rows = await loadPositions(POOLS.hypercore, WALLET, undefined, undefined, { client: c, fetchAccount, retryDelaysMs: [0, 0] });
    expect(c.multicall).toHaveBeenCalledTimes(3);
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
    const rows = await loadPositions(POOLS.hypercore, WALLET, undefined, undefined, { client: c, fetchAccount, retryDelaysMs: [0, 0] });
    expect(c.multicall).toHaveBeenCalledTimes(2);
    expect(rows[0].cap).toBe(9952605n);

    const c2 = client([perEntryLimited]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const rows2 = await loadPositions(POOLS.hypercore, WALLET, undefined, undefined, { client: c2, fetchAccount, retryDelaysMs: [0, 0] });
    expect(c2.multicall).toHaveBeenCalledTimes(3);
    expect(rows2[0].capError).toBe('RPC rate-limited (-32005/429) after retries');
  });

  it('a non-rate-limit failure is not retried and its message is the tooltip', async () => {
    const c = client([() => new Error('fetch failed: ECONNRESET')]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await readCaps(POOLS.hypercore.positionSource, WALLET, [BTC], { client: c, retryDelaysMs: [0, 0] });
    expect(c.multicall).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ error: 'fetch failed: ECONNRESET' });
  });

  it('a reverted entry inside the multicall becomes the row error', async () => {
    const c = client([() => [{ status: 'failure', error: new Error('execution reverted') }]]);
    const rows = await loadPositions(POOLS.hypercore, WALLET, undefined, undefined, { client: c, fetchAccount });
    expect(rows[0].capError).toMatch(/position read failed: execution reverted/);
    expect(capView(rows[0], fmtUsdc).text).toBe('unavailable (retry)');
  });

  it('capView: unconfigured perp is n/a, not unavailable', () => {
    expect(capView({ cap: undefined, perpIndex: undefined }, fmtUsdc)).toMatchObject({ text: 'n/a', unavailable: false });
    expect(capView({ cap: undefined, perpIndex: BTC }, fmtUsdc).text).toBe('unavailable (retry)');
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
});
