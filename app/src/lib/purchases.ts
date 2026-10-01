// Purchase txs remembered in this browser. When buyCover confirms here, {pool, coverId, txHash, block} is
// kept in localStorage, so the My covers Tx cell needs one eth_getTransactionReceipt instead of an
// eth_getLogs scan (the testnet RPC serves logs in 1000-block windows and rate-limits per IP).
// Storage is optional: every access is wrapped; when it is unavailable the app falls back to the scan.
import { decodeEventLog, getAddress, type Address, type Hex, type TransactionReceipt } from 'viem';
import { coverPoolAbi } from '../generated/abi';

export const PURCHASES_KEY = 'numera.purchases.v1';
const MAX_RECORDS = 200;

export interface StoredPurchase {
  chainId: number;
  pool: Address;
  coverId: string; // decimal
  txHash: Hex;
  block: string; // decimal
}
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** window.localStorage, or undefined when the accessor itself throws (blocked site data, sandbox). */
export function browserStorage(): StorageLike | undefined {
  try {
    return typeof globalThis.localStorage === 'undefined' ? undefined : globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function readAll(storage: StorageLike | undefined): StoredPurchase[] {
  try {
    const raw = storage?.getItem(PURCHASES_KEY);
    if (!raw) return [];
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v.filter(isRecord) as StoredPurchase[]) : [];
  } catch {
    return [];
  }
}
const isRecord = (r: unknown): boolean => {
  const x = r as Partial<StoredPurchase> | null;
  return (
    !!x &&
    typeof x.chainId === 'number' &&
    typeof x.pool === 'string' &&
    typeof x.coverId === 'string' &&
    typeof x.txHash === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(x.txHash) &&
    typeof x.block === 'string'
  );
};
const same = (r: StoredPurchase, chainId: number, pool: Address, coverId: bigint) =>
  r.chainId === chainId && r.pool.toLowerCase() === pool.toLowerCase() && r.coverId === coverId.toString();

function writeAll(storage: StorageLike | undefined, list: StoredPurchase[]): void {
  try {
    storage?.setItem(PURCHASES_KEY, JSON.stringify(list.slice(-MAX_RECORDS)));
  } catch {
    /* quota, private mode, blocked: the scan path still works */
  }
}

export function rememberPurchase(
  chainId: number,
  pool: Address,
  coverId: bigint,
  txHash: Hex,
  block: bigint,
  storage: StorageLike | undefined = browserStorage(),
): void {
  const list = readAll(storage).filter((r) => !same(r, chainId, pool, coverId));
  list.push({ chainId, pool: getAddress(pool), coverId: coverId.toString(), txHash, block: block.toString() });
  writeAll(storage, list);
}

export function storedPurchase(chainId: number, pool: Address, coverId: bigint, storage: StorageLike | undefined = browserStorage()): StoredPurchase | undefined {
  return readAll(storage).find((r) => same(r, chainId, pool, coverId));
}

export function forgetPurchase(chainId: number, pool: Address, coverId: bigint, storage: StorageLike | undefined = browserStorage()): void {
  const list = readAll(storage);
  const kept = list.filter((r) => !same(r, chainId, pool, coverId));
  if (kept.length !== list.length) writeAll(storage, kept);
}

/** Cover ids of the CoverPurchased logs that `pool` emitted in this receipt. */
export function purchasedCoverIds(receipt: Pick<TransactionReceipt, 'logs'>, pool: Address): bigint[] {
  const ids: bigint[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== pool.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: coverPoolAbi, data: log.data, topics: log.topics });
      if (ev.eventName === 'CoverPurchased') ids.push((ev.args as { coverId: bigint }).coverId);
    } catch {
      /* another event */
    }
  }
  return ids;
}
