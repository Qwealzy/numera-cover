# Calibration backtest: one-touch model on Hyperliquid history

Generated 2026-10-01T18:09Z by `python -m numera_engine.backtest --coins BTC ETH SOL HYPE` (model `gbm-touch-v1`, tail table `z-pooled-v2`, decision D9). Source: Hyperliquid mainnet Info API `candleSnapshot`, read-only. Files: `calibration.csv` (per coin/horizon/distance bucket, v1 and v2 out-of-sample columns), `calibration_z.csv` (pooled z buckets = the published table), `calibration_z_by_horizon.csv` (diagnostic), `calibration.svg` (reliability plot), `tail_multipliers.json` (consumed by the quote API).

## Pricing formula (engine v1, final)

For a cover on perp `i`, direction `isLong`, trigger level `L` (px6), payout `P` (USDC, 6 dec), duration `D` seconds:

```
S      = pool.priceSource().oraclePx6(i) / 1e6 via eth_call (D10: what buyCover checks); spotRef = it
         fallback if that read fails: testnet Info API metaAndAssetCtxs.oraclePx (breakdown.spotSource)
sigma  = max(EWMA_0.94(1h log returns), realized sigma over the last 30 days), annualized x sqrt(24*365)
         from mainnet Info API 1h candles of the same coin (read-only); used for every duration
T      = D / (365*24*3600)
b      = ln(L/S),  s = sigma*sqrt(T)
p      = N((b + s^2/2)/s) + (S/L) N((b - s^2/2)/s)          if L < S  (long cover, down level)
p      = N((-b - s^2/2)/s) + (S/L) N((-b + s^2/2)/s)        if L > S  (short cover, up level)
z      = b / s                                              (standardized distance)
k, q   = tail_multipliers.json lookup(direction, |z|)       (pooled z buckets, below)
priced = max(p * k, q)
refuse   prob_too_high           if priced > pMax = 0.5
refuse   level_already_breached  if isLong and S <= L, or !isLong and S >= L
premium = ceil(P * priced * (1 + theta)) + fee,  theta = 0.2, fee = 0 (configurable)
```
Lookup: k is the value of the |z| bucket that holds |z| (an empty bucket borrows the nearest populated one, nearer-the-money first). q is first made non-increasing in |z| (each bucket takes the max of itself and all further buckets) and then interpolated log-linearly between bucket mid-points, so the price is continuous in the level and never rises as the level moves away. Quote API: `breakdown` returns `sigma, touchProb (= p), loading (= theta), premium, model` plus `tailMultiplier (= k), tailFloor (= q), pricedProb, fee, coin, z, spotSource (pool | info_api), pool`. Request may carry an optional `pool` (default: configured pool), which must be in the allowlist (configured pool + pools in deployments/<env>.json); the quote is signed for that pool. Errors `{error, reason}`: 400 `invalid_request`, `unknown_perp`, `unknown_pool`, `duration_out_of_range`; 422 `level_already_breached`, `prob_too_high`, `capacity`; 403 `chain_not_allowed`; 503 `market_data_unavailable`, `signer_unavailable`. Nonce random in [1, 2^53) so JSON numbers stay exact in JavaScript. Never signs for chainId 999.

## Method

- **Question.** When the engine says "probability p that the price touches level L within T", does that happen with frequency p or less in real Hyperliquid data?
- **Data.** Horizons 1h, 4h, 1d: 1-hour candles (the Info API keeps only the latest ~5000). Horizon 7d: 1-day candles from 2023-02-26 on; zero-volume rows and earlier rows dropped (HL-traded data only).
- **No look-ahead.** At each window start, sigma = max(EWMA lambda=0.94 of log returns, 30-day realized), annualized, from candles that closed before the start only. A 30-day warm-up is skipped. The 7d horizon uses daily candles for sigma (1h history is too short for enough 7d windows).
- **Windows.** Non-overlapping (step = horizon), aligned to multiples of the horizon since the unix epoch. S = open of the first candle. Levels 1, 2, 3, 5, 7.5, 10, 15, 20 % below S (`down`, long cover) and above S (`up`, short cover). Touched if min(low) <= S(1-d) or max(high) >= S(1+d) in the window. Windows with a missing candle are skipped.
- **Model.** Closed-form one-touch probability under driftless GBM (ARCHITECTURE §7; checked against Monte Carlo in `tests/test_pricing.py`).
- **Tail adjustment by credibility pooling (v2).** Under the model, p depends on the level only through the standardized distance z = ln(L/S)/(sigma sqrt(T)) (plus a drift term of size sigma sqrt(T)/2, small at these horizons). A 1h BTC window at z = -3 and a 7d HYPE window at z = -3 are therefore the same risk to the model, so we pool every window of every coin and horizon into |z| buckets (0.25 wide up to 4, then 4-5, 5-7, >= 7), separately for down and up levels. This is actuarial credibility pooling: thin cells (177 one-day windows per coin) borrow strength from the whole book, and the fitted adjustment answers "how wrong is the model at this z", which is what we need to correct. Per bucket: q = Wilson one-sided 95 % upper bound of the realized touch frequency, k = clamp(q / mean p, 1, 10) (k = 1 when nothing touched). Whether pooling across horizons is fair is checked, not assumed: see the per-horizon diagnostic.
- **v1 for comparison.** The first version fitted (k, q) separately per coin x horizon x direction x % distance (n = 177 windows for 1d). Kept here only as the side-by-side baseline.
- **Out-of-sample protocol.** Each horizon's windows are split at the median start time. The tail table is fitted on the first halves only (pooled) and evaluated on the second halves: (a) per coin/horizon/direction/% bucket, pass if realized frequency <= mean priced probability; (b) a pool P&L simulation trading the second half.
- **Caveat: candles are trade prices, not the oracle.** Covers trigger on the oracle (validator median of 8 venues). HL trade wicks on thin books usually go further than the oracle, so candle touches probably over-count oracle touches (conservative for the pool; not verified). A payout also needs a `trigger()` call that sees the breach on-chain.

## Data actually used

| coin | candles | first (UTC) | last (UTC) | count | windows per horizon |
|---|---|---|---|---|---|
| BTC | 1h | 2026-03-07 07:00 | 2026-10-01 17:00 | 5003 | 1h: 4282, 4h: 1070, 1d: 177 |
| BTC | 1d | 2023-02-26 00:00 | 2026-09-30 00:00 | 1313 | 7d: 183 |
| ETH | 1h | 2026-03-07 07:00 | 2026-10-01 17:00 | 5003 | 1h: 4282, 4h: 1070, 1d: 177 |
| ETH | 1d | 2023-02-26 00:00 | 2026-09-30 00:00 | 1313 | 7d: 183 |
| SOL | 1h | 2026-03-07 07:00 | 2026-10-01 17:00 | 5003 | 1h: 4282, 4h: 1070, 1d: 177 |
| SOL | 1d | 2023-03-04 00:00 | 2026-09-30 00:00 | 1307 | 7d: 182 |
| HYPE | 1h | 2026-03-07 10:00 | 2026-10-01 17:00 | 5000 | 1h: 4279, 4h: 1069, 1d: 177 |
| HYPE | 1d | 2024-12-05 00:00 | 2026-09-30 00:00 | 665 | 7d: 90 |

## Headline: v2 (pooled z) against targets, side by side with v1 (per bucket)

Target (D9): out-of-sample loss ratio per horizon in 0.5-0.8; report how many buckets fail realized <= priced. All numbers below are out of sample (fit on first half, trade/test second half). Price multiple = average premium per 100 USDC of cover / the raw model's (both with the 20 % loading).

| horizon | raw: loss ratio | raw: max DD | v1: price x raw | v1: loss ratio | v1: max DD | v1: failing buckets | v2: price x raw | v2: loss ratio | v2: max DD | v2: failing buckets | v2 in target? |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1h | 1.03 | 13.5% | 4.25 | 0.24 | 1.7% | 0/64 | 2.31 | 0.45 | 3.3% | 9/64 | no (below: over-priced) |
| 4h | 0.53 | 3.1% | 1.78 | 0.30 | 1.5% | 0/64 | 1.18 | 0.45 | 2.6% | 7/64 | no (below: over-priced) |
| 1d | 0.58 | 2.7% | 1.42 | 0.35 | 1.3% | 1/64 | 1.05 | 0.55 | 2.6% | 8/64 | yes |
| 7d | 0.79 | 1.8% | 1.15 | 0.62 | 1.0% | 0/48 | 1.00 | 0.79 | 1.8% | 10/48 | yes |

- Out-of-sample failing buckets (realized > priced), all horizons: **v2 34/240**, v1 1/240.
- Why 1h and 4h stay below the 0.5 loss-ratio target: at |z| < 2 the raw model over-predicts touches (realized / p about 0.6-0.9, table below) and k >= 1 by design cannot discount that, while the tail floor adds premium for the far levels the simulated book also sells. Reaching 0.5-0.8 there would need k < 1 near the money (a §7 change: 'model never prices below realized' would then hold only through q). Not done: reported instead, per D9 ('don't game them').
- The v2 failures are concentrated where the per-horizon diagnostic shows pooling is unfair: 7d at moderate z (2-4) and up-moves at large z for 1h-1d. Short horizons dominate the pooled counts, so the pooled table reflects them; v2b (separate table per horizon) halves the failures at a higher price.
- In-sample with the published v2 table: 233/256 buckets pass (not by construction: the table is fitted on pooled z buckets, not on these buckets).
- Pooled table: 38 of 38 z buckets have >= 30 windows; k ranges 1.00-10.00; q ranges 9.34e-05-0.863.
- Raw model: realized above predicted in 66 of 256 % buckets, significantly (Wilson 95 % lower bound above p) in 37.

### Alternative not adopted: v2b = pool coins, separate z table per horizon

Same method, but the z table is fitted per horizon (pooling only across coins). Shown because the per-horizon diagnostic below finds that the model's error at a given z differs by horizon.

| horizon | v2b: price x raw | v2b: loss ratio | v2b: max DD | v2b: failing buckets |
|---|---|---|---|---|
| 1h | 2.41 | 0.43 | 3.2% | 9/64 |
| 4h | 1.29 | 0.41 | 2.4% | 4/64 |
| 1d | 1.26 | 0.46 | 2.1% | 0/64 |
| 7d | 1.13 | 0.69 | 1.0% | 4/48 |

v2b failing buckets, all horizons: 17/240.

## Pooled z buckets (the published table)

Fitted on all windows (both halves). `realized / p` > 1 means the raw model under-predicts at that z.

| dir | abs z | windows | touches | realized | mean model p | realized / p | k | q |
|---|---|---|---|---|---|---|---|---|
| down | 0-0.25 | 1354 | 1143 | 8.44e-01 | 8.82e-01 | 0.96 | 1.00 | 8.60e-01 |
| down | 0.25-0.5 | 2132 | 1375 | 6.45e-01 | 7.12e-01 | 0.91 | 1.00 | 6.62e-01 |
| down | 0.5-0.75 | 2758 | 1162 | 4.21e-01 | 5.33e-01 | 0.79 | 1.00 | 4.37e-01 |
| down | 0.75-1 | 4243 | 1209 | 2.85e-01 | 3.98e-01 | 0.72 | 1.00 | 2.96e-01 |
| down | 1-1.25 | 4437 | 738 | 1.66e-01 | 2.66e-01 | 0.63 | 1.00 | 1.76e-01 |
| down | 1.25-1.5 | 4532 | 510 | 1.13e-01 | 1.71e-01 | 0.66 | 1.00 | 1.20e-01 |
| down | 1.5-1.75 | 6447 | 447 | 6.93e-02 | 1.08e-01 | 0.64 | 1.00 | 7.47e-02 |
| down | 1.75-2 | 3731 | 206 | 5.52e-02 | 6.38e-02 | 0.87 | 1.00 | 6.17e-02 |
| down | 2-2.25 | 4754 | 169 | 3.55e-02 | 3.50e-02 | 1.02 | 1.15 | 4.02e-02 |
| down | 2.25-2.5 | 4808 | 114 | 2.37e-02 | 1.86e-02 | 1.27 | 1.48 | 2.76e-02 |
| down | 2.5-2.75 | 3535 | 71 | 2.01e-02 | 8.81e-03 | 2.28 | 2.76 | 2.43e-02 |
| down | 2.75-3 | 3136 | 50 | 1.59e-02 | 4.26e-03 | 3.74 | 4.70 | 2.01e-02 |
| down | 3-3.25 | 3692 | 29 | 7.85e-03 | 1.87e-03 | 4.20 | 5.68 | 1.06e-02 |
| down | 3.25-3.5 | 3505 | 22 | 6.28e-03 | 7.71e-04 | 8.14 | 10.00 | 8.88e-03 |
| down | 3.5-3.75 | 2899 | 22 | 7.59e-03 | 3.14e-04 | 24.18 | 10.00 | 1.07e-02 |
| down | 3.75-4 | 2358 | 10 | 4.24e-03 | 1.09e-04 | 39.07 | 10.00 | 7.08e-03 |
| down | 4-5 | 11719 | 41 | 3.50e-03 | 1.66e-05 | 210.78 | 10.00 | 4.52e-03 |
| down | 5-7 | 16520 | 18 | 1.09e-03 | 6.27e-08 | 17380.58 | 10.00 | 1.60e-03 |
| down | >= 7 | 95440 | 4 | 4.19e-05 | 2.59e-14 | 1618317745.68 | 10.00 | 9.34e-05 |
| up | 0-0.25 | 1384 | 1173 | 8.48e-01 | 8.69e-01 | 0.98 | 1.00 | 8.63e-01 |
| up | 0.25-0.5 | 2213 | 1365 | 6.17e-01 | 6.97e-01 | 0.88 | 1.00 | 6.34e-01 |
| up | 0.5-0.75 | 2920 | 1178 | 4.03e-01 | 5.20e-01 | 0.78 | 1.00 | 4.18e-01 |
| up | 0.75-1 | 4361 | 1138 | 2.61e-01 | 3.89e-01 | 0.67 | 1.00 | 2.72e-01 |
| up | 1-1.25 | 4539 | 760 | 1.67e-01 | 2.60e-01 | 0.64 | 1.00 | 1.77e-01 |
| up | 1.25-1.5 | 4851 | 489 | 1.01e-01 | 1.66e-01 | 0.61 | 1.00 | 1.08e-01 |
| up | 1.5-1.75 | 6471 | 493 | 7.62e-02 | 1.06e-01 | 0.72 | 1.00 | 8.18e-02 |
| up | 1.75-2 | 3932 | 161 | 4.09e-02 | 6.07e-02 | 0.68 | 1.00 | 4.65e-02 |
| up | 2-2.25 | 5133 | 196 | 3.82e-02 | 3.35e-02 | 1.14 | 1.28 | 4.28e-02 |
| up | 2.25-2.5 | 4445 | 98 | 2.20e-02 | 1.82e-02 | 1.21 | 1.43 | 2.60e-02 |
| up | 2.5-2.75 | 3662 | 66 | 1.80e-02 | 8.51e-03 | 2.12 | 2.59 | 2.20e-02 |
| up | 2.75-3 | 3446 | 39 | 1.13e-02 | 4.07e-03 | 2.78 | 3.61 | 1.47e-02 |
| up | 3-3.25 | 3676 | 42 | 1.14e-02 | 1.82e-03 | 6.26 | 8.05 | 1.47e-02 |
| up | 3.25-3.5 | 3623 | 35 | 9.66e-03 | 7.75e-04 | 12.46 | 10.00 | 1.27e-02 |
| up | 3.5-3.75 | 2816 | 16 | 5.68e-03 | 2.95e-04 | 19.28 | 10.00 | 8.53e-03 |
| up | 3.75-4 | 3216 | 14 | 4.35e-03 | 1.05e-04 | 41.40 | 10.00 | 6.72e-03 |
| up | 4-5 | 11601 | 42 | 3.62e-03 | 1.51e-05 | 239.58 | 10.00 | 4.66e-03 |
| up | 5-7 | 17358 | 23 | 1.33e-03 | 6.00e-08 | 22077.39 | 10.00 | 1.86e-03 |
| up | >= 7 | 92353 | 17 | 1.84e-04 | 2.67e-14 | 6887177654.74 | 10.00 | 2.74e-04 |

## Per-horizon diagnostic (is pooling across horizons fair?)

Second half, priced with the table fitted on first halves. `actual / model` > 1: the raw model under-predicts in this horizon at this z; `pass` compares realized with the mean priced probability.

| horizon | dir | abs z | windows | touches | actual / model | realized | mean priced | pass |
|---|---|---|---|---|---|---|---|---|
| 1h | down | 0-1 | 562 | 140 | 0.62 | 2.49e-01 | 4.01e-01 | pass |
| 1h | down | 1-2 | 5611 | 469 | 0.57 | 8.36e-02 | 1.49e-01 | pass |
| 1h | down | 2-3 | 5543 | 117 | 1.18 | 2.11e-02 | 3.57e-02 | pass |
| 1h | down | 3-4 | 4454 | 27 | 6.41 | 6.06e-03 | 1.47e-02 | pass |
| 1h | down | 4-7 | 10106 | 22 | 384.68 | 2.18e-03 | 3.81e-03 | pass |
| 1h | down | >= 7 | 42236 | 1 | 987771914.28 | 2.37e-05 | 1.74e-04 | pass |
| 1h | up | 0-1 | 583 | 123 | 0.53 | 2.11e-01 | 3.98e-01 | pass |
| 1h | up | 1-2 | 5726 | 447 | 0.53 | 7.81e-02 | 1.47e-01 | pass |
| 1h | up | 2-3 | 5663 | 114 | 1.13 | 2.01e-02 | 3.42e-02 | pass |
| 1h | up | 3-4 | 4559 | 38 | 8.28 | 8.34e-03 | 1.43e-02 | pass |
| 1h | up | 4-7 | 10763 | 21 | 326.31 | 1.95e-03 | 3.25e-03 | pass |
| 1h | up | >= 7 | 41218 | 10 | 10074122393.96 | 2.43e-04 | 1.09e-04 | **FAIL** |
| 4h | down | 0-1 | 1543 | 498 | 0.67 | 3.23e-01 | 4.79e-01 | pass |
| 4h | down | 1-2 | 2505 | 210 | 0.51 | 8.38e-02 | 1.66e-01 | pass |
| 4h | down | 2-3 | 1952 | 34 | 0.99 | 1.74e-02 | 3.54e-02 | pass |
| 4h | down | 3-4 | 1282 | 4 | 4.70 | 3.12e-03 | 1.34e-02 | pass |
| 4h | down | 4-7 | 2960 | 1 | 46.05 | 3.38e-04 | 3.52e-03 | pass |
| 4h | down | >= 7 | 6878 | 0 | 0.00 | 0.00e+00 | 1.79e-04 | pass |
| 4h | up | 0-1 | 1575 | 506 | 0.68 | 3.21e-01 | 4.75e-01 | pass |
| 4h | up | 1-2 | 2553 | 230 | 0.55 | 9.01e-02 | 1.65e-01 | pass |
| 4h | up | 2-3 | 1981 | 44 | 1.21 | 2.22e-02 | 3.43e-02 | pass |
| 4h | up | 3-4 | 1549 | 15 | 15.11 | 9.68e-03 | 1.09e-02 | pass |
| 4h | up | 4-7 | 3047 | 9 | 522.09 | 2.95e-03 | 2.86e-03 | **FAIL** |
| 4h | up | >= 7 | 6415 | 4 | 18731280140.19 | 6.24e-04 | 1.16e-04 | **FAIL** |
| 1d | down | 0-1 | 851 | 389 | 0.78 | 4.57e-01 | 5.88e-01 | pass |
| 1d | down | 1-2 | 529 | 49 | 0.56 | 9.26e-02 | 1.68e-01 | pass |
| 1d | down | 2-3 | 367 | 0 | 0.00 | 0.00e+00 | 3.52e-02 | pass |
| 1d | down | 3-4 | 292 | 0 | 0.00 | 0.00e+00 | 1.40e-02 | pass |
| 1d | down | 4-7 | 486 | 0 | 0.00 | 0.00e+00 | 3.68e-03 | pass |
| 1d | down | >= 7 | 323 | 0 | 0.00 | 0.00e+00 | 2.26e-04 | pass |
| 1d | up | 0-1 | 879 | 409 | 0.81 | 4.65e-01 | 5.78e-01 | pass |
| 1d | up | 1-2 | 541 | 65 | 0.75 | 1.20e-01 | 1.61e-01 | pass |
| 1d | up | 2-3 | 416 | 14 | 1.89 | 3.37e-02 | 3.44e-02 | pass |
| 1d | up | 3-4 | 311 | 5 | 19.04 | 1.61e-02 | 1.29e-02 | **FAIL** |
| 1d | up | 4-7 | 513 | 5 | 1403.00 | 9.75e-03 | 3.37e-03 | **FAIL** |
| 1d | up | >= 7 | 188 | 2 | 77558867247.08 | 1.06e-02 | 1.46e-04 | **FAIL** |
| 7d | down | 0-1 | 1861 | 1272 | 0.96 | 6.84e-01 | 7.11e-01 | pass |
| 7d | down | 1-2 | 665 | 127 | 1.05 | 1.91e-01 | 1.82e-01 | **FAIL** |
| 7d | down | 2-3 | 253 | 22 | 4.00 | 8.70e-02 | 3.95e-02 | **FAIL** |
| 7d | down | 3-4 | 94 | 2 | 23.89 | 2.13e-02 | 1.46e-02 | **FAIL** |
| 7d | down | 4-7 | 55 | 0 | 0.00 | 0.00e+00 | 4.96e-03 | pass |
| 7d | up | 0-1 | 1978 | 1189 | 0.89 | 6.01e-01 | 6.84e-01 | pass |
| 7d | up | 1-2 | 671 | 100 | 0.91 | 1.49e-01 | 1.64e-01 | pass |
| 7d | up | 2-3 | 198 | 11 | 2.87 | 5.56e-02 | 3.68e-02 | **FAIL** |
| 7d | up | 3-4 | 61 | 1 | 18.57 | 1.64e-02 | 1.30e-02 | **FAIL** |
| 7d | up | 4-7 | 20 | 0 | 0.00 | 0.00e+00 | 5.02e-03 | pass |

## Findings in plain language

- **Near the money (|z| < 2) the model over-predicts:** 13547 touches where it expected 17626 (0.77x). Likely reasons (not tested separately): the 30-day realized floor keeps sigma high after volatile spells, and short-horizon returns mean-revert a little.
- **2 <= |z| < 4:** 993 touches vs 619.6 expected (1.60x).
- **The tail (|z| >= 4) is where GBM fails:** 145 touches in 244991 windows where the model expected 0.37. These are the flash moves liquidation cover exists for; the floor q prices them at their observed frequency (upper bound) instead of ~0.
- **Direction:** actual/expected 0.81 for down levels (long covers), 0.80 for up.
- **Per-horizon cells that fail with the pooled table** (out of sample): 1h up |z| >= 7 (10/41218 touched, priced 1.1e-04); 4h up |z| 4-7 (9/3047 touched, priced 2.9e-03); 4h up |z| >= 7 (4/6415 touched, priced 1.2e-04); 1d up |z| 3-4 (5/311 touched, priced 1.3e-02); 1d up |z| 4-7 (5/513 touched, priced 3.4e-03); 1d up |z| >= 7 (2/188 touched, priced 1.5e-04); 7d down |z| 1-2 (127/665 touched, priced 1.8e-01); 7d down |z| 2-3 (22/253 touched, priced 3.9e-02); 7d down |z| 3-4 (2/94 touched, priced 1.5e-02); 7d up |z| 2-3 (11/198 touched, priced 3.7e-02); 7d up |z| 3-4 (1/61 touched, priced 1.3e-02). Pooling across horizons is not perfectly fair there.
- **Out-of-sample % buckets failing with v2:** BTC 1h up 3.0% (realized 0.0019 > priced 0.0012); BTC 1h up 5.0% (realized 0.0005 > priced 0.0002); ETH 1h up 5.0% (realized 0.0019 > priced 0.0005); ETH 1h up 7.5% (realized 0.0005 > priced 0.0002); SOL 1h down 7.5% (realized 0.0005 > priced 0.0002); SOL 1h down 10.0% (realized 0.0005 > priced 0.0002); HYPE 1h down 10.0% (realized 0.0005 > priced 0.0003); HYPE 1h up 10.0% (realized 0.0005 > priced 0.0002); HYPE 1h up 15.0% (realized 0.0005 > priced 0.0001); BTC 4h up 3.0% (realized 0.0187 > priced 0.0151); BTC 4h up 7.5% (realized 0.0019 > priced 0.0004); ETH 4h up 5.0% (realized 0.0093 > priced 0.0073); ....

## Pool P&L simulation

At every window start the pool sells one cover per coin x direction x distance in {2.0%, 3.0%, 5.0%, 7.5%, 10.0%}, each paying 0.25% of the initial LP capital (at most 10% locked; no compounding), premium = payout x priced x (1 + 0.2), refused when priced > 0.5. Covers settle before the next window; no fees, no idle yield. `raw` = model p with the loading only, `v1` = per-bucket table, `v2` = pooled z table; OOS rows trade only the second half with tables fitted on the first half; `v2 in-sample` trades everything with the published table.

**How to read it.** Price and claims per 100 USDC of cover, the loss ratio (claims / premiums; the 20 % loading alone targets 0.83 for a perfectly calibrated model) and drawdown do not depend on how many covers are sold. LP P&L does: this book sells a full set of covers every window (24 sets a day for 1h covers), far more than real demand. Read LP P&L as an upper bound for that assumption.

| horizon | variant | days | windows | covers sold | refused | triggered | premium per 100 | claims per 100 | loss ratio | LP P&L | LP P&L per 30 d | max drawdown | worst window |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1h | raw, OOS half | 89 | 2141 | 85636 | 4 | 285 | 0.322 | 0.333 | 1.03 | -2.2% | -0.7% | 13.50% | -2.89% |
| 1h | v1 per-bucket, OOS half | 89 | 2141 | 85596 | 44 | 283 | 1.370 | 0.331 | 0.24 | +222.5% | +74.8% | 1.66% | -1.27% |
| 1h | v2 pooled z, OOS half | 89 | 2141 | 85636 | 4 | 285 | 0.743 | 0.333 | 0.45 | +87.9% | +29.6% | 3.29% | -2.02% |
| 1h | v2 pooled z, in-sample, full | 178 | 4282 | 171246 | 4 | 880 | 0.868 | 0.514 | 0.59 | +151.7% | +25.5% | 2.89% | -2.02% |
| 1h | v2b z per horizon, OOS half | 89 | 2141 | 85636 | 4 | 285 | 0.777 | 0.333 | 0.43 | +95.0% | +32.0% | 3.20% | -1.96% |
| 4h | raw, OOS half | 89 | 535 | 21351 | 49 | 429 | 3.811 | 2.009 | 0.53 | +96.2% | +32.4% | 3.07% | -2.35% |
| 4h | v1 per-bucket, OOS half | 89 | 535 | 21325 | 75 | 428 | 6.790 | 2.007 | 0.30 | +255.0% | +85.8% | 1.50% | -1.26% |
| 4h | v2 pooled z, OOS half | 89 | 535 | 21351 | 49 | 429 | 4.487 | 2.009 | 0.45 | +132.2% | +44.5% | 2.64% | -2.07% |
| 4h | v2 pooled z, in-sample, full | 178 | 1070 | 42644 | 146 | 1205 | 5.065 | 2.826 | 0.56 | +238.8% | +40.2% | 3.36% | -2.73% |
| 4h | v2b z per horizon, OOS half | 89 | 535 | 21351 | 49 | 429 | 4.935 | 2.009 | 0.41 | +156.1% | +52.5% | 2.41% | -1.92% |
| 1d | raw, OOS half | 89 | 89 | 3088 | 472 | 280 | 15.703 | 9.067 | 0.58 | +51.2% | +17.3% | 2.71% | -2.71% |
| 1d | v1 per-bucket, OOS half | 89 | 89 | 2898 | 662 | 224 | 22.236 | 7.729 | 0.35 | +105.1% | +35.4% | 1.27% | -1.27% |
| 1d | v2 pooled z, OOS half | 89 | 89 | 3088 | 472 | 280 | 16.489 | 9.067 | 0.55 | +57.3% | +19.3% | 2.60% | -2.60% |
| 1d | v2 pooled z, in-sample, full | 177 | 177 | 6064 | 1016 | 641 | 17.315 | 10.571 | 0.61 | +102.2% | +17.3% | 2.36% | -1.96% |
| 1d | v2b z per horizon, OOS half | 89 | 89 | 3088 | 472 | 280 | 19.852 | 9.067 | 0.46 | +83.3% | +28.1% | 2.14% | -2.14% |
| 7d | raw, OOS half | 644 | 92 | 1349 | 2311 | 386 | 36.000 | 28.614 | 0.79 | +24.9% | +1.2% | 1.79% | -1.33% |
| 7d | v1 per-bucket, OOS half | 644 | 92 | 887 | 2773 | 229 | 41.572 | 25.817 | 0.62 | +34.9% | +1.6% | 0.95% | -0.87% |
| 7d | v2 pooled z, OOS half | 644 | 92 | 1349 | 2311 | 386 | 36.128 | 28.614 | 0.79 | +25.3% | +1.2% | 1.76% | -1.31% |
| 7d | v2 pooled z, in-sample, full | 1281 | 183 | 2529 | 3851 | 715 | 35.364 | 28.272 | 0.80 | +44.8% | +1.1% | 2.17% | -1.37% |
| 7d | v2b z per horizon, OOS half | 644 | 92 | 1252 | 2408 | 352 | 40.764 | 28.115 | 0.69 | +39.6% | +1.8% | 0.98% | -0.78% |

## Expected vs actual touches (raw model)

| horizon | direction | windows x distances | expected (sum p) | actual | actual / expected |
|---|---|---|---|---|---|
| 1h | down | 137000 | 2763.1 | 2110 | 0.76 |
| 1h | up | 137000 | 2816.3 | 2029 | 0.72 |
| 4h | down | 34232 | 2607.5 | 1910 | 0.73 |
| 4h | up | 34232 | 2642.5 | 1912 | 0.72 |
| 1d | down | 5664 | 1247.7 | 994 | 0.80 |
| 1d | up | 5664 | 1261.2 | 1083 | 0.86 |
| 7d | down | 5104 | 2446.9 | 2326 | 0.95 |
| 7d | up | 5104 | 2460.3 | 2321 | 0.94 |

## Calibration table per coin / horizon / distance

`ratio` = realized / raw predicted (`sig` = significantly under-predicted). `v2 priced` = mean priced probability with the published pooled table. `OOS v1/v2` = out-of-sample result (second half).

| coin | hz | dir | dist | windows | touches | realized | predicted | ratio | v2 priced | OOS v1 | OOS v2 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| BTC | 1h | down | 1.0% | 4282 | 150 | 0.0350 | 3.88e-02 | 0.90 | 0.0479 | pass | pass |
| BTC | 1h | down | 2.0% | 4282 | 16 | 0.0037 | 1.71e-03 | 2.19 sig | 0.0063 | pass | pass |
| BTC | 1h | down | 3.0% | 4282 | 1 | 0.0002 | 1.28e-04 | 1.83 | 0.0013 | pass | pass |
| BTC | 1h | down | 5.0% | 4282 | 1 | 0.0002 | 2.52e-07 | 925.12 sig | 0.0002 | pass | pass |
| BTC | 1h | down | 7.5% | 4282 | 0 | 0.0000 | 8.76e-12 | 0.00 | 0.0001 | pass | pass |
| BTC | 1h | down | 10.0% | 4282 | 0 | 0.0000 | 9.27e-18 | 0.00 | 0.0001 | pass | pass |
| BTC | 1h | down | 15.0% | 4282 | 0 | 0.0000 | 2.44e-35 | 0.00 | 0.0001 | pass | pass |
| BTC | 1h | down | 20.0% | 4282 | 0 | 0.0000 | 6.75e-62 | 0.00 | 0.0001 | pass | pass |
| BTC | 1h | up | 1.0% | 4282 | 139 | 0.0325 | 3.99e-02 | 0.81 | 0.0486 | pass | pass |
| BTC | 1h | up | 2.0% | 4282 | 20 | 0.0047 | 1.85e-03 | 2.52 sig | 0.0068 | pass | pass |
| BTC | 1h | up | 3.0% | 4282 | 6 | 0.0014 | 1.57e-04 | 8.92 sig | 0.0018 | pass | **FAIL** |
| BTC | 1h | up | 5.0% | 4282 | 1 | 0.0002 | 5.49e-07 | 425.50 sig | 0.0004 | pass | **FAIL** |
| BTC | 1h | up | 7.5% | 4282 | 0 | 0.0000 | 9.08e-11 | 0.00 | 0.0003 | pass | pass |
| BTC | 1h | up | 10.0% | 4282 | 0 | 0.0000 | 1.97e-15 | 0.00 | 0.0003 | pass | pass |
| BTC | 1h | up | 15.0% | 4282 | 0 | 0.0000 | 1.50e-27 | 0.00 | 0.0003 | pass | pass |
| BTC | 1h | up | 20.0% | 4282 | 0 | 0.0000 | 3.46e-43 | 0.00 | 0.0003 | pass | pass |
| ETH | 1h | down | 1.0% | 4282 | 283 | 0.0661 | 1.02e-01 | 0.64 | 0.1051 | pass | pass |
| ETH | 1h | down | 2.0% | 4282 | 51 | 0.0119 | 6.57e-03 | 1.81 sig | 0.0153 | pass | pass |
| ETH | 1h | down | 3.0% | 4282 | 11 | 0.0026 | 8.40e-04 | 3.06 sig | 0.0041 | pass | pass |
| ETH | 1h | down | 5.0% | 4282 | 2 | 0.0005 | 1.51e-05 | 30.94 sig | 0.0005 | pass | pass |
| ETH | 1h | down | 7.5% | 4282 | 0 | 0.0000 | 5.18e-08 | 0.00 | 0.0001 | pass | pass |
| ETH | 1h | down | 10.0% | 4282 | 0 | 0.0000 | 3.51e-11 | 0.00 | 0.0001 | pass | pass |
| ETH | 1h | down | 15.0% | 4282 | 0 | 0.0000 | 2.47e-20 | 0.00 | 0.0001 | pass | pass |
| ETH | 1h | down | 20.0% | 4282 | 0 | 0.0000 | 5.39e-34 | 0.00 | 0.0001 | pass | pass |
| ETH | 1h | up | 1.0% | 4282 | 265 | 0.0619 | 1.04e-01 | 0.59 | 0.1069 | pass | pass |
| ETH | 1h | up | 2.0% | 4282 | 52 | 0.0121 | 7.06e-03 | 1.72 sig | 0.0163 | pass | pass |
| ETH | 1h | up | 3.0% | 4282 | 20 | 0.0047 | 9.68e-04 | 4.83 sig | 0.0047 | pass | pass |
| ETH | 1h | up | 5.0% | 4282 | 5 | 0.0012 | 2.35e-05 | 49.74 sig | 0.0008 | pass | **FAIL** |
| ETH | 1h | up | 7.5% | 4282 | 1 | 0.0002 | 1.76e-07 | 1324.16 sig | 0.0004 | pass | **FAIL** |
| ETH | 1h | up | 10.0% | 4282 | 0 | 0.0000 | 5.67e-10 | 0.00 | 0.0003 | pass | pass |
| ETH | 1h | up | 15.0% | 4282 | 0 | 0.0000 | 2.52e-16 | 0.00 | 0.0003 | pass | pass |
| ETH | 1h | up | 20.0% | 4282 | 0 | 0.0000 | 2.02e-24 | 0.00 | 0.0003 | pass | pass |
| SOL | 1h | down | 1.0% | 4282 | 389 | 0.0908 | 1.34e-01 | 0.68 | 0.1362 | pass | pass |
| SOL | 1h | down | 2.0% | 4282 | 67 | 0.0156 | 1.01e-02 | 1.55 sig | 0.0199 | pass | pass |
| SOL | 1h | down | 3.0% | 4282 | 17 | 0.0040 | 1.15e-03 | 3.45 sig | 0.0056 | pass | pass |
| SOL | 1h | down | 5.0% | 4282 | 2 | 0.0005 | 1.77e-05 | 26.34 sig | 0.0007 | pass | pass |
| SOL | 1h | down | 7.5% | 4282 | 1 | 0.0002 | 2.34e-08 | 9965.32 sig | 0.0002 | pass | **FAIL** |
| SOL | 1h | down | 10.0% | 4282 | 1 | 0.0002 | 4.74e-12 | 49272557.93 sig | 0.0001 | pass | **FAIL** |
| SOL | 1h | down | 15.0% | 4282 | 0 | 0.0000 | 2.37e-22 | 0.00 | 0.0001 | pass | pass |
| SOL | 1h | down | 20.0% | 4282 | 0 | 0.0000 | 1.40e-37 | 0.00 | 0.0001 | pass | pass |
| SOL | 1h | up | 1.0% | 4282 | 367 | 0.0857 | 1.36e-01 | 0.63 | 0.1383 | pass | pass |
| SOL | 1h | up | 2.0% | 4282 | 79 | 0.0184 | 1.09e-02 | 1.69 sig | 0.0208 | pass | pass |
| SOL | 1h | up | 3.0% | 4282 | 20 | 0.0047 | 1.33e-03 | 3.51 sig | 0.0062 | pass | pass |
| SOL | 1h | up | 5.0% | 4282 | 2 | 0.0005 | 2.90e-05 | 16.12 sig | 0.0011 | pass | pass |
| SOL | 1h | up | 7.5% | 4282 | 0 | 0.0000 | 1.01e-07 | 0.00 | 0.0004 | pass | pass |
| SOL | 1h | up | 10.0% | 4282 | 0 | 0.0000 | 1.19e-10 | 0.00 | 0.0003 | pass | pass |
| SOL | 1h | up | 15.0% | 4282 | 0 | 0.0000 | 7.27e-18 | 0.00 | 0.0003 | pass | pass |
| SOL | 1h | up | 20.0% | 4282 | 0 | 0.0000 | 6.73e-27 | 0.00 | 0.0003 | pass | pass |
| HYPE | 1h | down | 1.0% | 4279 | 856 | 0.2000 | 2.85e-01 | 0.70 | 0.2850 | pass | pass |
| HYPE | 1h | down | 2.0% | 4279 | 202 | 0.0472 | 5.44e-02 | 0.87 | 0.0619 | pass | pass |
| HYPE | 1h | down | 3.0% | 4279 | 53 | 0.0124 | 9.87e-03 | 1.26 sig | 0.0184 | pass | pass |
| HYPE | 1h | down | 5.0% | 4279 | 4 | 0.0009 | 4.66e-04 | 2.01 | 0.0036 | pass | pass |
| HYPE | 1h | down | 7.5% | 4279 | 2 | 0.0005 | 1.80e-05 | 25.95 sig | 0.0007 | pass | pass |
| HYPE | 1h | down | 10.0% | 4279 | 1 | 0.0002 | 5.93e-07 | 394.07 sig | 0.0002 | pass | **FAIL** |
| HYPE | 1h | down | 15.0% | 4279 | 0 | 0.0000 | 8.78e-11 | 0.00 | 0.0001 | pass | pass |
| HYPE | 1h | down | 20.0% | 4279 | 0 | 0.0000 | 3.02e-16 | 0.00 | 0.0001 | pass | pass |
| HYPE | 1h | up | 1.0% | 4279 | 807 | 0.1886 | 2.87e-01 | 0.66 | 0.2866 | pass | pass |
| HYPE | 1h | up | 2.0% | 4279 | 191 | 0.0446 | 5.70e-02 | 0.78 | 0.0642 | pass | pass |
| HYPE | 1h | up | 3.0% | 4279 | 47 | 0.0110 | 1.11e-02 | 0.99 | 0.0197 | pass | pass |
| HYPE | 1h | up | 5.0% | 4279 | 4 | 0.0009 | 6.16e-04 | 1.52 | 0.0043 | pass | pass |
| HYPE | 1h | up | 7.5% | 4279 | 1 | 0.0002 | 3.29e-05 | 7.10 sig | 0.0012 | pass | pass |
| HYPE | 1h | up | 10.0% | 4279 | 1 | 0.0002 | 1.96e-06 | 119.04 sig | 0.0005 | pass | **FAIL** |
| HYPE | 1h | up | 15.0% | 4279 | 1 | 0.0002 | 3.56e-09 | 65619.62 sig | 0.0003 | pass | **FAIL** |
| HYPE | 1h | up | 20.0% | 4279 | 0 | 0.0000 | 1.76e-12 | 0.00 | 0.0003 | pass | pass |
| BTC | 4h | down | 1.0% | 1070 | 176 | 0.1645 | 2.58e-01 | 0.64 | 0.2576 | pass | pass |
| BTC | 4h | down | 2.0% | 1070 | 32 | 0.0299 | 3.83e-02 | 0.78 | 0.0475 | pass | pass |
| BTC | 4h | down | 3.0% | 1070 | 6 | 0.0056 | 6.50e-03 | 0.86 | 0.0150 | pass | pass |
| BTC | 4h | down | 5.0% | 1070 | 1 | 0.0009 | 4.38e-04 | 2.13 | 0.0027 | pass | pass |
| BTC | 4h | down | 7.5% | 1070 | 0 | 0.0000 | 1.17e-05 | 0.00 | 0.0004 | pass | pass |
| BTC | 4h | down | 10.0% | 1070 | 0 | 0.0000 | 1.51e-07 | 0.00 | 0.0002 | pass | pass |
| BTC | 4h | down | 15.0% | 1070 | 0 | 0.0000 | 1.59e-12 | 0.00 | 0.0001 | pass | pass |
| BTC | 4h | down | 20.0% | 1070 | 0 | 0.0000 | 1.10e-19 | 0.00 | 0.0001 | pass | pass |
| BTC | 4h | up | 1.0% | 1070 | 158 | 0.1477 | 2.59e-01 | 0.57 | 0.2594 | pass | pass |
| BTC | 4h | up | 2.0% | 1070 | 37 | 0.0346 | 4.05e-02 | 0.85 | 0.0492 | pass | pass |
| BTC | 4h | up | 3.0% | 1070 | 16 | 0.0150 | 7.23e-03 | 2.07 sig | 0.0167 | pass | **FAIL** |
| BTC | 4h | up | 5.0% | 1070 | 2 | 0.0019 | 5.71e-04 | 3.28 sig | 0.0035 | pass | pass |
| BTC | 4h | up | 7.5% | 1070 | 1 | 0.0009 | 2.46e-05 | 38.01 sig | 0.0008 | pass | **FAIL** |
| BTC | 4h | up | 10.0% | 1070 | 0 | 0.0000 | 7.31e-07 | 0.00 | 0.0004 | pass | pass |
| BTC | 4h | up | 15.0% | 1070 | 0 | 0.0000 | 2.03e-10 | 0.00 | 0.0003 | pass | pass |
| BTC | 4h | up | 20.0% | 1070 | 0 | 0.0000 | 1.03e-14 | 0.00 | 0.0003 | pass | pass |
| ETH | 4h | down | 1.0% | 1070 | 273 | 0.2551 | 3.91e-01 | 0.65 | 0.3908 | pass | pass |
| ETH | 4h | down | 2.0% | 1070 | 80 | 0.0748 | 1.02e-01 | 0.74 | 0.1042 | pass | pass |
| ETH | 4h | down | 3.0% | 1070 | 20 | 0.0187 | 2.31e-02 | 0.81 | 0.0344 | pass | pass |
| ETH | 4h | down | 5.0% | 1070 | 5 | 0.0047 | 2.09e-03 | 2.23 sig | 0.0073 | pass | pass |
| ETH | 4h | down | 7.5% | 1070 | 0 | 0.0000 | 1.55e-04 | 0.00 | 0.0016 | pass | pass |
| ETH | 4h | down | 10.0% | 1070 | 0 | 0.0000 | 9.66e-06 | 0.00 | 0.0004 | pass | pass |
| ETH | 4h | down | 15.0% | 1070 | 0 | 0.0000 | 1.54e-08 | 0.00 | 0.0001 | pass | pass |
| ETH | 4h | down | 20.0% | 1070 | 0 | 0.0000 | 2.42e-12 | 0.00 | 0.0001 | pass | pass |
| ETH | 4h | up | 1.0% | 1070 | 256 | 0.2393 | 3.91e-01 | 0.61 | 0.3914 | pass | pass |
| ETH | 4h | up | 2.0% | 1070 | 72 | 0.0673 | 1.05e-01 | 0.64 | 0.1078 | pass | pass |
| ETH | 4h | up | 3.0% | 1070 | 24 | 0.0224 | 2.54e-02 | 0.88 | 0.0357 | pass | pass |
| ETH | 4h | up | 5.0% | 1070 | 8 | 0.0075 | 2.56e-03 | 2.93 sig | 0.0085 | pass | **FAIL** |
| ETH | 4h | up | 7.5% | 1070 | 4 | 0.0037 | 2.52e-04 | 14.83 sig | 0.0024 | pass | **FAIL** |
| ETH | 4h | up | 10.0% | 1070 | 2 | 0.0019 | 2.46e-05 | 75.87 sig | 0.0008 | pass | **FAIL** |
| ETH | 4h | up | 15.0% | 1070 | 0 | 0.0000 | 2.04e-07 | 0.00 | 0.0004 | pass | pass |
| ETH | 4h | up | 20.0% | 1070 | 0 | 0.0000 | 9.47e-10 | 0.00 | 0.0003 | pass | pass |
| SOL | 4h | down | 1.0% | 1070 | 327 | 0.3056 | 4.29e-01 | 0.71 | 0.4290 | pass | pass |
| SOL | 4h | down | 2.0% | 1070 | 110 | 0.1028 | 1.33e-01 | 0.77 | 0.1353 | pass | pass |
| SOL | 4h | down | 3.0% | 1070 | 34 | 0.0318 | 3.54e-02 | 0.90 | 0.0442 | pass | pass |
| SOL | 4h | down | 5.0% | 1070 | 4 | 0.0037 | 2.98e-03 | 1.26 | 0.0098 | pass | pass |
| SOL | 4h | down | 7.5% | 1070 | 1 | 0.0009 | 2.20e-04 | 4.26 | 0.0023 | pass | pass |
| SOL | 4h | down | 10.0% | 1070 | 0 | 0.0000 | 1.27e-05 | 0.00 | 0.0006 | pass | pass |
| SOL | 4h | down | 15.0% | 1070 | 0 | 0.0000 | 8.30e-09 | 0.00 | 0.0001 | pass | pass |
| SOL | 4h | down | 20.0% | 1070 | 0 | 0.0000 | 4.17e-13 | 0.00 | 0.0001 | pass | pass |
| SOL | 4h | up | 1.0% | 1070 | 314 | 0.2935 | 4.29e-01 | 0.68 | 0.4292 | pass | pass |
| SOL | 4h | up | 2.0% | 1070 | 97 | 0.0907 | 1.37e-01 | 0.66 | 0.1393 | pass | pass |
| SOL | 4h | up | 3.0% | 1070 | 46 | 0.0430 | 3.87e-02 | 1.11 | 0.0469 | pass | pass |
| SOL | 4h | up | 5.0% | 1070 | 12 | 0.0112 | 3.70e-03 | 3.03 sig | 0.0112 | pass | **FAIL** |
| SOL | 4h | up | 7.5% | 1070 | 0 | 0.0000 | 3.53e-04 | 0.00 | 0.0033 | pass | pass |
| SOL | 4h | up | 10.0% | 1070 | 0 | 0.0000 | 3.44e-05 | 0.00 | 0.0012 | pass | pass |
| SOL | 4h | up | 15.0% | 1070 | 0 | 0.0000 | 1.68e-07 | 0.00 | 0.0004 | pass | pass |
| SOL | 4h | up | 20.0% | 1070 | 0 | 0.0000 | 3.50e-10 | 0.00 | 0.0003 | pass | pass |
| HYPE | 4h | down | 1.0% | 1069 | 522 | 0.4883 | 5.82e-01 | 0.84 | 0.5817 | pass | pass |
| HYPE | 4h | down | 2.0% | 1069 | 211 | 0.1974 | 2.84e-01 | 0.69 | 0.2843 | pass | pass |
| HYPE | 4h | down | 3.0% | 1069 | 88 | 0.0823 | 1.25e-01 | 0.66 | 0.1284 | pass | pass |
| HYPE | 4h | down | 5.0% | 1069 | 17 | 0.0159 | 2.22e-02 | 0.72 | 0.0314 | pass | pass |
| HYPE | 4h | down | 7.5% | 1069 | 2 | 0.0019 | 2.70e-03 | 0.69 | 0.0088 | pass | pass |
| HYPE | 4h | down | 10.0% | 1069 | 1 | 0.0009 | 4.41e-04 | 2.12 | 0.0033 | pass | pass |
| HYPE | 4h | down | 15.0% | 1069 | 0 | 0.0000 | 1.69e-05 | 0.00 | 0.0006 | pass | pass |
| HYPE | 4h | down | 20.0% | 1069 | 0 | 0.0000 | 4.57e-07 | 0.00 | 0.0002 | pass | pass |
| HYPE | 4h | up | 1.0% | 1069 | 521 | 0.4874 | 5.80e-01 | 0.84 | 0.5796 | pass | pass |
| HYPE | 4h | up | 2.0% | 1069 | 217 | 0.2030 | 2.87e-01 | 0.71 | 0.2874 | pass | pass |
| HYPE | 4h | up | 3.0% | 1069 | 97 | 0.0907 | 1.31e-01 | 0.69 | 0.1338 | pass | pass |
| HYPE | 4h | up | 5.0% | 1069 | 20 | 0.0187 | 2.60e-02 | 0.72 | 0.0342 | pass | pass |
| HYPE | 4h | up | 7.5% | 1069 | 5 | 0.0047 | 3.83e-03 | 1.22 | 0.0108 | pass | pass |
| HYPE | 4h | up | 10.0% | 1069 | 2 | 0.0019 | 7.50e-04 | 2.50 | 0.0047 | pass | pass |
| HYPE | 4h | up | 15.0% | 1069 | 1 | 0.0009 | 5.26e-05 | 17.78 sig | 0.0013 | pass | **FAIL** |
| HYPE | 4h | up | 20.0% | 1069 | 0 | 0.0000 | 4.56e-06 | 0.00 | 0.0005 | pass | pass |
| BTC | 1d | down | 1.0% | 177 | 94 | 0.5311 | 6.38e-01 | 0.83 | 0.6382 | pass | pass |
| BTC | 1d | down | 2.0% | 177 | 47 | 0.2655 | 3.52e-01 | 0.75 | 0.3524 | pass | pass |
| BTC | 1d | down | 3.0% | 177 | 20 | 0.1130 | 1.73e-01 | 0.65 | 0.1732 | pass | pass |
| BTC | 1d | down | 5.0% | 177 | 3 | 0.0169 | 3.44e-02 | 0.49 | 0.0437 | pass | pass |
| BTC | 1d | down | 7.5% | 177 | 0 | 0.0000 | 5.27e-03 | 0.00 | 0.0135 | pass | pass |
| BTC | 1d | down | 10.0% | 177 | 0 | 0.0000 | 1.13e-03 | 0.00 | 0.0051 | pass | pass |
| BTC | 1d | down | 15.0% | 177 | 0 | 0.0000 | 5.02e-05 | 0.00 | 0.0009 | pass | pass |
| BTC | 1d | down | 20.0% | 177 | 0 | 0.0000 | 9.35e-07 | 0.00 | 0.0003 | pass | pass |
| BTC | 1d | up | 1.0% | 177 | 94 | 0.5311 | 6.35e-01 | 0.84 | 0.6352 | pass | pass |
| BTC | 1d | up | 2.0% | 177 | 42 | 0.2373 | 3.54e-01 | 0.67 | 0.3545 | pass | pass |
| BTC | 1d | up | 3.0% | 177 | 21 | 0.1186 | 1.79e-01 | 0.66 | 0.1796 | pass | pass |
| BTC | 1d | up | 5.0% | 177 | 9 | 0.0508 | 3.99e-02 | 1.28 | 0.0486 | pass | **FAIL** |
| BTC | 1d | up | 7.5% | 177 | 3 | 0.0169 | 7.02e-03 | 2.41 | 0.0165 | **FAIL** | **FAIL** |
| BTC | 1d | up | 10.0% | 177 | 0 | 0.0000 | 1.76e-03 | 0.00 | 0.0071 | pass | pass |
| BTC | 1d | up | 15.0% | 177 | 0 | 0.0000 | 1.58e-04 | 0.00 | 0.0020 | pass | pass |
| BTC | 1d | up | 20.0% | 177 | 0 | 0.0000 | 1.26e-05 | 0.00 | 0.0007 | pass | pass |
| ETH | 1d | down | 1.0% | 177 | 106 | 0.5989 | 7.28e-01 | 0.82 | 0.7276 | pass | pass |
| ETH | 1d | down | 2.0% | 177 | 71 | 0.4011 | 4.87e-01 | 0.82 | 0.4871 | pass | pass |
| ETH | 1d | down | 3.0% | 177 | 40 | 0.2260 | 3.02e-01 | 0.75 | 0.3019 | pass | pass |
| ETH | 1d | down | 5.0% | 177 | 8 | 0.0452 | 9.79e-02 | 0.46 | 0.1008 | pass | pass |
| ETH | 1d | down | 7.5% | 177 | 2 | 0.0113 | 2.21e-02 | 0.51 | 0.0332 | pass | pass |
| ETH | 1d | down | 10.0% | 177 | 1 | 0.0056 | 6.03e-03 | 0.94 | 0.0139 | pass | pass |
| ETH | 1d | down | 15.0% | 177 | 0 | 0.0000 | 7.32e-04 | 0.00 | 0.0035 | pass | pass |
| ETH | 1d | down | 20.0% | 177 | 0 | 0.0000 | 1.02e-04 | 0.00 | 0.0009 | pass | pass |
| ETH | 1d | up | 1.0% | 177 | 113 | 0.6384 | 7.23e-01 | 0.88 | 0.7230 | pass | pass |
| ETH | 1d | up | 2.0% | 177 | 68 | 0.3842 | 4.86e-01 | 0.79 | 0.4859 | pass | pass |
| ETH | 1d | up | 3.0% | 177 | 32 | 0.1808 | 3.06e-01 | 0.59 | 0.3064 | pass | pass |
| ETH | 1d | up | 5.0% | 177 | 13 | 0.0734 | 1.07e-01 | 0.68 | 0.1098 | pass | pass |
| ETH | 1d | up | 7.5% | 177 | 7 | 0.0395 | 2.78e-02 | 1.42 | 0.0379 | pass | **FAIL** |
| ETH | 1d | up | 10.0% | 177 | 1 | 0.0056 | 8.53e-03 | 0.66 | 0.0181 | pass | pass |
| ETH | 1d | up | 15.0% | 177 | 1 | 0.0056 | 1.40e-03 | 4.04 | 0.0057 | pass | **FAIL** |
| ETH | 1d | up | 20.0% | 177 | 1 | 0.0056 | 3.17e-04 | 17.80 sig | 0.0024 | pass | **FAIL** |
| SOL | 1d | down | 1.0% | 177 | 122 | 0.6893 | 7.46e-01 | 0.92 | 0.7463 | pass | pass |
| SOL | 1d | down | 2.0% | 177 | 79 | 0.4463 | 5.19e-01 | 0.86 | 0.5193 | pass | pass |
| SOL | 1d | down | 3.0% | 177 | 46 | 0.2599 | 3.39e-01 | 0.77 | 0.3395 | pass | pass |
| SOL | 1d | down | 5.0% | 177 | 13 | 0.0734 | 1.26e-01 | 0.58 | 0.1284 | pass | pass |
| SOL | 1d | down | 7.5% | 177 | 2 | 0.0113 | 3.11e-02 | 0.36 | 0.0402 | pass | pass |
| SOL | 1d | down | 10.0% | 177 | 2 | 0.0113 | 7.45e-03 | 1.52 | 0.0166 | pass | pass |
| SOL | 1d | down | 15.0% | 177 | 0 | 0.0000 | 5.28e-04 | 0.00 | 0.0041 | pass | pass |
| SOL | 1d | down | 20.0% | 177 | 0 | 0.0000 | 3.66e-05 | 0.00 | 0.0012 | pass | pass |
| SOL | 1d | up | 1.0% | 177 | 121 | 0.6836 | 7.41e-01 | 0.92 | 0.7413 | pass | pass |
| SOL | 1d | up | 2.0% | 177 | 71 | 0.4011 | 5.17e-01 | 0.78 | 0.5171 | pass | pass |
| SOL | 1d | up | 3.0% | 177 | 47 | 0.2655 | 3.43e-01 | 0.77 | 0.3428 | pass | pass |
| SOL | 1d | up | 5.0% | 177 | 22 | 0.1243 | 1.36e-01 | 0.91 | 0.1382 | pass | pass |
| SOL | 1d | up | 7.5% | 177 | 9 | 0.0508 | 3.90e-02 | 1.30 | 0.0472 | pass | **FAIL** |
| SOL | 1d | up | 10.0% | 177 | 2 | 0.0113 | 1.13e-02 | 1.00 | 0.0213 | pass | **FAIL** |
| SOL | 1d | up | 15.0% | 177 | 0 | 0.0000 | 1.26e-03 | 0.00 | 0.0068 | pass | pass |
| SOL | 1d | up | 20.0% | 177 | 0 | 0.0000 | 1.87e-04 | 0.00 | 0.0030 | pass | pass |
| HYPE | 1d | down | 1.0% | 177 | 137 | 0.7740 | 8.24e-01 | 0.94 | 0.8241 | pass | pass |
| HYPE | 1d | down | 2.0% | 177 | 92 | 0.5198 | 6.56e-01 | 0.79 | 0.6559 | pass | pass |
| HYPE | 1d | down | 3.0% | 177 | 69 | 0.3898 | 5.05e-01 | 0.77 | 0.5051 | pass | pass |
| HYPE | 1d | down | 5.0% | 177 | 28 | 0.1582 | 2.76e-01 | 0.57 | 0.2755 | pass | pass |
| HYPE | 1d | down | 7.5% | 177 | 8 | 0.0452 | 1.16e-01 | 0.39 | 0.1203 | pass | pass |
| HYPE | 1d | down | 10.0% | 177 | 3 | 0.0169 | 4.65e-02 | 0.36 | 0.0542 | pass | pass |
| HYPE | 1d | down | 15.0% | 177 | 1 | 0.0056 | 7.04e-03 | 0.80 | 0.0161 | pass | pass |
| HYPE | 1d | down | 20.0% | 177 | 0 | 0.0000 | 1.28e-03 | 0.00 | 0.0059 | pass | pass |
| HYPE | 1d | up | 1.0% | 177 | 140 | 0.7910 | 8.18e-01 | 0.97 | 0.8176 | pass | pass |
| HYPE | 1d | up | 2.0% | 177 | 105 | 0.5932 | 6.49e-01 | 0.91 | 0.6492 | pass | pass |
| HYPE | 1d | up | 3.0% | 177 | 78 | 0.4407 | 5.02e-01 | 0.88 | 0.5023 | pass | pass |
| HYPE | 1d | up | 5.0% | 177 | 48 | 0.2712 | 2.83e-01 | 0.96 | 0.2834 | pass | pass |
| HYPE | 1d | up | 7.5% | 177 | 22 | 0.1243 | 1.31e-01 | 0.95 | 0.1332 | pass | pass |
| HYPE | 1d | up | 10.0% | 177 | 9 | 0.0508 | 5.93e-02 | 0.86 | 0.0663 | pass | pass |
| HYPE | 1d | up | 15.0% | 177 | 3 | 0.0169 | 1.28e-02 | 1.33 | 0.0219 | pass | pass |
| HYPE | 1d | up | 20.0% | 177 | 1 | 0.0056 | 3.20e-03 | 1.76 | 0.0101 | pass | **FAIL** |
| BTC | 7d | down | 1.0% | 183 | 158 | 0.8634 | 8.70e-01 | 0.99 | 0.8704 | pass | pass |
| BTC | 7d | down | 2.0% | 183 | 136 | 0.7432 | 7.43e-01 | 1.00 | 0.7430 | pass | **FAIL** |
| BTC | 7d | down | 3.0% | 183 | 103 | 0.5628 | 6.22e-01 | 0.90 | 0.6221 | pass | **FAIL** |
| BTC | 7d | down | 5.0% | 183 | 66 | 0.3607 | 4.13e-01 | 0.87 | 0.4129 | pass | pass |
| BTC | 7d | down | 7.5% | 183 | 34 | 0.1858 | 2.27e-01 | 0.82 | 0.2269 | pass | pass |
| BTC | 7d | down | 10.0% | 183 | 19 | 0.1038 | 1.15e-01 | 0.90 | 0.1182 | pass | **FAIL** |
| BTC | 7d | down | 15.0% | 183 | 8 | 0.0437 | 2.54e-02 | 1.72 | 0.0350 | pass | **FAIL** |
| BTC | 7d | down | 20.0% | 183 | 1 | 0.0055 | 4.89e-03 | 1.12 | 0.0131 | pass | pass |
| BTC | 7d | up | 1.0% | 183 | 156 | 0.8525 | 8.63e-01 | 0.99 | 0.8631 | pass | pass |
| BTC | 7d | up | 2.0% | 183 | 132 | 0.7213 | 7.33e-01 | 0.98 | 0.7332 | pass | pass |
| BTC | 7d | up | 3.0% | 183 | 102 | 0.5574 | 6.14e-01 | 0.91 | 0.6138 | pass | pass |
| BTC | 7d | up | 5.0% | 183 | 72 | 0.3934 | 4.14e-01 | 0.95 | 0.4144 | pass | pass |
| BTC | 7d | up | 7.5% | 183 | 42 | 0.2295 | 2.41e-01 | 0.95 | 0.2409 | pass | pass |
| BTC | 7d | up | 10.0% | 183 | 23 | 0.1257 | 1.35e-01 | 0.93 | 0.1369 | pass | pass |
| BTC | 7d | up | 15.0% | 183 | 7 | 0.0383 | 4.07e-02 | 0.94 | 0.0485 | pass | pass |
| BTC | 7d | up | 20.0% | 183 | 4 | 0.0219 | 1.24e-02 | 1.76 | 0.0219 | pass | pass |
| ETH | 7d | down | 1.0% | 183 | 159 | 0.8689 | 9.06e-01 | 0.96 | 0.9056 | pass | pass |
| ETH | 7d | down | 2.0% | 183 | 142 | 0.7760 | 8.11e-01 | 0.96 | 0.8114 | pass | pass |
| ETH | 7d | down | 3.0% | 183 | 124 | 0.6776 | 7.19e-01 | 0.94 | 0.7193 | pass | pass |
| ETH | 7d | down | 5.0% | 183 | 90 | 0.4918 | 5.49e-01 | 0.90 | 0.5486 | pass | pass |
| ETH | 7d | down | 7.5% | 183 | 62 | 0.3388 | 3.71e-01 | 0.91 | 0.3715 | pass | pass |
| ETH | 7d | down | 10.0% | 183 | 42 | 0.2295 | 2.39e-01 | 0.96 | 0.2399 | pass | **FAIL** |
| ETH | 7d | down | 15.0% | 183 | 17 | 0.0929 | 8.70e-02 | 1.07 | 0.0911 | pass | **FAIL** |
| ETH | 7d | down | 20.0% | 183 | 10 | 0.0546 | 2.71e-02 | 2.02 sig | 0.0359 | pass | **FAIL** |
| ETH | 7d | up | 1.0% | 183 | 161 | 0.8798 | 8.98e-01 | 0.98 | 0.8975 | pass | pass |
| ETH | 7d | up | 2.0% | 183 | 132 | 0.7213 | 7.99e-01 | 0.90 | 0.7990 | pass | pass |
| ETH | 7d | up | 3.0% | 183 | 109 | 0.5956 | 7.06e-01 | 0.84 | 0.7060 | pass | pass |
| ETH | 7d | up | 5.0% | 183 | 85 | 0.4645 | 5.41e-01 | 0.86 | 0.5407 | pass | pass |
| ETH | 7d | up | 7.5% | 183 | 60 | 0.3279 | 3.77e-01 | 0.87 | 0.3766 | pass | pass |
| ETH | 7d | up | 10.0% | 183 | 38 | 0.2077 | 2.57e-01 | 0.81 | 0.2569 | pass | pass |
| ETH | 7d | up | 15.0% | 183 | 17 | 0.0929 | 1.15e-01 | 0.81 | 0.1177 | pass | pass |
| ETH | 7d | up | 20.0% | 183 | 7 | 0.0383 | 5.00e-02 | 0.77 | 0.0563 | pass | pass |
| SOL | 7d | down | 1.0% | 182 | 163 | 0.8956 | 9.28e-01 | 0.97 | 0.9280 | pass | **FAIL** |
| SOL | 7d | down | 2.0% | 182 | 147 | 0.8077 | 8.56e-01 | 0.94 | 0.8555 | pass | pass |
| SOL | 7d | down | 3.0% | 182 | 132 | 0.7253 | 7.83e-01 | 0.93 | 0.7833 | pass | pass |
| SOL | 7d | down | 5.0% | 182 | 110 | 0.6044 | 6.43e-01 | 0.94 | 0.6433 | pass | pass |
| SOL | 7d | down | 7.5% | 182 | 78 | 0.4286 | 4.84e-01 | 0.89 | 0.4842 | pass | pass |
| SOL | 7d | down | 10.0% | 182 | 62 | 0.3407 | 3.50e-01 | 0.97 | 0.3501 | pass | **FAIL** |
| SOL | 7d | down | 15.0% | 182 | 25 | 0.1374 | 1.64e-01 | 0.84 | 0.1652 | pass | pass |
| SOL | 7d | down | 20.0% | 182 | 13 | 0.0714 | 6.80e-02 | 1.05 | 0.0743 | pass | **FAIL** |
| SOL | 7d | up | 1.0% | 182 | 169 | 0.9286 | 9.20e-01 | 1.01 | 0.9196 | pass | pass |
| SOL | 7d | up | 2.0% | 182 | 153 | 0.8407 | 8.42e-01 | 1.00 | 0.8415 | pass | pass |
| SOL | 7d | up | 3.0% | 182 | 132 | 0.7253 | 7.67e-01 | 0.95 | 0.7666 | pass | pass |
| SOL | 7d | up | 5.0% | 182 | 104 | 0.5714 | 6.28e-01 | 0.91 | 0.6281 | pass | pass |
| SOL | 7d | up | 7.5% | 182 | 81 | 0.4451 | 4.80e-01 | 0.93 | 0.4797 | pass | pass |
| SOL | 7d | up | 10.0% | 182 | 61 | 0.3352 | 3.60e-01 | 0.93 | 0.3597 | pass | pass |
| SOL | 7d | up | 15.0% | 182 | 37 | 0.2033 | 1.95e-01 | 1.04 | 0.1956 | pass | pass |
| SOL | 7d | up | 20.0% | 182 | 22 | 0.1209 | 1.03e-01 | 1.17 | 0.1062 | pass | pass |
| HYPE | 7d | down | 1.0% | 90 | 85 | 0.9444 | 9.45e-01 | 1.00 | 0.9453 |  |  |
| HYPE | 7d | down | 2.0% | 90 | 74 | 0.8222 | 8.90e-01 | 0.92 | 0.8899 |  |  |
| HYPE | 7d | down | 3.0% | 90 | 73 | 0.8111 | 8.34e-01 | 0.97 | 0.8342 |  |  |
| HYPE | 7d | down | 5.0% | 90 | 61 | 0.6778 | 7.23e-01 | 0.94 | 0.7233 |  |  |
| HYPE | 7d | down | 7.5% | 90 | 51 | 0.5667 | 5.90e-01 | 0.96 | 0.5899 |  |  |
| HYPE | 7d | down | 10.0% | 90 | 41 | 0.4556 | 4.67e-01 | 0.97 | 0.4674 |  |  |
| HYPE | 7d | down | 15.0% | 90 | 24 | 0.2667 | 2.69e-01 | 0.99 | 0.2688 |  |  |
| HYPE | 7d | down | 20.0% | 90 | 16 | 0.1778 | 1.38e-01 | 1.29 | 0.1396 |  |  |
| HYPE | 7d | up | 1.0% | 90 | 81 | 0.9000 | 9.36e-01 | 0.96 | 0.9365 |  |  |
| HYPE | 7d | up | 2.0% | 90 | 76 | 0.8444 | 8.75e-01 | 0.97 | 0.8746 |  |  |
| HYPE | 7d | up | 3.0% | 90 | 70 | 0.7778 | 8.15e-01 | 0.95 | 0.8146 |  |  |
| HYPE | 7d | up | 5.0% | 90 | 59 | 0.6556 | 7.01e-01 | 0.93 | 0.7013 |  |  |
| HYPE | 7d | up | 7.5% | 90 | 48 | 0.5333 | 5.74e-01 | 0.93 | 0.5741 |  |  |
| HYPE | 7d | up | 10.0% | 90 | 37 | 0.4111 | 4.64e-01 | 0.89 | 0.4640 |  |  |
| HYPE | 7d | up | 15.0% | 90 | 25 | 0.2778 | 2.94e-01 | 0.94 | 0.2942 |  |  |
| HYPE | 7d | up | 20.0% | 90 | 19 | 0.2111 | 1.81e-01 | 1.16 | 0.1820 |  |  |

## Limitations

- Trade-price candles approximate the oracle (see method). Oracle minute history exists only in a requester-pays S3 archive and was not used.
- 1h history is ~7 months for every coin: essentially one market regime. 7d windows span 2023-2026.
- Windows are not independent (the same window at 8 distances; correlated coins; volatility clustering). Wilson bounds treat them as independent, so true uncertainty is larger, and the pooled buckets look more certain than they are.
- Pooling assumes the model's error depends on z, not on the horizon or coin. The per-horizon diagnostic shows where that is not true; such cells need a horizon-specific adjustment or more data.
- The table is point-in-time; it must be refitted on a schedule and the out-of-sample pass rate tracked.
