import { useEffect, useState } from 'react';
import { usePoll } from '../hooks';
import { findPurchase, readCovers, scanRecentEvents, type Cover, type CoverEvents } from '../lib/pool';
import { useApp } from '../state';

/** Latest covers of the selected pool (getCover) + recent events (tx hashes, trigger oracle px). */
export function useCovers(limit = 200) {
  const { pool, stats } = useApp();
  const count = stats.data?.coverCount;
  const covers = usePoll(
    () => (count ? readCovers(pool, count, limit) : Promise.resolve([] as Cover[])),
    [pool.pool, count?.toString()],
    6000,
    count !== undefined,
  );
  const block = stats.data?.block;
  const events = usePoll(
    () => (block ? scanRecentEvents(pool.pool, block, 8) : Promise.resolve(new Map<string, CoverEvents>())),
    // refresh when a new cover appears or every 15 s
    [pool.pool, count?.toString(), block !== undefined],
    15000,
    block !== undefined,
  );
  return { covers, events };
}

/** Purchase tx for covers older than the recent-events window, located from `start` (cached). */
const purchaseCache = new Map<string, CoverEvents['purchased'] | null>();

export function usePurchaseTx(pool: `0x${string}`, c: Cover, known: CoverEvents['purchased'] | undefined, enabled: boolean) {
  const key = `${pool}:${c.id}`;
  const [tx, setTx] = useState(known ?? purchaseCache.get(key) ?? undefined);
  useEffect(() => {
    if (known) return setTx(known);
    if (!enabled || purchaseCache.has(key)) return;
    purchaseCache.set(key, null);
    findPurchase(pool, c.id, c.start)
      .then((r) => {
        purchaseCache.set(key, r ?? null);
        setTx(r);
      })
      .catch(() => purchaseCache.delete(key));
  }, [key, known, enabled, pool, c.id, c.start]);
  return tx;
}
