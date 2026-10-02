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
                         │ POST /quote                    │ txs (buyCover, deposit, requestRedeem, redeem)
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
- **Basis points**: `uint16`, `10_000` = 100 % (all `*Bps` limits).
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
    uint64  deadline;    // quote must be used before this (unix s), ~30 s after issue
    uint256 nonce;       // unique per quote; the contract marks it used
}
```

Type string (exact):
`Quote(address buyer,uint32 perpIndex,bool isLong,uint64 level,uint256 payout,uint256 premium,uint64 expiry,uint64 spotRef,uint64 deadline,uint256 nonce)`

The v2 contract keeps this struct, type string and domain unchanged; a v2 pool's domain differs only by
`verifyingContract`, so the engine signs exactly as before.

A shared test vector (`contracts/test/vectors/quote_vector.json`, signed with the public anvil test key)
checks that the Solidity and Python encoders produce the same digest and signature.

## 5. CoverPool contract (v2)

ERC-4626 vault over USDC (OpenZeppelin 5.4.0, decimals offset 6 against the inflation attack) plus a cover
book, with on-chain pricing floors, a sale throttle, a payout circuit breaker, a timelocked owner and
queued LP exits.

**Status.** v2 was specified on 2026-10-02 to close the contract-level items of the internal security
review ([SECURITY.md](../SECURITY.md), "Mainnet blockers" 1–6), and revised the same day after a security
review of the spec itself. It is **not yet implemented or deployed**: the live testnet pools in
`deployments/testnet.json` run v1 (§5.11). Everything below is v2 unless marked v1.

### 5.1 Cover book (unchanged from v1)

```solidity
enum Status { None, Active, Paid, Expired }
struct Cover { address buyer; uint32 perpIndex; bool isLong; uint64 level; uint256 payout;
               uint256 premium; uint64 start; uint64 expiry; Status status; }

function buyCover(Quote calldata q, bytes calldata sig) external returns (uint256 coverId);
function trigger(uint256 coverId) external;            // permissionless
function expire(uint256 coverId) external;             // permissionless, after expiry
function getCover(uint256 coverId) external view returns (Cover memory);
function lockedAssets() external view returns (uint256);

event CoverPurchased(uint256 indexed coverId, address indexed buyer, uint32 indexed perpIndex,
                     bool isLong, uint64 level, uint256 payout, uint256 premium, uint64 expiry);
event CoverTriggered(uint256 indexed coverId, uint64 oraclePx, address caller);
event CoverExpired(uint256 indexed coverId);
```

The Quote struct, its type string and `QUOTE_TYPEHASH` (§4) are **unchanged**; the engine's signing code
does not change. The EIP-712 domain keeps `name="Numera"`, `version="1"`; a v2 pool's domain differs from a
v1 pool's only by `verifyingContract` (the new pool address), so v1 quotes never verify on v2 and vice versa.
`Status.Paid` is set whether the payout was transferred or deferred (§5.3).

### 5.2 Limits (storage, bounds)

Units: bps are `uint16`, `10_000 = 100 %` (`BPS`); durations are seconds; USDC is 6 decimals.

```solidity
struct Limits {
    uint16  maxUtilizationBps;      // lockedAssets ≤ B × this
    uint16  perPerpCapBps;          // lockedByPerp[i] ≤ B × this
    uint64  maxDuration;            // expiry ≤ now + this (s)
    uint16  maxSpotDeviationBps;    // |px − spotRef| ≤ spotRef × this
    uint256 minPayout;              // USDC 6 dec
    uint16  minPremiumBps;          // NEW: premium ≥ payout × this
    uint16  minLevelDistanceBps;    // NEW: |px − level| ≥ px × this
    uint32  saleWindow;             // NEW: window length (s) for the sale throttle and the payout breaker
    uint16  maxSoldPerWindowBps;    // NEW: payout sold per window ≤ windowAssets × this
    uint16  maxBuyerWindowShareBps; // NEW: one buyer's share of the window's sale cap
    uint16  maxPaidPerWindowBps;    // NEW: payouts paid per window above paidWindowAssets × this → auto-pause
}
function limits() external view returns (Limits memory);
// individual getters stay while the size budget allows (§5.9; the app reads them today):
// maxUtilizationBps(), perPerpCapBps(), maxDuration(), maxSpotDeviationBps(), minPayout(), and one per new field
```

`B` is the **capacity base** (§5.3): `totalAssets()` minus the assets of escrowed (requested) shares.

Bounds, enforced by `_validateLimits` in the constructor, at queue time and again at execute time (any
violation reverts `InvalidLimits()`). The strict column applies only when the immutable `strict` flag is
set (§5.6) and is checked by the same function:

| Field | Min | Max | Strict mode adds | Testnet value |
|---|---|---|---|---|
| `maxUtilizationBps` | 1 | 9 000 | | 8 000 |
| `perPerpCapBps` | 1 | `maxUtilizationBps` | | 5 000 |
| `maxDuration` | 1 hour | 30 days | < `withdrawDelay` | 604 800 |
| `maxSpotDeviationBps` | 1 | 500 | ≤ 100 | 30 |
| `minPayout` | 1 | 1 000 000e6 | | 1e6 |
| `minPremiumBps` | 1 | 5 000 | | 20 |
| `minLevelDistanceBps` | 1 | 2 000 | ≥ 10 | 25 |
| `saleWindow` | 60 s | 7 days | ≥ 3 600 | 3 600 |
| `maxSoldPerWindowBps` | 1 | `maxUtilizationBps` | ≤ 2 500 | 2 500 |
| `maxBuyerWindowShareBps` | 1 | 10 000 | | 2 500 |
| `maxPaidPerWindowBps` | 1 | `maxSoldPerWindowBps` | ≤ `maxSoldPerWindowBps` | 1 500 |

The first five testnet values are today's deployed values. `minPremiumBps = 20`: the cheapest legitimate
priced probability on the engine's grid is about 1.09 bps of payout, so far-from-spot quotes are raised to
the floor by the engine (§6, `floorApplied`). 0 is never allowed for a floor or a cap: none of them can be
switched off. Mainnet targets (documented only; mainnet is out of scope, §10): `maxSoldPerWindowBps ≤ 1000`,
`maxPaidPerWindowBps ≤ 500`, `maxSpotDeviationBps ≤ 30`.

### 5.3 Functions and checks

Storage added for the checks below:

```solidity
uint256 public unearnedPremium;          // Σ premium of Active covers
uint256 public owedAssets;               // Σ owed[buyer]
mapping(address buyer => uint256) public owed;
uint64  public windowStart;              // sale window
uint256 public windowAssets;             // B snapshot at the sale window's start
uint256 public soldInWindow;             // gross payout sold in the current sale window
struct BuyerWindow { uint64 start; uint192 sold; }
mapping(address buyer => BuyerWindow) public buyerWindow; // sold counts only while start == windowStart
uint64  public paidWindowStart;          // payout-breaker window
uint256 public paidWindowAssets;         // B snapshot at the breaker window's start
uint256 public paidInWindow;             // payouts paid or deferred in the current breaker window
function capacityBase() public view returns (uint256); // B
```

**Accounting (v2).**
- `totalAssets() = USDC balance − owedAssets − unearnedPremium`. Owed payouts are not pool money, and a
  premium becomes pool money (raises the share price) only when its cover settles (expire or trigger).
  `totalAssets` saturates at 0; that floor is unreachable while invariant 1 (§5.8) holds.
- `freeAssets() = totalAssets − lockedAssets` (saturating at 0), i.e. `balance − locked − owed − unearned`.
  LP exits are bounded by `freeAssets`, so they never touch locked, owed or unearned USDC.
- Capacity base `B = totalAssets() − _convertToAssets(totalEscrowedShares, Floor)` (saturating at 0).
  Capital that has asked to leave does not back new covers.

**Windows.** The sale window and the breaker window share `saleWindow` and the same reset rule, but reset
independently: a window is `[start, start + saleWindow)` and starts at the first sale (resp. payout) after
the previous one ended. At a reset the window's base is snapshotted from `B` *before* the current call's own
accounting, and that snapshot is the base for the whole window. `windowStart` and `paidWindowStart` start
at 0, so the first sale (resp. the first payout) opens a window (`block.timestamp ≥ saleWindow` on any real
chain). An owner unpause (`setPaused(false)`) also resets the breaker window (`paidWindowStart = 0;
paidInWindow = 0`), so the next payout opens a fresh one instead of re-tripping on the old window's sum.

`buyCover` checks, in order (each failure is a custom error naming the check; new items marked NEW). All
checks before step 7 are view-only; the price is read once (step 3) and that one `px` is used for every
price check:

1. Signature recovers to `quoteSigner` (`InvalidSignature`); `q.buyer == msg.sender` (`BuyerMismatch`);
   `block.timestamp ≤ q.deadline` (`QuoteDeadlinePassed`); nonce unused (`NonceAlreadyUsed`).
2. NEW `perpAllowed[q.perpIndex]` (`PerpNotAllowed(perpIndex)`); `block.timestamp < q.expiry`
   (`ExpiryNotInFuture`); `q.expiry ≤ block.timestamp + maxDuration` (`DurationTooLong`);
   `payout ≥ minPayout` (`PayoutTooSmall`); NEW premium floor `premium × 10000 ≥ payout × minPremiumBps`
   (`PremiumBelowFloor(premium, minPremium)`, `minPremium = ceilDiv(payout × minPremiumBps, 10000)`).
3. Price: `px = priceSource.oraclePx6(perpIndex)`; `|px − spotRef| × 10000 ≤ spotRef × maxSpotDeviationBps`
   (`SpotDeviationTooHigh`); not already breached (`LevelAlreadyBreached`); NEW level-distance floor
   `|px − level| × 10000 ≥ px × minLevelDistanceBps` (`LevelTooClose(px, level)`).
4. Insurable interest (unchanged): position on `perpIndex` exists (`NoPosition`), sign matches `isLong`
   (`PositionSideMismatch`), `payout ≤ entryNtl / leverage` (`PayoutExceedsMarginCap`).
5. Capacity, against `B` before the premium arrives (v1 used `totalAssets`):
   `lockedAssets + payout ≤ B × maxUtilizationBps / 10000` (`UtilizationExceeded`);
   `lockedByPerp[i] + payout ≤ B × perPerpCapBps / 10000` (`PerPerpCapExceeded`).
6. NEW sale throttle. `reset = block.timestamp ≥ windowStart + saleWindow`;
   `W = reset ? B : windowAssets`; `sold = reset ? 0 : soldInWindow`; `cap = W × maxSoldPerWindowBps / 10000`;
   `sold + payout ≤ cap` (`SaleWindowCapExceeded(soldAfter, cap)`).
   Per buyer: `bSold = (reset || buyerWindow[buyer].start != windowStart) ? 0 : buyerWindow[buyer].sold`;
   `bSold + payout ≤ cap × maxBuyerWindowShareBps / 10000` (`BuyerWindowCapExceeded(buyer, soldAfter, cap)`).
7. Effects: mark nonce; lock payout (total and per perp); `unearnedPremium += premium`; NEW window
   accounting — if `reset` then `windowStart = block.timestamp; windowAssets = B; soldInWindow = 0`; then
   `soldInWindow += payout`; `buyerWindow[buyer] = (windowStart, bSold + payout)`; store cover; emit
   `CoverPurchased`; pull `premium` (`safeTransferFrom`).

**Throttle bound (strict mode only).** Each window sells at most `maxSoldPerWindowBps × windowAssets`, and
the snapshot cannot be raised mid-window by a deposit. Any interval of length `saleWindow` overlaps at most two windows. With the
premium floor, the net loss per window is at most a fraction `c = maxSoldPerWindowBps/1e4 × (1 −
minPremiumBps/1e4)` of the pool, so a compromised quote signer that sells and triggers through `N` windows
takes at most `1 − (1 − c)^N` of the pool (at the testnet caps c ≈ 0.2495; 1 window ≈ 25 %, 2 ≈ 44 %, 4 ≈
68 %). This N-window bound holds **only in strict mode** (`withdrawDelay > maxDuration`, §5.6, audit L-1).
With non-strict delays an attacker who also supplies capital defeats it (audit M-1, proven): deposit, sell
to the cap, request, claim at par once the request matures, then trigger, so the attacker's capital has left
before the covers it backed pay out. On testnet (non-strict) the throttle and the queue therefore only narrow
that race; they do not bound it.
The covers also need a real oracle move of at least `minLevelDistanceBps` to trigger. The payout breaker
(below) pauses sales on its own in the first breaker window whose payouts exceed `maxPaidPerWindowBps`, so
an attacker who triggers as they sell is stopped within about one window. An attacker who **sells without
triggering** (the patient path, audit I-3: sell up to the utilization cap over several windows, trigger
later) is bounded only by the utilization cap: covers already sold stay payable after a pause, so the worst
case is `maxUtilizationBps × B × (1 − minPremiumBps/1e4)` (up to 80 % of B at the testnet caps) once the
price moves. The one-window loss shown by the PoC test (24.95 %) is therefore not a general bound. Against that path the
defences are the monitoring alerts (sale cap reached, floor-priced sales, §5.10) and the guardian's pause.
The per-buyer share stops one address from filling a window and blocking honest buyers; a second address
also needs its own HyperCore position (check 4). `soldInWindow` counts gross payout sold and never
decreases. A change of `saleWindow` or a cap applies from the next sale.

`trigger(coverId)` (permissionless; checks unchanged): Active (`CoverNotActive`), `block.timestamp ≤ expiry`
(`CoverPastExpiry`), oracle breaches level (`LevelNotBreached`). Effects, in order:
1. `status = Paid`; unlock (total and per perp); `unearnedPremium −= premium`.
2. Breaker: if `block.timestamp ≥ paidWindowStart + saleWindow` then `paidWindowStart = now;
   paidWindowAssets = B; paidInWindow = 0` (B as read at the start of `trigger`, before step 1); then
   `paidInWindow += payout`; if `paidInWindow >
   paidWindowAssets × maxPaidPerWindowBps / 10000` and the pool is not paused: `_pause()` and emit
   `LossBreakerTripped(paidInWindow, cap)`. The breaker never reverts `trigger`.
3. Credit first: `owed[buyer] += payout; owedAssets += payout`; emit `CoverTriggered`.
4. Attempt `SafeERC20.trySafeTransfer(usdc, buyer, payout)`. On success reverse step 3 (`owed[buyer] −=
   payout; owedAssets −= payout`). On failure (e.g. a blocklisted buyer on real USDC) emit
   `PayoutDeferred(coverId, buyer, payout)`; the payout stays owed. `trigger` does not revert either way.

Crediting before the call keeps the failure path to one event. A caller cannot force a deferral by
starving the call of gas: under EIP-150 the outer frame keeps only 1/64 of the gas, which is not enough to
finish, so an out-of-gas transfer reverts the whole `trigger`; the deferral path is reached only when the
token itself refuses.

`claimPayout()` (the caller's own balance, works while paused): `amount = owed[msg.sender]`, revert
`NothingOwed()` if 0; `owed[msg.sender] = 0; owedAssets −= amount`; emit `PayoutClaimed(msg.sender,
amount)`; `safeTransfer` to `msg.sender` (reverts, and leaves the balance owed, if it still fails). There is
no redirect to another address (a blocklisted buyer cannot route around the blocklist through the pool).

`expire(coverId)`: Active and `block.timestamp > expiry` → Expired, unlock, `unearnedPremium −= premium`,
emit `CoverExpired`.

`nonReentrant`: `deposit`, `mint`, `requestRedeem`, `cancelRedeemRequest`, `redeem`, `withdraw`,
`claimPayout`, `trigger`, `expire`, `buyCover`.

### 5.4 LP exits: queued redeem (ERC-7540 style, redeem side only)

Deposits and mints stay synchronous ERC-4626 (blocked while paused). Exits are asynchronous: request, wait
`withdrawDelay`, claim inside `claimWindow`. Requests are **aggregated per controller** (`requestId = 0`, as
ERC-7540 allows): each address has one slot.

```solidity
enum RequestState { None, Pending, Claimable, Lapsed }
struct RedeemSlot { uint256 shares; uint64 claimableAt; }
mapping(address controller => RedeemSlot) private _redeemSlots;
uint256 public totalEscrowedShares;            // Σ slot.shares == balanceOf(address(this))
uint64 public immutable withdrawDelay;          // s, §5.6
uint64 public immutable claimWindow;            // s, §5.6

function requestRedeem(uint256 shares, address controller, address owner) external returns (uint256 requestId); // always 0
function cancelRedeemRequest() external returns (uint256 shares);
function redeemRequestOf(address controller) external view
    returns (uint256 shares, uint64 claimableAt, uint64 claimDeadline, RequestState state);
function pendingRedeemRequest(uint256 requestId, address controller) external view returns (uint256 shares);
function claimableRedeemRequest(uint256 requestId, address controller) external view returns (uint256 shares);
// ERC-4626 functions, v2 semantics: redeem(shares, receiver, controller), withdraw(assets, receiver, controller),
// maxRedeem(controller), maxWithdraw(controller); previewRedeem/previewWithdraw revert AsyncRedeemOnly().

event RedeemRequest(address indexed controller, address indexed owner, uint256 indexed requestId,
                    address sender, uint256 shares);                   // ERC-7540 signature, requestId = 0
event RedeemRequestCancelled(address indexed controller, uint256 shares);
// claims emit the ERC-4626 Withdraw(sender, receiver, owner = controller, assets, shares)
```

State of a slot with `shares > 0` (`claimDeadline = claimableAt + claimWindow`):
`Pending` if `now < claimableAt`; `Claimable` if `claimableAt ≤ now < claimDeadline`; `Lapsed` if
`now ≥ claimDeadline`. `None` if `shares == 0`.

Share escrow: the pool's own share balance is exactly the escrow. The `_update` override reverts
`SharesToPool()` for any transfer or mint to `address(this)`; `requestRedeem` moves shares with
`super._update(owner, address(this), shares)`, which bypasses that check, and claims and cancels move
shares out of the pool the same way.

`requestRedeem(shares, controller, owner)`, checks in order:
1. `msg.sender == owner` and `controller == owner` (`NotShareOwner(sender, owner)` /
   `ControllerMustBeOwner(controller, owner)`). Third-party and operator requests are not supported: letting
   someone else add shares to a controller's slot would let them restart that controller's clock.
2. Slot state is not `Claimable` (`RequestClaimable()`): claim or cancel first, so matured shares are never
   re-locked by accident.
3. `slot.shares + shares > 0` (`ZeroShares()`); `shares ≤ balanceOf(owner)` (ERC-20 balance error).
4. Effects: move `shares` from `owner` into the escrow; `slot.shares += shares; totalEscrowedShares +=
   shares; slot.claimableAt = now + withdrawDelay` (the clock restarts for the whole slot, including Lapsed
   shares, which is how lapsed shares are re-queued: `requestRedeem(0, me, me)`); emit
   `RedeemRequest(controller, owner, 0, msg.sender, shares)`.

Escrowed shares **stay in `totalSupply`**: they bear every payout until claimed, and they earn a premium
only as its cover settles (premiums are unearned until expire or trigger, §5.3). They no longer count in
the capacity base `B`, so no new cover is sized on them.

`redeem(shares, receiver, controller)` and `withdraw(assets, receiver, controller)`, checks in order:
1. `msg.sender == controller` (`NotController(sender, controller)`).
2. Slot state is `Claimable` (`RequestNotClaimable(state)`).
3. `redeem`: `assets = _convertToAssets(shares, Floor)`; `withdraw`: `shares = _convertToShares(assets, Ceil)`.
   `shares > 0` (`ZeroShares()`); `shares ≤ slot.shares` (`ExceedsClaimable(shares, slot.shares)`).
4. `assets ≤ freeAssets()` (`InsufficientFreeAssets(assets, free)`).
5. Effects: `slot.shares −= shares` (slot deleted at 0); `totalEscrowedShares −= shares`; burn `shares` from
   the escrow (no allowance path); emit `Withdraw(msg.sender, receiver, controller, assets, shares)`;
   transfer `assets` to `receiver`.

Price: **the share price at claim time**. Rounding (floor on assets out, ceil on shares burned) favours the
pool, so no claim lowers the share price for the LPs who stay.
Short free assets: a claim larger than `freeAssets` reverts; the LP may claim part now (`maxRedeem` shows
how much) and the rest stays Claimable (still bearing P&L) until locks release through expiry or trigger
and free assets grow. If the window ends first, the rest lapses and must be re-queued. Claims are
first come, first served against free assets; every claimant has already waited `withdrawDelay`.

`maxRedeem(controller) = Claimable ? min(slot.shares, _convertToShares(freeAssets, Floor)) : 0`;
`maxWithdraw(controller) = Claimable ? min(_convertToAssets(slot.shares, Floor), freeAssets) : 0`. There is
no other exit: `redeem`/`withdraw` only burn escrowed shares of a Claimable slot. Plain share transfers
between holders stay allowed (they move exposure, not USDC).

`cancelRedeemRequest()`: any non-empty slot of `msg.sender` (any state) → shares go back from the escrow to
`msg.sender`, slot deleted, `totalEscrowedShares −= shares`, emit `RedeemRequestCancelled`; `ZeroShares()` if
empty. Requests, claims and cancels all work while paused.

ERC-7540 views: `pendingRedeemRequest(0, c)` = slot shares if Pending, `claimableRedeemRequest(0, c)` = slot
shares if Claimable, both 0 for any other `requestId` or state (never revert). Lapsed shares appear in
neither; `redeemRequestOf` shows them.

**Which parts of ERC-7540 are implemented.** Implemented: `requestRedeem` (owner = controller = caller),
`pendingRedeemRequest`, `claimableRedeemRequest`, the `RedeemRequest` event, controller-based
`redeem`/`withdraw`, claimable-only `maxRedeem`/`maxWithdraw`, reverting `previewRedeem`/`previewWithdraw`,
`requestId = 0` aggregation. Skipped: operators (`setOperator`, `isOperator`, `OperatorSet`), requests by an
approved spender or for another controller, async deposits (`requestDeposit` etc.), ERC-7575 `share()`,
ERC-165 `supportsInterface` (the pool therefore does **not** advertise the 7540 interface ids
0xe3bc4e65 / 0x620ee8e4 / 0x2f0a18c5; it is "ERC-7540 style", not compliant), ERC-7887 cancellation
(own `cancelRedeemRequest` instead). Additions not in ERC-7540: the claim window and lapse. Standard
ERC-4626 integrations that call `withdraw(assets, receiver, owner)` expecting an instant exit will revert.

**Why the claim window, and what remains.** Without a window, an LP could request once, wait, and then
hold a matured claim indefinitely, able to exit instantly ahead of a known loss: the race the queue exists
to stop. With the window, a given LP's instant-exit option is open only a fraction `W/(D+W)` of the time
(`D = withdrawDelay`, `W = claimWindow`):
- strict mode (`W ≤ D/7`, `W ≤ 1 day`): at most 1/8 = 12.5 % (e.g. `D` = 7 days, `W` = 1 day);
- testnet (`D` = 600 s, `W` = 3 600 s): 6/7 ≈ 86 %. The testnet values keep the LP demo short (request,
  wait 10 minutes, claim within the hour); on testnet the exit race is therefore only slightly narrowed.

In strict mode (`withdrawDelay > maxDuration`) every cover that was alive when a request was made has
expired or triggered before the request matures, so the race is closed for those covers. Equality is not
enough: with `withdrawDelay == maxDuration` a cover sold in the request's second is still open for one second
after maturity (audit L-1, proven), so the strict check is strict. With non-strict delays (testnet) a request
made right after a sale matures before that cover settles: an LP, or an attacker who supplied the capital,
can claim at par ahead of the payout (audit M-1); there the queue only narrows the race. The residual is
the covers sold after the request, and only during the claim window. Because premiums are unearned until
their cover settles, the residual is not premium capture: a matured LP who waits does not collect the
premiums of covers still open.

### 5.5 Owner: Ownable2Step, timelock, guardian, pause

- `Ownable2Step` (OZ): `transferOwnership(new)` sets `pendingOwner` (`OwnershipTransferStarted`), `new` calls
  `acceptOwnership()`. Ownership transfer itself is not timelocked (the new owner still faces the
  timelock for config). Queued operations survive an ownership transfer; the new owner can execute or
  cancel them. `renounceOwnership()` is **disabled** (reverts `RenounceDisabled()`): a renounced pool could
  never be paused again, and pause is the protective control.
- Mainnet owner is a **Safe** multisig (Safe is canonical on HyperEVM 999: safe-deployments v1.4.1, singleton
  `0x41675C099F32341bf84BFc5382aF534df5C7461a`). Safe is not deployed on testnet 998, so the testnet owner
  stays the deployer EOA with Ownable2Step + timelock. On mainnet a full owner compromise means loss of the
  pool (after the timelock, it can install a signer and limits of its choice); the defence is the Safe
  threshold.
- `setPaused(bool)` stays **immediate** (onlyOwner). Pause blocks `buyCover`, `deposit`, `mint` only.
  `setPaused(false)` also sets `paidWindowStart = 0` and `paidInWindow = 0`, so the breaker does not re-trip
  on the payouts that tripped it.
- `guardian` (address, may be 0 = none; set through the timelock): `guardianPause()` pauses immediately
  (`NotGuardian()` for anyone else; no-op if already paused). The guardian can never unpause. Intended for a
  monitoring bot or a single operator key that is faster than a multisig.
- The payout breaker (§5.3) pauses on its own; only the owner unpauses.
- Timelocked (queue → wait `configDelay` → execute, or cancel), all `onlyOwner`:

```solidity
enum OpKind { QuoteSigner, Limits, PerpAllowed, Guardian }
uint64 public immutable configDelay;                 // s, §5.6
uint64 public constant CONFIG_GRACE = 3 days;        // execute window after eta
mapping(bytes32 id => uint64 eta) public queuedEta;  // 0 = not queued
mapping(uint32 perpIndex => bool) public perpAllowed;
address public guardian;

function queueSetQuoteSigner(address signer) external returns (bytes32 id);
function queueSetLimits(Limits calldata l) external returns (bytes32 id);
function queueSetPerpAllowed(uint32 perpIndex, bool allowed) external returns (bytes32 id);
function queueSetGuardian(address guardian) external returns (bytes32 id);
function setQuoteSigner(address signer) external;                 // execute
function setLimits(Limits calldata l) external;                   // execute
function setPerpAllowed(uint32 perpIndex, bool allowed) external; // execute
function setGuardian(address guardian) external;                  // execute
function cancel(bytes32 id) external;
function guardianPause() external;                                // guardian only, immediate
function opId(OpKind kind, bytes calldata data) external pure returns (bytes32); // keccak256(abi.encode(kind, data))

event ConfigQueued(bytes32 indexed id, OpKind kind, bytes data, uint64 eta);
event ConfigExecuted(bytes32 indexed id);
event ConfigCancelled(bytes32 indexed id);
event QuoteSignerUpdated(address indexed signer);
event LimitsUpdated(Limits limits);
event PerpAllowedUpdated(uint32 indexed perpIndex, bool allowed);
event GuardianUpdated(address indexed guardian);
event LossBreakerTripped(uint256 paidInWindow, uint256 cap);
```

`data` is `abi.encode(signer)`, `abi.encode(l)`, `abi.encode(perpIndex, allowed)` or `abi.encode(guardian)`.
Queue: validate the arguments (`ZeroAddress` for a signer, `InvalidLimits`; for `allowed = true` the price
source must return a price for the perp, else its own error bubbles up), `id` not already queued
(`OpAlreadyQueued(id)`), `eta = now + configDelay`, emit `ConfigQueued`. Execute: `queuedEta[id] != 0`
(`OpNotQueued(id)`), `now ≥ eta` (`OpNotReady(id, eta)`), `now ≤ eta + CONFIG_GRACE` (`OpStale(id, eta)`),
re-validate, delete the entry, apply, emit `ConfigExecuted` and the setting's own event. Cancel:
`OpNotQueued` if absent, delete, emit `ConfigCancelled`. The same operation can be queued again after it is
executed or cancelled; a **stale** entry (past its grace) still occupies its id, so cancel a stale op
before re-queueing it. Disallowing a perp affects new sales only; existing covers on it still trigger and
expire. Executing a signer change invalidates every outstanding quote (unchanged from v1).

The constructor sets the initial signer, limits, guardian and perp allowlist directly (no delay; emits the
setting events). It validates each initial perp through the price source (`oraclePx6` must return), so a
bad index fails the deploy. Perp indices come from `deployments/<env>.json` via the deploy script, never
hardcoded.

Note: with mainnet delays (`configDelay` 48 h < `withdrawDelay` ≥ 7 d), LPs cannot exit before a queued
change executes. The timelock's value is detection and cancellation (by a multisig owner), while the floors,
the throttle and the breaker bound what a bad signer can do after execution.

### 5.6 Deploy-time constants (immutable)

Constructor: `(IERC20 usdc, address owner, address quoteSigner, address guardian, IPriceSource,
IPositionSource, Limits limits, uint32[] perps, uint64 configDelay, uint64 withdrawDelay, uint64 claimWindow,
bool strict)`; reverts `ZeroAddress`, `InvalidLimits`, `InvalidDelays()`, `StrictRequired()`, or the price
source's error for a bad perp. `owner = 0` reverts first, with OZ `OwnableInvalidOwner(address(0))` (not
`ZeroAddress`).

| Constant | Bounds (always) | Strict mode (required unless chainid is 998 or 31337) | Testnet value |
|---|---|---|---|
| `configDelay` | 5 min … 30 days | ≥ 48 h | 600 (10 min) |
| `withdrawDelay` | 5 min … 60 days | > `maxDuration`, now and in every later `setLimits` (enforced by `_validateLimits`, `InvalidLimits`) | 600 (10 min) |
| `claimWindow` | 10 min … 7 days | ≤ `withdrawDelay / 7` and ≤ 1 day | 3 600 (1 h) |

- `strict` is an immutable constructor flag; `strict == false` reverts `StrictRequired()` on any chain other
  than 998 or 31337, so a non-testnet deploy cannot get testnet delays or testnet limits. Local tests cover
  both modes.
- Non-strict testnet keeps `withdrawDelay` (10 min) far below `maxDuration` (7 days) on purpose, so the LP
  demo stays short; §5.4 states what that leaves open.
- The 5-minute floor is ≥ 5 big-block intervals; how `block.timestamp` behaves across HyperEVM's small and
  big blocks is NOT VERIFIED, so no delay is set near the 1-minute big-block cadence.

### 5.7 Errors (new in v2; the v1 errors stay)

`PerpNotAllowed(uint32)`, `PremiumBelowFloor(uint256 premium, uint256 minPremium)`,
`LevelTooClose(uint64 oraclePx, uint64 level)`, `SaleWindowCapExceeded(uint256 soldAfter, uint256 cap)`,
`BuyerWindowCapExceeded(address buyer, uint256 soldAfter, uint256 cap)`, `NothingOwed()`,
`NotShareOwner(address sender, address owner)`, `ControllerMustBeOwner(address controller, address owner)`,
`NotController(address sender, address controller)`, `RequestClaimable()`,
`RequestNotClaimable(RequestState state)`, `ZeroShares()`, `ExceedsClaimable(uint256 shares, uint256
claimable)`, `InsufficientFreeAssets(uint256 assets, uint256 free)`, `AsyncRedeemOnly()`, `SharesToPool()`,
`NotGuardian()`, `OpAlreadyQueued(bytes32)`, `OpNotQueued(bytes32)`, `OpNotReady(bytes32, uint64 eta)`,
`OpStale(bytes32, uint64 eta)`, `RenounceDisabled()`, `InvalidDelays()`, `StrictRequired()`.
New events: `PayoutDeferred(uint256 indexed coverId, address indexed buyer, uint256 amount)`,
`PayoutClaimed(address indexed buyer, uint256 amount)`, plus those in §5.4 and §5.5. `LimitsUpdated` changes
signature (one `Limits` tuple). New views: `limits`, `capacityBase`, `owed(address)`, `owedAssets`,
`unearnedPremium`, `windowStart`, `windowAssets`, `soldInWindow`, `buyerWindow`, `paidWindowStart`,
`paidWindowAssets`, `paidInWindow`, `perpAllowed`, `guardian`, `queuedEta`, `opId`, `redeemRequestOf`,
`totalEscrowedShares`, the three delays, `strict`, `pendingOwner`. Existing views (`quoteDigest`,
`quoteStructHash`, `DOMAIN_SEPARATOR`, `QUOTE_TYPEHASH`, `freeAssets`, `lockedByPerp`, `nonceUsed`,
`coverCount`) stay.

### 5.8 Invariants (Foundry invariant campaign; v1 list extended)

Accounting
1. `usdc.balanceOf(pool) ≥ lockedAssets + owedAssets + unearnedPremium`.
2. `lockedAssets == Σ payout of Active covers`; `Σ lockedByPerp == lockedAssets` (v1).
3. `totalAssets() == usdc.balanceOf(pool) − owedAssets − unearnedPremium`.
4. `unearnedPremium == Σ premium of Active covers`.
5. `owedAssets == Σ owed[buyer]` over handler buyers, and `owed[b] ≤ Σ payout of b's Paid covers`.
6. Escrow: `balanceOf(pool) == totalEscrowedShares == Σ slot.shares`.

Sales and payouts
7. Throttle: `soldInWindow ≤ windowAssets × maxSoldPerWindowBps / 10000`, and per buyer
   `buyerWindow[b].sold ≤ that cap × maxBuyerWindowShareBps / 10000` while `buyerWindow[b].start ==
   windowStart` (checked after every sale, with the limits in force).
8. Breaker ghost: whenever `paidInWindow > paidWindowAssets × maxPaidPerWindowBps / 10000` after a
   trigger, the pool is paused (until the owner unpauses).
9. Floors: for every sold cover, `premium × 10000 ≥ payout × minPremiumBps` and
   `|px_at_sale − level| × 10000 ≥ px_at_sale × minLevelDistanceBps` (ghost records `px_at_sale` and the
   limits in force), and `perpAllowed[perpIndex]` held at sale.

Exits
10. No exit bypasses the queue: every decrease of `totalSupply` equals shares burned by a claim from a slot
    that was Claimable (ghost: request time + `withdrawDelay` ≤ claim time < request time + `withdrawDelay`
    + `claimWindow`); handler calls of `withdraw`/`redeem` without a Claimable slot always revert.
11. Liveness: after `pause`, and a warp of `maxDuration + withdrawDelay` with every cover expired or
    triggered, every requested slot (re-queued if lapsed) can claim in full.
12. Rounding: no LP action (deposit, mint, request, cancel, claim) lowers `convertToAssets(1e12)` (one
    share) for the other holders.

Owner
13. Timelock: limits, signer, guardian and allowlist change only through an execute whose `eta ≤ now`
    (ghost), and every queued entry has `eta − queuedAt == configDelay`.

Claimable redeem requests are not reserved in USDC (they are priced at claim time and bounded by free
assets), so there is no "escrow-claimable assets" term in invariant 1. Reserving them would need an
on-chain fulfilment step at maturity; v2 does not have one.

### 5.9 Gas, size and deploy plan

Facts (research 2026-10-02, primary sources):
- HyperEVM has dual blocks: small blocks every ~1 s with a 3M gas limit; big blocks every ~1 min with a 30M
  gas limit (Hyperliquid docs, "Dual-block architecture").
- An address opts into big blocks with the HyperCore L1 action `{"type":"evmUserModify","usingBigBlocks":true}`,
  signed by the same key (official Python SDK `Exchange.use_big_blocks(enable)`, example
  `examples/basic_evm_use_big_blocks.py` on the testnet API URL); `false` switches back. The address must
  already be a HyperCore user. The deployer `0x2BA5…52A9` is not one yet (`userRole: missing`); the
  founder will fund it with Core USDC. The mempool accepts only the next 8 nonces per address. A
  `bigBlockGasPrice` RPC method exists.
- v1 pool deploy used 2,670,847 gas (89 % of the small block); v2 adds code and will exceed 3M.
- EIP-170 (24,576-byte runtime limit) enforcement on HyperEVM is NOT VERIFIED (docs silent). v2 keeps the
  runtime under 24,576 bytes anyway.

Size budget: a review estimated the v2 runtime at 19–21.5 KB before the breaker, guardian, per-buyer cap and
unearned-premium additions. `forge build --sizes` is part of the code phase. If the pool exceeds **23 KB**:
first drop the individual limit getters (keep `limits()`; the app switches to it); if still over, replace
the custom timelock with an OZ `TimelockController` as owner (Safe holding the proposer and execution roles on mainnet, the
guardian keeps an immediate pause role on the pool). A further split (the redeem queue in its own contract)
is the last resort.

Plan:
1. Founder funds the deployer on HyperCore testnet (makes it a Core user).
2. Deployer sends `evmUserModify usingBigBlocks=true` (SDK `use_big_blocks(True)`, testnet URL).
3. Deploy, in this order (forge script, chain guard 998/31337 unchanged): price and position sources →
   `cachePerp` for each perp in `deployments/<env>.json` → pool (its constructor validates those perps).
   Txs land in big blocks (~1 min each); keep ≤ 8 pending nonces.
4. Deployer sends `usingBigBlocks=false` so seeding and admin txs go back to 1 s blocks.
5. Record addresses, tx hashes and the measured deploy gas in `deployments/testnet-v2.json` (v1's
   `deployments/testnet.json` stays as it is).

Steps 2 and 4 are `python scripts/big-blocks.py on|off|status` (official SDK, `DEPLOYER_KEY` read from
`.env` inside the script). Step 3 is `node scripts/deploy-v2.mjs` (the founder runs it):
- It loads `.env` into the child process env only (never argv, never printed), checks `eth_chainId` is 998
  or 31337 on the RPC, prints the plan and needs an explicit `--yes`. `--dry-run` runs the same steps against
  a local anvil (31337).
- Forge's local EVM has no HyperCore precompiles, so `cachePerp` and the pool constructor would revert in
  forge's local pass. For `MODE=hypercore`, `Deploy.s.sol`'s `run()` therefore etches stand-in contracts at
  `0x…0800`, `0x…0807` and `0x…080a` and configures them (prices from `STANDIN_PX6`, which the wrapper
  fetches from the Info API) **before** `vm.startBroadcast`. `deploy()` never etches, and nothing calls a
  stand-in inside the broadcast window, so no transaction to a precompile address is recorded (a test
  checks the broadcast list). The stand-ins only let the local pass finish.
- The wrapper first runs the same forge command without `--broadcast` against the real testnet RPC (a
  preflight that sends nothing; `--fork` rehearses the full deploy on a local anvil fork of 998), then
  broadcasts with `--skip-simulation --slow --disable-block-gas-limit`. The last flag is required: forge's
  local pass forks the latest block, usually a 3M small block, and otherwise caps the ~4.85M pool creation at
  that limit (it fails as "Failed to decode return value: 0x"). Forge still calls `eth_estimateGas` for each
  transaction, so on 998 the node runs the real precompiles, and an invalid perp aborts the deploy at that
  transaction's estimation, before it is sent (contracts already deployed, such as the price source, stay; the
  wrapper lists them). On anvil the hypercore route aborts there by design.
- The deployer key is read inside the script (`vm.startBroadcast(vm.envUint("DEPLOYER_KEY"))` when set), so
  it never appears in a command line.
- Afterwards the wrapper reads the pool's limits, owner, signer, guardian, delays and perps back over RPC and
  writes them with the addresses into `deployments/testnet-v2.json`.
Open (NOT VERIFIED): the exact v2 deploy gas (measured when the code exists), whether a big-block deploy
needs `bigBlockGasPrice` instead of `eth_gasPrice`, and timestamp behaviour across dual blocks.

### 5.10 What changes in the engine, app and keeper

- **Engine** (§6): read `limits()`, `perpAllowed(perp)`, `capacityBase()` and the window state
  (`windowStart`, `windowAssets`, `soldInWindow`, `buyerWindow(buyer)`) from the pool over `eth_call`.
  Raise a model premium below `ceil(payout × minPremiumBps / 10000)` to that floor (`floorApplied`); refuse
  what the contract would reject otherwise; use the on-chain allowlist instead of (or intersected with)
  `deployments.perps`.
- **App**: LP screen gets request / cancel / claim (state from `redeemRequestOf`, countdown to
  `claimableAt` and `claimDeadline`, `maxRedeem` for the claimable part) instead of instant withdraw;
  an "owed payout" banner with `claimPayout()` when `owed(account) > 0`; show the new limits and the
  paused-by-breaker state; regenerate the ABI; map the new custom errors in `lib/errors.ts`.
- **Keeper**: `trigger` keeps its signature and permissionless semantics and never reverts on a failed
  transfer or on the breaker, so the trigger loop is unchanged. New alerts (log, and later a notifier):
  `ConfigQueued`; the sale cap reached (`soldInWindow` within one minimum payout of the cap, or
  `SaleWindowCapExceeded` seen); a floor-priced sale (`premium × 10000 == payout × minPremiumBps`, rounded
  up); `LossBreakerTripped`; `PayoutDeferred`; ready but unexecuted ops (`queuedEta ≤ now`, inside the 3-day
  `CONFIG_GRACE`, so they can still be cancelled or will go stale). With a guardian key configured, the keeper
  may call
  `guardianPause()` on a rule the operator sets.
- **Deploy script**: v2 constructor args (limits, guardian, perps from `deployments/<env>.json`, delays,
  `strict=false` on 998), the deploy order, the stand-in route and big-block steps above
  (`scripts/deploy-v2.mjs`, `scripts/big-blocks.py`).
- **Docs**: SECURITY.md "Mainnet blockers" 1–6 move to "fixed in v2" once v2 is deployed with evidence.

### 5.11 v1 (deployed 2026-10-01, live testnet pools)

v1 differs from v2: no floors, throttle or on-chain allowlist; `Ownable` (single-step, renounce possible);
`setQuoteSigner`/`setLimits` immediate with wide bounds (`setLimits(uint16 maxUtilBps, uint16 perPerpCapBps,
uint64 maxDuration, uint16 maxSpotDevBps, uint256 minPayout)`, event with five fields); instant
`withdraw`/`redeem` limited to free assets; `trigger` transfers directly (reverts on a failed transfer);
`totalAssets` = USDC balance. Notes that still hold for v2:
- Price/position sources are immutable (constructor). A price source **reverts, never returns 0**, so a
  missing price can never count as a breach.
- Interfaces `IPriceSource.oraclePx6(uint32) → uint64` and
  `IPositionSource.position(address,uint32) → (int64 szi, uint64 entryNtl, uint32 leverage)`; HyperCore
  implementations do a gas-capped `staticcall` to the precompile and revert with a named error.
  `HyperCorePriceSource.cachePerp(idx)` should be called once per perp after deploy.
- Pool shares have **12 decimals** (USDC 6 + offset 6, inflation-attack defence).
- Capacity is checked against `totalAssets` before the premium arrives (conservative).
- Compiled with `via_ir`, `evm_version = shanghai`.
- Verified on testnet [RUN]: `perpAssetInfo(3)` decodes as one tuple → `("BTC", 54, 5, 40, false)`;
  position `entryNtl` = USD × 1e6 (research doc).
- Mainnet lock: deploy scripts `require(block.chainid == 998 || block.chainid == 31337)`.

## 6. Quote API (engine → app)

`POST /quote` with body `{buyer, perpIndex, isLong, level, payout, durationSec, pool?}` (level: px6 integer,
payout: 6-decimal integer).

Response: `{quote: <§4 fields>, signature, breakdown: {sigma, touchProb, loading, premium, model, tailMultiplier, tailFloor, pricedProb, fee, coin, z, spotSource, pool}}`
or `{error, reason}`.

- `pool` (optional): which pool the quote is for. It must be in the allowlist (the configured pool plus every
  pool in `deployments/<env>.json`), else 400 `unknown_pool`. The quote is signed with
  `verifyingContract = pool` and priced against that pool's own price source.
- Error codes and HTTP status: 400 `invalid_request`, `unknown_perp`, `perp_not_allowed`,
  `duration_out_of_range`, `unknown_pool`; 403 `chain_not_allowed`; 422 refusals `level_already_breached`,
  `level_too_close`, `prob_too_high`, `capacity`, `payout_too_small`; 429 `rate_limited`; 503
  `market_data_unavailable`, `signer_unavailable`, `pool_paused`.
- `pool_paused` (503): the pool is paused, so `buyCover` would revert. `payout_too_small` (422): the payout is
  below the pool's `minPayout`. Both are read from the pool (v1 and v2).
- `perp_not_allowed`: only the perps listed in `deployments/<env>.json` (`perps`) are quoted.
- Quote lifetime: `deadline` is 30 s after issue. `now` comes from the latest block timestamp (the engine's
  clock only if the RPC cannot be read). A level closer to spot than 3·σ·√(30 s) is refused with
  `level_too_close`: the price could reach it before the quote expires, so a buyer could wait and only use
  the quote once the move has happened.
- `rate_limited`: `POST /quote` allows about 10 requests a minute per client IP (small burst), with a
  `Retry-After` header.
- `nonce` < 2^53 (safe as a JSON number for JS clients).
- `capacity` is an engine-side sanity cap only; the on-chain utilization and per-perp checks are
  authoritative.

`GET /health` → `{ok, env, signer, chainId, pool, pools}`.

For a v2 pool (§5, not yet deployed) the engine will also read the pool's on-chain floors, perp allowlist and
sale-window state and never sign a quote the contract would reject. A model premium below `minPremiumBps`
of the payout is raised to that floor and the breakdown reports `floorApplied: true`; `perp_not_allowed`
when the perp is not allowed on that pool; `level_too_close` when the level is closer to spot than
`minLevelDistanceBps` plus a margin for the allowed oracle move (`m + d + ceil(m·d / 10000)`, 56 bps on
testnet), so the contract's own distance check, made against the live oracle, cannot fail; `capacity` when the payout exceeds what is left of the sale-window cap or the buyer's
share of it. That check covers the whole quote lifetime: if the sale window ends before the deadline, the
payout must also fit the fresh window the contract would open on the pool's current capital. v1 pools keep
today's behaviour.

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
  testnet end-to-end run with transaction hashes in `deployments/testnet.json`. v2 extends the invariant
  list (§5.8): owed payouts, unearned premium, the sale throttle and payout breaker, the floors, the redeem
queue (escrow, liveness, rounding) and the timelock.

## 10. Out of scope (v1)

Mainnet; hedging the pool on Hyperliquid through CoreWriter ("reinsurance", roadmap); partial payouts; a
secondary market for covers; governance or a token; cross-chain.
