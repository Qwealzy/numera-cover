import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallExecutionError, ExecutionRevertedError, HttpRequestError, LimitExceededRpcError, RpcRequestError, getContractError } from 'viem';
import { mockPositionSourceAbi } from '../generated/abi';
import { PURCHASE_MAX_ATTEMPTS, lookupPurchase, purchaseLookupState, resetPurchaseLookups } from './covers';
import { isRateLimited, lookupWithRetry } from './rpc';

const SOURCE = '0xCD44735B5640ab54777d31caf88D8EBb19730645';
const RPC = 'https://rpc.hyperliquid-testnet.xyz/evm';

/** A viem contract error for position(user, 3), the way readContract/multicall builds it. */
function contractError(cause: Error, user: `0x${string}`) {
  return getContractError(cause as never, { abi: mockPositionSourceAbi, address: SOURCE, functionName: 'position', args: [user, 3] });
}

describe('isRateLimited: no bare "429" match (review M2)', () => {
  it('a genuine revert whose args contain "429" (0x111…429111) is NOT a rate limit', () => {
    const user = '0x1111111111111111111111111111111111429111';
    const revert = contractError(new CallExecutionError(new ExecutionRevertedError({ message: 'execution reverted' }), {}), user);
    expect(revert.message).toContain('429111'); // the old /429/ regex matched exactly this
    expect(isRateLimited(revert)).toBe(false);
    // also a revert with a tx-hash-like "…429…" in its text
    expect(isRateLimited(new Error('execution reverted: tx 0xabc429def failed'))).toBe(false);
  });

  it('a real -32005 inside a viem contract error is a rate limit (cause chain walk)', () => {
    const rpc = new RpcRequestError({ body: {}, url: RPC, error: { code: -32005, message: 'rate limited' } });
    const e = contractError(new CallExecutionError(new LimitExceededRpcError(rpc), {}), '0x1111111111111111111111111111111111429111');
    expect(isRateLimited(e)).toBe(true);
  });

  it('an HTTP 429 is a rate limit (status field, and the explicit text forms)', () => {
    expect(isRateLimited(new HttpRequestError({ url: RPC, status: 429, details: 'Too Many Requests' }))).toBe(true);
    expect(isRateLimited(new Error('HTTP 429 from upstream'))).toBe(true);
    expect(isRateLimited(new Error('request failed, status: 429'))).toBe(true);
    expect(isRateLimited({ code: -32005 })).toBe(true);
    expect(isRateLimited(new HttpRequestError({ url: RPC, status: 500, details: 'Internal Server Error' }))).toBe(false);
  });
});

describe('lookupWithRetry (fake timers, review M1)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("'execution reverted' is not retried: one call, then give up", async () => {
    const fn = vi.fn(() => Promise.reject(new Error('execution reverted')));
    const giveUp = vi.fn();
    lookupWithRetry(fn, { maxAttempts: 4, delayMs: () => 15_000, onSuccess: vi.fn(), onGiveUp: giveUp });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(giveUp).toHaveBeenCalledWith(expect.objectContaining({ message: 'execution reverted' }), 1);
  });

  it('a persistent rate limit stops after the attempt cap', async () => {
    const fn = vi.fn(() => Promise.reject(Object.assign(new Error('rate limited'), { code: -32005 })));
    const giveUp = vi.fn();
    lookupWithRetry(fn, { maxAttempts: 4, delayMs: () => 15_000, onSuccess: vi.fn(), onGiveUp: giveUp });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fn).toHaveBeenCalledTimes(4);
    expect(giveUp).toHaveBeenCalledOnce();
    expect(giveUp.mock.calls[0][1]).toBe(4);
  });

  it('cancel stops pending retries', async () => {
    const fn = vi.fn(() => Promise.reject(Object.assign(new Error('rate limited'), { code: -32005 })));
    const cancel = lookupWithRetry(fn, { maxAttempts: 4, delayMs: () => 15_000, onSuccess: vi.fn(), onGiveUp: vi.fn() });
    await vi.advanceTimersByTimeAsync(1);
    cancel();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('lookupPurchase: capped, cached failure, manual retry (review M1)', () => {
  const POOL = '0xda611e1a07260005ea5641e9fe633cd4d10c341e' as const;
  const cover = { id: 1n, start: 1790890665n };
  beforeEach(() => {
    vi.useFakeTimers();
    resetPurchaseLookups();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('non-rate-limit error: no retry, failure cached (no new lookup), force retries once more', async () => {
    const find = vi.fn(() => Promise.reject(new Error('execution reverted')));
    lookupPurchase(POOL, cover, { find });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(find).toHaveBeenCalledTimes(1);
    expect(purchaseLookupState(POOL, 1n)).toEqual({ state: 'failed', error: 'execution reverted' });
    lookupPurchase(POOL, cover, { find }); // a re-render does not re-run a failed lookup
    await vi.advanceTimersByTimeAsync(60_000);
    expect(find).toHaveBeenCalledTimes(1);
    const ok = { tx: '0x3fb5c7073c2b9add2005ac541ac6626bb8b147c68c9ef1e0a35739df86166d44' as const, block: 65774354n };
    find.mockImplementationOnce(() => Promise.resolve(ok) as never);
    lookupPurchase(POOL, cover, { find, force: true }); // the Tx cell "retry"
    await vi.advanceTimersByTimeAsync(1);
    expect(find).toHaveBeenCalledTimes(2);
    expect(purchaseLookupState(POOL, 1n)).toEqual({ state: 'done', tx: ok });
  });

  it(`rate limit: stops after ${PURCHASE_MAX_ATTEMPTS} attempts and caches the failure`, async () => {
    const find = vi.fn(() => Promise.reject(Object.assign(new Error('rate limited'), { code: -32005 })));
    lookupPurchase(POOL, cover, { find });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(find).toHaveBeenCalledTimes(PURCHASE_MAX_ATTEMPTS);
    expect(purchaseLookupState(POOL, 1n)).toEqual({ state: 'failed', error: 'RPC rate-limited (-32005/429)' });
  });
});
