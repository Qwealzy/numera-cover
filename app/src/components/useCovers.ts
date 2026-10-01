import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePoll } from '../hooks';
import type { Cover, CoverEvents } from '../lib/pool';
import { hasStoredPurchase, loadCovers, loadEvents, lookupPurchase, purchaseLookupState, type PurchaseLookup } from '../lib/covers';
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
  /** A lookup is running (stored-hash receipt read, or the log scan with its rate-limit retries). */
  pending: boolean;
  /** Not looked up and not started automatically (All-in-pool rows past AUTO_LOCATE_ALL): offer "locate". */
  idle: boolean;
  /** Start (or, after a failure, restart) the lookup. */
  retry: () => void;
}

/**
 * Purchase tx for covers older than the recent-events window. `auto` starts the lookup on mount (once per
 * page and cover, shared by every row showing it); otherwise it starts on retry(). A hash this browser
 * remembered from its own buyCover is always looked up (one receipt read).
 */
export function usePurchaseTx(pool: `0x${string}`, c: Cover, known: CoverEvents['purchased'] | undefined, auto: boolean): PurchaseTx {
  const [st, setSt] = useState<PurchaseLookup | undefined>(() => purchaseLookupState(pool, c.id));
  const [force, setForce] = useState(0);
  // read once per row (the row re-renders every second for its countdown)
  const stored = useMemo(() => hasStoredPurchase(pool, c.id), [pool, c.id]);
  const start = auto || force > 0 || stored;
  useEffect(() => {
    if (known || !start) return;
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
  }, [pool, c.id, c.start, known, start, force]);
  const retry = useCallback(() => setForce((n) => n + 1), []);
  if (known) return { tx: known, pending: false, idle: false, retry };
  return {
    tx: st?.state === 'done' ? st.tx : undefined,
    error: st?.state === 'failed' ? st.error : undefined,
    pending: st?.state === 'pending',
    idle: st === undefined,
    retry,
  };
}
