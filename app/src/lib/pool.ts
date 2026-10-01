// On-chain reads for one CoverPool (ARCHITECTURE §5). All reads go through the public RPC.
import { parseAbiItem, zeroAddress, type Address, type Hex } from 'viem';
import { publicClient } from './chain';
import { coverPoolAbi, iPriceSourceAbi, mockPositionSourceAbi, mockUSDCAbi, mockPriceSourceAbi } from '../generated/abi';
import { USDC, type PoolConfig } from '../config';
import { decodeRevert, contractErrorMessage } from './errors';

const ONE_SHARE = 10n ** 12n; // pool shares have 12 decimals (§5 implementation notes)

export interface PoolStats {
  totalAssets: bigint;
  lockedAssets: bigint;
  freeAssets: bigint;
  totalSupply: bigint;
  sharePrice: bigint; // USDC (6 dec) per 1 whole share = convertToAssets(1e12)
  coverCount: bigint;
  paused: boolean;
  quoteSigner: Address;
  maxUtilizationBps: number;
  perPerpCapBps: number;
  maxDuration: bigint;
  maxSpotDeviationBps: number;
  minPayout: bigint;
  priceSource: Address;
  positionSource: Address;
  user?: { shares: bigint; assets: bigint; maxWithdraw: bigint; usdc: bigint; allowance: bigint };
  block: bigint;
}

export async function readPoolStats(p: PoolConfig, user?: Address): Promise<PoolStats> {
  const c = { address: p.pool, abi: coverPoolAbi } as const;
  const u = user ?? zeroAddress;
  const [block, r] = await Promise.all([
    publicClient.getBlockNumber(),
    publicClient.multicall({
      allowFailure: false,
      contracts: [
        { ...c, functionName: 'totalAssets' },
        { ...c, functionName: 'lockedAssets' },
        { ...c, functionName: 'freeAssets' },
        { ...c, functionName: 'totalSupply' },
        { ...c, functionName: 'convertToAssets', args: [ONE_SHARE] },
        { ...c, functionName: 'coverCount' },
        { ...c, functionName: 'paused' },
        { ...c, functionName: 'quoteSigner' },
        { ...c, functionName: 'maxUtilizationBps' },
        { ...c, functionName: 'perPerpCapBps' },
        { ...c, functionName: 'maxDuration' },
        { ...c, functionName: 'maxSpotDeviationBps' },
        { ...c, functionName: 'minPayout' },
        { ...c, functionName: 'priceSource' },
        { ...c, functionName: 'positionSource' },
        { ...c, functionName: 'balanceOf', args: [u] },
        { ...c, functionName: 'maxWithdraw', args: [u] },
        { address: USDC, abi: mockUSDCAbi, functionName: 'balanceOf', args: [u] },
        { address: USDC, abi: mockUSDCAbi, functionName: 'allowance', args: [u, p.pool] },
      ],
    }),
  ]);
  const shares = r[15] as bigint;
  const assets = shares === 0n ? 0n : await publicClient.readContract({ ...c, functionName: 'convertToAssets', args: [shares] });
  return {
    totalAssets: r[0] as bigint,
    lockedAssets: r[1] as bigint,
    freeAssets: r[2] as bigint,
    totalSupply: r[3] as bigint,
    sharePrice: r[4] as bigint,
    coverCount: r[5] as bigint,
    paused: r[6] as boolean,
    quoteSigner: r[7] as Address,
    maxUtilizationBps: Number(r[8]),
    perPerpCapBps: Number(r[9]),
    maxDuration: r[10] as bigint,
    maxSpotDeviationBps: Number(r[11]),
    minPayout: r[12] as bigint,
    priceSource: r[13] as Address,
    positionSource: r[14] as Address,
    user: user ? { shares, assets, maxWithdraw: r[16] as bigint, usdc: r[17] as bigint, allowance: r[18] as bigint } : undefined,
    block,
  };
}

// ---------------------------------------------------------------- prices and positions

export type PxResult = { ok: true; px6: bigint } | { ok: false; error: string };

/** Oracle px6 per perp from the pool's own price source — exactly what trigger() will read. */
export async function readOraclePxs(priceSource: Address, perps: number[]): Promise<Map<number, PxResult>> {
  const res = await publicClient.multicall({
    allowFailure: true,
    contracts: perps.map((i) => ({ address: priceSource, abi: iPriceSourceAbi, functionName: 'oraclePx6', args: [i] }) as const),
  });
  const m = new Map<number, PxResult>();
  res.forEach((r, k) => {
    if (r.status === 'success') m.set(perps[k], { ok: true, px6: r.result as bigint });
    else m.set(perps[k], { ok: false, error: revertText(r.error) });
  });
  return m;
}

function revertText(e: unknown): string {
  const data = findData(e);
  const d = decodeRevert(data);
  return d ? contractErrorMessage(d.name, d.args) : 'price unavailable';
}
function findData(e: unknown): Hex | undefined {
  let cur = e as { data?: unknown; raw?: unknown; cause?: unknown } | undefined;
  for (let i = 0; cur && i < 8; i++) {
    if (typeof cur.raw === 'string') return cur.raw as Hex;
    if (typeof cur.data === 'string' && cur.data.startsWith('0x')) return cur.data as Hex;
    cur = cur.cause as typeof cur;
  }
  return undefined;
}

export interface OnchainPosition {
  perpIndex: number;
  szi: bigint; // raw: size × 10^szDecimals
  entryNtl: bigint; // USD × 1e6
  leverage: number;
  cap: bigint; // entryNtl / leverage, as CoverPool._marginCap
}

/** Positions the pool's position source reports for `user` (what buyCover check 4 sees). */
export async function readPositions(positionSource: Address, user: Address, perps: number[]): Promise<Map<number, OnchainPosition | { error: string }>> {
  const res = await publicClient.multicall({
    allowFailure: true,
    contracts: perps.map((i) => ({ address: positionSource, abi: mockPositionSourceAbi, functionName: 'position', args: [user, i] }) as const),
  });
  const m = new Map<number, OnchainPosition | { error: string }>();
  res.forEach((r, k) => {
    if (r.status !== 'success') return m.set(perps[k], { error: revertText(r.error) });
    const [szi, entryNtl, leverage] = r.result as readonly [bigint, bigint, number];
    const lev = Number(leverage);
    m.set(perps[k], { perpIndex: perps[k], szi, entryNtl, leverage: lev, cap: lev > 0 ? entryNtl / BigInt(lev) : 0n });
  });
  return m;
}

export async function readMockOwners(p: PoolConfig): Promise<{ price: Address; position: Address } | undefined> {
  if (p.kind !== 'mock') return undefined;
  const [price, position] = await publicClient.multicall({
    allowFailure: false,
    contracts: [
      { address: p.priceSource, abi: mockPriceSourceAbi, functionName: 'owner' },
      { address: p.positionSource, abi: mockPositionSourceAbi, functionName: 'owner' },
    ],
  });
  return { price: price as Address, position: position as Address };
}

// ---------------------------------------------------------------- covers

export const Status = { None: 0, Active: 1, Paid: 2, Expired: 3 } as const;
export type Status = (typeof Status)[keyof typeof Status];

export interface Cover {
  id: bigint;
  buyer: Address;
  perpIndex: number;
  isLong: boolean;
  level: bigint;
  payout: bigint;
  premium: bigint;
  start: bigint;
  expiry: bigint;
  status: Status;
}

/** Most recent `limit` covers (ids coverCount down to coverCount−limit+1), via getCover. */
export async function readCovers(p: PoolConfig, coverCount: bigint, limit = 200): Promise<Cover[]> {
  const ids: bigint[] = [];
  for (let id = coverCount; id >= 1n && ids.length < limit; id--) ids.push(id);
  if (!ids.length) return [];
  const res = await publicClient.multicall({
    allowFailure: false,
    contracts: ids.map((id) => ({ address: p.pool, abi: coverPoolAbi, functionName: 'getCover', args: [id] }) as const),
  });
  return res.map((c, k) => {
    const x = c as unknown as Omit<Cover, 'id' | 'perpIndex' | 'status'> & { perpIndex: number; status: number };
    return { ...x, id: ids[k], perpIndex: Number(x.perpIndex), status: Number(x.status) as Status };
  });
}

// ---------------------------------------------------------------- events (best-effort, for tx links)

const evPurchased = parseAbiItem(
  'event CoverPurchased(uint256 indexed coverId, address indexed buyer, uint32 indexed perpIndex, bool isLong, uint64 level, uint256 payout, uint256 premium, uint64 expiry)',
);
const evTriggered = parseAbiItem('event CoverTriggered(uint256 indexed coverId, uint64 oraclePx, address caller)');
const evExpired = parseAbiItem('event CoverExpired(uint256 indexed coverId)');

export interface CoverEvents {
  purchased?: { tx: Hex; block: bigint };
  triggered?: { tx: Hex; block: bigint; oraclePx: bigint; caller: Address };
  expired?: { tx: Hex; block: bigint };
}

/** The testnet RPC caps eth_getLogs at 1000 blocks; scan the last `chunks` × 1000 blocks. */
export const LOG_RANGE = 1000n;

export async function scanRecentEvents(pool: Address, latest: bigint, chunks = 8): Promise<Map<string, CoverEvents>> {
  const out = new Map<string, CoverEvents>();
  const ranges: [bigint, bigint][] = [];
  for (let i = 0; i < chunks; i++) {
    const to = latest - BigInt(i) * LOG_RANGE;
    const from = to - LOG_RANGE + 1n;
    if (to < 0n) break;
    ranges.push([from < 0n ? 0n : from, to]);
  }
  const results = await Promise.allSettled(
    ranges.map(([fromBlock, toBlock]) =>
      publicClient.getLogs({ address: pool, events: [evPurchased, evTriggered, evExpired], fromBlock, toBlock }),
    ),
  );
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const log of r.value) mergeLog(out, log);
  }
  return out;
}

type AnyLog = Awaited<ReturnType<typeof publicClient.getLogs<undefined, [typeof evPurchased, typeof evTriggered, typeof evExpired]>>>[number];

function mergeLog(out: Map<string, CoverEvents>, log: AnyLog) {
  const id = (log.args as { coverId?: bigint }).coverId;
  if (id === undefined || !log.transactionHash || log.blockNumber === null) return;
  const e = out.get(id.toString()) ?? {};
  const base = { tx: log.transactionHash, block: log.blockNumber };
  if (log.eventName === 'CoverPurchased') e.purchased = base;
  else if (log.eventName === 'CoverExpired') e.expired = base;
  else if (log.eventName === 'CoverTriggered') {
    const a = log.args as { oraclePx: bigint; caller: Address };
    e.triggered = { ...base, oraclePx: a.oraclePx, caller: a.caller };
  }
  out.set(id.toString(), e);
}

/**
 * Locate a cover's CoverPurchased log from its `start` timestamp: estimate the block from the average
 * block rate, then search 1000-block windows outward. Returns undefined if not found in `tries` windows.
 */
export async function findPurchase(pool: Address, coverId: bigint, start: bigint, tries = 4): Promise<CoverEvents['purchased']> {
  const latest = await publicClient.getBlock();
  const anchorBack = 100_000n;
  const old = await publicClient.getBlock({ blockNumber: latest.number - anchorBack });
  const rate = Number(anchorBack) / Number(latest.timestamp - old.timestamp); // blocks per second
  const est = latest.number - BigInt(Math.round(Number(latest.timestamp - start) * rate));
  const offsets = [0n, -LOG_RANGE, LOG_RANGE, -2n * LOG_RANGE, 2n * LOG_RANGE].slice(0, tries + 1);
  for (const off of offsets) {
    const from = est + off - LOG_RANGE / 2n;
    const to = from + LOG_RANGE - 1n;
    if (to < 0n || from > latest.number) continue;
    const logs = await publicClient.getLogs({
      address: pool,
      event: evPurchased,
      args: { coverId },
      fromBlock: from < 0n ? 0n : from,
      toBlock: to > latest.number ? latest.number : to,
    });
    const l = logs[0];
    if (l?.transactionHash && l.blockNumber !== null) return { tx: l.transactionHash, block: l.blockNumber };
  }
  return undefined;
}
