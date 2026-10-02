// Pure helpers for scripts/e2e-mock-v2.mjs (F9 re-proof on the live v2 MOCK pool). No I/O here except
// signerSpawn's description, so node --test covers them. Units: prices px6 (USD x 1e6), USDC 6 decimals,
// ARCHITECTURE §3. Perp indices come from the deployments files, never from this file.

export const TESTNET_CHAIN_ID = 998;
export const LOCAL_CHAIN_ID = 31337;
export const MAINNET_CHAIN_ID = 999;

export const DEFAULTS = Object.freeze({
  coin: 'BTC',
  payout: 10_000_000n, // 10 mUSDC; per-buyer window cap on a 2,000 pool is 2,000 x 25 % x 25 % = 125
  durationSec: 3600,
  levelBps: 100, // level 1 % below the mock price (long cover); the v2 engine floor is 56 bps on testnet
  breachBps: 50, // the staged price sits this far past the level
  waitS: 60, // how long to wait for the keeper's trigger
  leverage: 10,
  headroom: 2n, // margin cap = headroom x payout
  maxFeeGwei: 10, // same ceiling as the keeper's default
  engine: 'http://localhost:8000',
  rpc: 'https://rpcs.chain.link/hyperevm/testnet',
});

export const USAGE = `usage: node scripts/e2e-mock-v2.mjs [--yes] [--fork] [--self-trigger] [--rpc <url>] [--engine <url>]
                                     [--coin BTC] [--payout <USDC 6-dec int>] [--level-bps <n>] [--duration <s>]
                                     [--wait <s>] [--max-fee-gwei <n>] [--no-reset]
  default         testnet (998): preflight and print the plan; nothing is sent
  --yes           execute on testnet as the deployer, with DEPLOYER_KEY read from .env inside this process
                  (handed to a local signer child through its environment; never on a command line, never printed)
  --fork          run the same flow on a local anvil FORK of testnet (chain id 998) this script starts; the deployer
                  is impersonated, no key is read; the live keeper does not watch the fork, so a read-only keeper
                  (--dry-run) is started against the fork to show its decision, and the trigger is sent by the
                  deployer (implies --self-trigger); writes a temp file, never deployments/
  --self-trigger  if the keeper has not triggered within --wait seconds, trigger from the deployer instead.
                  Such a run is recorded as NOT an F9 proof
  --rpc           testnet RPC (default ${DEFAULTS.rpc}); with --fork, the fork source
  --engine        Quote API base URL (default ${DEFAULTS.engine})
  --coin          perp by name from deployments/testnet.json perps (default ${DEFAULTS.coin}); long cover
  --payout        cover payout in USDC base units (default ${DEFAULTS.payout}, i.e. 10 mUSDC)
  --level-bps     level distance below the mock price in bps (default ${DEFAULTS.levelBps})
  --duration      cover duration in seconds (default ${DEFAULTS.durationSec})
  --wait          seconds to wait for the keeper's trigger (default ${DEFAULTS.waitS})
  --max-fee-gwei  maxFeePerGas ceiling (default ${DEFAULTS.maxFeeGwei})
  --no-reset      leave the mock price breached at the end (default: reset it to the live oracle)`;

export function parseE2eArgs(argv) {
  const a = {
    yes: false, fork: false, selfTrigger: false, rpc: null, engine: DEFAULTS.engine, coin: DEFAULTS.coin,
    payout: DEFAULTS.payout, levelBps: DEFAULTS.levelBps, durationSec: DEFAULTS.durationSec, waitS: DEFAULTS.waitS,
    maxFeeGwei: DEFAULTS.maxFeeGwei, reset: true, help: false,
  };
  const int = (k, v, min, max) => {
    if (!/^\d+$/.test(v)) throw new Error(`${k} must be a non-negative integer`);
    const n = Number(v);
    if (n < min || n > max) throw new Error(`${k} must be in [${min}, ${max}]`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${k} needs a value`);
      return v;
    };
    if (k === '--yes') a.yes = true;
    else if (k === '--fork') a.fork = true;
    else if (k === '--self-trigger') a.selfTrigger = true;
    else if (k === '--no-reset') a.reset = false;
    else if (k === '--help' || k === '-h') a.help = true;
    else if (k === '--rpc') a.rpc = val();
    else if (k === '--engine') a.engine = val().replace(/\/+$/, '');
    else if (k === '--coin') a.coin = val();
    else if (k === '--payout') {
      const v = val();
      if (!/^[1-9]\d*$/.test(v)) throw new Error('--payout must be a positive integer (USDC base units, 6 decimals)');
      a.payout = BigInt(v);
    } else if (k === '--level-bps') a.levelBps = int(k, val(), 1, 2000);
    else if (k === '--duration') a.durationSec = int(k, val(), 600, 7 * 86400);
    else if (k === '--wait') a.waitS = int(k, val(), 1, 600);
    else if (k === '--max-fee-gwei') {
      const v = val();
      if (!/^\d+(\.\d+)?$/.test(v) || !(Number(v) > 0)) throw new Error('--max-fee-gwei must be > 0');
      a.maxFeeGwei = Number(v);
    } else throw new Error(`unknown argument ${k}`);
  }
  if (a.fork) a.selfTrigger = true;
  if (!/^https?:\/\//.test(a.engine)) throw new Error('--engine must be an http(s) URL');
  return a;
}

// -- units -------------------------------------------------------------------------------------------

export function fmtUsdc(v) {
  const n = BigInt(v);
  const neg = n < 0n;
  const a = neg ? -n : n;
  return `${neg ? '-' : ''}${a / 1_000_000n}.${String(a % 1_000_000n).padStart(6, '0')}`;
}

export const fmtPx = fmtUsdc; // px6 has the same 6-decimal scale

// Level `bps` away from px6 on the losing side of the position: below for a long, above for a short.
export function levelFor(px6, isLong, bps) {
  const p = BigInt(px6);
  return isLong ? (p * BigInt(10_000 - bps)) / 10_000n : (p * BigInt(10_000 + bps) + 9_999n) / 10_000n;
}

// Staged price `bps` past the level (so the oracle breaches it: <= level for a long, >= for a short).
export function breachPrice(level, isLong, bps) {
  const l = BigInt(level);
  return isLong ? (l * BigInt(10_000 - bps)) / 10_000n : (l * BigInt(10_000 + bps) + 9_999n) / 10_000n;
}

// The engine's v2 level margin M = m + d + ceil(m d / 1e4) (ARCHITECTURE §6; 56 bps at the testnet limits).
export function levelMarginBps(limits) {
  const m = Number(limits.minLevelDistanceBps);
  const d = Number(limits.maxSpotDeviationBps);
  return m + d + Math.ceil((m * d) / 10_000);
}

// Mock position for the buyer: margin cap entryNtl / leverage = headroom x payout (USDC 6-dec = USD x 1e6).
// szi is in the perp's size units (10^szDecimals per coin, from the Info API meta), sign = direction.
export function planPosition({ payout, px6, isLong, leverage, szDecimals, headroom = DEFAULTS.headroom }) {
  const lev = BigInt(leverage);
  if (lev <= 0n) throw new Error('leverage must be > 0');
  const entryNtl = BigInt(payout) * headroom * lev;
  let szi = (entryNtl * 10n ** BigInt(szDecimals)) / BigInt(px6);
  if (szi < 1n) szi = 1n;
  if (entryNtl >= 2n ** 64n || szi >= 2n ** 63n) throw new Error('position does not fit uint64/int64');
  return { szi: isLong ? szi : -szi, entryNtl, leverage: Number(lev) };
}

// True when an existing mock position already backs the cover (same side, margin cap >= payout).
export function positionCovers(pos, isLong, payout) {
  if (!pos || pos.szi === 0n || pos.szi > 0n !== isLong || BigInt(pos.leverage) === 0n) return false;
  return BigInt(pos.entryNtl) / BigInt(pos.leverage) >= BigInt(payout);
}

// The contract's buyCover capacity and throttle checks (§5.3 checks 5 and 6) and the payout breaker of
// trigger, evaluated at `now` for one payout. -> { ok, problems[], room }
export function capacityCheck(s, payout, now, perpIndex) {
  const p = BigInt(payout);
  const L = s.limits;
  const B = s.capacityBase;
  const problems = [];
  const maxLocked = (B * BigInt(L.maxUtilizationBps)) / 10_000n;
  if (s.lockedAssets + p > maxLocked) problems.push(`utilization: locked ${fmtUsdc(s.lockedAssets + p)} > ${fmtUsdc(maxLocked)}`);
  const maxPerp = (B * BigInt(L.perPerpCapBps)) / 10_000n;
  if (s.lockedByPerp + p > maxPerp) problems.push(`per-perp cap (perp ${perpIndex}): ${fmtUsdc(s.lockedByPerp + p)} > ${fmtUsdc(maxPerp)}`);
  const reset = BigInt(now) >= s.windowStart + BigInt(L.saleWindow);
  const cap = ((reset ? B : s.windowAssets) * BigInt(L.maxSoldPerWindowBps)) / 10_000n;
  const sold = (reset ? 0n : s.soldInWindow) + p;
  if (sold > cap) problems.push(`sale window: ${fmtUsdc(sold)} > cap ${fmtUsdc(cap)}`);
  const bSold = (reset || s.buyerWindowStart !== s.windowStart ? 0n : s.buyerWindowSold) + p;
  const buyerCap = (cap * BigInt(L.maxBuyerWindowShareBps)) / 10_000n;
  if (bSold > buyerCap) problems.push(`buyer window share: ${fmtUsdc(bSold)} > ${fmtUsdc(buyerCap)}`);
  if (p < BigInt(L.minPayout)) problems.push(`payout ${fmtUsdc(p)} < minPayout ${fmtUsdc(L.minPayout)}`);
  // Payout breaker: the trigger must not pause the pool (a paused MOCK pool would block later demos).
  const pReset = BigInt(now) >= s.paidWindowStart + BigInt(L.saleWindow);
  const paid = (pReset ? 0n : s.paidInWindow) + p;
  const paidCap = ((pReset ? B : s.paidWindowAssets) * BigInt(L.maxPaidPerWindowBps)) / 10_000n;
  if (paid > paidCap) problems.push(`payout breaker: paid ${fmtUsdc(paid)} > ${fmtUsdc(paidCap)} would pause the pool`);
  return { ok: problems.length === 0, problems, room: { maxLocked, maxPerp, cap, buyerCap, paidCap } };
}

// -- ABI (static words; selectors and topics checked against `cast sig` in e2e.test.mjs) -----------------

export const SEL = Object.freeze({
  setPrice: '98764f22', // setPrice(uint32,uint64)
  px6Of: 'ea17da41', // px6Of(uint32)
  oraclePx6: 'b1d42205', // oraclePx6(uint32)
  setPosition: 'cb13e9e0', // setPosition(address,uint32,int64,uint64,uint32)
  position: '52aaa634', // position(address,uint32)
  owner: '8da5cb5b', // owner()
  mint: '40c10f19', // mint(address,uint256)
  approve: '095ea7b3', // approve(address,uint256)
  balanceOf: '70a08231', // balanceOf(address)
  buyCover: '3ec4ea0e', // buyCover((address,uint32,bool,uint64,uint256,uint256,uint64,uint64,uint64,uint256),bytes)
  trigger: 'ed684cc6', // trigger(uint256)
  getCover: 'fd7b68a2', // getCover(uint256)
  coverCount: 'feb0b8f5', // coverCount()
  paused: '5c975abb', // paused()
  capacityBase: 'c838a7af', // capacityBase()
  lockedAssets: '274fc72a', // lockedAssets()
  lockedByPerp: '0849ff36', // lockedByPerp(uint32)
  limits: '860aefcf', // limits()
  windowStart: 'b0c2783a', // windowStart()
  windowAssets: '71c51473', // windowAssets()
  soldInWindow: 'd81354b0', // soldInWindow()
  buyerWindow: '7d1296fc', // buyerWindow(address)
  paidWindowStart: 'a565c897', // paidWindowStart()
  paidWindowAssets: '7ebd677d', // paidWindowAssets()
  paidInWindow: '855e56dd', // paidInWindow()
  perpAllowed: '8f739c59', // perpAllowed(uint32)
  minPremiumBps: 'd8fcb368', // minPremiumBps()
  priceSource: '20531bc9', // priceSource()
  positionSource: '2d458292', // positionSource()
  asset: '38d52e0f', // asset()
  quoteSigner: 'f413bdb3', // quoteSigner()
});

export const SIGS = Object.freeze({
  setPrice: 'setPrice(uint32,uint64)', px6Of: 'px6Of(uint32)', oraclePx6: 'oraclePx6(uint32)',
  setPosition: 'setPosition(address,uint32,int64,uint64,uint32)', position: 'position(address,uint32)', owner: 'owner()',
  mint: 'mint(address,uint256)', approve: 'approve(address,uint256)', balanceOf: 'balanceOf(address)',
  buyCover: 'buyCover((address,uint32,bool,uint64,uint256,uint256,uint64,uint64,uint64,uint256),bytes)',
  trigger: 'trigger(uint256)', getCover: 'getCover(uint256)', coverCount: 'coverCount()', paused: 'paused()',
  capacityBase: 'capacityBase()', lockedAssets: 'lockedAssets()', lockedByPerp: 'lockedByPerp(uint32)', limits: 'limits()',
  windowStart: 'windowStart()', windowAssets: 'windowAssets()', soldInWindow: 'soldInWindow()',
  buyerWindow: 'buyerWindow(address)', paidWindowStart: 'paidWindowStart()', paidWindowAssets: 'paidWindowAssets()',
  paidInWindow: 'paidInWindow()', perpAllowed: 'perpAllowed(uint32)', minPremiumBps: 'minPremiumBps()',
  priceSource: 'priceSource()', positionSource: 'positionSource()', asset: 'asset()', quoteSigner: 'quoteSigner()',
});

export const TOPIC = Object.freeze({
  CoverPurchased: '0xebcd070febd687c66afe734149e8108c33f949e953df393546ca2c5b57e13a62',
  CoverTriggered: '0x81ed9f2747da9d0a39a4029b3be1c496e63b89f61dcbfe088a7c42f46b5d3309',
  Transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  PayoutDeferred: '0x54ce20b025f500d61d580ad59a7050cc533f69121275cfe095ef32ec9976df90',
  LossBreakerTripped: '0x043ac3aaa9b5d1503773a782896cf4a211871c4ead233773403fd1f0487f4f4c',
});

export const EVENT_SIGS = Object.freeze({
  CoverPurchased: 'CoverPurchased(uint256,address,uint32,bool,uint64,uint256,uint256,uint64)',
  CoverTriggered: 'CoverTriggered(uint256,uint64,address)',
  Transfer: 'Transfer(address,address,uint256)',
  PayoutDeferred: 'PayoutDeferred(uint256,address,uint256)',
  LossBreakerTripped: 'LossBreakerTripped(uint256,uint256)',
});

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export function word(v) {
  if (typeof v === 'boolean') return (v ? 1n : 0n).toString(16).padStart(64, '0');
  if (typeof v === 'string' && ADDR_RE.test(v)) return v.slice(2).toLowerCase().padStart(64, '0');
  let n = BigInt(v);
  if (n < 0n) n += 2n ** 256n; // two's complement (int64 szi of a short)
  if (n < 0n || n >= 2n ** 256n) throw new Error(`value out of range: ${v}`);
  return n.toString(16).padStart(64, '0');
}

export function calldata(name, args = []) {
  const sel = SEL[name];
  if (!sel) throw new Error(`no selector for ${name}`);
  return `0x${sel}${args.map(word).join('')}`;
}

export const QUOTE_FIELDS = ['buyer', 'perpIndex', 'isLong', 'level', 'payout', 'premium', 'expiry', 'spotRef', 'deadline', 'nonce'];

// buyCover(Quote, bytes): the static Quote tuple inline (10 words), then the bytes offset, length and data.
export function buyCoverCalldata(q, sig) {
  if (!/^0x([0-9a-fA-F]{2})+$/.test(sig)) throw new Error('signature is not hex');
  const head = QUOTE_FIELDS.map((f) => word(q[f]));
  const bytes = sig.slice(2).toLowerCase();
  const len = bytes.length / 2;
  const padded = bytes.padEnd(Math.ceil(len / 32) * 64, '0');
  return `0x${SEL.buyCover}${head.join('')}${word(32 * (QUOTE_FIELDS.length + 1))}${word(len)}${padded}`;
}

export function words(hex) {
  const h = String(hex ?? '0x').replace(/^0x/, '');
  if (h.length % 64) throw new Error(`return data is not whole words (${h.length / 2} bytes)`);
  const out = [];
  for (let i = 0; i < h.length; i += 64) out.push(BigInt(`0x${h.slice(i, i + 64)}`));
  return out;
}

export const toAddr = (w) => `0x${BigInt(w).toString(16).padStart(40, '0')}`;
export const toInt64 = (w) => {
  const n = BigInt.asUintN(64, BigInt(w));
  return n >= 2n ** 63n ? n - 2n ** 64n : n;
};

export const STATUS = ['None', 'Active', 'Paid', 'Expired'];

// getCover -> {buyer, perpIndex, isLong, level, payout, premium, start, expiry, status}
export function decodeCover(hex) {
  const w = words(hex);
  if (w.length < 9) throw new Error('getCover: short return');
  return {
    buyer: toAddr(w[0]), perpIndex: Number(w[1]), isLong: w[2] === 1n, level: w[3], payout: w[4], premium: w[5],
    start: w[6], expiry: w[7], status: STATUS[Number(w[8])] ?? `unknown(${w[8]})`,
  };
}

export const LIMIT_FIELDS = [
  'maxUtilizationBps', 'perPerpCapBps', 'maxDuration', 'maxSpotDeviationBps', 'minPayout', 'minPremiumBps',
  'minLevelDistanceBps', 'saleWindow', 'maxSoldPerWindowBps', 'maxBuyerWindowShareBps', 'maxPaidPerWindowBps',
];

export function decodeLimits(hex) {
  const w = words(hex);
  if (w.length < LIMIT_FIELDS.length) throw new Error('limits: short return');
  return Object.fromEntries(LIMIT_FIELDS.map((f, i) => [f, w[i]]));
}

const lc = (a) => String(a ?? '').toLowerCase();
const topicAddr = (t) => toAddr(BigInt(t));

// CoverPurchased log of a buyCover receipt -> coverId (null when absent).
export function coverIdFromReceipt(receipt, pool) {
  for (const lg of receipt?.logs ?? []) {
    if (lc(lg.address) === lc(pool) && lc(lg.topics?.[0]) === TOPIC.CoverPurchased) return BigInt(lg.topics[1]);
  }
  return null;
}

// A trigger receipt -> { coverId, oraclePx, caller, payoutTransfer, deferred, breaker }.
export function decodeTriggerReceipt(receipt, { pool, usdc, buyer }) {
  const out = { coverId: null, oraclePx: null, caller: null, payoutTransfer: null, deferred: false, breaker: false };
  for (const lg of receipt?.logs ?? []) {
    const t0 = lc(lg.topics?.[0]);
    if (lc(lg.address) === lc(pool) && t0 === TOPIC.CoverTriggered) {
      const w = words(lg.data);
      out.coverId = BigInt(lg.topics[1]);
      out.oraclePx = w[0];
      out.caller = toAddr(w[1]);
    } else if (lc(lg.address) === lc(pool) && t0 === TOPIC.PayoutDeferred) out.deferred = true;
    else if (lc(lg.address) === lc(pool) && t0 === TOPIC.LossBreakerTripped) out.breaker = true;
    else if (lc(lg.address) === lc(usdc) && t0 === TOPIC.Transfer && lg.topics.length === 3) {
      if (lc(topicAddr(lg.topics[1])) === lc(pool) && lc(topicAddr(lg.topics[2])) === lc(buyer)) {
        out.payoutTransfer = words(lg.data)[0];
      }
    }
  }
  return out;
}

// eth_getBlockByNumber(full txs) -> the tx calling pool.trigger(coverId), or null.
export function findTriggerTx(block, pool, coverId) {
  const want = `0x${SEL.trigger}${word(coverId)}`;
  for (const tx of block?.transactions ?? []) {
    if (typeof tx === 'object' && lc(tx.to) === lc(pool) && lc(tx.input ?? tx.data).startsWith(want)) return tx;
  }
  return null;
}

// -- quote checks ------------------------------------------------------------------------------------

// Engine /quote response vs what this run asked for and what the chain holds. -> problems[]
export function checkQuote(resp, want) {
  const p = [];
  const q = resp?.quote;
  if (!q || typeof resp.signature !== 'string') return [`no quote in the response: ${JSON.stringify(resp).slice(0, 300)}`];
  for (const f of QUOTE_FIELDS) {
    if (f === 'buyer') continue;
    if (f === 'isLong') {
      if (typeof q.isLong !== 'boolean') p.push('isLong is not a boolean');
    } else if (!Number.isSafeInteger(q[f]) || q[f] < 0) p.push(`${f} is not a JSON-safe non-negative integer`);
  }
  if (p.length) return p;
  if (lc(q.buyer) !== lc(want.buyer)) p.push(`buyer ${q.buyer} != ${want.buyer}`);
  if (q.perpIndex !== want.perpIndex) p.push(`perpIndex ${q.perpIndex} != ${want.perpIndex}`);
  if (q.isLong !== want.isLong) p.push('isLong differs');
  if (BigInt(q.level) !== BigInt(want.level)) p.push(`level ${q.level} != ${want.level}`);
  if (BigInt(q.payout) !== BigInt(want.payout)) p.push(`payout ${q.payout} != ${want.payout}`);
  if (BigInt(q.spotRef) !== BigInt(want.spotRef)) p.push(`spotRef ${q.spotRef} != mock price ${want.spotRef} (engine spot cache?)`);
  if (resp.breakdown?.pool && lc(resp.breakdown.pool) !== lc(want.pool)) p.push(`signed for pool ${resp.breakdown.pool}, not ${want.pool}`);
  if (BigInt(q.premium) * 2n > BigInt(q.payout)) p.push(`premium ${fmtUsdc(q.premium)} is more than half the payout`);
  return p;
}

// -- deployments record ------------------------------------------------------------------------------

export function localDate(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

// Key for the record: e2e_F9_<date> (a self-triggered run: e2e_F9_selftrigger_<date>), suffixed _2, _3...
// when that key exists already, so an earlier run is never overwritten.
export function e2eKey(date, selfTriggered, existing = {}) {
  const base = `e2e_F9_${selfTriggered ? 'selftrigger_' : ''}${date}`;
  if (!(base in existing)) return base;
  for (let i = 2; ; i++) if (!(`${base}_${i}` in existing)) return `${base}_${i}`;
}

// Merge the record into deployments/testnet-v2.json content under pools.mock (the pool address must match).
export function mergeE2e(doc, pool, key, block) {
  const out = JSON.parse(JSON.stringify(doc));
  const mock = out?.pools?.mock;
  if (!mock) throw new Error('deployments/testnet-v2.json has no pools.mock');
  if (lc(mock.pool) !== lc(pool)) throw new Error(`pools.mock.pool is ${mock.pool}, this run used ${pool}`);
  if (key in mock) throw new Error(`pools.mock already has ${key}`);
  mock[key] = block;
  return out;
}

// JSON with BigInt values as decimal strings (numbers that fit 2^53 stay numbers).
export function jsonable(v) {
  if (typeof v === 'bigint') return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
  if (Array.isArray(v)) return v.map(jsonable);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonable(x)]));
  return v;
}

// -- fees --------------------------------------------------------------------------------------------

// EIP-1559 fees: maxFee = 2 x base + tip, capped at the ceiling; refuses a base fee above the ceiling.
export function chooseFees(baseFee, tip, ceilingWei) {
  const base = BigInt(baseFee);
  const t = BigInt(tip);
  const cap = BigInt(ceilingWei);
  if (base + t > cap) throw new Error(`base fee ${base} + tip ${t} wei is above the ${cap} wei ceiling (--max-fee-gwei)`);
  const want = 2n * base + t;
  return { maxFeePerGas: want > cap ? cap : want, maxPriorityFeePerGas: t };
}

// -- signer child ------------------------------------------------------------------------------------

// The signer runs in the engine venv python (eth_account). DEPLOYER_KEY reaches it through its environment
// only. It answers {"address"} once, then signs one EIP-1559 tx per stdin line ({"tx": {...}} ->
// {"raw": "0x..."}) for chain 998 / 31337 only and only to the allowlisted addresses. It never writes the key.
export const SIGNER_PY = `
import json, os, sys
from eth_account import Account
from eth_utils import to_checksum_address
key = os.environ.pop("DEPLOYER_KEY", "").strip()
allow = {a.lower() for a in os.environ.get("E2E_SIGNER_ALLOW", "").split(",") if a}
if not key:
    print(json.dumps({"error": "DEPLOYER_KEY is not set"}), flush=True)
    sys.exit(2)
try:
    acct = Account.from_key(key)
except Exception:
    print(json.dumps({"error": "DEPLOYER_KEY is not a valid private key"}), flush=True)
    sys.exit(2)
del key
print(json.dumps({"address": acct.address}), flush=True)
for line in sys.stdin:
    try:
        tx = json.loads(line)["tx"]
        if int(tx["chainId"]) not in (998, 31337):
            raise ValueError("refusing chainId %s" % tx["chainId"])
        if tx["to"].lower() not in allow:
            raise ValueError("refusing a tx to %s (not allowlisted)" % tx["to"])
        t = {"type": 2, "chainId": int(tx["chainId"]), "nonce": int(tx["nonce"]), "to": to_checksum_address(tx["to"]),
             "value": 0, "data": tx["data"], "gas": int(tx["gas"]), "maxFeePerGas": int(tx["maxFeePerGas"]),
             "maxPriorityFeePerGas": int(tx["maxPriorityFeePerGas"])}
        s = acct.sign_transaction(t)
        raw = getattr(s, "raw_transaction", None) or getattr(s, "rawTransaction")
        out = {"raw": "0x" + bytes(raw).hex().removeprefix("0x"), "hash": "0x" + bytes(s.hash).hex().removeprefix("0x")}
    except Exception as e:
        out = {"error": type(e).__name__ + ": " + str(e)[:200]}
    print(json.dumps(out), flush=True)
`;

// Spawn description for the signer: the key goes into the child's env only (never argv); every other
// secret is dropped from that env. -> { args, env }
export function signerSpawn({ baseEnv, dotenv, allow }) {
  const env = { ...baseEnv };
  for (const k of ['DEPLOYER_KEY', 'QUOTE_SIGNER_KEY', 'KEEPER_KEY']) delete env[k];
  const key = (dotenv?.DEPLOYER_KEY ?? '').trim();
  if (!key) throw new Error('DEPLOYER_KEY is not set in .env');
  env.DEPLOYER_KEY = key;
  env.E2E_SIGNER_ALLOW = allow.map(lc).join(',');
  env.PYTHONUNBUFFERED = '1';
  return { args: ['-c', SIGNER_PY], env };
}

// Last-line defence for output: replaces any 32-byte hex secret from `secrets` in a line.
export function scrub(line, secrets) {
  let s = String(line);
  for (const k of secrets) {
    const h = String(k ?? '').trim().replace(/^0x/i, '');
    if (h.length >= 32) s = s.split(h).join('<redacted>').split(h.toLowerCase()).join('<redacted>');
  }
  return s;
}
