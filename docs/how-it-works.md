# How Numera works

Position-linked, parametric liquidation cover for Hyperliquid perps: a USDC underwriter pool on HyperEVM
and an off-chain pricing engine that signs quotes. This document is the technical design; the README has
the deployment, evidence and run instructions.

## 1. Product

A trader with a long BTC perp at 20× fears a wick to the liquidation price. They buy cover: "if the BTC
oracle price trades at or below $L before time T, pay me $P". $L defaults to just above the liquidation
price; $P is capped by the margin they would lose. If the level is hit, anyone (the keeper, the trader, a
bot) calls `trigger()` and the pool pays at once: no claim, no assessor, no trade to execute in a gap.
Underwriters deposit USDC into the pool and earn the premiums. Every payout is fully reserved at sale, so
the pool cannot become insolvent.

**Why not a stop-loss?** A stop closes the position, often at the bottom of a wick, and slips in a gap.
Cover keeps the position open and pays cash.

**Why not an outcome market?** Outcome markets are order-book contracts that settle at expiry. Numera's
cover is a path-dependent touch, sized and checked against the trader's actual HyperCore position, priced on
demand from a published formula, with an underwriter pool on the other side.

## 2. Components

```
                 ┌────────────────────────── app/ (Vite + React + viem) ──────────────────────────┐
  Trader / LP ──►│ positions & liq px (Info API) · quote · buy cover · LP deposit · dashboards    │
                 └───────┬───────────────────────────────┬────────────────────────────────────────┘
                         │ POST /quote                    │ txs (buyCover, deposit, withdraw)
                         ▼                                ▼
  ┌──── engine/ (Python) ─────────────┐      ┌──── contracts/ (Foundry, HyperEVM) ──────────────┐
  │ data: Info API candles, ctxs      │      │ CoverPool  (ERC-4626 vault + cover book)          │
  │ vol: EWMA σ + floor               │      │   ├─ quote verification (EIP-712, signer, nonce)  │
  │ pricing: one-touch p, tail floor  │ sig  │   ├─ IPriceSource  ─ HyperCorePriceSource (0x807) │
  │ quote_api: FastAPI, signs quotes ─┼─────►│   │                └ MockPriceSource (demo/tests) │
  │ backtest: calibration + pool P&L  │      │   └─ IPositionSource ─ HyperCorePositionSource    │
  │ keeper: watch covers, trigger() ──┼─────►│                       (0x800) └ MockPositionSource│
  └───────────────────────────────────┘      │ MockUSDC (testnet/local only)                     │
                                             └───────────────────────────────────────────────────┘
```

The three components meet only at the EIP-712 Quote (§4), the contract ABI and events (§5) and the Quote
API (§6).

## 3. Units and conventions

- **Price**: `uint64`, USD × 1e6 ("px6"). From the precompile: `px6 = raw × 10^szDecimals`.
- **USDC amounts**: `uint256`, 6 decimals.
- **Time**: unix seconds (`uint64`) on-chain; milliseconds only inside Info API calls.
- **Perp index**: `uint32`, network-specific (BTC is 0 on mainnet and 3 on testnet), never hardcoded; read
  from `deployments/<env>.json`.
- **Direction**: `isLong = true` → the cover triggers when `oraclePx ≤ level`; `false` → when `oraclePx ≥ level`.
- **Networks**: `local` (anvil, chain 31337), `testnet` (998). Mainnet (999) is out of scope: deploy
  scripts require chain 998 or 31337 and the engine never signs for 999.

## 4. Quote (EIP-712): the engine signs, the contract verifies

Domain: `name="Numera"`, `version="1"`, `chainId`, `verifyingContract = CoverPool`.

```solidity
struct Quote {
    address buyer;       // must equal msg.sender
    uint32  perpIndex;
    bool    isLong;      // direction of the covered position
    uint64  level;       // px6 trigger level
    uint256 payout;      // USDC (6 dec)
    uint256 premium;     // USDC (6 dec)
    uint64  expiry;      // cover end (unix s)
    uint64  spotRef;     // px6 oracle price the engine priced against
    uint64  deadline;    // quote must be used before this (unix s), ~60 s after issue
    uint256 nonce;       // unique per quote; the contract marks it used
}
```

Type string (exact):
`Quote(address buyer,uint32 perpIndex,bool isLong,uint64 level,uint256 payout,uint256 premium,uint64 expiry,uint64 spotRef,uint64 deadline,uint256 nonce)`

A shared test vector (`contracts/test/vectors/quote_vector.json`, signed with the public anvil test key)
checks that the Solidity and Python encoders produce the same digest and signature.

## 5. CoverPool contract

An ERC-4626 vault over USDC (OpenZeppelin, with a decimals offset against the inflation attack) plus a
cover book.

```solidity
enum Status { None, Active, Paid, Expired }
struct Cover { address buyer; uint32 perpIndex; bool isLong; uint64 level; uint256 payout;
               uint256 premium; uint64 start; uint64 expiry; Status status; }

function buyCover(Quote calldata q, bytes calldata sig) external returns (uint256 coverId);
function trigger(uint256 coverId) external;            // permissionless
function expire(uint256 coverId) external;             // permissionless, after expiry
function getCover(uint256 coverId) external view returns (Cover memory);
function lockedAssets() external view returns (uint256);
// owner: setQuoteSigner, setLimits(maxUtilBps, perPerpCapBps, maxDuration, maxSpotDevBps, minPayout), setPaused

event CoverPurchased(uint256 indexed coverId, address indexed buyer, uint32 indexed perpIndex,
                     bool isLong, uint64 level, uint256 payout, uint256 premium, uint64 expiry);
event CoverTriggered(uint256 indexed coverId, uint64 oraclePx, address caller);
event CoverExpired(uint256 indexed coverId);
```

`buyCover` checks, in order (each failure is a custom error naming the check):

1. The signature recovers to `quoteSigner`; `q.buyer == msg.sender`; `block.timestamp ≤ q.deadline`; the
   nonce is unused.
2. `block.timestamp < q.expiry ≤ block.timestamp + maxDuration`; `payout ≥ minPayout`.
3. Price sanity: the current oracle price is within `maxSpotDeviationBps` of `q.spotRef` and the level is
   **not already breached**.
4. Insurable interest (via `IPositionSource`): the buyer holds a position on `perpIndex` whose sign matches
   `isLong`, and `payout ≤ marginCap`, where `marginCap = entryNtl / leverage` (initial margin estimate).
5. Capacity: `lockedAssets + payout ≤ totalAssets × maxUtilizationBps`, and the amount locked on that perp
   stays within `perPerpCapBps`.
6. Pull `premium` USDC from the buyer, lock `payout`, store the cover, emit `CoverPurchased`.

`trigger`: the cover is Active, `block.timestamp ≤ expiry` and the current oracle price breaches the level →
status Paid, unlock, transfer the payout to the buyer, emit. `expire`: Active and `block.timestamp > expiry`
→ Expired, unlock, emit.

Vault accounting: `totalAssets` = the pool's USDC balance (premiums raise the share price, payouts lower
it). `maxWithdraw`/`maxRedeem` are limited to free assets (`totalAssets − lockedAssets`). Invariant, tested
with fuzzing: USDC balance ≥ `lockedAssets` at all times.

Implementation notes:

- Price and position sources are set in the constructor and cannot change. Interfaces:
  `IPriceSource.oraclePx6(uint32) → uint64` and
  `IPositionSource.position(address,uint32) → (int64 szi, uint64 entryNtl, uint32 leverage)`.
- The HyperCore sources make a gas-capped `staticcall` to the read precompiles (oracle price `0x…0807`,
  position `0x…0800`, perp info `0x…080a`) and revert with a named error on failure. A price source
  **reverts, never returns 0**, so a missing price can never count as a breach.
  `HyperCorePriceSource.cachePerp(idx)` validates a perp once and caches its `szDecimals`.
- Pool shares have 12 decimals (USDC 6 + offset 6).
- Pause blocks `buyCover` and deposits only; trigger, expire and withdrawals of free assets always work.
- Capacity is checked against `totalAssets` before the premium arrives (conservative).
- Extra views for the app and engine: `quoteDigest`, `quoteStructHash`, `DOMAIN_SEPARATOR`,
  `QUOTE_TYPEHASH`, `freeAssets`, `lockedByPerp`, `nonceUsed`, `coverCount`, limit getters.
- Compiled with `via_ir` so deployment fits HyperEVM's 3M-gas small blocks.

## 6. Quote API (engine → app)

`POST /quote` with body `{buyer, perpIndex, isLong, level, payout, durationSec, pool?}` (level: px6 integer,
payout: 6-decimal integer).

Response: `{quote: <§4 fields>, signature, breakdown: {sigma, touchProb, loading, premium, model, tailMultiplier, tailFloor, pricedProb, fee, coin, z, spotSource, pool}}`
or `{error, reason}`.

- `pool` (optional): which pool the quote is for. It must be in the allowlist (the configured pool plus every
  pool in `deployments/<env>.json`), else 400 `unknown_pool`. The quote is signed with
  `verifyingContract = pool` and priced against that pool's own price source.
- Error codes and HTTP status: 400 `invalid_request`, `unknown_perp`, `duration_out_of_range`,
  `unknown_pool`; 403 `chain_not_allowed`; 422 refusals `level_already_breached`, `prob_too_high`,
  `capacity`; 503 `market_data_unavailable`, `signer_unavailable`.
- `nonce` < 2^53 (safe as a JSON number for JS clients).
- `capacity` is an engine-side sanity cap only; the on-chain utilization and per-perp checks are
  authoritative.

`GET /health` → `{ok, env, signer, chainId, pool, pools}`.

## 7. Pricing model (v4)

Evidence and the methods compared: [`engine/reports/calibration.md`](../engine/reports/calibration.md).
Perp `i`, direction `isLong`, level `H` (px6), payout `P`, duration `D`, `T = D / 1 year`:

1. **Spot** `S = pool.priceSource().oraclePx6(i)` via `eth_call`, the same price `buyCover` checks.
   Fallback: the testnet Info API `oraclePx`, reported as `breakdown.spotSource`. `spotRef = S`.
2. **σ** = max(EWMA λ = 0.94 of 1 h log returns, 30-day realized σ), annualized, from **mainnet** 1 h
   candles of the same coin (read-only; testnet order books are thin).
3. **Touch probability**, driftless GBM, down barrier `H < S` (mirror for up):
   `p = N((b + σ²T/2)/(σ√T)) + (S/H)·N((b − σ²T/2)/(σ√T))`, `b = ln(H/S)`.
   The discrete-monitoring correction is negligible at the ~3 s keeper cadence (Broadie–Glasserman level
   shift ≈ 0.007 % at σ = 40 %; not applied).
4. **Tail tables** (`engine/reports/tail_multipliers.json`): standardized distance `z = ln(H/S)/(σ√T)`.
   One table per horizon h ∈ {1h, 4h, 1d, 7d} (the smallest h ≥ D), coins pooled, buckets of |z| per
   direction. The 1h and 4h tables are fitted on 1 h candles; the 1d and 7d tables on daily candles
   (Hyperliquid-traded history since 2023/2024; a 1d window is one UTC day, touched if the daily low/high
   reached the level). Per bucket, `q` = Wilson 95 % upper bound of the touch frequency and
   `k = clamp(q / mean p, 1, 10)`. A thin bucket (< 300 windows or no touch) is pooled with its
   nearer-the-money neighbours, one at a time, until it has ≥ 300 windows and ≥ 1 touch; since the touch
   frequency cannot rise with |z|, the pooled bound is still an upper bound for that bucket. `q` is made
   non-increasing in |z| and interpolated, so the price never rises as the level moves away.
5. **Priced probability** `= max(p·k_z, q_z)`; refuse `prob_too_high` if it exceeds pMax = 0.5, and
   `level_already_breached` if S is already past H.
6. **Premium** `= ceil(P × priced × (1 + θ)) + fee`, θ = 0.20, fee = 0 (configurable).

Out of sample (fit on the first half of the data, test on the second): 15 of 256 buckets fail (realized
frequency above the priced probability); loss ratio 1h 0.43 / 4h 0.41 / 1d 0.66 / 7d 0.65. In sample:
10/256 fail, each named in the report. Example: a 1-day BTC cover 6 % below spot costs 3.24 % of the payout
against a 2.46 % empirical touch frequency (loss ratio ≈ 0.76). Short horizons are priced conservatively on
purpose. The live engine takes σ from 1 h candles for every horizon; under that σ the 1d table tests 2/64
failing out of sample, loss ratio 0.49.

## 8. Trigger semantics and demo modes

- The trigger price is the **oracle** price (validator median of 8 venues; harder to move than the mark
  price, which includes the Hyperliquid book). Liquidation uses the mark price, so there is basis risk; the
  default level sits a buffer above the liquidation price, and the app says so.
- A cover pays if **a `trigger()` call before expiry observes the breach on-chain**. The keeper checks
  every ~3 s: one Multicall3 `eth_call` reads all cover states and price sources, with RPC failover and
  backoff. A wick shorter than the poll interval can be missed; the effect on pricing is negligible
  (Broadie–Glasserman level shift ≈ 0.007 % at σ = 40 %). `trigger()` is permissionless, so anyone
  watching faster can call it.
- **Demo A (real):** a testnet pool on the HyperCore sources. Buying cover needs a real testnet HyperCore
  position; the keeper triggers on a real oracle touch.
- **Demo B (staged):** a separate pool on `MockPriceSource`/`MockPositionSource`, labelled **MOCK** in the
  app. The operator sets the price and position to show trigger → payout. It is never presented as a real
  market event.

## 9. Evidence

- **Calibration backtest**: BTC/ETH/SOL/HYPE × horizons {1h, 4h, 1d, 7d} × distances {1 … 20 %}:
  predicted probability vs realized touch frequency, using candle lows/highs as a proxy for the oracle.
  Output: tables and a reliability plot in `engine/reports/`. Target: out-of-sample failing buckets ≤ 10 %
  and loss ratio per horizon 0.4–0.8.
- **Pool P&L simulation**: sell covers at the model premium through history → LP return, worst drawdown.
- **Contracts**: unit, fuzz and invariant tests (`USDC balance ≥ lockedAssets`), precompile mocks, and a
  testnet end-to-end run with transaction hashes in `deployments/testnet.json`.

## 10. Out of scope (v1)

Mainnet; hedging the pool on Hyperliquid through CoreWriter ("reinsurance", roadmap); partial payouts; a
secondary market for covers; governance or a token; cross-chain.
