import { useEffect, useRef, useState } from 'react';
import { usePoll } from '../hooks';
import { findPurchaseQueued, type Cover, type CoverEvents } from '../lib/pool';
import { loadCovers, loadEvents } from '../lib/covers';
import { useApp } from '../state';

/**
 * Covers of the selected pool (getCover) + recent events (tx hashes, trigger oracle px).
 * No timer of its own: it re-reads when the pool snapshot (polled every POLL_MS) shows a new cover
 * (coverCount) or a trigger/expiry (lockedAssets), and after the user's own transaction.
 * `withEvents` = false skips the log scan (the Pool screen only needs it for "paid" links).
 */
export function useCovers(withEvents: boolean | ((covers: Cover[]) => boolean) = true) {
  const { pool, stats } = useApp();
  const s = stats.data;
  const count = s?.coverCount;
  const locked = s?.lockedAssets;
  const covers = usePoll(
    () => loadCovers(pool, count!, locked!),
    [pool.pool, count, locked],
    0,
    count !== undefined && locked !== undefined,
  );
  const blockRef = useRef(s?.block);
  blockRef.current = s?.block;
  const wantEvents = !!covers.data?.length && (typeof withEvents === 'function' ? withEvents(covers.data) : withEvents);
  const events = usePoll(
    () => loadEvents(pool.pool, blockRef.current!, count!, locked!),
    [pool.pool, count, locked],
    0,
    wantEvents && s?.block !== undefined,
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
    if (!enabled || purchaseCache.has(key)) return setTx(purchaseCache.get(key) ?? undefined);
    purchaseCache.set(key, null);
    findPurchaseQueued(pool, c.id, c.start)
      .then((r) => {
        purchaseCache.set(key, r ?? null);
        setTx(r);
      })
      .catch(() => purchaseCache.delete(key));
  }, [key, known, enabled, pool, c.id, c.start]);
  return tx;
}
