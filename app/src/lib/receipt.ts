// In-app transaction receipt: how a judge verifies a tx without a block explorer (no working chain-998
// explorer as of 2026-10-02). eth_getTransactionReceipt through the app's viem client, logs decoded with the
// generated pool / mUSDC ABIs.
import { decodeEventLog, getAddress, type Abi, type Address, type Hex, type TransactionReceipt } from 'viem';
import { coverPoolAbi, mockUSDCAbi } from '../generated/abi';
import { POOLS, USDC, coinOf } from '../config';
import { SHARE_DECIMALS, USDC_DECIMALS, fmtFixed, fmtPx6, fmtTime } from './format';
import { publicClient } from './chain';
import { retryRateLimited } from './rpc';

type Kind = 'pool' | 'usdc';
interface Known {
  label: string;
  kind: Kind;
  abi: Abi;
}

/** Contracts whose logs the app can decode: both pools (CoverPool, ERC-4626 shares) and mUSDC. */
export function knownContracts(): Map<string, Known> {
  const m = new Map<string, Known>();
  for (const p of Object.values(POOLS)) m.set(p.pool.toLowerCase(), { label: `CoverPool (${p.short})`, kind: 'pool', abi: coverPoolAbi as Abi });
  m.set(USDC.toLowerCase(), { label: 'mUSDC', kind: 'usdc', abi: mockUSDCAbi as Abi });
  return m;
}

export interface DecodedArg {
  name: string;
  raw: string;
  /** Human reading with units (mUSDC, shares, px6 price, time), when the field is known. */
  pretty?: string;
}
export interface DecodedEvent {
  logIndex: number;
  address: Address;
  contract: string; // label, or "unknown contract"
  name: string; // event name, or "undecoded log"
  args: DecodedArg[];
}
export interface ReceiptView {
  hash: Hex;
  status: 'success' | 'reverted';
  blockNumber: bigint;
  from: Address;
  to: Address | null;
  contractAddress: Address | null;
  gasUsed: bigint;
  events: DecodedEvent[];
}

const USDC_FIELDS = new Set(['assets', 'payout', 'premium']);
const PX6_FIELDS = new Set(['level', 'oraclePx']);

function pretty(kind: Kind, event: string, name: string, v: unknown): string | undefined {
  if (typeof v !== 'bigint' && typeof v !== 'number') return undefined;
  const b = BigInt(v);
  if (kind === 'usdc' && name === 'value') return `${fmtFixed(b, USDC_DECIMALS, 6)} mUSDC`;
  if (kind !== 'pool') return undefined;
  if (USDC_FIELDS.has(name)) return `${fmtFixed(b, USDC_DECIMALS, 6)} mUSDC`;
  if (name === 'shares' || ((event === 'Transfer' || event === 'Approval') && name === 'value')) return `${fmtFixed(b, SHARE_DECIMALS, 6)} shares`;
  if (PX6_FIELDS.has(name)) return `${fmtPx6(b)} (px6 ${b})`;
  if (name === 'expiry') return fmtTime(b);
  if (name === 'perpIndex') return `${coinOf(Number(b))} (perp ${b})`;
  return undefined;
}

const str = (v: unknown): string => (typeof v === 'bigint' ? v.toString() : typeof v === 'string' ? v : JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));

/** Decode a viem-formatted receipt. Logs from unknown contracts or with unknown topics are listed, not dropped. */
export function decodeReceipt(r: TransactionReceipt, known: Map<string, Known> = knownContracts()): ReceiptView {
  const events: DecodedEvent[] = r.logs.map((log, i) => {
    const address = getAddress(log.address);
    const k = known.get(log.address.toLowerCase());
    const base = { logIndex: log.logIndex ?? i, address, contract: k?.label ?? 'unknown contract' };
    if (!k) return { ...base, name: 'undecoded log', args: [{ name: 'topic0', raw: log.topics[0] ?? '' }] };
    try {
      const d = decodeEventLog({ abi: k.abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      const args = Object.entries((d.args ?? {}) as Record<string, unknown>).map(([name, v]) => ({
        name,
        raw: str(v),
        pretty: pretty(k.kind, String(d.eventName), name, v),
      }));
      return { ...base, name: String(d.eventName), args };
    } catch {
      return { ...base, name: 'undecoded log', args: [{ name: 'topic0', raw: log.topics[0] ?? '' }] };
    }
  });
  return {
    hash: r.transactionHash,
    status: r.status,
    blockNumber: r.blockNumber,
    from: getAddress(r.from),
    to: r.to ? getAddress(r.to) : null,
    contractAddress: r.contractAddress ? getAddress(r.contractAddress) : null,
    gasUsed: r.gasUsed,
    events,
  };
}

/** Read and decode one receipt over the RPC (rate-limit answers retried; other errors surface). */
export async function fetchReceipt(hash: Hex, client: Pick<typeof publicClient, 'getTransactionReceipt'> = publicClient): Promise<ReceiptView> {
  const r = await retryRateLimited(() => client.getTransactionReceipt({ hash }));
  return decodeReceipt(r);
}
