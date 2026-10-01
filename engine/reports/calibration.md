# Calibration backtest: one-touch model on Hyperliquid history

Generated 2026-10-01T18:44Z by `python -m numera_engine.backtest --coins BTC ETH SOL HYPE` (model `gbm-touch-v1`, tail table `z-per-horizon-v4`, decisions D9, D11, D13). Source: Hyperliquid mainnet Info API `candleSnapshot`, read-only. Files: `calibration.csv` (per coin / data set / % distance bucket, in-sample and out-of-sample columns for every method), `calibration_z.csv` (z buckets per data set and method, `1d:v4` etc. are the published tables), `calibration_z_by_horizon.csv` (diagnostic), `calibration.svg` (reliability plot), `tail_multipliers.json` (consumed by the quote API).

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
h      = smallest calibrated horizon in {1h, 4h, 1d, 7d} >= D (7d beyond)
k, q   = tail_multipliers.json tables[h] lookup(direction, |z|)   (z buckets per horizon, below)
priced = max(p * k, q)
refuse   prob_too_high           if priced > pMax = 0.5
refuse   level_already_breached  if isLong and S <= L, or !isLong and S >= L
premium = ceil(P * priced * (1 + theta)) + fee,  theta = 0.2, fee = 0 (configurable)
```
Lookup: k is the value of the |z| bucket that holds |z| (an empty bucket borrows the nearest populated one, nearer-the-money first). q is made non-increasing in |z| (each bucket takes the max of itself and all further buckets) and then interpolated log-linearly between bucket mid-points, so the price is continuous in the level and never rises as the level moves away. k >= 1 always. The formula and the quote API are unchanged by D13; only the numbers in `tail_multipliers.json` change.

## What changed in v4 (D13)

1. **The 1d table is fitted on daily candles** (BTC/ETH from 2023-02-26, SOL 2023-03-04, HYPE 2024-12-05; zero-volume rows dropped), the same source the 7d table uses. A window is one UTC day: S = the daily open, touched if the daily low (high) reached the level, which is the exact intraday touch for that window. This multiplies the 1d sample by about six (v3 had ~177 days per coin from the only ~7 months of 1h candles the API keeps).
2. **Thin |z| buckets are pooled with their nearer neighbours** (nearward pooling, N = 300). The true touch frequency cannot rise as the level moves away, so every nearer bucket touches at least as often as a given bucket; the pooled frequency of that bucket and its nearer neighbours is therefore at least its own, and the Wilson upper bound of the pooled counts is still an upper bound for it, only a tighter one. A bucket with fewer than 300 windows or no touch borrows its nearer neighbours one at a time until the pool has >= 300 windows and >= 1 touch; data-rich buckets keep their own counts. Every floor then rests on >= 300 windows (one touch in 300 has a bound of about 1.5 %, one in 110 had 4 %), so the never-cheaper-further-away rule no longer carries one thin bucket's wide bound into every nearer, data-rich bucket. The pool never reaches into the further, safer tail, so no bucket's floor is diluted. N = 300 (10 x the 30-window minimum) was fixed before the run; N = 100 and 1000 are reported as a sensitivity check.
3. **Rejected alternatives** (all evaluated below): (a) merging adjacent buckets into fixed blocks from the tail inwards until each has >= N windows and >= 1 touch: the nearest member of each block is averaged with safer, further buckets, so the block's bound is not an upper bound for it, and that inner edge is exactly the |z| 3-5 region liquidation covers live in; (b) isotonic regression of the Wilson bounds weighted by n: it averages upper bounds from samples of different size, which is not a confidence bound for anything; (c) PAVA on the counts (D11's v3p): the maximum-likelihood monotone fit, but its pooled bound again under-covers the nearest member of each block.

## Method

- **Question.** When the engine says "probability p that the price touches level L within T", does that happen with frequency p or less in real Hyperliquid data?
- **Data.** 1h and 4h horizons: 1-hour candles (the Info API keeps only the latest ~5000). 1d and 7d: daily candles from 2023-02-26 on; zero-volume rows and earlier rows dropped (HL-traded data only). The D11 1d data set (24 one-hour candles per day, `1d-1h`) is kept for the old-vs-new comparison.
- **No look-ahead.** At each window start, sigma = max(EWMA lambda=0.94 of log returns, 30-day realized), annualized, from candles that closed before the start only (30-day warm-up skipped). 1h/4h windows (and `1d-1h`) use 1h candles, exactly like the live engine; 1d and 7d windows use daily candles.
- **Sigma for the 1d table (choice and mismatch).** Daily sigma is the only estimator available over 2023-2026 (1h history is ~7 months), and it is the one the 7d table already uses, so the 1d table is fitted on z computed with daily sigma. The live engine computes sigma from 1h candles for every duration. The mismatch is measured below on the ~7 months where both exist (same days), and the 1d table is validated directly under the live sigma: the 1d windows of the `1d-1h` set (sigma from 1h candles) are priced with the v4 1d table fitted on the first half of the daily set. All of those windows lie after that half, so this check is out of sample.
- **Windows.** Non-overlapping (step = horizon), aligned to multiples of the horizon since the unix epoch (UTC midnight for 1d). Levels 1, 2, 3, 5, 7.5, 10, 15, 20 % below S (`down`, long cover) and above S (`up`, short cover). Touched if min(low) <= S(1-d) or max(high) >= S(1+d) in the window. Windows with a missing candle are skipped.
- **Tail tables (D11, unchanged in structure).** Per horizon, all coins pooled into |z| buckets (0.25 wide up to 4, then 4-5, 5-7, >= 7), per direction. Per bucket q = Wilson one-sided 95 % upper bound (on the counts chosen by the thin-bucket rule), k = clamp(q / mean p, 1, 10).
- **Out-of-sample protocol.** Each data set's windows are split at the median start time. Every method is fitted on the first half only and evaluated on the second half: (a) per coin/horizon/direction/% bucket with >= 30 second-half windows (D11 also required >= 30 first-half windows of that coin; both counts are reported), pass if realized frequency <= mean priced probability; (b) a pool P&L simulation trading the second half. In-sample = tables fitted on all windows, evaluated on all windows (per % bucket with >= 30 windows).
- **Caveat: candles are trade prices, not the oracle.** Covers trigger on the oracle (validator median of 8 venues). HL trade wicks on thin books usually go further than the oracle, so candle touches probably over-count oracle touches (conservative for the pool; not verified).

## Data actually used

| coin | candles | first (UTC) | last (UTC) | count | windows per data set |
|---|---|---|---|---|---|
| BTC | 1h | 2026-03-07 07:00 | 2026-10-01 17:00 | 5003 | 1h: 4282, 4h: 1070, 1d-1h: 177 |
| BTC | 1d | 2023-02-26 00:00 | 2026-09-30 00:00 | 1313 | 1d: 1282, 7d: 183 |
| ETH | 1h | 2026-03-07 07:00 | 2026-10-01 17:00 | 5003 | 1h: 4282, 4h: 1070, 1d-1h: 177 |
| ETH | 1d | 2023-02-26 00:00 | 2026-09-30 00:00 | 1313 | 1d: 1282, 7d: 183 |
| SOL | 1h | 2026-03-07 07:00 | 2026-10-01 17:00 | 5003 | 1h: 4282, 4h: 1070, 1d-1h: 177 |
| SOL | 1d | 2023-03-04 00:00 | 2026-09-30 00:00 | 1307 | 1d: 1276, 7d: 182 |
| HYPE | 1h | 2026-03-07 10:00 | 2026-10-01 17:00 | 5000 | 1h: 4279, 4h: 1069, 1d-1h: 177 |
| HYPE | 1d | 2024-12-05 00:00 | 2026-09-30 00:00 | 665 | 1d: 634, 7d: 90 |

## Headline: old (v3, main) vs new (v4)

Per horizon: in-sample failing % buckets / out-of-sample failing % buckets / OOS loss ratio (claims / premiums) / OOS price multiple (average premium per 100 USDC of cover divided by the raw model's on the same windows, both with the 20 % loading). D13 targets: OOS failing <= 24/240, loss ratio 0.4-0.8. The old row is D11's published configuration re-run on today's data. `OOS fails (D11)` counts like D11 did (only buckets whose coin also has >= 30 first-half windows: HYPE starts after the 1d/7d split, so its 1d/7d buckets drop out); `OOS fails (all)` also tests HYPE's 1d/7d buckets, priced by tables fitted on the other coins' first half, which the coin-pooled tables allow.

| method | in-sample fails | OOS fails (D11) | OOS fails (all) | 1h | 4h | 1d | 7d |
|---|---|---|---|---|---|---|---|
| **v3 = main (D11): 1d table on 1h candles** | 10/256 | **17/240** | 17/256 | 7/64 / 9/64 / 0.43 / 2.41x | 1/64 / 4/64 / 0.41 / 1.29x | 0/64 / 0/64 / 0.46 / 1.26x | 2/64 / 4/64 / 0.69 / 1.13x |
| v3 rule, 1d table on daily candles (data change only) | 10/256 | 17/224 | 17/256 | 7/64 / 9/64 / 0.43 / 2.41x | 1/64 / 4/64 / 0.41 / 1.29x | 0/64 / 0/64 / 0.66 / 1.14x | 2/64 / 4/64 / 0.69 / 1.13x |
| **v4 (D13, adopted): daily candles for 1d + nearward pooling** | 10/256 | **15/224** | 15/256 | 7/64 / 9/64 / 0.43 / 2.42x | 1/64 / 4/64 / 0.41 / 1.29x | 0/64 / 0/64 / 0.66 / 1.14x | 2/64 / 2/64 / 0.65 / 1.10x |
| v4 with N = 100 (sensitivity) | 10/256 | 17/224 | 17/256 | 7/64 / 9/64 / 0.43 / 2.42x | 1/64 / 4/64 / 0.41 / 1.30x | 0/64 / 0/64 / 0.66 / 1.14x | 2/64 / 4/64 / 0.70 / 1.12x |
| v4 with N = 1000 (sensitivity) | 10/256 | 15/224 | 15/256 | 7/64 / 9/64 / 0.42 / 2.43x | 2/64 / 5/64 / 0.39 / 1.35x | 0/64 / 0/64 / 0.62 / 1.20x | 1/64 / 1/64 / 0.35 / 1.39x |
| daily 1d + adjacent blocks merged tail-inward (rejected) | 10/256 | 20/224 | 21/256 | 7/64 / 11/64 / 0.43 / 2.38x | 1/64 / 6/64 / 0.41 / 1.28x | 0/64 / 0/64 / 0.66 / 1.14x | 2/64 / 4/64 / 0.71 / 1.06x |
| daily 1d + isotonic fit of Wilson bounds weighted by n (rejected) | 10/256 | 17/224 | 17/256 | 7/64 / 9/64 / 0.44 / 2.33x | 1/64 / 4/64 / 0.41 / 1.28x | 0/64 / 0/64 / 0.66 / 1.14x | 2/64 / 4/64 / 0.70 / 1.12x |
| daily 1d + PAVA on counts (rejected) | 11/256 | 24/224 | 25/256 | 7/64 / 12/64 / 0.46 / 2.22x | 2/64 / 7/64 / 0.42 / 1.25x | 0/64 / 0/64 / 0.66 / 1.13x | 2/64 / 6/64 / 0.71 / 1.11x |

Horizon cells: in-sample fails / OOS fails (all) / OOS loss ratio / OOS price multiple.

Raw model (k = 1, no floor) OOS loss ratio, 1h / 4h / 1d / 7d: 1.03 | 0.53 | 0.75 | 0.79; on the old 1d set (`1d-1h`): 0.58.

**1d table under the live engine's sigma** (`1d-1h` windows, sigma from 1h candles, priced with the v4 1d table fitted on the first half of the daily set; second half of `1d-1h`, the same windows the old row is tested on): OOS failing 2/64, loss ratio 0.49, price multiple 1.17x; in-sample (published table) 0/64 failing.

**Sigma mismatch, measured.** Ratio live sigma (1h candles) / fit sigma (daily candles) at the same window starts: pooled median 1.03; per coin BTC 1.05 (10-90 %: 0.84-1.37, 177 days); ETH 1.02 (10-90 %: 0.81-1.34, 177 days); SOL 1.07 (10-90 %: 0.91-1.36, 177 days); HYPE 1.01 (10-90 %: 0.91-1.23, 177 days). A ratio above 1 means the live engine sees a smaller |z| than the table was fitted on for the same level, so it looks up a nearer, more expensive bucket and a larger p (conservative); below 1 the opposite.

### What a quote costs: floor q by |z| (down levels), old v3 vs new v4

Published tables (all windows). The priced probability is max(p * k, q); in the far tail q dominates.

| abs z | 1h old q | 1h new q | 4h old q | 4h new q | 1d old q | 1d new q | 7d old q | 7d new q |
|---|---|---|---|---|---|---|---|---|
| 2 | 5.07% | 5.07% | 5.58% | 5.58% | 4.01% | 7.57% | 13.11% | 12.06% |
| 2.5 | 2.77% | 2.77% | 3.04% | 3.04% | 3.97% | 4.58% | 13.11% | 9.42% |
| 3 | 1.48% | 1.48% | 2.04% | 2.04% | 3.97% | 3.31% | 13.11% | 7.69% |
| 3.25 | 1.12% | 1.12% | 1.41% | 1.41% | 3.97% | 2.57% | 13.11% | 7.12% |
| 3.5 | 1.12% | 1.12% | 1.24% | 1.24% | 3.97% | 2.25% | 13.11% | 6.85% |
| 3.75 | 0.94% | 0.94% | 1.09% | 1.09% | 3.97% | 2.24% | 13.11% | 6.60% |
| 4 | 0.73% | 0.73% | 0.79% | 0.79% | 2.81% | 1.93% | 10.28% | 6.12% |
| 4.5 | 0.55% | 0.55% | 0.28% | 0.28% | 0.71% | 1.06% | 3.88% | 5.13% |
| 5 | 0.40% | 0.40% | 0.18% | 0.20% | 0.62% | 0.95% | 3.88% | 5.10% |
| 6 | 0.21% | 0.21% | 0.07% | 0.10% | 0.49% | 0.75% | 3.88% | 5.06% |

## Published tables: z buckets per horizon (v4)

Fitted on all windows of all coins, per horizon. Cell = own touches/windows, pooled touches/windows behind q (`=` when the bucket's own counts are used), k, q.

| dir | abs z | 1h own | 1h pool | 1h k | 1h q | 4h own | 4h pool | 4h k | 4h q | 1d own | 1d pool | 1d k | 1d q | 7d own | 7d pool | 7d k | 7d q |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| down | 0-0.25 | 0/0 | = |  |  | 10/12 | = |  |  | 1244/1528 | = | 1.00 | 8.30e-01 | 998/1172 | = | 1.00 | 8.68e-01 |
| down | 0.25-0.5 | 27/43 | = | 1.11 | 7.38e-01 | 314/511 | = | 1.00 | 6.49e-01 | 2707/4192 | = | 1.00 | 6.58e-01 | 627/912 | = | 1.00 | 7.12e-01 |
| down | 0.5-0.75 | 183/445 | = | 1.00 | 4.50e-01 | 474/1217 | = | 1.00 | 4.13e-01 | 1560/3414 | = | 1.00 | 4.71e-01 | 300/604 | = | 1.00 | 5.30e-01 |
| down | 0.75-1 | 460/1598 | = | 1.00 | 3.07e-01 | 472/1746 | = | 1.00 | 2.88e-01 | 891/2712 | = | 1.00 | 3.44e-01 | 160/464 | = | 1.00 | 3.82e-01 |
| down | 1-1.25 | 309/2059 | = | 1.00 | 1.63e-01 | 259/1632 | = | 1.00 | 1.74e-01 | 437/2070 | = | 1.00 | 2.26e-01 | 101/414 | = | 1.01 | 2.80e-01 |
| down | 1.25-1.5 | 292/2828 | = | 1.00 | 1.13e-01 | 135/1150 | = | 1.00 | 1.34e-01 | 330/1932 | = | 1.05 | 1.85e-01 | 50/275 | 151/689 | 1.35 | 2.46e-01 |
| down | 1.5-1.75 | 311/4532 | = | 1.00 | 7.51e-02 | 86/1343 | = | 1.00 | 7.59e-02 | 156/1563 | = | 1.02 | 1.13e-01 | 34/288 | 84/563 | 1.54 | 1.76e-01 |
| down | 1.75-2 | 141/2436 | = | 1.04 | 6.62e-02 | 45/914 | = | 1.00 | 6.24e-02 | 110/1416 | = | 1.42 | 9.02e-02 | 17/199 | 51/487 | 1.93 | 1.30e-01 |
| down | 2-2.25 | 107/3217 | = | 1.12 | 3.89e-02 | 47/1188 | = | 1.41 | 5.00e-02 | 81/1521 | = | 1.80 | 6.35e-02 | 13/156 | 30/355 | 2.99 | 1.12e-01 |
| down | 2.25-2.5 | 76/3354 | = | 1.46 | 2.73e-02 | 27/1097 | = | 1.84 | 3.36e-02 | 51/1145 | = | 2.93 | 5.57e-02 | 9/151 | 22/307 | 5.06 | 9.98e-02 |
| down | 2.5-2.75 | 52/2347 | = | 3.21 | 2.77e-02 | 12/890 | = | 2.38 | 2.15e-02 | 24/997 | = | 3.60 | 3.34e-02 | 6/116 | 28/423 | 9.07 | 8.90e-02 |
| down | 2.75-3 | 33/2226 | = | 4.61 | 1.97e-02 | 12/693 | = | 6.52 | 2.75e-02 | 29/1039 | = | 8.70 | 3.76e-02 | 3/56 | 18/323 | 10.00 | 8.06e-02 |
| down | 3-3.25 | 21/2724 | = | 5.95 | 1.10e-02 | 6/763 | = | 7.82 | 1.51e-02 | 24/1144 | = | 10.00 | 2.92e-02 | 2/65 | 20/388 | 10.00 | 7.33e-02 |
| down | 3.25-3.5 | 16/2618 | = | 10.00 | 9.18e-03 | 4/674 | = | 10.00 | 1.32e-02 | 13/900 | = | 10.00 | 2.26e-02 | 2/58 | 22/446 | 10.00 | 6.91e-02 |
| down | 3.5-3.75 | 15/2041 | = | 10.00 | 1.12e-02 | 3/639 | = | 10.00 | 1.17e-02 | 6/660 | = | 10.00 | 1.75e-02 | 3/54 | 16/349 | 10.00 | 6.80e-02 |
| down | 3.75-4 | 7/1636 | = | 10.00 | 7.87e-03 | 2/590 | = | 10.00 | 1.02e-02 | 9/688 | = | 10.00 | 2.24e-02 | 0/22 | 16/371 | 10.00 | 6.40e-02 |
| down | 4-5 | 39/9148 | = | 10.00 | 5.54e-03 | 2/2123 | = | 10.00 | 2.84e-03 | 21/2823 | = | 10.00 | 1.06e-02 | 0/67 | 10/322 | 10.00 | 5.13e-02 |
| down | 5-7 | 17/12082 | = | 10.00 | 2.09e-03 | 0/3855 | 2/5978 | 10.00 | 1.01e-03 | 16/3192 | = | 10.00 | 7.53e-03 | 1/29 | 11/351 | 10.00 | 5.06e-02 |
| down | >= 7 | 4/81666 | = | 10.00 | 1.09e-04 | 0/13195 | 2/19173 | 10.00 | 3.15e-04 | 5/2856 | = | 10.00 | 3.59e-03 | 0/2 | 11/353 | 10.00 | 5.03e-02 |
| up | 0-0.25 | 0/0 | = |  |  | 12/13 | = |  |  | 1285/1568 | = | 1.00 | 8.35e-01 | 1023/1197 | = | 1.00 | 8.71e-01 |
| up | 0.25-0.5 | 21/46 | = | 1.00 | 5.76e-01 | 311/522 | = | 1.00 | 6.31e-01 | 2833/4299 | = | 1.00 | 6.71e-01 | 609/970 | = | 1.00 | 6.53e-01 |
| up | 0.5-0.75 | 191/469 | = | 1.00 | 4.45e-01 | 493/1283 | = | 1.00 | 4.07e-01 | 1586/3482 | = | 1.00 | 4.69e-01 | 280/660 | = | 1.00 | 4.56e-01 |
| up | 0.75-1 | 417/1619 | = | 1.00 | 2.76e-01 | 422/1764 | = | 1.00 | 2.56e-01 | 926/2831 | = | 1.00 | 3.42e-01 | 169/511 | = | 1.00 | 3.66e-01 |
| up | 1-1.25 | 313/2141 | = | 1.00 | 1.59e-01 | 280/1639 | = | 1.00 | 1.87e-01 | 497/2268 | = | 1.00 | 2.34e-01 | 97/419 | = | 1.06 | 2.67e-01 |
| up | 1.25-1.5 | 282/2984 | = | 1.00 | 1.04e-01 | 114/1232 | = | 1.00 | 1.07e-01 | 299/2063 | = | 1.00 | 1.58e-01 | 58/339 | = | 1.29 | 2.07e-01 |
| up | 1.5-1.75 | 335/4568 | = | 1.00 | 7.99e-02 | 98/1347 | = | 1.00 | 8.53e-02 | 146/1573 | = | 1.03 | 1.06e-01 | 29/269 | 87/608 | 1.68 | 1.68e-01 |
| up | 1.75-2 | 88/2501 | = | 1.00 | 4.18e-02 | 44/1052 | = | 1.00 | 5.32e-02 | 116/1766 | = | 1.29 | 7.61e-02 | 24/190 | 53/459 | 2.51 | 1.42e-01 |
| up | 2-2.25 | 133/3499 | = | 1.30 | 4.37e-02 | 44/1208 | = | 1.38 | 4.64e-02 | 72/1455 | = | 1.79 | 5.97e-02 | 11/163 | 35/353 | 4.06 | 1.28e-01 |
| up | 2.25-2.5 | 54/3087 | = | 1.18 | 2.18e-02 | 27/1060 | = | 1.97 | 3.47e-02 | 41/1228 | = | 2.50 | 4.29e-02 | 10/91 | 45/444 | 7.68 | 1.27e-01 |
| up | 2.5-2.75 | 38/2450 | = | 2.38 | 2.02e-02 | 17/943 | = | 3.10 | 2.67e-02 | 22/1245 | = | 2.95 | 2.49e-02 | 4/74 | 25/328 | 10.00 | 1.04e-01 |
| up | 2.75-3 | 32/2428 | = | 4.27 | 1.76e-02 | 6/765 | = | 3.76 | 1.51e-02 | 29/1293 | = | 7.58 | 3.03e-02 | 1/72 | 26/400 | 10.00 | 8.83e-02 |
| up | 3-3.25 | 32/2775 | = | 8.42 | 1.54e-02 | 7/668 | = | 10.00 | 1.92e-02 | 9/1001 | = | 8.57 | 1.54e-02 | 3/39 | 29/439 | 10.00 | 8.83e-02 |
| up | 3.25-3.5 | 25/2667 | = | 10.00 | 1.30e-02 | 7/785 | = | 10.00 | 1.64e-02 | 16/868 | = | 10.00 | 2.76e-02 | 1/31 | 19/307 | 10.00 | 8.86e-02 |
| up | 3.5-3.75 | 8/1930 | = | 10.00 | 7.34e-03 | 6/749 | = | 10.00 | 1.54e-02 | 7/921 | = | 10.00 | 1.40e-02 | 1/23 | 20/330 | 10.00 | 8.60e-02 |
| up | 3.75-4 | 6/2278 | = | 10.00 | 5.09e-03 | 5/780 | = | 10.00 | 1.31e-02 | 5/904 | = | 10.00 | 1.13e-02 | 0/22 | 20/352 | 10.00 | 8.07e-02 |
| up | 4-5 | 34/9046 | = | 10.00 | 4.98e-03 | 6/2090 | = | 10.00 | 5.54e-03 | 14/2480 | = | 10.00 | 8.72e-03 | 1/29 | 21/381 | 10.00 | 7.77e-02 |
| up | 5-7 | 10/12667 | = | 10.00 | 1.32e-03 | 8/4152 | = | 10.00 | 3.42e-03 | 8/2686 | = | 10.00 | 5.28e-03 | 0/5 | 21/386 | 10.00 | 7.67e-02 |
| up | >= 7 | 10/79845 | = | 10.00 | 2.09e-04 | 5/12180 | = | 10.00 | 8.43e-04 | 5/1861 | = | 10.00 | 5.51e-03 | 0/0 | = |  |  |

## Per-horizon diagnostic (out of sample)

Second half, priced with tables fitted on the first halves. `actual / model` > 1: the raw model under-predicts there. Old = v3 as on main (1d on 1h candles), new = v4.

| horizon | dir | abs z | old windows | old touches | old priced | old | new windows | new touches | new actual / model | new realized | new priced | new |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1h | down | 0-1 | 562 | 140 | 4.01e-01 | pass | 562 | 140 | 0.62 | 2.49e-01 | 4.01e-01 | pass |
| 1h | down | 1-2 | 5611 | 469 | 1.50e-01 | pass | 5611 | 469 | 0.57 | 8.36e-02 | 1.50e-01 | pass |
| 1h | down | 2-3 | 5543 | 117 | 3.62e-02 | pass | 5543 | 117 | 1.18 | 2.11e-02 | 3.62e-02 | pass |
| 1h | down | 3-4 | 4454 | 27 | 1.53e-02 | pass | 4454 | 27 | 6.41 | 6.06e-03 | 1.53e-02 | pass |
| 1h | down | 4-7 | 10106 | 22 | 4.59e-03 | pass | 10106 | 22 | 384.68 | 2.18e-03 | 4.59e-03 | pass |
| 1h | down | >= 7 | 42236 | 1 | 2.04e-04 | pass | 42236 | 1 | 987771914.28 | 2.37e-05 | 2.04e-04 | pass |
| 1h | up | 0-1 | 583 | 123 | 3.98e-01 | pass | 583 | 123 | 0.53 | 2.11e-01 | 3.98e-01 | pass |
| 1h | up | 1-2 | 5726 | 447 | 1.47e-01 | pass | 5726 | 447 | 0.53 | 7.81e-02 | 1.47e-01 | pass |
| 1h | up | 2-3 | 5663 | 114 | 3.49e-02 | pass | 5663 | 114 | 1.13 | 2.01e-02 | 3.49e-02 | pass |
| 1h | up | 3-4 | 4559 | 38 | 1.51e-02 | pass | 4559 | 38 | 8.28 | 8.34e-03 | 1.51e-02 | pass |
| 1h | up | 4-7 | 10763 | 21 | 3.52e-03 | pass | 10763 | 21 | 326.31 | 1.95e-03 | 3.57e-03 | pass |
| 1h | up | >= 7 | 41218 | 10 | 7.67e-05 | **FAIL** | 41218 | 10 | 10074122393.96 | 2.43e-04 | 2.06e-04 | **FAIL** |
| 4h | down | 0-1 | 1543 | 498 | 4.80e-01 | pass | 1543 | 498 | 0.67 | 3.23e-01 | 4.80e-01 | pass |
| 4h | down | 1-2 | 2505 | 210 | 1.68e-01 | pass | 2505 | 210 | 0.51 | 8.38e-02 | 1.68e-01 | pass |
| 4h | down | 2-3 | 1952 | 34 | 4.93e-02 | pass | 1952 | 34 | 0.99 | 1.74e-02 | 4.92e-02 | pass |
| 4h | down | 3-4 | 1282 | 4 | 2.16e-02 | pass | 1282 | 4 | 4.70 | 3.12e-03 | 1.79e-02 | pass |
| 4h | down | 4-7 | 2960 | 1 | 3.31e-03 | pass | 2960 | 1 | 46.05 | 3.38e-04 | 3.21e-03 | pass |
| 4h | down | >= 7 | 6878 | 0 | 4.43e-04 | pass | 6878 | 0 | 0.00 | 0.00e+00 | 4.95e-04 | pass |
| 4h | up | 0-1 | 1575 | 506 | 4.75e-01 | pass | 1575 | 506 | 0.68 | 3.21e-01 | 4.75e-01 | pass |
| 4h | up | 1-2 | 2553 | 230 | 1.66e-01 | pass | 2553 | 230 | 0.55 | 9.01e-02 | 1.66e-01 | pass |
| 4h | up | 2-3 | 1981 | 44 | 4.43e-02 | pass | 1981 | 44 | 1.21 | 2.22e-02 | 4.43e-02 | pass |
| 4h | up | 3-4 | 1549 | 15 | 1.77e-02 | pass | 1549 | 15 | 15.11 | 9.68e-03 | 1.77e-02 | pass |
| 4h | up | 4-7 | 3047 | 9 | 4.58e-03 | pass | 3047 | 9 | 522.09 | 2.95e-03 | 4.58e-03 | pass |
| 4h | up | >= 7 | 6415 | 4 | 8.30e-04 | pass | 6415 | 4 | 18731280140.19 | 6.24e-04 | 8.30e-04 | pass |
| 1d | down | 0-1 | 851 | 389 | 5.90e-01 | pass | 7104 | 3977 | 0.91 | 5.60e-01 | 6.18e-01 | pass |
| 1d | down | 1-2 | 529 | 49 | 1.84e-01 | pass | 4022 | 601 | 0.91 | 1.49e-01 | 1.78e-01 | pass |
| 1d | down | 2-3 | 367 | 0 | 8.12e-02 | pass | 2706 | 98 | 1.86 | 3.62e-02 | 6.83e-02 | pass |
| 1d | down | 3-4 | 292 | 0 | 7.91e-02 | pass | 1909 | 31 | 16.13 | 1.62e-02 | 3.23e-02 | pass |
| 1d | down | 4-7 | 486 | 0 | 1.48e-02 | pass | 3304 | 17 | 634.15 | 5.15e-03 | 1.36e-02 | pass |
| 1d | down | >= 7 | 323 | 0 | 1.05e-02 | pass | 1411 | 2 | 9891158115.62 | 1.42e-03 | 5.44e-03 | pass |
| 1d | up | 0-1 | 879 | 409 | 5.80e-01 | pass | 7305 | 4011 | 0.91 | 5.49e-01 | 6.11e-01 | pass |
| 1d | up | 1-2 | 541 | 65 | 1.92e-01 | pass | 4460 | 561 | 0.82 | 1.26e-01 | 1.75e-01 | pass |
| 1d | up | 2-3 | 416 | 14 | 7.83e-02 | pass | 3004 | 76 | 1.53 | 2.53e-02 | 6.04e-02 | pass |
| 1d | up | 3-4 | 311 | 5 | 5.57e-02 | pass | 2070 | 18 | 11.38 | 8.70e-03 | 2.55e-02 | pass |
| 1d | up | 4-7 | 513 | 5 | 2.09e-02 | pass | 2636 | 11 | 498.35 | 4.17e-03 | 1.05e-02 | pass |
| 1d | up | >= 7 | 188 | 2 | 1.90e-02 | pass | 981 | 2 | 16760847234.87 | 2.04e-03 | 8.50e-03 | pass |
| 7d | down | 0-1 | 1861 | 1272 | 7.11e-01 | pass | 1861 | 1272 | 0.96 | 6.84e-01 | 7.29e-01 | pass |
| 7d | down | 1-2 | 665 | 127 | 2.26e-01 | pass | 665 | 127 | 1.05 | 1.91e-01 | 2.40e-01 | pass |
| 7d | down | 2-3 | 253 | 22 | 1.37e-01 | pass | 253 | 22 | 4.00 | 8.70e-02 | 1.05e-01 | pass |
| 7d | down | 3-4 | 94 | 2 | 1.29e-01 | pass | 94 | 2 | 23.89 | 2.13e-02 | 6.65e-02 | pass |
| 7d | down | 4-7 | 55 | 0 | 8.27e-02 | pass | 55 | 0 | 0.00 | 0.00e+00 | 6.13e-02 | pass |
| 7d | up | 0-1 | 1978 | 1189 | 7.06e-01 | pass | 1978 | 1189 | 0.89 | 6.01e-01 | 7.35e-01 | pass |
| 7d | up | 1-2 | 671 | 100 | 2.81e-01 | pass | 671 | 100 | 0.91 | 1.49e-01 | 2.98e-01 | pass |
| 7d | up | 2-3 | 198 | 11 | 1.78e-01 | pass | 198 | 11 | 2.87 | 5.56e-02 | 1.68e-01 | pass |
| 7d | up | 3-4 | 61 | 1 | 8.03e-02 | pass | 61 | 1 | 18.57 | 1.64e-02 | 1.23e-01 | pass |
| 7d | up | 4-7 | 20 | 0 | 8.03e-02 | pass | 20 | 0 | 0.00 | 0.00e+00 | 1.17e-01 | pass |

## Findings in plain language

- **Near the money (|z| < 2) the model over-predicts:** 26638 touches where it expected 32020 (0.83x), all horizons pooled. Likely reasons (not tested separately): the 30-day realized floor keeps sigma high after volatile spells, and short-horizon returns mean-revert a little.
- **2 <= |z| < 4:** 1394 touches vs 771.9 expected (1.81x).
- **The tail (|z| >= 4) is where GBM fails:** 206 touches in 258079 windows where the model expected 0.45. These are the flash moves liquidation cover exists for; the floor q prices them at their observed frequency (upper bound) instead of ~0.
- **1h: 0 of 36 fitted buckets use nearward pooling**.
- **4h: 2 of 36 fitted buckets use nearward pooling**: down 5-7 0/3855 -> 2/5978; >= 7 0/13195 -> 2/19173.
- **1d: 0 of 38 fitted buckets use nearward pooling**.
- **7d: 26 of 37 fitted buckets use nearward pooling**: down 1.25-1.5 50/275 -> 151/689; 1.5-1.75 34/288 -> 84/563; 1.75-2 17/199 -> 51/487; 2-2.25 13/156 -> 30/355; 2.25-2.5 9/151 -> 22/307; 2.5-2.75 6/116 -> 28/423; 2.75-3 3/56 -> 18/323; 3-3.25 2/65 -> 20/388; 3.25-3.5 2/58 -> 22/446; 3.5-3.75 3/54 -> 16/349; 3.75-4 0/22 -> 16/371; 4-5 0/67 -> 10/322; 5-7 1/29 -> 11/351; >= 7 0/2 -> 11/353.
- **Per-horizon diagnostic:** 1 horizon x z cells fail out of sample with v3 (main), 1 with v4.
  Still failing with v4: 1h up |z| >= 7 (10/41218 touched, realized 2.4e-04 vs priced 2.1e-04).
- **Out-of-sample % buckets failing with v4:** BTC 1h up 3.0% (realized 0.0019 > priced 0.0012); BTC 1h up 5.0% (realized 0.0005 > priced 0.0003); ETH 1h up 5.0% (realized 0.0019 > priced 0.0006); ETH 1h up 7.5% (realized 0.0005 > priced 0.0003); SOL 1h down 7.5% (realized 0.0005 > priced 0.0002); SOL 1h down 10.0% (realized 0.0005 > priced 0.0002); HYPE 1h down 10.0% (realized 0.0005 > priced 0.0003); HYPE 1h up 10.0% (realized 0.0005 > priced 0.0003); HYPE 1h up 15.0% (realized 0.0005 > priced 0.0002); BTC 4h up 7.5% (realized 0.0019 > priced 0.0013); ETH 4h up 7.5% (realized 0.0056 > priced 0.0035); ETH 4h up 10.0% (realized 0.0037 > priced 0.0014); HYPE 4h up 15.0% (realized 0.0019 > priced 0.0017); BTC 7d down 2.0% (realized 0.7717 > priced 0.7360); SOL 7d down 1.0% (realized 0.9239 > priced 0.9228).

## Pool P&L simulation

At every window start the pool sells one cover per coin x direction x distance in {2.0%, 3.0%, 5.0%, 7.5%, 10.0%}, each paying 0.25% of the initial LP capital (at most 10% locked; no compounding), premium = payout x priced x (1 + 0.2), refused when priced > 0.5. Covers settle before the next window; no fees, no idle yield. OOS rows trade only the second half with tables fitted on the first half; `in-sample` rows trade everything with the tables fitted on everything.

**How to read it.** Price and claims per 100 USDC of cover, the loss ratio (claims / premiums; the 20 % loading alone targets 0.83 for a perfectly calibrated model) and drawdown do not depend on how many covers are sold. LP P&L does: this book sells a full set of covers every window, far more than real demand. Read LP P&L as an upper bound for that assumption.

| data set | variant | days | windows | covers sold | refused | triggered | premium per 100 | claims per 100 | loss ratio | LP P&L | LP P&L per 30 d | max drawdown | worst window |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1h | raw model, OOS half | 89 | 2141 | 85636 | 4 | 285 | 0.322 | 0.333 | 1.03 | -2.2% | -0.7% | 13.50% | -2.89% |
| 1h | v3 (D11): own bucket counts, OOS half | 89 | 2141 | 85636 | 4 | 285 | 0.777 | 0.333 | 0.43 | +95.0% | +32.0% | 3.20% | -1.96% |
| 1h | v3 (D11): own bucket counts, in-sample, all | 178 | 4282 | 171246 | 4 | 880 | 0.874 | 0.514 | 0.59 | +154.2% | +25.9% | 2.81% | -2.01% |
| 1h | v4 (D13): thin buckets pooled nearward (>= 300 windows, >= 1 touch), OOS half | 89 | 2141 | 85636 | 4 | 285 | 0.782 | 0.333 | 0.43 | +96.1% | +32.3% | 3.18% | -1.96% |
| 1h | v4 (D13): thin buckets pooled nearward (>= 300 windows, >= 1 touch), in-sample, all | 178 | 4282 | 171246 | 4 | 880 | 0.874 | 0.514 | 0.59 | +154.2% | +25.9% | 2.81% | -2.01% |
| 1h | v4 with N = 100 (sensitivity), OOS half | 89 | 2141 | 85636 | 4 | 285 | 0.782 | 0.333 | 0.43 | +96.1% | +32.3% | 3.18% | -1.96% |
| 1h | v4 with N = 1000 (sensitivity), OOS half | 89 | 2141 | 85636 | 4 | 285 | 0.785 | 0.333 | 0.42 | +96.8% | +32.6% | 3.17% | -1.95% |
| 1h | adjacent blocks merged tail-inward (>= 300, >= 1 touch; rejected), OOS half | 89 | 2141 | 85636 | 4 | 285 | 0.768 | 0.333 | 0.43 | +93.1% | +31.3% | 3.23% | -1.98% |
| 1h | isotonic fit of the Wilson bounds, weighted by n (rejected), OOS half | 89 | 2141 | 85636 | 4 | 285 | 0.751 | 0.333 | 0.44 | +89.5% | +30.1% | 3.27% | -2.00% |
| 1h | PAVA on counts (D11 alternative, rejected), OOS half | 89 | 2141 | 85636 | 4 | 285 | 0.716 | 0.333 | 0.46 | +82.1% | +27.6% | 3.38% | -2.05% |
| 4h | raw model, OOS half | 89 | 535 | 21351 | 49 | 429 | 3.811 | 2.009 | 0.53 | +96.2% | +32.4% | 3.07% | -2.35% |
| 4h | v3 (D11): own bucket counts, OOS half | 89 | 535 | 21351 | 49 | 429 | 4.935 | 2.009 | 0.41 | +156.1% | +52.5% | 2.41% | -1.92% |
| 4h | v3 (D11): own bucket counts, in-sample, all | 178 | 1070 | 42644 | 146 | 1205 | 5.296 | 2.826 | 0.53 | +263.4% | +44.3% | 3.26% | -2.70% |
| 4h | v4 (D13): thin buckets pooled nearward (>= 300 windows, >= 1 touch), OOS half | 89 | 535 | 21351 | 49 | 429 | 4.907 | 2.009 | 0.41 | +154.6% | +52.0% | 2.43% | -1.93% |
| 4h | v4 (D13): thin buckets pooled nearward (>= 300 windows, >= 1 touch), in-sample, all | 178 | 1070 | 42644 | 146 | 1205 | 5.301 | 2.826 | 0.53 | +263.9% | +44.4% | 3.26% | -2.70% |
| 4h | v4 with N = 100 (sensitivity), OOS half | 89 | 535 | 21351 | 49 | 429 | 4.936 | 2.009 | 0.41 | +156.2% | +52.6% | 2.41% | -1.92% |
| 4h | v4 with N = 1000 (sensitivity), OOS half | 89 | 535 | 21347 | 53 | 429 | 5.143 | 2.010 | 0.39 | +167.2% | +56.3% | 2.31% | -1.87% |
| 4h | adjacent blocks merged tail-inward (>= 300, >= 1 touch; rejected), OOS half | 89 | 535 | 21351 | 49 | 429 | 4.863 | 2.009 | 0.41 | +152.3% | +51.3% | 2.45% | -1.94% |
| 4h | isotonic fit of the Wilson bounds, weighted by n (rejected), OOS half | 89 | 535 | 21351 | 49 | 429 | 4.862 | 2.009 | 0.41 | +152.3% | +51.2% | 2.45% | -1.94% |
| 4h | PAVA on counts (D11 alternative, rejected), OOS half | 89 | 535 | 21351 | 49 | 429 | 4.770 | 2.009 | 0.42 | +147.4% | +49.6% | 2.49% | -1.97% |
| 1d | raw model, OOS half | 641 | 641 | 20283 | 5287 | 2729 | 18.018 | 13.455 | 0.75 | +231.4% | +10.8% | 9.54% | -2.86% |
| 1d | v3 (D11): own bucket counts, OOS half | 641 | 641 | 20283 | 5287 | 2729 | 20.538 | 13.455 | 0.66 | +359.2% | +16.8% | 6.89% | -2.55% |
| 1d | v3 (D11): own bucket counts, in-sample, all | 1282 | 1282 | 36730 | 8010 | 4909 | 19.124 | 13.365 | 0.70 | +528.8% | +12.4% | 6.25% | -1.81% |
| 1d | v4 (D13): thin buckets pooled nearward (>= 300 windows, >= 1 touch), OOS half | 641 | 641 | 20283 | 5287 | 2729 | 20.538 | 13.455 | 0.66 | +359.2% | +16.8% | 6.89% | -2.55% |
| 1d | v4 (D13): thin buckets pooled nearward (>= 300 windows, >= 1 touch), in-sample, all | 1282 | 1282 | 36730 | 8010 | 4909 | 19.124 | 13.365 | 0.70 | +528.8% | +12.4% | 6.25% | -1.81% |
| 1d | v4 with N = 100 (sensitivity), OOS half | 641 | 641 | 20283 | 5287 | 2729 | 20.538 | 13.455 | 0.66 | +359.2% | +16.8% | 6.89% | -2.55% |
| 1d | v4 with N = 1000 (sensitivity), OOS half | 641 | 641 | 20283 | 5287 | 2729 | 21.617 | 13.455 | 0.62 | +413.9% | +19.4% | 5.91% | -2.37% |
| 1d | adjacent blocks merged tail-inward (>= 300, >= 1 touch; rejected), OOS half | 641 | 641 | 20283 | 5287 | 2729 | 20.538 | 13.455 | 0.66 | +359.2% | +16.8% | 6.89% | -2.55% |
| 1d | isotonic fit of the Wilson bounds, weighted by n (rejected), OOS half | 641 | 641 | 20283 | 5287 | 2729 | 20.456 | 13.455 | 0.66 | +355.0% | +16.6% | 6.94% | -2.56% |
| 1d | PAVA on counts (D11 alternative, rejected), OOS half | 641 | 641 | 20283 | 5287 | 2729 | 20.331 | 13.455 | 0.66 | +348.7% | +16.3% | 7.02% | -2.57% |
| 7d | raw model, OOS half | 644 | 92 | 1349 | 2311 | 386 | 36.000 | 28.614 | 0.79 | +24.9% | +1.2% | 1.79% | -1.33% |
| 7d | v3 (D11): own bucket counts, OOS half | 644 | 92 | 1252 | 2408 | 352 | 40.764 | 28.115 | 0.69 | +39.6% | +1.8% | 0.98% | -0.78% |
| 7d | v3 (D11): own bucket counts, in-sample, all | 1281 | 183 | 2529 | 3851 | 715 | 38.291 | 28.272 | 0.74 | +63.3% | +1.5% | 1.83% | -0.96% |
| 7d | v4 (D13): thin buckets pooled nearward (>= 300 windows, >= 1 touch), OOS half | 644 | 92 | 1020 | 2640 | 261 | 39.546 | 25.588 | 0.65 | +35.6% | +1.7% | 1.13% | -0.97% |
| 7d | v4 (D13): thin buckets pooled nearward (>= 300 windows, >= 1 touch), in-sample, all | 1281 | 183 | 2529 | 3851 | 715 | 38.332 | 28.272 | 0.74 | +63.6% | +1.5% | 1.82% | -1.08% |
| 7d | v4 with N = 100 (sensitivity), OOS half | 644 | 92 | 1252 | 2408 | 352 | 40.203 | 28.115 | 0.70 | +37.8% | +1.8% | 1.07% | -0.86% |
| 7d | v4 with N = 1000 (sensitivity), OOS half | 644 | 92 | 373 | 3287 | 65 | 50.218 | 17.426 | 0.35 | +30.6% | +1.4% | 0.33% | -0.29% |
| 7d | adjacent blocks merged tail-inward (>= 300, >= 1 touch; rejected), OOS half | 644 | 92 | 1185 | 2475 | 319 | 38.123 | 26.920 | 0.71 | +33.2% | +1.5% | 1.23% | -0.92% |
| 7d | isotonic fit of the Wilson bounds, weighted by n (rejected), OOS half | 644 | 92 | 1252 | 2408 | 352 | 40.177 | 28.115 | 0.70 | +37.8% | +1.8% | 1.07% | -0.85% |
| 7d | PAVA on counts (D11 alternative, rejected), OOS half | 644 | 92 | 1252 | 2408 | 352 | 39.859 | 28.115 | 0.71 | +36.8% | +1.7% | 1.11% | -0.88% |
| 1d-1h | raw model, OOS half | 89 | 89 | 3088 | 472 | 280 | 15.703 | 9.067 | 0.58 | +51.2% | +17.3% | 2.71% | -2.71% |
| 1d-1h | v3 (D11): own bucket counts, OOS half | 89 | 89 | 3088 | 472 | 280 | 19.852 | 9.067 | 0.46 | +83.3% | +28.1% | 2.14% | -2.14% |
| 1d-1h | v3 (D11): own bucket counts, in-sample, all | 177 | 177 | 6064 | 1016 | 641 | 18.909 | 10.571 | 0.56 | +126.4% | +21.4% | 1.89% | -1.68% |
| 1d-1h | v4 (D13): thin buckets pooled nearward (>= 300 windows, >= 1 touch), OOS half | 89 | 89 | 2965 | 595 | 238 | 18.801 | 8.027 | 0.43 | +79.9% | +26.9% | 2.19% | -2.19% |
| 1d-1h | v4 (D13): thin buckets pooled nearward (>= 300 windows, >= 1 touch), in-sample, all | 177 | 177 | 6064 | 1016 | 641 | 18.501 | 10.571 | 0.57 | +120.2% | +20.4% | 1.92% | -1.76% |
| 1d-1h | v4 with N = 100 (sensitivity), OOS half | 89 | 89 | 3088 | 472 | 280 | 18.733 | 9.067 | 0.48 | +74.6% | +25.2% | 2.28% | -2.28% |
| 1d-1h | v4 with N = 1000 (sensitivity), OOS half | 89 | 89 | 2344 | 1216 | 94 | 27.197 | 4.010 | 0.15 | +135.9% | +45.8% | 1.28% | -1.28% |
| 1d-1h | adjacent blocks merged tail-inward (>= 300, >= 1 touch; rejected), OOS half | 89 | 89 | 3088 | 472 | 280 | 17.904 | 9.067 | 0.51 | +68.2% | +23.0% | 2.41% | -2.41% |
| 1d-1h | isotonic fit of the Wilson bounds, weighted by n (rejected), OOS half | 89 | 89 | 3088 | 472 | 280 | 18.867 | 9.067 | 0.48 | +75.7% | +25.5% | 2.25% | -2.25% |
| 1d-1h | PAVA on counts (D11 alternative, rejected), OOS half | 89 | 89 | 3088 | 472 | 280 | 17.934 | 9.067 | 0.51 | +68.4% | +23.1% | 2.36% | -2.36% |
| 1d-1h | v4 1d table, live sigma (1h candles), OOS half | 89 | 89 | 3088 | 472 | 280 | 18.334 | 9.067 | 0.49 | +71.5% | +24.1% | 2.34% | -2.34% |
| 1d-1h | v4 1d table, live sigma (1h candles), in-sample, all | 177 | 177 | 6064 | 1016 | 641 | 18.401 | 10.571 | 0.57 | +118.7% | +20.1% | 1.98% | -1.79% |

## Expected vs actual touches (raw model)

| data set | direction | windows x distances | expected (sum p) | actual | actual / expected |
|---|---|---|---|---|---|
| 1h | down | 137000 | 2763.1 | 2110 | 0.76 |
| 1h | up | 137000 | 2816.3 | 2029 | 0.72 |
| 4h | down | 34232 | 2607.5 | 1910 | 0.73 |
| 4h | up | 34232 | 2642.5 | 1912 | 0.72 |
| 1d | down | 35792 | 8481.3 | 7714 | 0.91 |
| 1d | up | 35792 | 8574.5 | 7916 | 0.92 |
| 7d | down | 5104 | 2446.9 | 2326 | 0.95 |
| 7d | up | 5104 | 2460.3 | 2321 | 0.94 |
| 1d-1h | down | 5664 | 1247.7 | 994 | 0.80 |
| 1d-1h | up | 5664 | 1261.2 | 1083 | 0.86 |

## Calibration table per coin / horizon / distance (published data sets)

`ratio` = realized / raw predicted (`sig` = significantly under-predicted). `v4 priced` = mean priced probability with the published tables (in-sample). OOS = second half priced with first-half tables.

| coin | hz | dir | dist | windows | touches | realized | predicted | ratio | v4 priced | in-sample v4 | OOS v3 | OOS v4 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BTC | 1h | down | 1.0% | 4282 | 150 | 0.0350 | 3.88e-02 | 0.90 | 0.0485 | pass | pass | pass |
| BTC | 1h | down | 2.0% | 4282 | 16 | 0.0037 | 1.71e-03 | 2.19 sig | 0.0070 | pass | pass | pass |
| BTC | 1h | down | 3.0% | 4282 | 1 | 0.0002 | 1.28e-04 | 1.83 | 0.0015 | pass | pass | pass |
| BTC | 1h | down | 5.0% | 4282 | 1 | 0.0002 | 2.52e-07 | 925.12 sig | 0.0002 | **FAIL** | pass | pass |
| BTC | 1h | down | 7.5% | 4282 | 0 | 0.0000 | 8.76e-12 | 0.00 | 0.0001 | pass | pass | pass |
| BTC | 1h | down | 10.0% | 4282 | 0 | 0.0000 | 9.27e-18 | 0.00 | 0.0001 | pass | pass | pass |
| BTC | 1h | down | 15.0% | 4282 | 0 | 0.0000 | 2.44e-35 | 0.00 | 0.0001 | pass | pass | pass |
| BTC | 1h | down | 20.0% | 4282 | 0 | 0.0000 | 6.75e-62 | 0.00 | 0.0001 | pass | pass | pass |
| BTC | 1h | up | 1.0% | 4282 | 139 | 0.0325 | 3.99e-02 | 0.81 | 0.0481 | pass | pass | pass |
| BTC | 1h | up | 2.0% | 4282 | 20 | 0.0047 | 1.85e-03 | 2.52 sig | 0.0064 | pass | pass | pass |
| BTC | 1h | up | 3.0% | 4282 | 6 | 0.0014 | 1.57e-04 | 8.92 sig | 0.0015 | pass | **FAIL** | **FAIL** |
| BTC | 1h | up | 5.0% | 4282 | 1 | 0.0002 | 5.49e-07 | 425.50 sig | 0.0003 | pass | **FAIL** | **FAIL** |
| BTC | 1h | up | 7.5% | 4282 | 0 | 0.0000 | 9.08e-11 | 0.00 | 0.0002 | pass | pass | pass |
| BTC | 1h | up | 10.0% | 4282 | 0 | 0.0000 | 1.97e-15 | 0.00 | 0.0002 | pass | pass | pass |
| BTC | 1h | up | 15.0% | 4282 | 0 | 0.0000 | 1.50e-27 | 0.00 | 0.0002 | pass | pass | pass |
| BTC | 1h | up | 20.0% | 4282 | 0 | 0.0000 | 3.46e-43 | 0.00 | 0.0002 | pass | pass | pass |
| ETH | 1h | down | 1.0% | 4282 | 283 | 0.0661 | 1.02e-01 | 0.64 | 0.1056 | pass | pass | pass |
| ETH | 1h | down | 2.0% | 4282 | 51 | 0.0119 | 6.57e-03 | 1.81 sig | 0.0160 | pass | pass | pass |
| ETH | 1h | down | 3.0% | 4282 | 11 | 0.0026 | 8.40e-04 | 3.06 sig | 0.0048 | pass | pass | pass |
| ETH | 1h | down | 5.0% | 4282 | 2 | 0.0005 | 1.51e-05 | 30.94 sig | 0.0005 | pass | pass | pass |
| ETH | 1h | down | 7.5% | 4282 | 0 | 0.0000 | 5.18e-08 | 0.00 | 0.0002 | pass | pass | pass |
| ETH | 1h | down | 10.0% | 4282 | 0 | 0.0000 | 3.51e-11 | 0.00 | 0.0001 | pass | pass | pass |
| ETH | 1h | down | 15.0% | 4282 | 0 | 0.0000 | 2.47e-20 | 0.00 | 0.0001 | pass | pass | pass |
| ETH | 1h | down | 20.0% | 4282 | 0 | 0.0000 | 5.39e-34 | 0.00 | 0.0001 | pass | pass | pass |
| ETH | 1h | up | 1.0% | 4282 | 265 | 0.0619 | 1.04e-01 | 0.59 | 0.1066 | pass | pass | pass |
| ETH | 1h | up | 2.0% | 4282 | 52 | 0.0121 | 7.06e-03 | 1.72 sig | 0.0161 | pass | pass | pass |
| ETH | 1h | up | 3.0% | 4282 | 20 | 0.0047 | 9.68e-04 | 4.83 sig | 0.0044 | **FAIL** | pass | pass |
| ETH | 1h | up | 5.0% | 4282 | 5 | 0.0012 | 2.35e-05 | 49.74 sig | 0.0006 | **FAIL** | **FAIL** | **FAIL** |
| ETH | 1h | up | 7.5% | 4282 | 1 | 0.0002 | 1.76e-07 | 1324.16 sig | 0.0003 | pass | **FAIL** | **FAIL** |
| ETH | 1h | up | 10.0% | 4282 | 0 | 0.0000 | 5.67e-10 | 0.00 | 0.0002 | pass | pass | pass |
| ETH | 1h | up | 15.0% | 4282 | 0 | 0.0000 | 2.52e-16 | 0.00 | 0.0002 | pass | pass | pass |
| ETH | 1h | up | 20.0% | 4282 | 0 | 0.0000 | 2.02e-24 | 0.00 | 0.0002 | pass | pass | pass |
| SOL | 1h | down | 1.0% | 4282 | 389 | 0.0908 | 1.34e-01 | 0.68 | 0.1366 | pass | pass | pass |
| SOL | 1h | down | 2.0% | 4282 | 67 | 0.0156 | 1.01e-02 | 1.55 sig | 0.0206 | pass | pass | pass |
| SOL | 1h | down | 3.0% | 4282 | 17 | 0.0040 | 1.15e-03 | 3.45 sig | 0.0062 | pass | pass | pass |
| SOL | 1h | down | 5.0% | 4282 | 2 | 0.0005 | 1.77e-05 | 26.34 sig | 0.0008 | pass | pass | pass |
| SOL | 1h | down | 7.5% | 4282 | 1 | 0.0002 | 2.34e-08 | 9965.32 sig | 0.0002 | **FAIL** | **FAIL** | **FAIL** |
| SOL | 1h | down | 10.0% | 4282 | 1 | 0.0002 | 4.74e-12 | 49272557.93 sig | 0.0001 | **FAIL** | **FAIL** | **FAIL** |
| SOL | 1h | down | 15.0% | 4282 | 0 | 0.0000 | 2.37e-22 | 0.00 | 0.0001 | pass | pass | pass |
| SOL | 1h | down | 20.0% | 4282 | 0 | 0.0000 | 1.40e-37 | 0.00 | 0.0001 | pass | pass | pass |
| SOL | 1h | up | 1.0% | 4282 | 367 | 0.0857 | 1.36e-01 | 0.63 | 0.1381 | pass | pass | pass |
| SOL | 1h | up | 2.0% | 4282 | 79 | 0.0184 | 1.09e-02 | 1.69 sig | 0.0207 | pass | pass | pass |
| SOL | 1h | up | 3.0% | 4282 | 20 | 0.0047 | 1.33e-03 | 3.51 sig | 0.0059 | pass | pass | pass |
| SOL | 1h | up | 5.0% | 4282 | 2 | 0.0005 | 2.90e-05 | 16.12 sig | 0.0009 | pass | pass | pass |
| SOL | 1h | up | 7.5% | 4282 | 0 | 0.0000 | 1.01e-07 | 0.00 | 0.0003 | pass | pass | pass |
| SOL | 1h | up | 10.0% | 4282 | 0 | 0.0000 | 1.19e-10 | 0.00 | 0.0002 | pass | pass | pass |
| SOL | 1h | up | 15.0% | 4282 | 0 | 0.0000 | 7.27e-18 | 0.00 | 0.0002 | pass | pass | pass |
| SOL | 1h | up | 20.0% | 4282 | 0 | 0.0000 | 6.73e-27 | 0.00 | 0.0002 | pass | pass | pass |
| HYPE | 1h | down | 1.0% | 4279 | 856 | 0.2000 | 2.85e-01 | 0.70 | 0.2858 | pass | pass | pass |
| HYPE | 1h | down | 2.0% | 4279 | 202 | 0.0472 | 5.44e-02 | 0.87 | 0.0623 | pass | pass | pass |
| HYPE | 1h | down | 3.0% | 4279 | 53 | 0.0124 | 9.87e-03 | 1.26 sig | 0.0191 | pass | pass | pass |
| HYPE | 1h | down | 5.0% | 4279 | 4 | 0.0009 | 4.66e-04 | 2.01 | 0.0041 | pass | pass | pass |
| HYPE | 1h | down | 7.5% | 4279 | 2 | 0.0005 | 1.80e-05 | 25.95 sig | 0.0009 | pass | pass | pass |
| HYPE | 1h | down | 10.0% | 4279 | 1 | 0.0002 | 5.93e-07 | 394.07 sig | 0.0002 | **FAIL** | **FAIL** | **FAIL** |
| HYPE | 1h | down | 15.0% | 4279 | 0 | 0.0000 | 8.78e-11 | 0.00 | 0.0001 | pass | pass | pass |
| HYPE | 1h | down | 20.0% | 4279 | 0 | 0.0000 | 3.02e-16 | 0.00 | 0.0001 | pass | pass | pass |
| HYPE | 1h | up | 1.0% | 4279 | 807 | 0.1886 | 2.87e-01 | 0.66 | 0.2866 | pass | pass | pass |
| HYPE | 1h | up | 2.0% | 4279 | 191 | 0.0446 | 5.70e-02 | 0.78 | 0.0641 | pass | pass | pass |
| HYPE | 1h | up | 3.0% | 4279 | 47 | 0.0110 | 1.11e-02 | 0.99 | 0.0191 | pass | pass | pass |
| HYPE | 1h | up | 5.0% | 4279 | 4 | 0.0009 | 6.16e-04 | 1.52 | 0.0038 | pass | pass | pass |
| HYPE | 1h | up | 7.5% | 4279 | 1 | 0.0002 | 3.29e-05 | 7.10 sig | 0.0010 | pass | pass | pass |
| HYPE | 1h | up | 10.0% | 4279 | 1 | 0.0002 | 1.96e-06 | 119.04 sig | 0.0004 | pass | **FAIL** | **FAIL** |
| HYPE | 1h | up | 15.0% | 4279 | 1 | 0.0002 | 3.56e-09 | 65619.62 sig | 0.0002 | **FAIL** | **FAIL** | **FAIL** |
| HYPE | 1h | up | 20.0% | 4279 | 0 | 0.0000 | 1.76e-12 | 0.00 | 0.0002 | pass | pass | pass |
| BTC | 4h | down | 1.0% | 1070 | 176 | 0.1645 | 2.58e-01 | 0.64 | 0.2576 | pass | pass | pass |
| BTC | 4h | down | 2.0% | 1070 | 32 | 0.0299 | 3.83e-02 | 0.78 | 0.0527 | pass | pass | pass |
| BTC | 4h | down | 3.0% | 1070 | 6 | 0.0056 | 6.50e-03 | 0.86 | 0.0172 | pass | pass | pass |
| BTC | 4h | down | 5.0% | 1070 | 1 | 0.0009 | 4.38e-04 | 2.13 | 0.0025 | pass | pass | pass |
| BTC | 4h | down | 7.5% | 1070 | 0 | 0.0000 | 1.17e-05 | 0.00 | 0.0006 | pass | pass | pass |
| BTC | 4h | down | 10.0% | 1070 | 0 | 0.0000 | 1.51e-07 | 0.00 | 0.0004 | pass | pass | pass |
| BTC | 4h | down | 15.0% | 1070 | 0 | 0.0000 | 1.59e-12 | 0.00 | 0.0003 | pass | pass | pass |
| BTC | 4h | down | 20.0% | 1070 | 0 | 0.0000 | 1.10e-19 | 0.00 | 0.0003 | pass | pass | pass |
| BTC | 4h | up | 1.0% | 1070 | 158 | 0.1477 | 2.59e-01 | 0.57 | 0.2594 | pass | pass | pass |
| BTC | 4h | up | 2.0% | 1070 | 37 | 0.0346 | 4.05e-02 | 0.85 | 0.0536 | pass | pass | pass |
| BTC | 4h | up | 3.0% | 1070 | 16 | 0.0150 | 7.23e-03 | 2.07 sig | 0.0208 | pass | pass | pass |
| BTC | 4h | up | 5.0% | 1070 | 2 | 0.0019 | 5.71e-04 | 3.28 sig | 0.0051 | pass | pass | pass |
| BTC | 4h | up | 7.5% | 1070 | 1 | 0.0009 | 2.46e-05 | 38.01 sig | 0.0017 | pass | **FAIL** | **FAIL** |
| BTC | 4h | up | 10.0% | 1070 | 0 | 0.0000 | 7.31e-07 | 0.00 | 0.0010 | pass | pass | pass |
| BTC | 4h | up | 15.0% | 1070 | 0 | 0.0000 | 2.03e-10 | 0.00 | 0.0009 | pass | pass | pass |
| BTC | 4h | up | 20.0% | 1070 | 0 | 0.0000 | 1.03e-14 | 0.00 | 0.0008 | pass | pass | pass |
| ETH | 4h | down | 1.0% | 1070 | 273 | 0.2551 | 3.91e-01 | 0.65 | 0.3908 | pass | pass | pass |
| ETH | 4h | down | 2.0% | 1070 | 80 | 0.0748 | 1.02e-01 | 0.74 | 0.1065 | pass | pass | pass |
| ETH | 4h | down | 3.0% | 1070 | 20 | 0.0187 | 2.31e-02 | 0.81 | 0.0389 | pass | pass | pass |
| ETH | 4h | down | 5.0% | 1070 | 5 | 0.0047 | 2.09e-03 | 2.23 sig | 0.0076 | pass | pass | pass |
| ETH | 4h | down | 7.5% | 1070 | 0 | 0.0000 | 1.55e-04 | 0.00 | 0.0016 | pass | pass | pass |
| ETH | 4h | down | 10.0% | 1070 | 0 | 0.0000 | 9.66e-06 | 0.00 | 0.0006 | pass | pass | pass |
| ETH | 4h | down | 15.0% | 1070 | 0 | 0.0000 | 1.54e-08 | 0.00 | 0.0003 | pass | pass | pass |
| ETH | 4h | down | 20.0% | 1070 | 0 | 0.0000 | 2.42e-12 | 0.00 | 0.0003 | pass | pass | pass |
| ETH | 4h | up | 1.0% | 1070 | 256 | 0.2393 | 3.91e-01 | 0.61 | 0.3914 | pass | pass | pass |
| ETH | 4h | up | 2.0% | 1070 | 72 | 0.0673 | 1.05e-01 | 0.64 | 0.1094 | pass | pass | pass |
| ETH | 4h | up | 3.0% | 1070 | 24 | 0.0224 | 2.54e-02 | 0.88 | 0.0408 | pass | pass | pass |
| ETH | 4h | up | 5.0% | 1070 | 8 | 0.0075 | 2.56e-03 | 2.93 sig | 0.0117 | pass | pass | pass |
| ETH | 4h | up | 7.5% | 1070 | 4 | 0.0037 | 2.52e-04 | 14.83 sig | 0.0038 | pass | **FAIL** | **FAIL** |
| ETH | 4h | up | 10.0% | 1070 | 2 | 0.0019 | 2.46e-05 | 75.87 sig | 0.0017 | **FAIL** | **FAIL** | **FAIL** |
| ETH | 4h | up | 15.0% | 1070 | 0 | 0.0000 | 2.04e-07 | 0.00 | 0.0010 | pass | pass | pass |
| ETH | 4h | up | 20.0% | 1070 | 0 | 0.0000 | 9.47e-10 | 0.00 | 0.0009 | pass | pass | pass |
| SOL | 4h | down | 1.0% | 1070 | 327 | 0.3056 | 4.29e-01 | 0.71 | 0.4290 | pass | pass | pass |
| SOL | 4h | down | 2.0% | 1070 | 110 | 0.1028 | 1.33e-01 | 0.77 | 0.1370 | pass | pass | pass |
| SOL | 4h | down | 3.0% | 1070 | 34 | 0.0318 | 3.54e-02 | 0.90 | 0.0487 | pass | pass | pass |
| SOL | 4h | down | 5.0% | 1070 | 4 | 0.0037 | 2.98e-03 | 1.26 | 0.0110 | pass | pass | pass |
| SOL | 4h | down | 7.5% | 1070 | 1 | 0.0009 | 2.20e-04 | 4.26 | 0.0022 | pass | pass | pass |
| SOL | 4h | down | 10.0% | 1070 | 0 | 0.0000 | 1.27e-05 | 0.00 | 0.0007 | pass | pass | pass |
| SOL | 4h | down | 15.0% | 1070 | 0 | 0.0000 | 8.30e-09 | 0.00 | 0.0003 | pass | pass | pass |
| SOL | 4h | down | 20.0% | 1070 | 0 | 0.0000 | 4.17e-13 | 0.00 | 0.0003 | pass | pass | pass |
| SOL | 4h | up | 1.0% | 1070 | 314 | 0.2935 | 4.29e-01 | 0.68 | 0.4292 | pass | pass | pass |
| SOL | 4h | up | 2.0% | 1070 | 97 | 0.0907 | 1.37e-01 | 0.66 | 0.1405 | pass | pass | pass |
| SOL | 4h | up | 3.0% | 1070 | 46 | 0.0430 | 3.87e-02 | 1.11 | 0.0514 | pass | pass | pass |
| SOL | 4h | up | 5.0% | 1070 | 12 | 0.0112 | 3.70e-03 | 3.03 sig | 0.0150 | pass | pass | pass |
| SOL | 4h | up | 7.5% | 1070 | 0 | 0.0000 | 3.53e-04 | 0.00 | 0.0049 | pass | pass | pass |
| SOL | 4h | up | 10.0% | 1070 | 0 | 0.0000 | 3.44e-05 | 0.00 | 0.0022 | pass | pass | pass |
| SOL | 4h | up | 15.0% | 1070 | 0 | 0.0000 | 1.68e-07 | 0.00 | 0.0010 | pass | pass | pass |
| SOL | 4h | up | 20.0% | 1070 | 0 | 0.0000 | 3.50e-10 | 0.00 | 0.0009 | pass | pass | pass |
| HYPE | 4h | down | 1.0% | 1069 | 522 | 0.4883 | 5.82e-01 | 0.84 | 0.5817 | pass | pass | pass |
| HYPE | 4h | down | 2.0% | 1069 | 211 | 0.1974 | 2.84e-01 | 0.69 | 0.2843 | pass | pass | pass |
| HYPE | 4h | down | 3.0% | 1069 | 88 | 0.0823 | 1.25e-01 | 0.66 | 0.1308 | pass | pass | pass |
| HYPE | 4h | down | 5.0% | 1069 | 17 | 0.0159 | 2.22e-02 | 0.72 | 0.0357 | pass | pass | pass |
| HYPE | 4h | down | 7.5% | 1069 | 2 | 0.0019 | 2.70e-03 | 0.69 | 0.0100 | pass | pass | pass |
| HYPE | 4h | down | 10.0% | 1069 | 1 | 0.0009 | 4.41e-04 | 2.12 | 0.0034 | pass | pass | pass |
| HYPE | 4h | down | 15.0% | 1069 | 0 | 0.0000 | 1.69e-05 | 0.00 | 0.0007 | pass | pass | pass |
| HYPE | 4h | down | 20.0% | 1069 | 0 | 0.0000 | 4.57e-07 | 0.00 | 0.0004 | pass | pass | pass |
| HYPE | 4h | up | 1.0% | 1069 | 521 | 0.4874 | 5.80e-01 | 0.84 | 0.5796 | pass | pass | pass |
| HYPE | 4h | up | 2.0% | 1069 | 217 | 0.2030 | 2.87e-01 | 0.71 | 0.2874 | pass | pass | pass |
| HYPE | 4h | up | 3.0% | 1069 | 97 | 0.0907 | 1.31e-01 | 0.69 | 0.1357 | pass | pass | pass |
| HYPE | 4h | up | 5.0% | 1069 | 20 | 0.0187 | 2.60e-02 | 0.72 | 0.0383 | pass | pass | pass |
| HYPE | 4h | up | 7.5% | 1069 | 5 | 0.0047 | 3.83e-03 | 1.22 | 0.0142 | pass | pass | pass |
| HYPE | 4h | up | 10.0% | 1069 | 2 | 0.0019 | 7.50e-04 | 2.50 | 0.0072 | pass | pass | pass |
| HYPE | 4h | up | 15.0% | 1069 | 1 | 0.0009 | 5.26e-05 | 17.78 sig | 0.0024 | pass | **FAIL** | **FAIL** |
| HYPE | 4h | up | 20.0% | 1069 | 0 | 0.0000 | 4.56e-06 | 0.00 | 0.0013 | pass | pass | pass |
| BTC | 1d | down | 1.0% | 1282 | 722 | 0.5632 | 6.58e-01 | 0.86 | 0.6577 | pass | pass | pass |
| BTC | 1d | down | 2.0% | 1282 | 402 | 0.3136 | 3.83e-01 | 0.82 | 0.3847 | pass | pass | pass |
| BTC | 1d | down | 3.0% | 1282 | 221 | 0.1724 | 2.04e-01 | 0.85 | 0.2134 | pass | pass | pass |
| BTC | 1d | down | 5.0% | 1282 | 71 | 0.0554 | 4.86e-02 | 1.14 | 0.0756 | pass | pass | pass |
| BTC | 1d | down | 7.5% | 1282 | 18 | 0.0140 | 7.11e-03 | 1.97 sig | 0.0304 | pass | pass | pass |
| BTC | 1d | down | 10.0% | 1282 | 9 | 0.0070 | 9.61e-04 | 7.30 sig | 0.0156 | pass | pass | pass |
| BTC | 1d | down | 15.0% | 1282 | 4 | 0.0031 | 1.04e-05 | 299.54 sig | 0.0064 | pass | pass | pass |
| BTC | 1d | down | 20.0% | 1282 | 0 | 0.0000 | 4.39e-08 | 0.00 | 0.0042 | pass | pass | pass |
| BTC | 1d | up | 1.0% | 1282 | 730 | 0.5694 | 6.54e-01 | 0.87 | 0.6543 | pass | pass | pass |
| BTC | 1d | up | 2.0% | 1282 | 403 | 0.3144 | 3.85e-01 | 0.82 | 0.3848 | pass | pass | pass |
| BTC | 1d | up | 3.0% | 1282 | 224 | 0.1747 | 2.10e-01 | 0.83 | 0.2137 | pass | pass | pass |
| BTC | 1d | up | 5.0% | 1282 | 90 | 0.0702 | 5.53e-02 | 1.27 sig | 0.0752 | pass | pass | pass |
| BTC | 1d | up | 7.5% | 1282 | 24 | 0.0187 | 9.94e-03 | 1.88 sig | 0.0304 | pass | pass | pass |
| BTC | 1d | up | 10.0% | 1282 | 9 | 0.0070 | 1.83e-03 | 3.83 sig | 0.0151 | pass | pass | pass |
| BTC | 1d | up | 15.0% | 1282 | 1 | 0.0008 | 5.88e-05 | 13.26 sig | 0.0073 | pass | pass | pass |
| BTC | 1d | up | 20.0% | 1282 | 1 | 0.0008 | 1.57e-06 | 495.68 sig | 0.0058 | pass | pass | pass |
| ETH | 1d | down | 1.0% | 1282 | 833 | 0.6498 | 7.45e-01 | 0.87 | 0.7449 | pass | pass | pass |
| ETH | 1d | down | 2.0% | 1282 | 556 | 0.4337 | 5.20e-01 | 0.83 | 0.5198 | pass | pass | pass |
| ETH | 1d | down | 3.0% | 1282 | 366 | 0.2855 | 3.43e-01 | 0.83 | 0.3461 | pass | pass | pass |
| ETH | 1d | down | 5.0% | 1282 | 171 | 0.1334 | 1.33e-01 | 1.00 | 0.1492 | pass | pass | pass |
| ETH | 1d | down | 7.5% | 1282 | 62 | 0.0484 | 3.49e-02 | 1.38 sig | 0.0617 | pass | pass | pass |
| ETH | 1d | down | 10.0% | 1282 | 26 | 0.0203 | 8.06e-03 | 2.52 sig | 0.0322 | pass | pass | pass |
| ETH | 1d | down | 15.0% | 1282 | 9 | 0.0070 | 2.91e-04 | 24.13 sig | 0.0123 | pass | pass | pass |
| ETH | 1d | down | 20.0% | 1282 | 3 | 0.0023 | 4.89e-06 | 478.94 sig | 0.0065 | pass | pass | pass |
| ETH | 1d | up | 1.0% | 1282 | 857 | 0.6685 | 7.40e-01 | 0.90 | 0.7400 | pass | pass | pass |
| ETH | 1d | up | 2.0% | 1282 | 565 | 0.4407 | 5.17e-01 | 0.85 | 0.5173 | pass | pass | pass |
| ETH | 1d | up | 3.0% | 1282 | 344 | 0.2683 | 3.46e-01 | 0.77 | 0.3471 | pass | pass | pass |
| ETH | 1d | up | 5.0% | 1282 | 133 | 0.1037 | 1.43e-01 | 0.73 | 0.1518 | pass | pass | pass |
| ETH | 1d | up | 7.5% | 1282 | 53 | 0.0413 | 4.35e-02 | 0.95 | 0.0633 | pass | pass | pass |
| ETH | 1d | up | 10.0% | 1282 | 20 | 0.0156 | 1.27e-02 | 1.23 | 0.0333 | pass | pass | pass |
| ETH | 1d | up | 15.0% | 1282 | 7 | 0.0055 | 9.98e-04 | 5.47 sig | 0.0134 | pass | pass | pass |
| ETH | 1d | up | 20.0% | 1282 | 3 | 0.0023 | 6.87e-05 | 34.07 sig | 0.0081 | pass | pass | pass |
| SOL | 1d | down | 1.0% | 1276 | 975 | 0.7641 | 8.03e-01 | 0.95 | 0.8028 | pass | pass | pass |
| SOL | 1d | down | 2.0% | 1276 | 714 | 0.5596 | 6.18e-01 | 0.91 | 0.6178 | pass | pass | pass |
| SOL | 1d | down | 3.0% | 1276 | 507 | 0.3973 | 4.57e-01 | 0.87 | 0.4575 | pass | pass | pass |
| SOL | 1d | down | 5.0% | 1276 | 258 | 0.2022 | 2.26e-01 | 0.89 | 0.2335 | pass | pass | pass |
| SOL | 1d | down | 7.5% | 1276 | 116 | 0.0909 | 8.19e-02 | 1.11 | 0.1044 | pass | pass | pass |
| SOL | 1d | down | 10.0% | 1276 | 40 | 0.0313 | 2.70e-02 | 1.16 | 0.0548 | pass | pass | pass |
| SOL | 1d | down | 15.0% | 1276 | 16 | 0.0125 | 2.59e-03 | 4.85 sig | 0.0211 | pass | pass | pass |
| SOL | 1d | down | 20.0% | 1276 | 7 | 0.0055 | 2.04e-04 | 26.93 sig | 0.0105 | pass | pass | pass |
| SOL | 1d | up | 1.0% | 1276 | 997 | 0.7813 | 7.97e-01 | 0.98 | 0.7968 | pass | pass | pass |
| SOL | 1d | up | 2.0% | 1276 | 729 | 0.5713 | 6.12e-01 | 0.93 | 0.6124 | pass | pass | pass |
| SOL | 1d | up | 3.0% | 1276 | 541 | 0.4240 | 4.56e-01 | 0.93 | 0.4563 | pass | pass | pass |
| SOL | 1d | up | 5.0% | 1276 | 279 | 0.2187 | 2.36e-01 | 0.93 | 0.2382 | pass | pass | pass |
| SOL | 1d | up | 7.5% | 1276 | 114 | 0.0893 | 9.51e-02 | 0.94 | 0.1095 | pass | pass | pass |
| SOL | 1d | up | 10.0% | 1276 | 61 | 0.0478 | 3.70e-02 | 1.29 sig | 0.0587 | pass | pass | pass |
| SOL | 1d | up | 15.0% | 1276 | 11 | 0.0086 | 5.73e-03 | 1.50 | 0.0240 | pass | pass | pass |
| SOL | 1d | up | 20.0% | 1276 | 5 | 0.0039 | 9.52e-04 | 4.12 sig | 0.0128 | pass | pass | pass |
| HYPE | 1d | down | 1.0% | 634 | 535 | 0.8438 | 8.48e-01 | 0.99 | 0.8481 | pass | pass | pass |
| HYPE | 1d | down | 2.0% | 634 | 424 | 0.6688 | 7.00e-01 | 0.95 | 0.7003 | pass | pass | pass |
| HYPE | 1d | down | 3.0% | 634 | 337 | 0.5315 | 5.63e-01 | 0.94 | 0.5631 | pass | pass | pass |
| HYPE | 1d | down | 5.0% | 634 | 178 | 0.2808 | 3.37e-01 | 0.83 | 0.3390 | pass | pass | pass |
| HYPE | 1d | down | 7.5% | 634 | 83 | 0.1309 | 1.56e-01 | 0.84 | 0.1683 | pass | pass | pass |
| HYPE | 1d | down | 10.0% | 634 | 40 | 0.0631 | 6.42e-02 | 0.98 | 0.0888 | pass | pass | pass |
| HYPE | 1d | down | 15.0% | 634 | 9 | 0.0142 | 8.04e-03 | 1.77 sig | 0.0351 | pass | pass | pass |
| HYPE | 1d | down | 20.0% | 634 | 2 | 0.0032 | 7.08e-04 | 4.45 sig | 0.0169 | pass | pass | pass |
| HYPE | 1d | up | 1.0% | 634 | 531 | 0.8375 | 8.41e-01 | 1.00 | 0.8412 | pass | pass | pass |
| HYPE | 1d | up | 2.0% | 634 | 438 | 0.6909 | 6.92e-01 | 1.00 | 0.6921 | pass | pass | pass |
| HYPE | 1d | up | 3.0% | 634 | 352 | 0.5552 | 5.58e-01 | 1.00 | 0.5578 | pass | pass | pass |
| HYPE | 1d | up | 5.0% | 634 | 213 | 0.3360 | 3.43e-01 | 0.98 | 0.3433 | pass | pass | pass |
| HYPE | 1d | up | 7.5% | 634 | 107 | 0.1688 | 1.73e-01 | 0.98 | 0.1775 | pass | pass | pass |
| HYPE | 1d | up | 10.0% | 634 | 53 | 0.0836 | 8.17e-02 | 1.02 | 0.0969 | pass | pass | pass |
| HYPE | 1d | up | 15.0% | 634 | 16 | 0.0252 | 1.65e-02 | 1.53 sig | 0.0405 | pass | pass | pass |
| HYPE | 1d | up | 20.0% | 634 | 5 | 0.0079 | 3.09e-03 | 2.55 sig | 0.0215 | pass | pass | pass |
| BTC | 7d | down | 1.0% | 183 | 158 | 0.8634 | 8.70e-01 | 0.99 | 0.8704 | pass | pass | pass |
| BTC | 7d | down | 2.0% | 183 | 136 | 0.7432 | 7.43e-01 | 1.00 | 0.7430 | **FAIL** | **FAIL** | **FAIL** |
| BTC | 7d | down | 3.0% | 183 | 103 | 0.5628 | 6.22e-01 | 0.90 | 0.6221 | pass | **FAIL** | pass |
| BTC | 7d | down | 5.0% | 183 | 66 | 0.3607 | 4.13e-01 | 0.87 | 0.4212 | pass | pass | pass |
| BTC | 7d | down | 7.5% | 183 | 34 | 0.1858 | 2.27e-01 | 0.82 | 0.2679 | pass | pass | pass |
| BTC | 7d | down | 10.0% | 183 | 19 | 0.1038 | 1.15e-01 | 0.90 | 0.1793 | pass | pass | pass |
| BTC | 7d | down | 15.0% | 183 | 8 | 0.0437 | 2.54e-02 | 1.72 | 0.1001 | pass | pass | pass |
| BTC | 7d | down | 20.0% | 183 | 1 | 0.0055 | 4.89e-03 | 1.12 | 0.0708 | pass | pass | pass |
| BTC | 7d | up | 1.0% | 183 | 156 | 0.8525 | 8.63e-01 | 0.99 | 0.8631 | pass | pass | pass |
| BTC | 7d | up | 2.0% | 183 | 132 | 0.7213 | 7.33e-01 | 0.98 | 0.7332 | pass | pass | pass |
| BTC | 7d | up | 3.0% | 183 | 102 | 0.5574 | 6.14e-01 | 0.91 | 0.6140 | pass | pass | pass |
| BTC | 7d | up | 5.0% | 183 | 72 | 0.3934 | 4.14e-01 | 0.95 | 0.4202 | pass | pass | pass |
| BTC | 7d | up | 7.5% | 183 | 42 | 0.2295 | 2.41e-01 | 0.95 | 0.2739 | pass | pass | pass |
| BTC | 7d | up | 10.0% | 183 | 23 | 0.1257 | 1.35e-01 | 0.93 | 0.2014 | pass | pass | pass |
| BTC | 7d | up | 15.0% | 183 | 7 | 0.0383 | 4.07e-02 | 0.94 | 0.1330 | pass | pass | pass |
| BTC | 7d | up | 20.0% | 183 | 4 | 0.0219 | 1.24e-02 | 1.76 | 0.1016 | pass | pass | pass |
| ETH | 7d | down | 1.0% | 183 | 159 | 0.8689 | 9.06e-01 | 0.96 | 0.9056 | pass | pass | pass |
| ETH | 7d | down | 2.0% | 183 | 142 | 0.7760 | 8.11e-01 | 0.96 | 0.8114 | pass | pass | pass |
| ETH | 7d | down | 3.0% | 183 | 124 | 0.6776 | 7.19e-01 | 0.94 | 0.7193 | pass | pass | pass |
| ETH | 7d | down | 5.0% | 183 | 90 | 0.4918 | 5.49e-01 | 0.90 | 0.5499 | pass | pass | pass |
| ETH | 7d | down | 7.5% | 183 | 62 | 0.3388 | 3.71e-01 | 0.91 | 0.3848 | pass | pass | pass |
| ETH | 7d | down | 10.0% | 183 | 42 | 0.2295 | 2.39e-01 | 0.96 | 0.2759 | pass | **FAIL** | pass |
| ETH | 7d | down | 15.0% | 183 | 17 | 0.0929 | 8.70e-02 | 1.07 | 0.1553 | pass | pass | pass |
| ETH | 7d | down | 20.0% | 183 | 10 | 0.0546 | 2.71e-02 | 2.02 sig | 0.1020 | pass | pass | pass |
| ETH | 7d | up | 1.0% | 183 | 161 | 0.8798 | 8.98e-01 | 0.98 | 0.8975 | pass | pass | pass |
| ETH | 7d | up | 2.0% | 183 | 132 | 0.7213 | 7.99e-01 | 0.90 | 0.7990 | pass | pass | pass |
| ETH | 7d | up | 3.0% | 183 | 109 | 0.5956 | 7.06e-01 | 0.84 | 0.7060 | pass | pass | pass |
| ETH | 7d | up | 5.0% | 183 | 85 | 0.4645 | 5.41e-01 | 0.86 | 0.5419 | pass | pass | pass |
| ETH | 7d | up | 7.5% | 183 | 60 | 0.3279 | 3.77e-01 | 0.87 | 0.3879 | pass | pass | pass |
| ETH | 7d | up | 10.0% | 183 | 38 | 0.2077 | 2.57e-01 | 0.81 | 0.2881 | pass | pass | pass |
| ETH | 7d | up | 15.0% | 183 | 17 | 0.0929 | 1.15e-01 | 0.81 | 0.1853 | pass | pass | pass |
| ETH | 7d | up | 20.0% | 183 | 7 | 0.0383 | 5.00e-02 | 0.77 | 0.1395 | pass | pass | pass |
| SOL | 7d | down | 1.0% | 182 | 163 | 0.8956 | 9.28e-01 | 0.97 | 0.9280 | pass | **FAIL** | **FAIL** |
| SOL | 7d | down | 2.0% | 182 | 147 | 0.8077 | 8.56e-01 | 0.94 | 0.8555 | pass | pass | pass |
| SOL | 7d | down | 3.0% | 182 | 132 | 0.7253 | 7.83e-01 | 0.93 | 0.7833 | pass | pass | pass |
| SOL | 7d | down | 5.0% | 182 | 110 | 0.6044 | 6.43e-01 | 0.94 | 0.6434 | pass | pass | pass |
| SOL | 7d | down | 7.5% | 182 | 78 | 0.4286 | 4.84e-01 | 0.89 | 0.4869 | pass | pass | pass |
| SOL | 7d | down | 10.0% | 182 | 62 | 0.3407 | 3.50e-01 | 0.97 | 0.3652 | pass | pass | pass |
| SOL | 7d | down | 15.0% | 182 | 25 | 0.1374 | 1.64e-01 | 0.84 | 0.2185 | pass | pass | pass |
| SOL | 7d | down | 20.0% | 182 | 13 | 0.0714 | 6.80e-02 | 1.05 | 0.1401 | pass | pass | pass |
| SOL | 7d | up | 1.0% | 182 | 169 | 0.9286 | 9.20e-01 | 1.01 | 0.9196 | **FAIL** | pass | pass |
| SOL | 7d | up | 2.0% | 182 | 153 | 0.8407 | 8.42e-01 | 1.00 | 0.8415 | pass | pass | pass |
| SOL | 7d | up | 3.0% | 182 | 132 | 0.7253 | 7.67e-01 | 0.95 | 0.7666 | pass | pass | pass |
| SOL | 7d | up | 5.0% | 182 | 104 | 0.5714 | 6.28e-01 | 0.91 | 0.6282 | pass | pass | pass |
| SOL | 7d | up | 7.5% | 182 | 81 | 0.4451 | 4.80e-01 | 0.93 | 0.4816 | pass | pass | pass |
| SOL | 7d | up | 10.0% | 182 | 61 | 0.3352 | 3.60e-01 | 0.93 | 0.3711 | pass | pass | pass |
| SOL | 7d | up | 15.0% | 182 | 37 | 0.2033 | 1.95e-01 | 1.04 | 0.2433 | pass | pass | pass |
| SOL | 7d | up | 20.0% | 182 | 22 | 0.1209 | 1.03e-01 | 1.17 | 0.1800 | pass | pass | pass |
| HYPE | 7d | down | 1.0% | 90 | 85 | 0.9444 | 9.45e-01 | 1.00 | 0.9453 | pass | pass | pass |
| HYPE | 7d | down | 2.0% | 90 | 74 | 0.8222 | 8.90e-01 | 0.92 | 0.8899 | pass | pass | pass |
| HYPE | 7d | down | 3.0% | 90 | 73 | 0.8111 | 8.34e-01 | 0.97 | 0.8342 | pass | pass | pass |
| HYPE | 7d | down | 5.0% | 90 | 61 | 0.6778 | 7.23e-01 | 0.94 | 0.7233 | pass | pass | pass |
| HYPE | 7d | down | 7.5% | 90 | 51 | 0.5667 | 5.90e-01 | 0.96 | 0.5900 | pass | pass | pass |
| HYPE | 7d | down | 10.0% | 90 | 41 | 0.4556 | 4.67e-01 | 0.97 | 0.4702 | pass | pass | pass |
| HYPE | 7d | down | 15.0% | 90 | 24 | 0.2667 | 2.69e-01 | 0.99 | 0.2979 | pass | pass | pass |
| HYPE | 7d | down | 20.0% | 90 | 16 | 0.1778 | 1.38e-01 | 1.29 | 0.1981 | pass | pass | pass |
| HYPE | 7d | up | 1.0% | 90 | 81 | 0.9000 | 9.36e-01 | 0.96 | 0.9365 | pass | pass | pass |
| HYPE | 7d | up | 2.0% | 90 | 76 | 0.8444 | 8.75e-01 | 0.97 | 0.8746 | pass | pass | pass |
| HYPE | 7d | up | 3.0% | 90 | 70 | 0.7778 | 8.15e-01 | 0.95 | 0.8146 | pass | pass | pass |
| HYPE | 7d | up | 5.0% | 90 | 59 | 0.6556 | 7.01e-01 | 0.93 | 0.7013 | pass | pass | pass |
| HYPE | 7d | up | 7.5% | 90 | 48 | 0.5333 | 5.74e-01 | 0.93 | 0.5741 | pass | pass | pass |
| HYPE | 7d | up | 10.0% | 90 | 37 | 0.4111 | 4.64e-01 | 0.89 | 0.4661 | pass | pass | pass |
| HYPE | 7d | up | 15.0% | 90 | 25 | 0.2778 | 2.94e-01 | 0.94 | 0.3164 | pass | pass | pass |
| HYPE | 7d | up | 20.0% | 90 | 19 | 0.2111 | 1.81e-01 | 1.16 | 0.2324 | pass | pass | pass |

## Limitations (read before trusting the numbers)

The evidence is real but thinner than the tables make it look. The Wilson bounds treat every window as an independent draw, and they are not: the same window is counted at eight distances, BTC, ETH, SOL and HYPE move together (a market-wide crash is one event, counted up to four times when we pool coins), and volatility clusters in time. The effective sample is therefore much smaller than the window counts, and the true uncertainty around every k and q is wider than the bounds state. The 1h and 4h evidence still comes from only ~7 months of 1-hour candles, essentially one market regime; the 1d and 7d evidence spans 2023-2026 but 7d has fewer than 200 windows per coin. Touches are measured on Hyperliquid trade-price candles, not on the oracle the covers trigger on (oracle minute history exists only in a requester-pays S3 archive and was not used).

- **D13-specific.** (1) The 1d table is fitted on z with daily sigma, while the live engine uses 1h sigma (see the sigma comparison above); the check under the live sigma covers only ~7 months, and 1d windows always start at 00:00 UTC whereas a live 1d quote can start at any time (intraday seasonality is not modelled). (2) Nearward pooling is conservative only if the touch frequency really is non-increasing in |z|; that holds for the true probability, not for a bucket's noisy estimate, which is the point. Its bound overstates the frequency of a pooled bucket by design (it carries some nearer-money touches). (3) N = 300 is a judgement, not an estimate; the sensitivity rows show how much it matters. (4) Daily candles before an asset's HL listing do not exist; HYPE has ~10 months.
- What would make it stronger: oracle history from the S3 archive (years, and the actual trigger price); block-bootstrap or cluster-robust intervals instead of Wilson; a scheduled refit with the out-of-sample pass rate tracked over time.
- The tables are point-in-time. A failing bucket after refit is a signal to widen the margin, not noise.
