import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransactionReceiptNotFoundError, formatTransactionReceipt, type Hex, type RpcTransactionReceipt } from 'viem';
import { PURCHASES_KEY, browserStorage, forgetPurchase, purchasedCoverIds, rememberPurchase, storedPurchase } from './purchases';
import { findPurchaseStoredOrScan, lookupPurchase, purchaseLookupState, resetPurchaseLookups } from './covers';

// Real buyCover receipt of cover #1 on the HyperCore pool (chain 998), see receipt.test.ts.
const receipt = formatTransactionReceipt(
  (JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'receipt-buycover.json'), 'utf8')) as { result: RpcTransactionReceipt }).result,
);
const BUY: Hex = '0x3fb5c7073c2b9add2005ac541ac6626bb8b147c68c9ef1e0a35739df86166d44';
const POOL = '0xDa611E1a07260005ea5641e9Fe633CD4d10C341e' as const;
const OTHER_POOL = '0x00000000000000000000000000000000000000aa' as const;
const CHAIN = 998;

/** In-memory Storage with the two methods the store uses. */
function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}
const throwing = {
  getItem: () => {
    throw new DOMException('denied', 'SecurityError');
  },
  setItem: () => {
    throw new DOMException('quota', 'QuotaExceededError');
  },
};

describe('purchase store (localStorage, versioned key)', () => {
  it('remember / read / forget, keyed by chain + pool (case-insensitive) + coverId', () => {
    const s = memStorage();
    rememberPurchase(CHAIN, POOL, 1n, BUY, 65774354n, s);
    expect(JSON.parse(s.m.get(PURCHASES_KEY)!)).toHaveLength(1);
    expect(storedPurchase(CHAIN, POOL.toLowerCase() as `0x${string}`, 1n, s)).toMatchObject({ txHash: BUY, block: '65774354', coverId: '1' });
    expect(storedPurchase(CHAIN, POOL, 2n, s)).toBeUndefined();
    expect(storedPurchase(31337, POOL, 1n, s)).toBeUndefined();
    rememberPurchase(CHAIN, POOL, 1n, BUY, 65774354n, s); // no duplicate
    expect(JSON.parse(s.m.get(PURCHASES_KEY)!)).toHaveLength(1);
    forgetPurchase(CHAIN, POOL, 1n, s);
    expect(storedPurchase(CHAIN, POOL, 1n, s)).toBeUndefined();
  });

  it('throwing storage, a throwing accessor and corrupt JSON never throw', () => {
    expect(() => rememberPurchase(CHAIN, POOL, 1n, BUY, 1n, throwing)).not.toThrow();
    expect(storedPurchase(CHAIN, POOL, 1n, throwing)).toBeUndefined();
    expect(() => forgetPurchase(CHAIN, POOL, 1n, throwing)).not.toThrow();
    const s = memStorage();
    s.m.set(PURCHASES_KEY, '{not json');
    expect(storedPurchase(CHAIN, POOL, 1n, s)).toBeUndefined();
    s.m.set(PURCHASES_KEY, JSON.stringify([{ chainId: CHAIN, pool: POOL, coverId: '1', txHash: 'nope', block: '1' }]));
    expect(storedPurchase(CHAIN, POOL, 1n, s)).toBeUndefined(); // malformed record ignored
    vi.stubGlobal('localStorage', undefined);
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    try {
      expect(browserStorage()).toBeUndefined();
      expect(() => rememberPurchase(CHAIN, POOL, 1n, BUY, 1n)).not.toThrow();
      expect(storedPurchase(CHAIN, POOL, 1n)).toBeUndefined();
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
      vi.unstubAllGlobals();
    }
  });

  it('purchasedCoverIds decodes CoverPurchased of the given pool only', () => {
    expect(purchasedCoverIds(receipt, POOL)).toEqual([1n]);
    expect(purchasedCoverIds(receipt, OTHER_POOL)).toEqual([]);
  });
});

describe('findPurchaseStoredOrScan: stored hash first, verified, else scan', () => {
  const scanned = { tx: '0x' + '11'.repeat(32), block: 5n } as { tx: Hex; block: bigint };
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('a stored hash whose receipt holds CoverPurchased(pool, id) is used: one receipt read, no scan', async () => {
    const s = memStorage();
    rememberPurchase(CHAIN, POOL, 1n, BUY, 65774354n, s);
    const client = { getTransactionReceipt: vi.fn(async () => receipt) };
    const scan = vi.fn(async () => scanned);
    const r = await findPurchaseStoredOrScan(POOL, 1n, 0n, { client: client as never, storage: s, scan, chainId: CHAIN });
    expect(r).toEqual({ tx: BUY, block: 65774354n });
    expect(client.getTransactionReceipt).toHaveBeenCalledExactlyOnceWith({ hash: BUY });
    expect(scan).not.toHaveBeenCalled();
  });

  it('wrong coverId in the receipt: stored record ignored and dropped, then the scan', async () => {
    const s = memStorage();
    rememberPurchase(CHAIN, POOL, 2n, BUY, 65774354n, s); // receipt is cover #1's
    const client = { getTransactionReceipt: vi.fn(async () => receipt) };
    const scan = vi.fn(async () => scanned);
    expect(await findPurchaseStoredOrScan(POOL, 2n, 0n, { client: client as never, storage: s, scan, chainId: CHAIN })).toBe(scanned);
    expect(scan).toHaveBeenCalledOnce();
    expect(storedPurchase(CHAIN, POOL, 2n, s)).toBeUndefined();
  });

  it('a receipt from another pool or a reverted tx does not confirm it either', async () => {
    const s = memStorage();
    rememberPurchase(CHAIN, OTHER_POOL, 1n, BUY, 1n, s);
    const scan = vi.fn(async () => scanned);
    const client = { getTransactionReceipt: vi.fn(async () => receipt) };
    expect(await findPurchaseStoredOrScan(OTHER_POOL, 1n, 0n, { client: client as never, storage: s, scan, chainId: CHAIN })).toBe(scanned);
    rememberPurchase(CHAIN, POOL, 1n, BUY, 1n, s);
    const reverted = { getTransactionReceipt: vi.fn(async () => ({ ...receipt, status: 'reverted' as const })) };
    expect(await findPurchaseStoredOrScan(POOL, 1n, 0n, { client: reverted as never, storage: s, scan, chainId: CHAIN })).toBe(scanned);
  });

  it('receipt not found: dropped, scan; rate-limited: rethrown (record kept, lookupPurchase retries)', async () => {
    const s = memStorage();
    rememberPurchase(CHAIN, POOL, 1n, BUY, 1n, s);
    const scan = vi.fn(async () => scanned);
    const limited = { getTransactionReceipt: vi.fn(async () => Promise.reject(Object.assign(new Error('rate limited'), { code: -32005 }))) };
    await expect(findPurchaseStoredOrScan(POOL, 1n, 0n, { client: limited as never, storage: s, scan, chainId: CHAIN })).rejects.toThrow('rate limited');
    expect(scan).not.toHaveBeenCalled();
    expect(storedPurchase(CHAIN, POOL, 1n, s)).toBeDefined();
    const missing = { getTransactionReceipt: vi.fn(async () => Promise.reject(new TransactionReceiptNotFoundError({ hash: BUY }))) };
    expect(await findPurchaseStoredOrScan(POOL, 1n, 0n, { client: missing as never, storage: s, scan, chainId: CHAIN })).toBe(scanned);
    expect(storedPurchase(CHAIN, POOL, 1n, s)).toBeUndefined();
  });

  it('storage that throws: straight to the scan, no error', async () => {
    const client = { getTransactionReceipt: vi.fn(async () => receipt) };
    const scan = vi.fn(async () => scanned);
    expect(await findPurchaseStoredOrScan(POOL, 1n, 0n, { client: client as never, storage: throwing, scan, chainId: CHAIN })).toBe(scanned);
    expect(client.getTransactionReceipt).not.toHaveBeenCalled();
  });
});

describe('lookupPurchase logs and states', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetPurchaseLookups();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('logs the start (info) and every rate-limited attempt (warn), then fails after the cap', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const find = vi.fn(() => Promise.reject(Object.assign(new Error('rate limited'), { code: -32005 })));
    const e = lookupPurchase(POOL, { id: 1n, start: 0n }, { find });
    expect(e.state).toBe('pending');
    expect(info).toHaveBeenCalledWith(expect.stringContaining('locating purchase tx for cover #1'));
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('purchase tx lookup for cover #1 rate-limited'))).toHaveLength(3);
    expect(purchaseLookupState(POOL, 1n)?.state).toBe('failed');
  });
});
