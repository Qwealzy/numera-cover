// CoverPool v2 view logic (ARCHITECTURE §5.2–5.5): LP exit state machine, sale window, payout breaker,
// premium floor. Pure functions over on-chain reads; unit-tested in v2.test.ts.

export const BPS = 10_000n;

export interface V2Limits {
  maxUtilizationBps: number;
  perPerpCapBps: number;
  maxDuration: bigint;
  maxSpotDeviationBps: number;
  minPayout: bigint;
  minPremiumBps: number;
  minLevelDistanceBps: number;
  saleWindow: number;
  maxSoldPerWindowBps: number;
  maxBuyerWindowShareBps: number;
  maxPaidPerWindowBps: number;
}

/** Pool-level v2 state read in the snapshot multicall. */
export interface V2Stats {
  limits: V2Limits;
  capacityBase: bigint;
  unearnedPremium: bigint;
  owedAssets: bigint;
  windowStart: bigint;
  windowAssets: bigint;
  soldInWindow: bigint;
  paidWindowStart: bigint;
  paidWindowAssets: bigint;
  paidInWindow: bigint;
  totalEscrowedShares: bigint;
  withdrawDelay: bigint;
  claimWindow: bigint;
  configDelay: bigint;
  guardian: string;
  strict: boolean;
  blockTimestamp: bigint;
}

/** `redeemRequestOf(controller)`: state None=0 Pending=1 Claimable=2 Lapsed=3 at the read block. */
export interface RedeemRequest {
  shares: bigint;
  claimableAt: bigint;
  claimDeadline: bigint;
  state: number;
}

export interface V2User {
  owed: bigint;
  request: RedeemRequest;
  /** Shares claimable now (Claimable slot, limited to free assets); 0 otherwise. */
  maxRedeem: bigint;
  /** Assets claimable now (same limits); 0 otherwise. */
  maxWithdraw: bigint;
  buyerWindow: { start: bigint; sold: bigint };
}

/** limits() tuple (viem returns an object with named fields) -> V2Limits; undefined when malformed. */
export function toLimits(x: unknown): V2Limits | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const o = x as Record<string, unknown>;
  const n = (k: string) => (typeof o[k] === 'number' || typeof o[k] === 'bigint' ? Number(o[k]) : NaN);
  const b = (k: string) => (typeof o[k] === 'bigint' ? (o[k] as bigint) : typeof o[k] === 'number' ? BigInt(o[k] as number) : undefined);
  const l = {
    maxUtilizationBps: n('maxUtilizationBps'),
    perPerpCapBps: n('perPerpCapBps'),
    maxDuration: b('maxDuration'),
    maxSpotDeviationBps: n('maxSpotDeviationBps'),
    minPayout: b('minPayout'),
    minPremiumBps: n('minPremiumBps'),
    minLevelDistanceBps: n('minLevelDistanceBps'),
    saleWindow: n('saleWindow'),
    maxSoldPerWindowBps: n('maxSoldPerWindowBps'),
    maxBuyerWindowShareBps: n('maxBuyerWindowShareBps'),
    maxPaidPerWindowBps: n('maxPaidPerWindowBps'),
  };
  if (l.maxDuration === undefined || l.minPayout === undefined) return undefined;
  if (Object.values(l).some((v) => typeof v === 'number' && !Number.isFinite(v))) return undefined;
  return l as V2Limits;
}

// ---------------------------------------------------------------- LP exits (§5.4)

export type ExitPhase = 'none' | 'pending' | 'claimable' | 'lapsed';

export interface ExitView {
  phase: ExitPhase;
  shares: bigint;
  /** Seconds until the slot becomes claimable (pending) / until the claim window closes (claimable). */
  secondsLeft: number;
  claimableAt: number;
  claimDeadline: number;
  /** requestRedeem(shares > 0): not while Claimable (RequestClaimable). Restarts the clock of a pending slot. */
  canRequest: boolean;
  /** requestRedeem(0): re-queues a lapsed slot (the clock restarts for the whole slot). */
  canRequeue: boolean;
  canCancel: boolean;
  /** redeem/withdraw: Claimable and something is claimable against free assets now. */
  canClaim: boolean;
  /** Claimable, but free assets cover only part of the slot (claim part now, the rest stays claimable). */
  partialOnly: boolean;
}

/**
 * Exit state at local time `now` (unix s), mirroring CoverPool._stateOf: Pending if now < claimableAt,
 * Claimable while now < claimDeadline, then Lapsed; None without shares. Recomputed every second from the
 * slot's timestamps, so the countdown moves between polls; `maxRedeem` (read at the last block) decides
 * whether a claim can be filled.
 */
export function exitView(req: RedeemRequest | undefined, now: number, maxRedeem: bigint, walletShares: bigint): ExitView {
  const shares = req?.shares ?? 0n;
  const at = Number(req?.claimableAt ?? 0n);
  const dl = Number(req?.claimDeadline ?? 0n);
  let phase: ExitPhase = 'none';
  if (shares > 0n) phase = now < at ? 'pending' : now < dl ? 'claimable' : 'lapsed';
  const claimable = phase === 'claimable';
  // maxRedeem was read at the last block; if the slot only just matured locally it may still read 0.
  const claimNow = claimable ? (maxRedeem > shares ? shares : maxRedeem) : 0n;
  return {
    phase,
    shares,
    secondsLeft: phase === 'pending' ? at - now : claimable ? dl - now : 0,
    claimableAt: at,
    claimDeadline: dl,
    canRequest: !claimable && walletShares > 0n,
    canRequeue: phase === 'lapsed',
    canCancel: shares > 0n,
    canClaim: claimNow > 0n,
    partialOnly: claimable && claimNow > 0n && claimNow < shares,
  };
}

// ---------------------------------------------------------------- sale window (§5.3 check 6)

export interface SaleWindowView {
  /** The last window has ended: the next sale opens a new one on the current capacity base. */
  reset: boolean;
  sold: bigint;
  cap: bigint;
  /** Seconds until the open window ends (undefined after a reset). */
  resetsIn: number | undefined;
  buyerSold: bigint;
  buyerCap: bigint;
}

export function saleWindow(v: V2Stats, now: number, buyer?: { start: bigint; sold: bigint }): SaleWindowView {
  const end = Number(v.windowStart) + v.limits.saleWindow;
  const reset = now >= end;
  const cap = ((reset ? v.capacityBase : v.windowAssets) * BigInt(v.limits.maxSoldPerWindowBps)) / BPS;
  const buyerSold = !buyer || reset || buyer.start !== v.windowStart ? 0n : buyer.sold;
  return {
    reset,
    sold: reset ? 0n : v.soldInWindow,
    cap,
    resetsIn: reset ? undefined : end - now,
    buyerSold,
    buyerCap: (cap * BigInt(v.limits.maxBuyerWindowShareBps)) / BPS,
  };
}

// ---------------------------------------------------------------- breaker (§5.3 trigger step 2, §5.5)

export type PauseCause = 'running' | 'breaker' | 'owner';

/**
 * Why the pool is paused, as far as state shows. The breaker pauses when paidInWindow exceeds
 * paidWindowAssets × maxPaidPerWindowBps; an owner unpause zeroes paidWindowStart and paidInWindow. So a
 * paused pool whose breaker window is over its cap was (almost certainly) paused by LossBreakerTripped;
 * otherwise the owner or the guardian paused it.
 */
export function pauseCause(paused: boolean, v: V2Stats | undefined): PauseCause {
  if (!paused) return 'running';
  if (!v || v.paidWindowStart === 0n) return 'owner';
  const cap = (v.paidWindowAssets * BigInt(v.limits.maxPaidPerWindowBps)) / BPS;
  return v.paidInWindow > cap ? 'breaker' : 'owner';
}

// ---------------------------------------------------------------- premium floor (§5.3 check 2)

/** ceilDiv(payout × minPremiumBps, 10000): the least premium buyCover accepts on a v2 pool. */
export function premiumFloor(payout: bigint, minPremiumBps: number): bigint {
  const n = payout * BigInt(minPremiumBps);
  return (n + BPS - 1n) / BPS;
}
