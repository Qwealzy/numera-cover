// Data functions behind useCovers (kept React-free so they are unit-tested).
import type { Address } from 'viem';
import type { PoolConfig } from '../config';
import { cached } from './rpc';
import { publicClient } from './chain';
import { readCovers, scanRecentEvents, type Cover, type CoverEvents, type ReadClient } from './pool';

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
