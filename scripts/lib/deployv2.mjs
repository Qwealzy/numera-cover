// Pure helpers for scripts/deploy-v2.mjs (ARCHITECTURE §5.9). No I/O here, so node --test covers them.

export const TESTNET_CHAIN_ID = 998;
export const LOCAL_CHAIN_ID = 31337;
export const PRECOMPILES = [
  '0x0000000000000000000000000000000000000800',
  '0x0000000000000000000000000000000000000807',
  '0x000000000000000000000000000000000000080a',
];
// HyperEVM big-block gas limit (docs/research/hyperliquid.md); the --fork anvil uses it. Must equal
// Deploy.BIG_BLOCK_GAS_LIMIT. The CoverPool creation (~4.9M gas) does not fit a 3M small block, and forge's local
// pass caps each broadcast transaction at the gas limit of the block it forks (the RPC's latest, almost always a
// small block), even with --block-gas-limit; only --disable-block-gas-limit lifts it. 2026-10-02 testnet run: the
// pool creation ran out of gas there and forge only said "Failed to decode return value: 0x".
export const BIG_BLOCK_GAS_LIMIT = 30_000_000;
// anvil's first default account (public dev account; the dry run broadcasts with --unlocked, no key).
export const ANVIL_ACCOUNT0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

export const USAGE = `usage: node scripts/deploy-v2.mjs [--dry-run | --fork] [--yes] [--mode hypercore|mock] [--rpc <url>]
                                   [--standin-px <px6,...>] [--gas-price <wei>] [--replace]
  default      deploy to testnet (998) with DEPLOYER_KEY from .env; writes deployments/testnet-v2.json
  --dry-run    same steps against a local anvil (31337) this script starts (or --rpc to an existing one);
               broadcasts with anvil's unlocked account 0, never with DEPLOYER_KEY; writes a temp file
  --fork       same steps against a local anvil FORK of testnet (chain id 998, real nonce, USDC and state) this
               script starts from the testnet RPC (or --rpc as the fork source); broadcasts to the fork only, as
               the impersonated deployer from deployments/testnet.json, never with DEPLOYER_KEY; writes a temp file
  --yes        required to broadcast (the plan and a no-broadcast forge simulation run first)
  --mode       hypercore (default: HyperCore precompile sources) | mock (MOCK demo pool)
  --standin-px px6 per perp for the local stand-ins / mock prices (default: fetched from the testnet Info API)
  --gas-price  passed to forge as --with-gas-price (big-block gas price is NOT VERIFIED, ARCHITECTURE §5.9)
  --replace    overwrite an existing entry for this mode in deployments/testnet-v2.json`;

export function parseDeployArgs(argv) {
  const a = { dryRun: false, fork: false, yes: false, mode: 'hypercore', rpc: null, standinPx: null, gasPrice: null, replace: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${k} needs a value`);
      return v;
    };
    if (k === '--dry-run') a.dryRun = true;
    else if (k === '--fork') a.fork = true;
    else if (k === '--yes') a.yes = true;
    else if (k === '--replace') a.replace = true;
    else if (k === '--help' || k === '-h') a.help = true;
    else if (k === '--mode') a.mode = val();
    else if (k === '--rpc') a.rpc = val();
    else if (k === '--standin-px') a.standinPx = val().split(',').map((s) => s.trim());
    else if (k === '--gas-price') a.gasPrice = val();
    else throw new Error(`unknown argument ${k}`);
  }
  if (a.dryRun && a.fork) throw new Error('--dry-run and --fork are exclusive');
  if (!['hypercore', 'mock'].includes(a.mode)) throw new Error('--mode must be hypercore or mock');
  if (a.gasPrice !== null && !/^\d+$/.test(a.gasPrice)) throw new Error('--gas-price must be an integer (wei)');
  if (a.standinPx) for (const p of a.standinPx) if (!/^[1-9]\d*$/.test(p)) throw new Error('--standin-px must be positive integers (px6)');
  return a;
}

// Info API decimal price string -> px6 integer string, rounding half up beyond 6 decimals. Throws on <= 0.
export function decimalToPx6(s) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(s).trim());
  if (!m) throw new Error(`not a decimal price: ${s}`);
  const frac = (m[2] ?? '').padEnd(7, '0');
  let v = BigInt(m[1]) * 1_000_000n + BigInt(frac.slice(0, 6));
  if (Number(frac[6]) >= 5) v += 1n;
  if (v <= 0n) throw new Error(`non-positive price ${s}`);
  return v.toString();
}

// deployments/<env>.json `perps` ({BTC: 3, ...}) -> [{name, index}] in file order.
export function perpList(perps) {
  if (!perps || typeof perps !== 'object') throw new Error('deployments file has no perps');
  return Object.entries(perps).map(([name, index]) => {
    if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) throw new Error(`bad perp index for ${name}`);
    return { name, index };
  });
}

// metaAndAssetCtxs -> stand-in px6 per perp; the universe name at each index must match the deployments name,
// so a stale index table is caught before anything is sent.
export function standinFromInfo(meta, perps) {
  if (!Array.isArray(meta) || meta.length !== 2 || !Array.isArray(meta[0]?.universe)) {
    throw new Error('unexpected metaAndAssetCtxs response');
  }
  const [{ universe }, ctxs] = meta;
  return perps.map(({ name, index }) => {
    const u = universe[index];
    if (!u || u.name !== name) throw new Error(`Info API perp ${index} is ${u?.name ?? 'missing'}, deployments says ${name}`);
    const px = ctxs[index]?.oraclePx;
    if (px === undefined) throw new Error(`no oraclePx for ${name}`);
    return decimalToPx6(px);
  });
}

// Environment for the forge child. .env values go here only (never argv, never printed). The dry run never
// sees DEPLOYER_KEY: it broadcasts with anvil's unlocked account.
export function childEnv(base, dotenv, vars, { dryRun }) {
  const env = { ...base };
  delete env.DEPLOYER_KEY;
  if (!dryRun && dotenv?.DEPLOYER_KEY) env.DEPLOYER_KEY = dotenv.DEPLOYER_KEY;
  for (const [k, v] of Object.entries(vars)) if (v !== undefined && v !== null && v !== '') env[k] = String(v);
  return env;
}

// forge script argv. broadcast=false is the preflight: forge's local pass only, nothing is sent. unlockedSender
// (anvil only) broadcasts through the node's unlocked/impersonated account instead of DEPLOYER_KEY.
export function forgeArgs({ rpc, unlockedSender = null, gasPrice = null, broadcast = true }) {
  const a = ['script', 'script/Deploy.s.sol', '--rpc-url', rpc];
  if (broadcast) a.push('--broadcast');
  a.push('--skip-simulation', '--slow', '--disable-block-gas-limit');
  if (unlockedSender) a.push('--unlocked', '--sender', unlockedSender);
  if (gasPrice) a.push('--with-gas-price', gasPrice);
  return a;
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;

// Audit L4: the guardian (pause key) must be a key of its own, never the keeper bot's. Returns a problem string or
// null. On chain 998 (also the fork) both addresses are mandatory, as in Deploy.s.sol; on local 31337 the guardian
// may be absent. Pure, so node --test covers it.
export function guardianProblem(chainId, guardian, keeper) {
  const g = (guardian ?? '').trim();
  const k = (keeper ?? '').trim();
  if (g && !ADDR.test(g)) return `GUARDIAN is not an address: ${g}`;
  if (k && !ADDR.test(k)) return `keeper in deployments/testnet.json is not an address: ${k}`;
  if (chainId === TESTNET_CHAIN_ID) {
    if (!g) return 'GUARDIAN is not set in .env: the pause key must be a key of its own (not the keeper, audit L4)';
    if (!k) return 'deployments/testnet.json has no keeper address to check GUARDIAN against';
  }
  if (g && k && g.toLowerCase() === k.toLowerCase()) return 'GUARDIAN equals the keeper address: use a separate key (audit L4)';
  return null;
}

// SEED_USDC (.env, whole mUSDC) -> normalised string, undefined when unset (Deploy.s.sol then defaults to 100000 on
// 998). Throws on anything but a non-negative integer. Audit L3.
export function parseSeed(v) {
  if (v === undefined || v === null || String(v).trim() === '') return undefined;
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) throw new Error(`SEED_USDC must be a whole number of mUSDC, got "${s}"`);
  return s;
}

// eth_getCode result -> true when the address has code ("0x" / "0x0" / empty = no code).
export function hasCode(code) {
  return typeof code === 'string' && /^0x[0-9a-f]*$/i.test(code) && /[1-9a-f]/i.test(code.slice(2));
}

// forge's run-latest.json -> { contracts: {Name: address}, txs: [...], precompileTxs: [...] }.
export function summarizeBroadcast(run) {
  const receipts = new Map((run.receipts ?? []).map((r) => [String(r.transactionHash).toLowerCase(), r]));
  const contracts = {};
  const txs = [];
  const precompileTxs = [];
  for (const t of run.transactions ?? []) {
    const to = String(t.transaction?.to ?? '').toLowerCase();
    if (PRECOMPILES.includes(to)) precompileTxs.push(t.hash);
    if (t.transactionType === 'CREATE' && t.contractName && t.contractAddress) contracts[t.contractName] = t.contractAddress;
    const r = receipts.get(String(t.hash).toLowerCase());
    txs.push({
      name: t.contractName ?? null,
      function: t.function ?? (t.transactionType === 'CREATE' ? 'create' : null),
      hash: t.hash,
      gasUsed: r ? Number(BigInt(r.gasUsed)) : null,
      status: r ? Number(BigInt(r.status)) : null,
    });
  }
  return { contracts, txs, precompileTxs };
}

export const LIMIT_FIELDS = [
  'maxUtilizationBps',
  'perPerpCapBps',
  'maxDuration',
  'maxSpotDeviationBps',
  'minPayout',
  'minPremiumBps',
  'minLevelDistanceBps',
  'saleWindow',
  'maxSoldPerWindowBps',
  'maxBuyerWindowShareBps',
  'maxPaidPerWindowBps',
];

// `cast call ... "limits()((uint16,...))" --json` -> ["(8000, 5000, ...)"] or a nested array; -> {field: string}
export function parseLimits(castJson) {
  let v = castJson;
  if (Array.isArray(v) && v.length === 1) v = v[0];
  const parts = Array.isArray(v) ? v.map(String) : String(v).replace(/^\(|\)$/g, '').split(',').map((s) => s.trim().split(' ')[0]);
  if (parts.length !== LIMIT_FIELDS.length) throw new Error(`limits(): expected ${LIMIT_FIELDS.length} fields, got ${parts.length}`);
  return Object.fromEntries(LIMIT_FIELDS.map((f, i) => [f, parts[i]]));
}

// Merge one mode's block into deployments/testnet-v2.json content; refuses to replace an entry unless asked.
export function mergeV2(existing, mode, block, { replace }) {
  const out = existing ? JSON.parse(JSON.stringify(existing)) : { env: 'testnet', chainId: TESTNET_CHAIN_ID, contract: 'CoverPool v2', pools: {} };
  out.pools ??= {};
  if (out.pools[mode] && !replace) throw new Error(`deployments/testnet-v2.json already has a ${mode} pool; pass --replace to overwrite`);
  out.pools[mode] = block;
  return out;
}
