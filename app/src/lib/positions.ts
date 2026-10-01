// One row per coverable position, merged from the Info API (real pool) or the MOCK position source.
import type { Address } from 'viem';
import { PERPS, perpIndexOf, type PoolConfig } from '../config';
import { fetchAccount, type Market } from './info';
import { mockPositionLiq, positionLiq, type ApiAccount, type LiqResult, type Side } from './liq';
import { firstLine, readPositions, type OnchainPosition, type ReadClient } from './pool';
import { PartialData, isRateLimited } from './rpc';

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
  /** Why `cap` is undefined although the perp is configured (read failed after retries, or the entry reverted). */
  capError?: string;
  source: 'info' | 'mock';
}

/** Injectable I/O for tests (defaults: the public RPC client and the Info API). */
export interface LoadDeps {
  client?: Pick<ReadClient, 'multicall'>;
  fetchAccount?: typeof fetchAccount;
  retryDelaysMs?: number[];
}

/**
 * Polled path: ONE short retry inside a poll. A longer throttle is handed to usePoll (PartialData), whose
 * backoff (15 s … 60 s) and "RPC busy" hint take over, so a sustained limit costs ≤ 2 eth_calls per poll.
 */
export const POLLED_CAP_RETRY_MS = [1_500];

/**
 * Info API rows + the position-source caps. When the cap read is rate-limited the rows are still
 * returned, inside a PartialData error (cap "unavailable (retry)"), so usePoll shows them and backs off.
 * `signal` aborts a pending retry (usePoll aborts the previous run on reload/unmount).
 */
export async function loadPositions(
  pool: PoolConfig,
  user: Address,
  market: Market | undefined,
  signal?: AbortSignal,
  deps: LoadDeps = {},
): Promise<PositionRow[]> {
  return pool.kind === 'mock' ? loadMock(pool, user, market, signal, deps) : loadReal(pool, user, market, signal, deps);
}

export type CapsResult = Map<number, OnchainPosition | { error: string }> | { error: string; rateLimited: boolean; cause: unknown };

/**
 * The position-source reads behind "Max payout". The Info API rows are still shown when this fails, so the
 * failure is returned (and logged), never swallowed: the row then says "unavailable" with the reason.
 * An abort is rethrown (a newer read replaced this one).
 */
export async function readCaps(positionSource: Address, user: Address, perps: number[], deps: LoadDeps = {}, signal?: AbortSignal): Promise<CapsResult> {
  if (!perps.length) return new Map();
  try {
    return await readPositions(positionSource, user, perps, deps.client, deps.retryDelaysMs ?? POLLED_CAP_RETRY_MS, signal);
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    console.error('[numera] position source read failed (max payout unavailable)', e);
    const rateLimited = isRateLimited(e);
    return { error: rateLimited ? 'RPC rate-limited (-32005/429); retrying with backoff' : firstLine(e), rateLimited, cause: e };
  }
}

async function loadReal(pool: PoolConfig, user: Address, market: Market | undefined, signal: AbortSignal | undefined, deps: LoadDeps): Promise<PositionRow[]> {
  const acct = await (deps.fetchAccount ?? fetchAccount)(user, signal);
  const positions = acct.assetPositions.map((a) => a.position);
  const idxs = positions.map((p) => perpIndexOf(p.coin)).filter((x): x is number => x !== undefined);
  const caps = await readCaps(pool.positionSource, user, idxs, deps, signal);
  const rows = buildRealRows(positions, acct, market, caps);
  if (!(caps instanceof Map) && caps.rateLimited) throw new PartialData(rows, caps.cause);
  return rows;
}

function buildRealRows(positions: ApiAccount['assetPositions'][number]['position'][], acct: ApiAccount, market: Market | undefined, caps: CapsResult): PositionRow[] {
  const onchain = caps instanceof Map ? caps : undefined;
  const readError = caps instanceof Map ? undefined : caps.error;
  return positions.map((p) => {
    const m = market?.byName.get(p.coin);
    const markPx = m ? Number(m.ctx.markPx) : undefined;
    const szi = Number(p.szi);
    const perpIndex = perpIndexOf(p.coin);
    const oc: PositionRow['onchain'] =
      perpIndex === undefined ? undefined : readError !== undefined ? { error: readError } : onchain?.get(perpIndex);
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
      capError: oc && 'error' in oc ? oc.error : undefined,
      source: 'info',
    } satisfies PositionRow;
  });
}

async function loadMock(pool: PoolConfig, user: Address, market: Market | undefined, signal: AbortSignal | undefined, deps: LoadDeps): Promise<PositionRow[]> {
  // MOCK rows come only from the position source, so a failed read fails the whole load (usePoll shows it).
  const res = await readPositions(pool.positionSource, user, PERPS.map((p) => p.index), deps.client, deps.retryDelaysMs ?? POLLED_CAP_RETRY_MS, signal);
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

/** What the "Max payout" cell shows: the cap, "unavailable (retry)" with the reason, or "n/a" for an unconfigured perp. */
export function capView(row: Pick<PositionRow, 'cap' | 'capError' | 'perpIndex'>, fmt: (x: bigint) => string): { text: string; title?: string; unavailable: boolean } {
  if (row.cap !== undefined) return { text: fmt(row.cap), unavailable: false };
  if (row.perpIndex === undefined) return { text: 'n/a', title: 'This perp is not configured for Numera on this network', unavailable: false };
  return { text: 'unavailable (retry)', title: row.capError ?? 'Position source not read yet', unavailable: true };
}
