import { defineChain, getAddress, type Address } from 'viem';
import { testnet } from './generated/deployments';

const env = (import.meta.env ?? {}) as Record<string, string | undefined>;

export const RPC_URL = env.VITE_RPC_URL || testnet.rpc;
export const INFO_URL = env.VITE_INFO_URL || 'https://api.hyperliquid-testnet.xyz/info';
export const EXPLORER_URL = (env.VITE_EXPLORER_URL || 'https://explore-testnet.hyperpc.app').replace(/\/$/, '');
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
  blockExplorers: { default: { name: 'HyperEVM testnet explorer', url: EXPLORER_URL } },
  // Multicall3 is deployed on 998 (eth_getCode checked 2026-10-01); all polled reads go through it.
  contracts: { multicall3: { address: MULTICALL3 } },
  testnet: true,
});

export type PoolKind = 'hypercore' | 'mock';

export interface PoolConfig {
  kind: PoolKind;
  label: string;
  short: string;
  pool: Address;
  priceSource: Address;
  positionSource: Address;
  engineUrl: string;
  deployTx: `0x${string}`;
}

function pool(kind: PoolKind): PoolConfig {
  const p = testnet.pools[kind];
  const override = kind === 'mock' ? env.VITE_ENGINE_URL_MOCK : env.VITE_ENGINE_URL_HYPERCORE;
  return {
    kind,
    label: p.label,
    short: kind === 'mock' ? 'MOCK demo' : 'Real (HyperCore oracle)',
    pool: getAddress(p.pool),
    priceSource: getAddress(p.priceSource),
    positionSource: getAddress(p.positionSource),
    engineUrl: (override || ENGINE_DEFAULT).replace(/\/$/, ''),
    deployTx: p.txs.pool as `0x${string}`,
  };
}

export const POOLS: Record<PoolKind, PoolConfig> = { hypercore: pool('hypercore'), mock: pool('mock') };
export const USDC: Address = getAddress(testnet.usdc.address);
export const DEPLOYER: Address = getAddress(testnet.deployer);
export const QUOTE_SIGNER: Address = getAddress(testnet.quoteSigner);
/** Testnet perp indices from deployments/testnet.json — never hardcoded (CLAUDE.md). */
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

/** Default trigger level sits this fraction of the liq price above it (toward spot) — basis buffer, §8. */
export const LEVEL_BUFFER = 0.01;
export const FAUCET_AMOUNT = 1_000n * 10n ** 6n;

export const txUrl = (hash: string) => `${EXPLORER_URL}/tx/${hash}`;
export const addrUrl = (a: string) => `${EXPLORER_URL}/address/${a}`;
