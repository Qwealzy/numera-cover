// Hyperliquid testnet Info API (read-only): POST /info, clearinghouseState and meta.
import { INFO_URL } from '../config';
import type { ApiAccount } from './liq';

async function info<T>(body: unknown, signal?: AbortSignal): Promise<T> {
  const r = await fetch(INFO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) throw new Error(`Info API ${r.status}`);
  return (await r.json()) as T;
}

export interface PerpMeta {
  index: number;
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated?: boolean;
}
export interface AssetCtx {
  oraclePx: string;
  markPx: string;
  midPx: string | null;
  funding: string;
  openInterest: string;
}
export interface Market {
  universe: PerpMeta[];
  ctxs: AssetCtx[];
  byName: Map<string, { meta: PerpMeta; ctx: AssetCtx }>;
  fetchedAt: number;
}

export async function fetchMarket(signal?: AbortSignal): Promise<Market> {
  const [meta, ctxs] = await info<[{ universe: Omit<PerpMeta, 'index'>[] }, AssetCtx[]]>(
    { type: 'metaAndAssetCtxs' },
    signal,
  );
  const universe = meta.universe.map((u, index) => ({ ...u, index }));
  const byName = new Map<string, { meta: PerpMeta; ctx: AssetCtx }>();
  universe.forEach((m, i) => byName.set(m.name, { meta: m, ctx: ctxs[i] }));
  return { universe, ctxs, byName, fetchedAt: Date.now() };
}

export function fetchAccount(user: string, signal?: AbortSignal): Promise<ApiAccount> {
  return info<ApiAccount>({ type: 'clearinghouseState', user }, signal);
}

// userAbstraction changes only on a user action, so it is read once per wallet per page load.
const abstractionCache = new Map<string, Promise<string>>();

/** Account abstraction mode ("unifiedAccount", "portfolioMargin", "default", ...), cached per wallet. A failed read is not cached. */
export function fetchAbstraction(user: string): Promise<string> {
  const key = user.toLowerCase();
  let p = abstractionCache.get(key);
  if (!p) {
    p = info<string>({ type: 'userAbstraction', user });
    abstractionCache.set(key, p);
    p.catch(() => abstractionCache.delete(key));
  }
  return p;
}

/** Test hook. */
export const clearAbstractionCache = () => abstractionCache.clear();

export interface SpotBalance {
  coin: string;
  token: number;
  total: string;
  hold: string;
}
export interface SpotAccount {
  balances: SpotBalance[];
}

export function fetchSpotAccount(user: string, signal?: AbortSignal): Promise<SpotAccount> {
  return info<SpotAccount>({ type: 'spotClearinghouseState', user }, signal);
}

/** Spot `total` of the perp collateral coin (USDC), matched by name, not by token index. */
export function spotCollateralTotal(spot: SpotAccount, coin = 'USDC'): number | undefined {
  const b = spot.balances?.find((x) => x.coin === coin);
  const v = b ? Number(b.total) : NaN;
  return Number.isFinite(v) ? v : undefined;
}
