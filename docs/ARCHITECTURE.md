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
or `{error, reason}` (e.g. `level_already_breached`, `prob_too_high`, `capacity`).
`GET /health` → `{ok, env, signer, chainId, pool}`. Engine never signs for chainId 999.

## 7. Pricing model (engine, v1)

1. σ per asset: EWMA (λ = 0.94) of 1 h log returns from Info API candles, annualized; floor at the
   30-day realized σ. Stored with timestamp.
2. Touch probability, driftless GBM (ν = −σ²/2), down barrier `H < S` (mirror for up):
   `p = N((b + σ²T/2)/(σ√T)) + (S/H)·N((b − σ²T/2)/(σ√T))`, `b = ln(H/S)`.
   Discrete-monitoring correction is negligible at 1 s keeper cadence (documented, not applied).
3. Tail adjustment: multiplier `k(asset, horizon, distance-bucket) ≥ 1` from the backtest (§9), so the
   model never prices below realized touch frequency.
4. `premium = payout × min(p·k, pMax) × (1 + θ) + fee`, θ = 0.20 loading, refuse if `p·k > pMax` (0.5).

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
  2023-02). Output table + reliability plot. Pass: realized ≤ priced (with k) in every bucket with ≥ 30 obs.
- **Pool P&L simulation**: sell covers at model premium through history → LP return, worst drawdown.
- **Contracts**: unit + fuzz tests (accounting invariant: `USDC balance ≥ lockedAssets` always),
  precompile mocks, testnet E2E with tx hashes logged.

## 10. Out of scope (v1)

Mainnet; CoreWriter hedging of the pool on HIP-4/perps (pitch as roadmap: "reinsurance"); partial
payouts; secondary market for covers; governance/token; cross-chain.
