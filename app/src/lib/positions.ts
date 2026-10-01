// One row per coverable position, merged from the Info API (real pool) or the MOCK position source.
import type { Address } from 'viem';
import { PERPS, perpIndexOf, type PoolConfig } from '../config';
import { fetchAccount, type Market } from './info';
import { mockPositionLiq, positionLiq, type LiqResult, type Side } from './liq';
import { readPositions, type OnchainPosition } from './pool';

export interface PositionRow {
  coin: string;
  perpIndex: number | undefined; // undefined: perp not configured for Numera on this network
  side: Side;
  size: number; // coin units
  entryPx: number;
  markPx: number | undefined;
  infoOraclePx: number | undefined; // Info API oracle (cross-check; the pool's source is authoritative)
  leverage: number;
  levType: 'cross' | 'isolated' | 'mock';
  maxLeverage: number;
  szDecimals: number;
  uPnl: number | undefined;
  liq: LiqResult;
  onchain: OnchainPosition | { error: string } | undefined; // what buyCover check 4 sees
  cap: bigint | undefined; // max payout = entryNtl / leverage (from the position source)
  source: 'info' | 'mock';
}

export async function loadPositions(pool: PoolConfig, user: Address, market: Market | undefined, signal?: AbortSignal): Promise<PositionRow[]> {
  return pool.kind === 'mock' ? loadMock(pool, user, market) : loadReal(pool, user, market, signal);
}

async function loadReal(pool: PoolConfig, user: Address, market: Market | undefined, signal?: AbortSignal): Promise<PositionRow[]> {
  const acct = await fetchAccount(user, signal);
  const positions = acct.assetPositions.map((a) => a.position);
  const idxs = positions.map((p) => perpIndexOf(p.coin)).filter((x): x is number => x !== undefined);
  const onchain = idxs.length ? await readPositions(pool.positionSource, user, idxs).catch(() => undefined) : undefined;
  return positions.map((p) => {
    const m = market?.byName.get(p.coin);
    const markPx = m ? Number(m.ctx.markPx) : undefined;
    const szi = Number(p.szi);
    const perpIndex = perpIndexOf(p.coin);
    const oc = perpIndex !== undefined ? onchain?.get(perpIndex) : undefined;
    return {
      coin: p.coin,
      perpIndex,
      side: szi >= 0 ? 1 : -1,
      size: Math.abs(szi),
      entryPx: Number(p.entryPx),
      markPx,
      infoOraclePx: m ? Number(m.ctx.oraclePx) : undefined,
      leverage: p.leverage.value,
      levType: p.leverage.type,
      maxLeverage: p.maxLeverage,
      szDecimals: m?.meta.szDecimals ?? 0,
      uPnl: Number(p.unrealizedPnl),
      liq: positionLiq(p, acct, markPx ?? 0),
      onchain: oc,
      cap: oc && 'cap' in oc ? oc.cap : undefined,
      source: 'info',
    } satisfies PositionRow;
  });
}

async function loadMock(pool: PoolConfig, user: Address, market: Market | undefined): Promise<PositionRow[]> {
  const res = await readPositions(pool.positionSource, user, PERPS.map((p) => p.index));
  const rows: PositionRow[] = [];
  for (const { coin, index } of PERPS) {
    const oc = res.get(index);
    if (!oc || !('szi' in oc) || oc.szi === 0n) continue;
    const m = market?.byName.get(coin);
    const szDecimals = m?.meta.szDecimals ?? 0;
    const maxLeverage = m?.meta.maxLeverage ?? oc.leverage;
    const side: Side = oc.szi > 0n ? 1 : -1;
    const size = Math.abs(Number(oc.szi)) / 10 ** szDecimals;
    const entryPx = size > 0 ? Number(oc.entryNtl) / 1e6 / size : 0;
    rows.push({
      coin,
      perpIndex: index,
      side,
      size,
      entryPx,
      markPx: undefined,
      infoOraclePx: m ? Number(m.ctx.oraclePx) : undefined,
      leverage: oc.leverage,
      levType: 'mock',
      maxLeverage,
      szDecimals,
      uPnl: undefined,
      liq: { px: mockPositionLiq(size, side, entryPx, oc.leverage, maxLeverage), source: 'computed' },
      onchain: oc,
      cap: oc.cap,
      source: 'mock',
    });
  }
  return rows;
}
