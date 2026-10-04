// Site constants. Addresses, perp indices and limits come from the deployment record at build time
// (deployments/testnet-v2.json); nothing chain-specific is hardcoded here. Build-time only (Astro frontmatter):
// the client reads these values from data- attributes in the HTML.
import testnetV2 from '../../deployments/testnet-v2.json';
import { findRecordedRun } from './lib/recorded.ts';

/** HyperEVM testnet: chain id and read-only RPC endpoints, tried in order (both send CORS *). */
export const TESTNET_CHAIN_ID = 998;
export const TESTNET_RPCS = ['https://rpcs.chain.link/hyperevm/testnet', 'https://rpc.hyperliquid-testnet.xyz/evm'];

const isAddr = (a: unknown): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
if (testnetV2.chainId !== TESTNET_CHAIN_ID) throw new Error('deployments/testnet-v2.json: expected chain 998');

const mock = testnetV2.pools.mock;
const core = testnetV2.pools.hypercore;
if (!isAddr(mock.pool) || !isAddr(core.priceSource))
  throw new Error('deployments/testnet-v2.json: expected a mock pool and a hypercore price source address');

/** The MOCK v2 pool the live ledger reads ("testnet demo pool"). */
export const MOCK_POOL = mock.pool;
/** The HyperCore price source: oraclePx6(perp) is the live testnet oracle. Never the MOCK price source. */
export const ORACLE_SOURCE = core.priceSource;
/** BTC's perp index on testnet, from the deployment record (differs per network; never hardcoded). */
export const BTC_INDEX: number = core.config.perps.BTC.index;
if (!Number.isInteger(BTC_INDEX)) throw new Error('deployments/testnet-v2.json: BTC perp index missing');

/** Testnet limits (strings in the record): shown as "testnet settings". */
export const LIMITS = Object.fromEntries(
  Object.entries(mock.config.limits).map(([k, v]) => [k, Number(v)]),
) as Record<keyof typeof mock.config.limits, number>;
export const WITHDRAW_DELAY_S = mock.config.withdrawDelay;
export const CLAIM_WINDOW_S = mock.config.claimWindow;
export const CONFIG_DELAY_S = mock.config.configDelay;

/** The recorded keeper run shown in Proof (build spec 2.2 S6). */
// The record may sit under the current pool or, after a redeploy, under previous.mock (the earlier pool).
const hit = findRecordedRun(testnetV2, 'mock', 'e2e_F9_2026-10-02_3');
const run = hit.run as any;
const tx = (purpose: RegExp) => {
  const t = run.txs.find((x: { purpose: string }) => purpose.test(x.purpose));
  if (!t || !/^0x[0-9a-f]{64}$/.test(t.hash)) throw new Error(`recorded run: no tx for ${purpose}`);
  return { block: t.block, status: t.status };
};
export const RECORDED_RUN = {
  /** The pool the run was made on; `earlier` when it is not the current MOCK pool. */
  pool: hit.pool,
  earlier: hit.earlier,
  coverId: run.coverId,
  buy: tx(/^buyCover/),
  drop: tx(/^setPrice BTC \d+ \(breach/),
  trigger: tx(/^trigger\(/),
  payout: run.trigger.payoutTransfer,
  premium: run.quote.premium,
  seconds: run.timing.blockTimestampDeltaS,
};
if (RECORDED_RUN.seconds !== 3) throw new Error('recorded run: the copy says 3 s by block timestamps; re-check it');

export const WAITLIST_ENDPOINT = '/api/join';
export const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

export { SITE_URL } from './site.ts';
