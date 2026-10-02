# Security

This page describes who can move money in Numera, what the code guarantees, what it does not, and what
must change before real funds are involved. It is written for judges and for future auditors.

## 1. Status

- **Testnet only.** Numera runs on HyperEVM testnet (chain 998). The USDC in the pools is a mock token
  with public mint; it has no value. There is no mainnet deployment and no real funds.
- **Not independently audited.** The code had an internal security review on 2026-10-02 (read-only
  review of `contracts/`, the engine's signing and keeper code, and the app's write path, with local
  proof-of-concept tests). That is not an independent audit, and this page is not an audit report.
- **Reporting an issue.** Open a GitHub issue on this repository. If the issue could put funds at risk
  on a deployment you control, describe the class of problem in the issue and leave the exploit details
  out until a fix is ready.

## 2. Trust model and money flows

### How USDC can leave a pool

`CoverPool` (an ERC-4626 vault, [`contracts/src/CoverPool.sol`](contracts/src/CoverPool.sol)) has exactly
two ways to send USDC out:

1. **`trigger(coverId)`** pays the cover's `payout` to the cover's `buyer`, and only when the cover is
   active, not past expiry, and the oracle price is at or past the level.
2. **LP `withdraw` / `redeem`**, limited to `freeAssets() = totalAssets - lockedAssets`, i.e. the USDC
   not reserved for active covers.

There is no sweep or rescue function, no upgrade proxy, and the price and position sources are immutable
(set in the constructor).

### Roles

| Role | Can | Cannot |
|---|---|---|
| **Owner** (deployer key on testnet) | Rotate the quote signer (`setQuoteSigner`); change limits (`setLimits`: max utilization, per-perp cap, max duration, max spot deviation, min payout); pause and unpause; transfer or renounce ownership. | Move USDC; change the price or position source; stop `trigger`, `expire` or withdrawals of free assets (pause does not cover them). Indirectly, by rotating the signer, it gains everything the quote signer can do (see H1). |
| **Quote signer** (engine key) | Sign EIP-712 quotes. Any quote it signs that passes the contract's checks (signature, buyer, deadline, nonce, expiry window, min payout, spot deviation, level not already breached, buyer's position and margin cap, pool capacity) can be bought. | Move USDC; sign for another pool or chain (the domain binds both); let a quote be used twice or by another address; sell a cover the pool cannot fully reserve. |
| **Keeper** (bot key) | Call `trigger` and `expire`, which anyone may call. | Anything else. A stolen keeper key costs only its gas balance. |
| **Anyone** | `trigger`, `expire`, `cachePerp` on the price source, deposit (when not paused), withdraw their own free share, request a quote from the engine. | Trigger a cover whose level is not breached, or expire one before expiry. |

The engine (`engine/`) is the off-chain pricing service: it computes the premium and signs quotes with
the quote signer key. The app (`app/`) only writes through the user's wallet, approves exactly the signed
premium, and builds requests from its own fields.

## 3. Guarantees that hold, and why

- **Every active payout is fully reserved.** `buyCover` adds the payout to `lockedAssets` (and the
  per-perp total) in the same transaction, after checking it fits under the utilization and per-perp
  caps. LP withdrawals are capped at `totalAssets - lockedAssets`, and only `trigger`/`expire` release a
  lock. So the pool's USDC balance is always at least the sum of active payouts, and a buyer whose cover
  triggers is paid in full. This is checked by a stateful fuzz (invariant) campaign: the USDC balance
  covers `lockedAssets`, `lockedAssets` equals the sum of active payouts, per-perp locks sum to the total,
  and `totalAssets` equals the balance (see section 7).
- **Quotes are bound to chain, pool, buyer, nonce and deadline.** The EIP-712 domain contains the chain
  id and the pool address, so a quote for one pool or chain does not verify on another. The contract
  requires `quote.buyer == msg.sender`, rejects a quote after its deadline, and marks each nonce used
  once per pool. Rotating the signer invalidates every outstanding quote. Signature recovery uses
  `tryRecover`, so a malformed signature reverts with `InvalidSignature` instead of recovering a wrong
  address.
- **A price source reverts rather than returning 0.** The HyperCore price source validates the perp
  index, reverts on a failed precompile call, on a zero price and on an overflow; the mock source reverts
  when no price is set. A missing price therefore can never look like a breach (for a long cover, a
  price of 0 would be "at or below every level").
- **Trigger and expire are permissionless and keep working while paused.** Pause stops new covers and
  new deposits only. `trigger`, `expire` and withdrawals of free assets have no pause check, so buyers
  can be paid and LPs can leave with free capital even when the owner pauses the pool.
- **Mainnet is refused at every layer.** The deploy script requires chain id 998 or 31337 before it
  broadcasts (tested for 999 and an unknown id); the engine answers every `/quote` with
  `chain_not_allowed` on 999; the keeper refuses to start or send on 999; the app defines only chain 998
  and passes it on every wallet write, so a wallet on another chain cannot send.
- **Reentrancy and rounding.** State-changing functions are `nonReentrant`, follow checks-effects-
  interactions, and the sources are read by static call. The vault uses a decimals offset of 6
  (virtual shares) against the first-depositor inflation attack, which has a dedicated test.

## 4. Known limitations and risks

Severity is for a mainnet deployment with real funds. On testnet the funds are worthless and the keys are
held by the operator.

**H1 (High): a compromised quote signer or owner can drain the LPs.** The contract does not enforce a
minimum premium or a minimum distance between the level and the spot price: the only size limits are the
buyer's margin cap and the pool's capacity caps. Whoever holds the quote signer key (or the owner key,
which can rotate the signer in one step, with no timelock) can sign zero-premium covers with a level one
tick from spot and trigger them right away. In the review's local proof of concept this took a
100,000 USDC pool to about 391 USDC in 8 rounds. **Buyers are still always paid**, because every payout
is reserved; the underwriters bear the loss. A wrong but honest quote has the same shape on a smaller
scale: it can misprice a premium, and the LPs absorb the difference.

**H2 (High): LP withdrawal race.** Free assets are withdrawn first come, first served, and the share
price does not mark active covers at their expected loss. When a cover is close to triggering, an LP who
withdraws first leaves the coming payout to the LPs who stay. Whoever sees a breach first (the keeper
operator, or anyone watching the oracle) has an edge. This moves losses between LPs; it does not affect
buyers.

**M1 (Medium): stale-quote option, now narrowed off-chain.** A signed quote can be held until its
deadline and submitted only if the price has moved toward the level, as long as the oracle is still within
the contract's spot-deviation limit (1 % by default). The engine now issues quotes valid for 30 s instead
of 60 s and refuses levels within 3·σ·√TTL of spot (`level_too_close`). The on-chain deviation limit is
unchanged.

**M2 (Medium): no on-chain perp allowlist.** The price source accepts any perp index HyperCore lists,
including thin test markets. The engine quotes only the perps listed in the deployment file for its chain
(`perp_not_allowed` otherwise) and refuses to start on 998 without that list. Exploiting an odd perp
therefore needs a signer compromise (H1) or an engine change.

**M3 (Medium, by design): the position is checked at purchase only.** `buyCover` requires a
same-direction position and caps the payout at its margin. `trigger` does not check the position again,
so a buyer who closes the position still collects. The cover is "sized by your position at purchase"; it
is not an indemnity for an actual liquidation, and the premium has to stand on its own.

**M4 (Medium): quote endpoint availability, now mitigated.** `/quote` is unauthenticated. A flood could
exhaust the shared RPC and slow the keeper. The engine now rate-limits per client IP (`rate_limited`;
X-Forwarded-For is believed only from configured trusted proxies), caches the pool spot price per
(pool, perp) for 2 s, and fails over between RPC endpoints. This has not been load-tested.

**L1 / L2 (Low): owner hardening.** The pool uses `Ownable`, not `Ownable2Step`, so ownership can be
transferred to a wrong address or renounced in one call. `setLimits` accepts values up to 100 % (for
example a 100 % spot deviation or 100 % utilization), with no timelock.

**L7 (Low): untriggerable covers on a delisted perp.** If a perp is delisted, or its price overflows the
px6 range, the price read reverts, so `trigger` reverts until expiry. The cover then expires, the payout
is released back to the pool, and the buyer loses the premium.

**L8 (Low, mainnet only): USDC blocklist.** Real USDC can blocklist addresses. A blocklisted buyer's
`trigger` would revert, and the payout would return to the pool at expiry. A pull-payment fallback is
needed.

**Oracle vs mark basis.** Covers trigger on the HyperCore oracle price; Hyperliquid liquidates on the mark
price. They can differ, so the default level sits a buffer above the liquidation price, and a liquidation
without an oracle touch does not pay.

**Observed touches only.** A cover pays when a `trigger()` call before expiry sees the breach on-chain.
The keeper polls about every 3 s, so a shorter wick can be missed; anyone watching faster can call
`trigger` themselves. Details: [`docs/how-it-works.md`](docs/how-it-works.md) §8.

## 5. Mitigated off-chain (2026-10-02)

These changes are in the engine (`engine/`) and the app (`app/`); they apply to the deployed v1 contracts,
which are unchanged. The on-chain mitigations in v2 are listed after this list.

- **M1:** quote lifetime 30 s; levels within 3·σ·√TTL of spot are refused (`level_too_close`).
- **M2:** the engine quotes only the perps in the deployment file and fails closed on chain 998 when the
  file, its pools or its perps are missing.
- **M4:** per-IP rate limit (`rate_limited`, trusted proxies only for X-Forwarded-For), 2 s spot cache per
  (pool, perp), RPC failover for the engine's pool reads.
- **App:** Approve and Buy stay disabled unless the quote signature recovers to the pool's on-chain quote
  signer and the premium matches the price breakdown. The approval amount is the signed premium.
- **Keeper:** a max fee per gas ceiling, replace-by-fee for a stuck transaction (same nonce, bumped fees),
  a cap on transactions per poll (triggers first), and a low-balance warning.
- **Signer key hygiene:** the quote signer key is kept out of every `repr` and log line.
- **Clock:** quote deadline and expiry are computed from the latest block timestamp, with a fallback to
  the wall clock when the chain cannot be read or lags.

### CoverPool v2 (in the repository, not deployed)

A second version of the pool contract is merged into the repository but is **not deployed**. The pools
running on testnet today are still v1, so everything in section 4 still describes the live testnet
contracts. v2 implements:

- on-chain `minPremiumBps` and `minLevelDistanceBps` floors, a sale-window throttle, and a payout circuit
  breaker that pauses sales when payouts in a window exceed a cap (an owner unpause also resets the
  breaker window);
- a timelock on `setQuoteSigner`, `setLimits` and the allowlist, `Ownable2Step`, disabled renounce, and a
  guardian that can cancel queued changes; queued changes expire 3 days after they become executable;
- asynchronous LP exits (request, wait `withdrawDelay`, claim);
- an on-chain, owner-set perp allowlist;
- bounds on `setLimits`;
- a pull-payment fallback when a direct payout transfer fails.

v2 had an internal design review and an internal code audit (no Critical or High findings; mutation
checks on the new guards were caught). That is still not an independent audit.

## 6. Mainnet blockers

The v2 contract addresses blockers 1 to 6 below in code, but v2 is not deployed and has not been
independently audited, so none of them is closed on a live deployment. All must hold on a deployment that
has real funds:

1. On-chain `minPremiumBps` and `minLevelDistanceBps`, and per-buyer (or per-block) caps, so a signer
   compromise cannot sell covers that lose money by construction (H1, M1).
2. `Ownable2Step`, a multisig owner and a timelock on `setQuoteSigner` and `setLimits`; quote signer key
   custody in an HSM or KMS (H1, L1).
3. A withdrawal queue or cooldown at least as long as the maximum cover duration, or pro-rata exits, so
   LPs cannot run ahead of a known loss (H2).
4. An on-chain, owner-set perp allowlist (M2).
5. Bounds on `setLimits` (for example spot deviation at most 5 %, utilization at most 90 %, per-perp cap
   at most utilization) (L2, M1).
6. A pull-payment fallback when a direct payout transfer fails (L8).
7. A deploy gas plan: the current deploy uses most of HyperEVM's small-block gas limit, so the contract
   additions above will likely need big blocks.
8. An independent audit.

Residual risks that remain even with v2 as written:

- **Throttle and exit queue only bind in strict mode.** The attacker who also supplies capital (deposit,
  sell covers, request an exit) is only bounded when `withdrawDelay` is longer than the maximum cover
  duration. The testnet configuration uses a 10-minute delay, so there the throttle and the queue narrow
  the race and do not close it. A mainnet deployment must use strict delays; the constructor refuses
  non-strict delays outside chains 998 and 31337.
- **Patient-path loss.** Within the floors, throttle and breaker, a compromised signer can still sell
  covers over time that lose money; the loss is bounded by `maxUtilization` of the pool, not zero.
- **Full owner compromise.** An owner key that stays compromised through the timelock delay, with no
  working guardian cancel, can still queue and execute harmful changes. Multisig custody and an honest
  guardian are operational requirements, not something the contract can enforce.

## 7. Tests backing these claims

Run everything with:

```sh
node scripts/check.mjs
```

It runs `forge build` and `forge test` in `contracts/`, `ruff` and `pytest` in `engine/`, and the build
and tests in `app/`. Results on 2026-10-02:

- **Contracts:** 98 Foundry tests in 7 suites, all passing. They cover each `buyCover` check and its
  order, trigger and expire semantics (including trigger while paused), the vault (pause, withdrawal
  limits, inflation attack), the HyperCore sources (invalid index, failed precompile, zero price,
  overflow), the deploy script's chain guard (999 and an unknown chain are refused), and an EIP-712 test
  vector shared with the engine.
- **Invariant campaign:** 4 invariants (balance covers `lockedAssets`; `lockedAssets` equals the sum of
  active payouts; per-perp locks sum to the total; `totalAssets` equals the balance), 256 runs × depth 64
  = 16,384 handler calls, 0 reverts.
- **Engine:** 207 pytest tests, all passing, including the quote API hardening (TTL, `level_too_close`,
  perp allowlist and fail-closed start-up, rate limit, spot cache, block-time clock, mainnet refusal) and
  the keeper (fee ceiling, replace-by-fee, per-poll cap, balance warning, mainnet refusal).
- **App:** 106 tests passing (1 skipped), including the Approve/Buy gate.

Individually: `forge test` in `contracts/`; `python -m pytest -q tests` in `engine/`; `npm test` in
`app/`. Setup is in the [README](README.md#run-it).
