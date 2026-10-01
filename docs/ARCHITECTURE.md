# Architecture — Numera Liquidation Cover

Position-linked, parametric liquidation cover for Hyperliquid perps, underwritten by a USDC pool on
HyperEVM and priced by an actuarial engine. Target: Colosseum Crypto World's Fair, Hyperliquid track +
general prizes. Submission closes **2026-10-12 23:59 PT**. Facts and sources: `docs/research/hyperliquid.md`.
Decisions and their reasons: `docs/DECISIONS.md`. This file is the **contract** every worker builds against;
change it here first, then in code.

## 1. Product in one paragraph

A trader with a long BTC perp at 20× fears a wick to their liquidation price. In one click they buy
cover: "if the BTC oracle price trades at or below $L before time T, pay me $P". $L defaults to just
above their liquidation price, $P is capped by the margin they would lose. If the level is hit, anyone
(our keeper, the trader, a bot) calls `trigger()` and the pool pays instantly — no claim, no assessor,
no trade to execute in a gap. Underwriters deposit USDC into the pool and earn the premiums. Every
payout is fully reserved at sale, so the pool cannot become insolvent.

**Why not just a stop-loss?** A stop closes the position (often at the bottom of a wick) and slips in a gap.
Cover keeps the position open and pays cash. **Why not HIP-4 / prediction markets?** Those are
speculator CLOB markets settling at expiry; ours is a path-dependent touch, sized and positioned from the
trader's actual HyperCore position (insurable interest), priced on demand from a formula, with an
underwriter yield product on the other side.

## 2. Components

```
                 ┌───────────────────────── app/ (Vite + React + viem) ─────────────────────────┐
  Trader / LP ──►│ positions & liq px (Info API) · quote · buy cover · LP deposit · dashboards │
                 └───────┬───────────────────────────────┬──────────────────────────────────────┘
                         │ POST /quote                    │ txs (buyCover, deposit, withdraw)
                         ▼                                ▼
  ┌──── engine/ (Python) ─────────────┐      ┌──── contracts/ (Foundry, HyperEVM) ──────────────┐
  │ data: Info API candles, ctxs      │      │ CoverPool  (ERC-4626 vault + cover book)          │
  │ vol: EWMA σ + floor               │      │   ├─ QuoteVerifier (EIP-712, signer, nonce)       │
  │ pricing: one-touch p, loading     │ sig  │   ├─ IPriceSource  ─ HyperCorePriceSource (0x807) │
  │ quote_api: FastAPI, signs quotes ─┼─────►│   │                └ MockPriceSource (demo/tests) │
  │ backtest: calibration + pool P&L  │      │   └─ IPositionSource ─ HyperCorePositionSource    │
  │ keeper: watch covers, trigger() ──┼─────►│                       (0x800) └ MockPositionSource│
  └───────────────────────────────────┘      │ MockUSDC (testnet/local only)                     │
                                             └───────────────────────────────────────────────────┘
```

Ownership: contracts/ ↔ engine/ ↔ app/ meet only at **§4 (EIP-712 Quote)**, **§5 (contract ABI/events)**
and **§6 (Quote API)**. Workers may change internals freely; these three sections change only via the
orchestrator.

## 3. Units and conventions (all components)

- **Price**: `uint64`, USD × 1e6 ("px6"). From precompile: `px6 = raw × 10^szDecimals`.
- **USDC amounts**: `uint256`, 6 decimals.
- **Time**: unix seconds (`uint64`) on-chain; milliseconds only inside Info API calls.
- **Perp index**: `uint32`, network-specific, never hardcoded (see research table).
- **Direction**: `isLong = true` → cover triggers when `oraclePx ≤ level`; `false` → when `oraclePx ≥ level`.
- **Environment names** (logs, UI, deploy files): `local` (anvil, chain 31337), `testnet` (998). `mainnet` (999) is out of scope and mechanically blocked.

## 4. Quote (EIP-712) — engine signs, contract verifies

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
    uint256 nonce;       // unique per quote; contract marks used
}
```
Type string (exact): `Quote(address buyer,uint32 perpIndex,bool isLong,uint64 level,uint256 payout,uint256 premium,uint64 expiry,uint64 spotRef,uint64 deadline,uint256 nonce)`

## 5. CoverPool contract

ERC-4626 vault over USDC (OpenZeppelin, with decimals offset against inflation attack) plus a cover book.

```solidity
enum Status { None, Active, Paid, Expired }
struct Cover { address buyer; uint32 perpIndex; bool isLong; uint64 level; uint256 payout;
               uint256 premium; uint64 start; uint64 expiry; Status status; }

function buyCover(Quote calldata q, bytes calldata sig) external returns (uint256 coverId);
function trigger(uint256 coverId) external;            // permissionless
function expire(uint256 coverId) external;             // permissionless, after expiry
function getCover(uint256 coverId) external view returns (Cover memory);
function lockedAssets() external view returns (uint256);
// admin (owner): setQuoteSigner, setLimits, setPaused, setPriceSource/PositionSource (constructor-only in v1 if time allows)

event CoverPurchased(uint256 indexed coverId, address indexed buyer, uint32 indexed perpIndex,
                     bool isLong, uint64 level, uint256 payout, uint256 premium, uint64 expiry);
event CoverTriggered(uint256 indexed coverId, uint64 oraclePx, address caller);
event CoverExpired(uint256 indexed coverId);
```

`buyCover` checks, in order (each failure is a custom error naming the check):
1. Signature recovers to `quoteSigner`; `q.buyer == msg.sender`; `block.timestamp ≤ q.deadline`; nonce unused.
2. `block.timestamp < q.expiry ≤ block.timestamp + maxDuration`; `payout ≥ minPayout`.
3. Price sanity: current oracle `px` within `maxSpotDeviationBps` of `q.spotRef`, and **not already breached**.
4. Insurable interest (via `IPositionSource`): buyer holds a position on `perpIndex` whose sign matches
   `isLong`, and `payout ≤ marginCap` where `marginCap = entryNtl / leverage` (initial margin estimate).
5. Capacity: `lockedAssets + payout ≤ totalAssets × maxUtilizationBps`; per-perp locked ≤ `perPerpCapBps`.
6. Pull `premium` USDC from buyer, lock `payout`, store cover, emit `CoverPurchased`.

`trigger`: cover Active, `block.timestamp ≤ expiry`, current oracle breaches level → status Paid, unlock,
transfer payout to buyer, emit. `expire`: Active and `block.timestamp > expiry` → Expired, unlock, emit.

Vault accounting: `totalAssets = USDC balance` (premiums raise share price, payouts lower it).
`maxWithdraw/maxRedeem` limited to free assets (`totalAssets − lockedAssets`).

Price/position sources: interfaces `IPriceSource.oraclePx6(uint32) → uint64` and
`IPositionSource.position(address,uint32) → (int64 szi, uint64 entryNtl, uint32 leverage)`.
HyperCore implementations do a gas-capped `staticcall` to the precompile and revert with a named error on
failure. Validate perp index once via `perpAssetInfo` and cache `szDecimals`.

Mainnet lock: deploy scripts `require(block.chainid == 998 || block.chainid == 31337)`.

Implementation notes (v1, accepted 2026-10-01 after contracts merge `00343cb`):
- Price/position sources are immutable (constructor). A price source **reverts, never returns 0**, so a
  missing price can never count as a breach.
- Extra views for app/engine: `quoteDigest`, `quoteStructHash`, `DOMAIN_SEPARATOR`, `QUOTE_TYPEHASH`,
  `freeAssets`, `lockedByPerp`, `nonceUsed`, `coverCount`, limit getters; events `QuoteSignerUpdated`,
  `LimitsUpdated`; `setLimits(uint16 maxUtilBps, uint16 perPerpCapBps, uint64 maxDuration, uint16 maxSpotDevBps, uint256 minPayout)`.
- Pool shares have **12 decimals** (USDC 6 + offset 6, inflation-attack defence).
- Pause blocks `buyCover` and deposits only; trigger, expire and free-asset withdrawals always work.
- Capacity is checked against `totalAssets` before the premium arrives (conservative).
- Compiled with `via_ir` (deploy gas 2.67M vs 3M small-block limit; ~11 % headroom — growth needs big blocks).
- `HyperCorePriceSource.cachePerp(idx)` should be called once per perp after deploy (cheaper reads).
- Verified on testnet [RUN]: `perpAssetInfo(3)` decodes as one tuple → `("BTC", 54, 5, 40, false)`;
  position `entryNtl` = USD × 1e6 (research doc).

## 6. Quote API (engine → app)

`POST /quote` body `{buyer, perpIndex, isLong, level, payout, durationSec}` (level px6 int, payout 6-dec int).
Response `{quote: <§4 fields>, signature, breakdown: {sigma, touchProb, loading, premium, model:"gbm-touch-v1"}}`
or `{error, reason}`.
`GET /health` → `{ok, env, signer, chainId, pool}`. Engine never signs for chainId 999.

Accepted 2026-10-01 after engine merge (`2998ec4`):
- Error codes: `invalid_request`, `unknown_perp`, `duration_out_of_range`, `market_data_unavailable`,
  `signer_unavailable`, `chain_not_allowed`, `level_already_breached`, `prob_too_high`, `capacity`.
- HTTP status: 400 bad request (`invalid_request`, `unknown_perp`, `duration_out_of_range`), 422 refusal
  (`level_already_breached`, `prob_too_high`, `capacity`), 503 dependency (`market_data_unavailable`,
  `signer_unavailable`); `chain_not_allowed` is 403.
- Extra breakdown fields (additive, informational): `tailMultiplier`, `tailFloor`, `pricedProb`, `fee`, `coin`.
- `nonce` < 2^53 (JSON-number safe for JS clients).
- `capacity` is an engine-side sanity cap only (`NUMERA_MAX_PAYOUT`); the on-chain utilization and
  per-perp checks (§5 check 5) are authoritative.

Added 2026-10-01 (D10, engine merge `de5690c`):
- Optional request field `pool` (address). Default: the configured pool. It must be in the allowlist
  (configured pool + every pool in `deployments/<env>.json`), else 400 `unknown_pool`. The quote is signed
  with `verifyingContract = pool` and priced against that pool's own price source.
- Extra breakdown fields: `z` (standardized distance, §7), `spotSource` (`pool` | `info_api`), `pool`.
- `/health` also returns `pools` (the allowlist).

## 7. Pricing model (engine, v1 — final, D11)

Evidence and compared methods: [`engine/reports/calibration.md`](../engine/reports/calibration.md).
Perp `i`, direction `isLong`, level `H` (px6), payout `P`, duration `D`, `T = D / 1 y`:

1. **Spot** `S = pool.priceSource().oraclePx6(i)` via `eth_call` — the price `buyCover` checks (D10).
   Fallback: testnet Info API `oraclePx`; reported as `breakdown.spotSource`. `spotRef = S`.
2. **σ** = max(EWMA λ = 0.94 of 1 h log returns, 30-day realized σ), annualized, from **mainnet** 1 h
   candles of the same coin (read-only; testnet books are thin).
3. **Touch probability**, driftless GBM, down barrier `H < S` (mirror for up):
   `p = N((b + σ²T/2)/(σ√T)) + (S/H)·N((b − σ²T/2)/(σ√T))`, `b = ln(H/S)`.
   Discrete-monitoring correction is negligible at 1 s keeper cadence (documented, not applied).
4. **Tail tables** (`tail_multipliers.json`, `z-per-horizon-v3`): `z = ln(H/S)/(σ√T)`; one table per
   horizon h ∈ {1h, 4h, 1d, 7d} (smallest h ≥ D), coins pooled, buckets of |z| per direction. Per bucket
   `q` = Wilson 95 % upper bound of the realized touch frequency, `k = clamp(q / mean p, 1, 10)`.
   q is made non-increasing in |z| and interpolated, so the price never rises as the level moves away.
5. **Priced probability** `= min(max(p·k_z, q_z), pMax)`; refuse `prob_too_high` if `max(p·k, q) > pMax`
   (0.5), `level_already_breached` if S is already past H.
6. **Premium** `= ceil(P × priced × (1 + θ)) + fee`, θ = 0.20, fee = 0 (configurable).

Out of sample (fit first half, test second): 17/240 % buckets fail; loss ratio 1h 0.43 / 4h 0.41 /
1d 0.46 / 7d 0.69. Short horizons are priced conservatively on purpose (D11).

## 8. Trigger semantics and demo

- Trigger price is the **oracle** price (validator median of 8 venues; harder to manipulate than mark, which
  includes the HL book). Liquidation uses mark → small basis risk; the default level sits a buffer above
  the liquidation price. Documented in UI.
- A cover pays if **a `trigger()` call before expiry observes the breach on-chain**. The keeper checks every
  block (~1 s). A sub-second wick between checks can be missed — stated in docs, reflected in pricing.
- Demo A (real): testnet pool on HyperCore sources; buy a short cover with a level close to spot; the
  keeper triggers on a real touch. Needs a testnet HyperCore position (mock USDC drip needs prior mainnet
  deposit on that address).
- Demo B (staged): separate pool with `MockPriceSource`/`MockPositionSource`, UI-labelled **MOCK**;
  operator moves the price to show trigger → payout. Never presented as real.

## 9. Evidence (eval) — what proves the model

- **Calibration backtest**: for BTC/ETH/SOL/HYPE × horizons {1h, 4h, 1d, 7d} × distances {1…20 %},
  predicted p vs realized touch frequency (candle lows/highs as proxy; 1 h data ≈ 7 months, 1 d since
  2023-02). Output table + reliability plot. Pass: out-of-sample failing buckets ≤ 10 % and loss ratio per
  horizon 0.4–0.8 (F15); in-sample failures listed in the report. Strict per-bucket rule tracked as F6.
- **Pool P&L simulation**: sell covers at model premium through history → LP return, worst drawdown.
- **Contracts**: unit + fuzz tests (accounting invariant: `USDC balance ≥ lockedAssets` always),
  precompile mocks, testnet E2E with tx hashes logged.

## 10. Out of scope (v1)

Mainnet; CoreWriter hedging of the pool on HIP-4/perps (pitch as roadmap: "reinsurance"); partial
payouts; secondary market for covers; governance/token; cross-chain.
