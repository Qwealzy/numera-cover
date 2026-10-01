// On-chain reads for one CoverPool (docs/how-it-works.md §5). All reads go through the public RPC.
import { parseAbi, parseAbiItem, zeroAddress, type Address, type Hex } from 'viem';
import { publicClient } from './chain';
import { coverPoolAbi, iPriceSourceAbi, mockPositionSourceAbi, mockUSDCAbi, mockPriceSourceAbi } from '../generated/abi';
import { MULTICALL3, USDC, type PoolConfig } from '../config';
import { decodeRevert, contractErrorMessage } from './errors';
import { isRateLimited, retryRateLimited } from './rpc';

// viem's bundled multicall3Abi has no getBlockNumber; Multicall3 does (selector 0x42cbb15c, checked on 998).
const multicall3BlockAbi = parseAbi(['function getBlockNumber() view returns (uint256 blockNumber)']);
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

/** The bits of a viem PublicClient these reads use (injectable for unit tests). */
export type ReadClient = Pick<typeof publicClient, 'multicall' | 'readContract'>;

export interface Snapshot {
  stats: PoolStats;
  oracle: Map<number, PxResult>;
}

type Call = { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] };
type CallResult = { status: 'success'; result: unknown } | { status: 'failure'; error: Error };

/** Last seen LP share balance per pool:user, so convertToAssets(shares) rides in the same multicall. */
const lastShares = new Map<string, bigint>();

/**
 * Everything a screen polls, in ONE eth_call through Multicall3: block number, pool stats, the user's
 * balances and the pool price source's oracle price for every configured perp. One RPC request per poll.
 */
export async function readSnapshot(p: PoolConfig, user: Address | undefined, perps: number[], client: ReadClient = publicClient): Promise<Snapshot> {
  const c = { address: p.pool, abi: coverPoolAbi } as const;
  const u = user ?? zeroAddress;
  const sk = `${p.pool}:${u}`;
  const guess = user ? lastShares.get(sk) : undefined;
  const required: Call[] = [
    { address: MULTICALL3, abi: multicall3BlockAbi, functionName: 'getBlockNumber' },
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
  ];
  if (guess) required.push({ ...c, functionName: 'convertToAssets', args: [guess] });
  const oracleCalls: Call[] = perps.map((i) => ({ address: p.priceSource, abi: iPriceSourceAbi, functionName: 'oraclePx6', args: [i] }));
  const res = (await client.multicall({
    allowFailure: true,
    contracts: [...required, ...oracleCalls] as Parameters<ReadClient['multicall']>[0]['contracts'],
  })) as unknown as CallResult[];
  const r = res.slice(0, required.length).map((x) => {
    if (x.status !== 'success') throw x.error;
    return x.result;
  });
  const shares = r[16] as bigint;
  const assets =
    shares === 0n
      ? 0n
      : guess === shares
        ? (r[20] as bigint)
        : await client.readContract({ ...c, functionName: 'convertToAssets', args: [shares] });
  if (user) lastShares.set(sk, shares);
  const oracle = new Map<number, PxResult>();
  res.slice(required.length).forEach((x, k) => {
    oracle.set(perps[k], x.status === 'success' ? { ok: true, px6: x.result as bigint } : { ok: false, error: revertText(x.error) });
  });
  const stats: PoolStats = {
    block: r[0] as bigint,
    totalAssets: r[1] as bigint,
    lockedAssets: r[2] as bigint,
    freeAssets: r[3] as bigint,
    totalSupply: r[4] as bigint,
    sharePrice: r[5] as bigint,
    coverCount: r[6] as bigint,
    paused: r[7] as boolean,
    quoteSigner: r[8] as Address,
    maxUtilizationBps: Number(r[9]),
    perPerpCapBps: Number(r[10]),
    maxDuration: r[11] as bigint,
    maxSpotDeviationBps: Number(r[12]),
    minPayout: r[13] as bigint,
    priceSource: r[14] as Address,
    positionSource: r[15] as Address,
    user: user ? { shares, assets, maxWithdraw: r[17] as bigint, usdc: r[18] as bigint, allowance: r[19] as bigint } : undefined,
  };
  return { stats, oracle };
}

// ---------------------------------------------------------------- prices and positions

export type PxResult = { ok: true; px6: bigint } | { ok: false; error: string };

function revertText(e: unknown, fallback = 'price unavailable'): string {
  const data = findData(e);
  const d = decodeRevert(data);
  return d ? contractErrorMessage(d.name, d.args) : fallback;
}
/** viem's shortMessage, else the first line of the message. */
export function firstLine(e: unknown): string {
  const x = e as { shortMessage?: unknown; message?: unknown } | undefined;
  const s = typeof x?.shortMessage === 'string' ? x.shortMessage : typeof x?.message === 'string' ? x.message : String(e);
  return s.split('\n')[0] || 'unknown error';
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
export async function readPositions(
  positionSource: Address,
  user: Address,
  perps: number[],
  client: Pick<ReadClient, 'multicall'> = publicClient,
  retryDelaysMs?: number[],
  signal?: AbortSignal,
):Promise<Map<number, OnchainPosition | { error: string }>> {
  // One eth_call; a rate-limited answer is retried with spaced delays (the public RPC limits per IP).
  // With allowFailure, viem does NOT throw when the whole eth_call fails: it marks every entry
  // `failure` with the RPC error (seen in the browser 2026-10-02: -32005 "Request exceeds defined limit"
  // arrived as per-entry errors, which is how "Max payout" became a bare dash). A rate-limit error is
  // never a contract revert, so rethrow it here and let retryRateLimited back off.
  const res = await retryRateLimited(
    async () => {
      const r = await client.multicall({
        allowFailure: true,
        contracts: perps.map((i) => ({ address: positionSource, abi: mockPositionSourceAbi, functionName: 'position', args: [user, i] }) as const),
      });
      const limited = r.find((x) => x.status !== 'success' && isRateLimited(x.error));
      if (limited && limited.status !== 'success') throw limited.error;
      return r;
    },
    { delaysMs: retryDelaysMs, signal, onRetry: (n, e) => console.warn(`[numera] position read rate-limited, retry ${n}`, e) },
  );
  const m = new Map<number, OnchainPosition | { error: string }>();
  res.forEach((r, k) => {
    if (r.status !== 'success') return m.set(perps[k], { error: revertText(r.error, `position read failed: ${firstLine(r.error)}`) });
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
export async function readCovers(p: PoolConfig, coverCount: bigint, limit = 200, client: ReadClient = publicClient): Promise<Cover[]> {
  const ids: bigint[] = [];
  for (let id = coverCount; id >= 1n && ids.length < limit; id--) ids.push(id);
  if (!ids.length) return [];
  const res = await client.multicall({
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
  // Sequential, newest window first, stop at the first failure: under a rate limit an attempt costs one
  // request instead of `chunks`, and a failed window never silently drops tx links (the caller retries).
  for (const [fromBlock, toBlock] of ranges) {
    const logs = await publicClient.getLogs({ address: pool, events: [evPurchased, evTriggered, evExpired], fromBlock, toBlock });
    for (const log of logs) mergeLog(out, log);
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
let blockClock: Promise<{ number: bigint; timestamp: bigint; rate: number }> | undefined;
/** Latest block + average block rate, measured once per page load (2 requests). */
function getBlockClock() {
  blockClock ??= (async () => {
    const latest = await publicClient.getBlock();
    const anchorBack = 100_000n;
    const old = await publicClient.getBlock({ blockNumber: latest.number - anchorBack });
    return { number: latest.number, timestamp: latest.timestamp, rate: Number(anchorBack) / Number(latest.timestamp - old.timestamp) };
  })().catch((e) => {
    blockClock = undefined;
    throw e;
  });
  return blockClock;
}

let purchaseQueue: Promise<unknown> = Promise.resolve();
/** findPurchase calls run one at a time, so a list of old covers never bursts the RPC. */
export function findPurchaseQueued(...a: Parameters<typeof findPurchase>): ReturnType<typeof findPurchase> {
  const next = purchaseQueue.then(() => findPurchase(...a));
  purchaseQueue = next.catch(() => undefined);
  return next;
}

export async function findPurchase(pool: Address, coverId: bigint, start: bigint, tries = 4): Promise<CoverEvents['purchased']> {
  // A cover bought after the clock was read is inside the recent-events window, so the clock's block is
  // a safe upper bound here.
  const latest = await getBlockClock();
  const rate = latest.rate; // blocks per second
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
