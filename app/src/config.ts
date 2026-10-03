import { defineChain, getAddress, type Address } from 'viem';
import { testnet, testnetV2 } from './generated/deployments';
import { fallbackUrls } from './lib/transport';

const env = (import.meta.env ?? {}) as Record<string, string | undefined>;

export const RPC_URL = env.VITE_RPC_URL || testnet.rpc;
/**
 * Read-only fallback RPCs, tried in order when the official RPC answers -32005/429, 5xx or a network error
 * (the official testnet RPC rate-limits per IP). Chainlink's public HyperEVM testnet RPC allows browser CORS
 * (OPTIONS 204, access-control-allow-origin *) and the engine already falls back to it (engine/numera_engine/rpc.py).
 * Override with VITE_RPC_FALLBACK_URLS (comma-separated; empty disables). Every fallback must answer chain
 * id 998 before its first use (lib/transport.ts), or it is never read from.
 */
export const DEFAULT_RPC_FALLBACKS = ['https://rpcs.chain.link/hyperevm/testnet'] as const;
export const RPC_FALLBACK_URLS = fallbackUrls(RPC_URL, testnet.rpc, env.VITE_RPC_FALLBACK_URLS, DEFAULT_RPC_FALLBACKS);
/** Primary first, then the fallbacks: the read transport's URL list. */
export const READ_RPC_URLS: readonly string[] = [RPC_URL, ...RPC_FALLBACK_URLS];
export const INFO_URL = env.VITE_INFO_URL || 'https://api.hyperliquid-testnet.xyz/info';
/**
 * Block explorer base URL. Empty by default: no working chain-998 explorer exists as of 2026-10-02 (the
 * hyperpc Blockscout indexer stopped at block 60,609,357 on 2026-08-03; hypurrscan's EVM view does not find
 * our txs). Empty means the app renders no external tx/address links; tx hashes open the in-app receipt view
 * (eth_getTransactionReceipt over the RPC) instead.
 */
export const EXPLORER_URL = explorerBase(env.VITE_EXPLORER_URL);
export function explorerBase(raw: string | undefined): string {
  return (raw ?? '').trim().replace(/\/+$/, '');
}
export const USE_QUOTE_FIXTURE = env.VITE_USE_QUOTE_FIXTURE === '1' || env.VITE_USE_QUOTE_FIXTURE === 'true';
/** Founder-supplied waitlist form; the CTA is hidden when unset. */
export const WAITLIST_URL = env.VITE_WAITLIST_URL || '';
const ENGINE_DEFAULT = (env.VITE_ENGINE_URL || 'http://localhost:8000').replace(/\/$/, '');

export const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';
/** Poll interval for on-chain reads (pool stats, oracle, positions). The public RPC is shared by every judge. */
export const POLL_MS = 15_000;

/** Chain 998. Mainnet (999) is deliberately not defined anywhere in the app. */
export const hyperEvmTestnet = defineChain({
  id: testnet.chainId,
  name: 'Hyperliquid EVM Testnet',
  nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  // Omitted when no explorer is configured, so viem/wallets never build a link to a dead explorer.
  ...(EXPLORER_URL ? { blockExplorers: { default: { name: 'HyperEVM testnet explorer', url: EXPLORER_URL } } } : {}),
  // Multicall3 is deployed on 998 (eth_getCode checked 2026-10-01); all polled reads go through it.
  contracts: { multicall3: { address: MULTICALL3 } },
  testnet: true,
});

export type PoolKind = 'hypercore' | 'mock';
/** CoverPool contract version (ARCHITECTURE §5 v2, §5.11 v1). Undefined in a config = detect on chain. */
export type PoolVersion = 'v1' | 'v2';

export interface PoolConfig {
  /** Switch key and URL value: 'hypercore' | 'mock' (v1, deployments/testnet.json) or '<mode>-v2'. */
  key: string;
  kind: PoolKind;
  /** 'v2' when deployments/testnet-v2.json lists the pool; else detected per snapshot (minPremiumBps probe). */
  version: PoolVersion | undefined;
  label: string;
  short: string;
  pool: Address;
  priceSource: Address;
  positionSource: Address;
  /** The pool's asset (mUSDC). The same token for every testnet pool; a v2 entry records its own. */
  usdc: Address;
  engineUrl: string;
  deployTx: `0x${string}` | undefined;
}

export const USDC: Address = getAddress(testnet.usdc.address);

function pool(kind: PoolKind): PoolConfig {
  const p = testnet.pools[kind];
  const override = kind === 'mock' ? env.VITE_ENGINE_URL_MOCK : env.VITE_ENGINE_URL_HYPERCORE;
  return {
    key: kind,
    kind,
    version: undefined,
    label: p.label,
    short: kind === 'mock' ? 'MOCK demo' : 'Real (HyperCore oracle)',
    pool: getAddress(p.pool),
    priceSource: getAddress(p.priceSource),
    positionSource: getAddress(p.positionSource),
    usdc: USDC,
    engineUrl: (override || ENGINE_DEFAULT).replace(/\/$/, ''),
    deployTx: p.txs.pool as `0x${string}`,
  };
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;

/**
 * Pools of deployments/testnet-v2.json (scripts/deploy-v2.mjs, mergeV2 shape: {contract, pools: {mode: {chainId,
 * mode, pool, priceSource, positionSource, usdc, txs: [{name, function, hash}]}}}). Entries on another chain,
 * with an unknown mode or a malformed address are skipped. Pure; unit-tested.
 */
export function parseV2Pools(raw: unknown, chainId: number, engineUrl: string, fallbackUsdc: Address): PoolConfig[] {
  if (!raw || typeof raw !== 'object') return [];
  const pools = (raw as { pools?: unknown }).pools;
  if (!pools || typeof pools !== 'object') return [];
  const out: PoolConfig[] = [];
  for (const [mode, v] of Object.entries(pools as Record<string, unknown>)) {
    const p = v as Record<string, unknown> | null;
    if (!p || typeof p !== 'object' || (mode !== 'hypercore' && mode !== 'mock')) continue;
    if (p.chainId !== undefined && Number(p.chainId) !== chainId) continue;
    const addrs = [p.pool, p.priceSource, p.positionSource];
    if (!addrs.every((a) => typeof a === 'string' && ADDR.test(a))) continue;
    const usdc = typeof p.usdc === 'string' && ADDR.test(p.usdc) ? getAddress(p.usdc) : fallbackUsdc;
    const txs = Array.isArray(p.txs) ? (p.txs as { name?: string; function?: string | null; hash?: string }[]) : [];
    const deploy = txs.find((t) => t?.name === 'CoverPool' && (t.function === 'create' || t.function == null))?.hash;
    out.push({
      key: `${mode}-v2`,
      kind: mode,
      version: 'v2',
      label: `${mode === 'mock' ? 'MOCK sources' : 'Real HyperCore sources'} (CoverPool v2)`,
      short: mode === 'mock' ? 'MOCK demo' : 'Real',
      pool: getAddress(p.pool as string),
      priceSource: getAddress(p.priceSource as string),
      positionSource: getAddress(p.positionSource as string),
      usdc,
      engineUrl,
      deployTx: typeof deploy === 'string' && /^0x[0-9a-fA-F]{64}$/.test(deploy) ? (deploy as `0x${string}`) : undefined,
    });
  }
  return out;
}

/**
 * Version a pool actually serves: the deployments file's word when it has one, else the on-chain probe
 * (minPremiumBps() and limits() answer only on v2). Pure; unit-tested.
 */
export function detectVersion(configured: PoolVersion | undefined, probeOk: boolean | undefined): PoolVersion {
  if (configured) return configured;
  return probeOk ? 'v2' : 'v1';
}

/** Every pool the switch offers: the two v1 pools, then the v2 pools when deployments/testnet-v2.json exists. */
export const POOLS: Record<string, PoolConfig> & { hypercore: PoolConfig; mock: PoolConfig } = {
  hypercore: pool('hypercore'),
  mock: pool('mock'),
  ...Object.fromEntries(parseV2Pools(testnetV2, testnet.chainId, ENGINE_DEFAULT, USDC).map((p) => [p.key, p])),
};
/** Default pool: the Real v2 pool when deployments/testnet-v2.json has one, else v1 hypercore. */
export const DEFAULT_POOL_KEY: string = Object.hasOwn(POOLS, 'hypercore-v2') ? 'hypercore-v2' : 'hypercore';
/** The pools the header switch offers: v2 only. v1 pools stay reachable through ?pool=<key>. */
export const SWITCH_POOL_KEYS: string[] = Object.values(POOLS)
  .filter((p) => p.version === 'v2')
  .map((p) => p.key);
/**
 * Pool a load lands on. A ?pool= key wins when it names a pool (v1 included); a remembered (localStorage) key
 * counts only when it is a v2 pool, so a v1 pool stored earlier never hijacks a fresh load. Pure; unit-tested.
 */
export function resolvePoolKey(urlKey: string | null | undefined, storedKey: string | null | undefined): string {
  if (urlKey && Object.hasOwn(POOLS, urlKey)) return urlKey;
  if (storedKey && Object.hasOwn(POOLS, storedKey) && POOLS[storedKey].version === 'v2') return storedKey;
  return DEFAULT_POOL_KEY;
}
export const DEPLOYER: Address = getAddress(testnet.deployer);
export const QUOTE_SIGNER: Address = getAddress(testnet.quoteSigner);
/** Testnet perp indices from deployments/testnet.json — never hardcoded (indices differ per network). */
export const PERPS: { coin: string; index: number }[] = Object.entries(testnet.perps).map(([coin, index]) => ({
  coin,
  index: index as number,
}));
export const perpIndexOf = (coin: string): number | undefined => PERPS.find((p) => p.coin === coin)?.index;
export const coinOf = (index: number): string => PERPS.find((p) => p.index === index)?.coin ?? `perp ${index}`;

export const DURATIONS: { label: string; sec: number }[] = [
  { label: '1h', sec: 3600 },
  { label: '4h', sec: 4 * 3600 },
  { label: '1d', sec: 86400 },
  { label: '3d', sec: 3 * 86400 },
  { label: '7d', sec: 7 * 86400 },
];

/** Default trigger level sits this fraction of the liq price above it (toward spot) — basis buffer, docs/how-it-works.md §8. */
export const LEVEL_BUFFER = 0.01;
export const FAUCET_AMOUNT = 1_000n * 10n ** 6n;

/** External explorer links, or undefined when VITE_EXPLORER_URL is empty (then render no link). */
export const txUrl = (hash: string, base = EXPLORER_URL): string | undefined => (base ? `${base}/tx/${hash}` : undefined);
export const addrUrl = (a: string, base = EXPLORER_URL): string | undefined => (base ? `${base}/address/${a}` : undefined);
