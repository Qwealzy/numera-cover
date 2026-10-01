import { useCallback, useEffect, useRef, useState } from 'react';
import { usePoll } from '../hooks';
import type { Cover, CoverEvents } from '../lib/pool';
import { loadCovers, loadEvents, lookupPurchase, purchaseLookupState, type PurchaseLookup } from '../lib/covers';
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

export interface PurchaseTx {
  tx: CoverEvents['purchased'];
  /** Lookup gave up (non-rate-limit error, or the attempt cap): the reason, for the Tx cell tooltip. */
  error?: string;
  pending: boolean;
  retry: () => void;
}

/** Purchase tx for covers older than the recent-events window, located from `start` (once per page). */
export function usePurchaseTx(pool: `0x${string}`, c: Cover, known: CoverEvents['purchased'] | undefined, enabled: boolean): PurchaseTx {
  const [st, setSt] = useState<PurchaseLookup | undefined>(() => purchaseLookupState(pool, c.id));
  const [force, setForce] = useState(0);
  useEffect(() => {
    if (known || !enabled) return;
    let alive = true;
    const entry = lookupPurchase(pool, c, { force: force > 0 });
    setSt(entry);
    if (entry.state === 'pending')
      entry.done.then(() => {
        if (alive) setSt(purchaseLookupState(pool, c.id));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, c.id, c.start, known, enabled, force]);
  const retry = useCallback(() => setForce((n) => n + 1), []);
  if (known) return { tx: known, pending: false, retry };
  return {
    tx: st?.state === 'done' ? st.tx : undefined,
    error: st?.state === 'failed' ? st.error : undefined,
    pending: st?.state === 'pending',
    retry,
  };
}

