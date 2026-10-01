// Data functions behind useCovers (kept React-free so they are unit-tested).
import { TransactionReceiptNotFoundError, type Address } from 'viem';
import { hyperEvmTestnet, type PoolConfig } from '../config';
import { backoffMs, cached, isRateLimited, lookupWithRetry } from './rpc';
import { publicClient } from './chain';
import { findPurchaseQueued, firstLine, readCovers, scanRecentEvents, type Cover, type CoverEvents, type ReadClient } from './pool';
import { browserStorage, forgetPurchase, purchasedCoverIds, storedPurchase } from './purchases';

/** How many covers the UI reads (newest first) and how many 1000-block log windows it scans. */
export const COVER_LIMIT = 200;
export const EVENT_CHUNKS = 4;

/**
 * The newest covers of `pool`, given its on-chain `coverCount` (from the same snapshot that showed
 * "Covers sold"). Throws instead of returning [] when the count says covers exist but none came back,
 * so the UI shows loading/error, never "No covers sold yet" next to "Covers sold 1".
 * `lockedAssets` is part of the cache key: a trigger or expiry changes it, a purchase changes the count,
 * and nothing else changes a cover.
 */
export async function loadCovers(
  pool: PoolConfig,
  coverCount: bigint,
  lockedAssets: bigint,
  client: ReadClient = publicClient,
  limit = COVER_LIMIT,
): Promise<Cover[]> {
  if (coverCount === 0n) return [];
  return cached(`covers:${pool.pool}:${coverCount}:${lockedAssets}:${limit}`, 60_000, async () => {
    const covers = await readCovers(pool, coverCount, limit, client);
    const want = coverCount < BigInt(limit) ? Number(coverCount) : limit;
    if (covers.length !== want || covers[0]?.id !== coverCount) {
      throw new Error(`Read ${covers.length} of ${want} covers from ${pool.pool}; retrying.`);
    }
    return covers;
  });
}

/** CoverPurchased / Triggered / Expired logs of the last EVENT_CHUNKS × 1000 blocks (tx links only). */
export function loadEvents(pool: Address, block: bigint, coverCount: bigint, lockedAssets: bigint): Promise<Map<string, CoverEvents>> {
  return cached(`events:${pool}:${coverCount}:${lockedAssets}`, 120_000, () => scanRecentEvents(pool, block, EVENT_CHUNKS));
}

// ---------------------------------------------------------------- purchase tx of older covers

type ReceiptClient = Pick<typeof publicClient, 'getTransactionReceipt'>;
type StorageLike = ReturnType<typeof browserStorage>;

/**
 * Purchase tx of cover `id`: a hash remembered by this browser's buyCover (lib/purchases.ts) is confirmed
 * with ONE eth_getTransactionReceipt (successful tx whose CoverPurchased log from `pool` has this coverId);
 * a missing, reverted or mismatching receipt drops the record. Without a confirmed record: the log scan.
 * Rate-limit errors are rethrown so lookupPurchase retries the whole thing with backoff.
 */
export async function findPurchaseStoredOrScan(
  pool: Address,
  id: bigint,
  start: bigint,
  deps: { client?: ReceiptClient; storage?: StorageLike; scan?: FindPurchase; chainId?: number } = {},
): Promise<CoverEvents['purchased']> {
  const chainId = deps.chainId ?? hyperEvmTestnet.id;
  const storage = deps.storage ?? browserStorage();
  const rec = storedPurchase(chainId, pool, id, storage);
  if (rec) {
    try {
      const r = await (deps.client ?? publicClient).getTransactionReceipt({ hash: rec.txHash });
      if (r.status === 'success' && purchasedCoverIds(r, pool).includes(id)) return { tx: rec.txHash, block: r.blockNumber };
      console.warn(`[numera] stored purchase tx ${rec.txHash} does not hold CoverPurchased #${id} of ${pool}; ignored, scanning logs`);
      forgetPurchase(chainId, pool, id, storage);
    } catch (e) {
      if (isRateLimited(e)) throw e;
      console.warn(`[numera] stored purchase tx ${rec.txHash} for cover #${id} not confirmed (${firstLine(e)}); scanning logs`);
      if (e instanceof TransactionReceiptNotFoundError) forgetPurchase(chainId, pool, id, storage);
    }
  }
  return (deps.scan ?? findPurchaseQueued)(pool, id, start);
}

/** True when this browser remembered a purchase tx for the cover (no RPC call). */
export const hasStoredPurchase = (pool: Address, id: bigint): boolean => storedPurchase(hyperEvmTestnet.id, pool, id) !== undefined;

/** "All in pool" view: rows (newest first) whose purchase tx is located without a click. */
export const AUTO_LOCATE_ALL = 5;

export const PURCHASE_MAX_ATTEMPTS = 4;
export type PurchaseLookup =
  | { state: 'pending'; done: Promise<void> }
  | { state: 'done'; tx: CoverEvents['purchased'] }
  | { state: 'failed'; error: string };
type FindPurchase = (pool: Address, id: bigint, start: bigint) => Promise<CoverEvents['purchased']>;
const purchaseLookups = new Map<string, PurchaseLookup>();

/**
 * Locate a cover's purchase tx once per page (shared by every row showing it). Retries ONLY rate-limit
 * errors, at most PURCHASE_MAX_ATTEMPTS attempts with backoff (>= 15 s). Any other error, or the cap,
 * ends in `failed` with the reason (logged); the Tx cell then offers a manual retry (`force`).
 */
export function lookupPurchase(
  pool: Address,
  c: Pick<Cover, 'id' | 'start'>,
  opts: { force?: boolean; find?: FindPurchase; delayMs?: (failed: number) => number } = {},
): PurchaseLookup {
  const key = `${pool}:${c.id}`;
  const cur = purchaseLookups.get(key);
  if (cur && !(opts.force && cur.state === 'failed')) return cur;
  const find = opts.find ?? findPurchaseStoredOrScan;
  console.info(`[numera] locating purchase tx for cover #${c.id} of ${pool}`);
  let settle!: () => void;
  const entry: PurchaseLookup = { state: 'pending', done: new Promise<void>((r) => (settle = r)) };
  purchaseLookups.set(key, entry);
  lookupWithRetry(() => find(pool, c.id, c.start), {
    maxAttempts: PURCHASE_MAX_ATTEMPTS,
    delayMs: opts.delayMs ?? ((n) => backoffMs(n, 15_000)),
    onRetry: (n, e) => console.warn(`[numera] purchase tx lookup for cover #${c.id} rate-limited (attempt ${n}/${PURCHASE_MAX_ATTEMPTS}); retrying`, e),
    onSuccess: (tx) => {
      purchaseLookups.set(key, { state: 'done', tx });
      settle();
    },
    onGiveUp: (e, n) => {
      console.error(`[numera] purchase tx lookup for cover #${c.id} failed after ${n} attempt(s)`, e);
      purchaseLookups.set(key, { state: 'failed', error: isRateLimited(e) ? 'RPC rate-limited (-32005/429)' : firstLine(e) });
      settle();
    },
  });
  return entry;
}

export const purchaseLookupState = (pool: Address, id: bigint): PurchaseLookup | undefined => purchaseLookups.get(`${pool}:${id}`);
export const resetPurchaseLookups = (): void => purchaseLookups.clear();
