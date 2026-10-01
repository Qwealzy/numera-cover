# Calibration backtest: one-touch model on Hyperliquid history

Generated 2026-10-01T18:17Z by `python -m numera_engine.backtest --coins BTC ETH SOL HYPE` (model `gbm-touch-v1`, tail table `z-per-horizon-v3`, decisions D9 and D11). Source: Hyperliquid mainnet Info API `candleSnapshot`, read-only. Files: `calibration.csv` (per coin/horizon/distance bucket with out-of-sample columns for every method), `calibration_z.csv` (z buckets: per horizon = the published table, `all` = the pooled comparison), `calibration_z_by_horizon.csv` (diagnostic), `calibration.svg` (reliability plot), `tail_multipliers.json` (consumed by the quote API).

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
Lookup: k is the value of the |z| bucket that holds |z| (an empty bucket borrows the nearest populated one, nearer-the-money first). q is first made non-increasing in |z| (each bucket takes the max of itself and all further buckets) and then interpolated log-linearly between bucket mid-points, so the price is continuous in the level and never rises as the level moves away. k >= 1 always: the engine never prices below the model, even where the model over-predicts. Quote API: `breakdown` returns `sigma, touchProb (= p), loading (= theta), premium, model` plus `tailMultiplier (= k), tailFloor (= q), pricedProb, fee, coin, z, spotSource (pool | info_api), pool`. Request may carry an optional `pool` (default: configured pool), which must be in the allowlist (configured pool + pools in deployments/<env>.json); the quote is signed for that pool. Errors `{error, reason}`: 400 `invalid_request`, `unknown_perp`, `unknown_pool`, `duration_out_of_range`; 422 `level_already_breached`, `prob_too_high`, `capacity`; 403 `chain_not_allowed`; 503 `market_data_unavailable`, `signer_unavailable`. Nonce random in [1, 2^53) so JSON numbers stay exact in JavaScript. Never signs for chainId 999.

## Method

- **Question.** When the engine says "probability p that the price touches level L within T", does that happen with frequency p or less in real Hyperliquid data?
- **Data.** Horizons 1h, 4h, 1d: 1-hour candles (the Info API keeps only the latest ~5000). Horizon 7d: 1-day candles from 2023-02-26 on; zero-volume rows and earlier rows dropped (HL-traded data only).
- **No look-ahead.** At each window start, sigma = max(EWMA lambda=0.94 of log returns, 30-day realized), annualized, from candles that closed before the start only. A 30-day warm-up is skipped. The 7d horizon uses daily candles for sigma (1h history is too short for enough 7d windows).
- **Windows.** Non-overlapping (step = horizon), aligned to multiples of the horizon since the unix epoch. S = open of the first candle. Levels 1, 2, 3, 5, 7.5, 10, 15, 20 % below S (`down`, long cover) and above S (`up`, short cover). Touched if min(low) <= S(1-d) or max(high) >= S(1+d) in the window. Windows with a missing candle are skipped.
- **Model.** Closed-form one-touch probability under driftless GBM (ARCHITECTURE §7; checked against Monte Carlo in `tests/test_pricing.py`).
- **Tail adjustment by credibility pooling on standardized distance.** Under the model, p depends on the level only through z = ln(L/S)/(sigma sqrt(T)) (plus a drift term of size sigma sqrt(T)/2, small here). Windows with the same z are the same risk to the model, so we pool them into |z| buckets (0.25 wide up to 4, then 4-5, 5-7, >= 7), separately for down and up levels. This is actuarial credibility pooling: thin cells (177 one-day windows per coin) borrow strength from related experience, and the fitted adjustment answers "how wrong is the model at this z". Per bucket: q = Wilson one-sided 95 % upper bound of the realized touch frequency, k = clamp(q / mean p, 1, 10) (k = 1 when nothing touched).
- **Adopted (D11): one z table per horizon, pooled over coins only (v3).** Pooling across horizons too (v2) was tried first; the per-horizon diagnostic showed the model's error at a given z depends on the horizon (7d at |z| 2-4 was under-priced about 4x by the fully pooled table, because short horizons dominate the pooled counts). Liquidation covers live in the far tail (a 10x long is ~9 % from liquidation; with BTC 1d sigma ~2 % that is |z| ~4-5), exactly where full pooling under-prices, so the per-horizon table is the conservative choice. Compared alternatives are kept below.
- **Out-of-sample protocol.** Each horizon's windows are split at the median start time. Every method is fitted on the first halves only and evaluated on the second halves: (a) per coin/horizon/direction/% bucket, pass if realized frequency <= mean priced probability; (b) a pool P&L simulation trading the second half.
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

## Headline: compared methods, out of sample

Fit on the first half of each horizon, test and trade the second half. Each horizon cell: loss ratio (claims / premiums) / price multiple (average premium per 100 USDC of cover divided by the raw model's, both with the 20 % loading) / failing % buckets (realized > priced). Max drawdown is in the simulation table below. D9 target for the loss ratio: 0.5-0.8.

| method | OOS failing buckets | 1h | 4h | 1d | 7d |
|---|---|---|---|---|---|
| raw model (k = 1, no floor) | - | 1.03 / 1.00x / - | 0.53 / 1.00x / - | 0.58 / 1.00x / - | 0.79 / 1.00x / - |
| v1 per coin x horizon x % distance | 1/240 | 0.24 / 4.25x / 0/64 | 0.30 / 1.78x / 0/64 | 0.35 / 1.42x / 1/64 | 0.62 / 1.15x / 0/48 |
| v2 z pooled over coins and horizons | 34/240 | 0.45 / 2.31x / 9/64 | 0.45 / 1.18x / 7/64 | 0.55 / 1.05x / 8/64 | 0.79 / 1.00x / 10/48 |
| **v3 z per horizon, pooled over coins (adopted, D11)** | **17/240** | 0.43 / 2.41x / 9/64 | 0.41 / 1.29x / 4/64 | 0.46 / 1.26x / 0/64 | 0.69 / 1.13x / 4/48 |
| v3 + monotone pooling of thin z buckets (PAVA; not adopted) | 27/240 | 0.46 / 2.22x / 12/64 | 0.42 / 1.25x / 7/64 | 0.51 / 1.14x / 3/64 | 0.71 / 1.11x / 5/48 |

- Adopted v3: 17/240 % buckets fail out of sample. v1 fails fewer because its per-bucket floors are fitted on very thin cells and are therefore very wide (it prices 1h covers at ~4x the raw model); v2 is cheapest but under-prices 7d and the far tail.
- Side effect of thin per-horizon tables: at 1d and 7d a far |z| bucket with ~100 windows and one touch gets a wide upper bound (e.g. 1 in 110 -> q ~ 4 %), and the never-cheaper-further-away rule lifts every nearer bucket to it. Quotes in that |z| range (about 3-4 for 1d) are therefore expensive. `v3p` pools such buckets with their neighbours first (PAVA: the maximum-likelihood fit with touch frequency non-increasing in |z|): cheaper there, but it fails more buckets out of sample, so the conservative v3 stays adopted (D11). Better data (oracle history) is the real fix.
- 1h and 4h loss ratios sit below the 0.5 target: at |z| < 2 the raw model over-predicts touches (realized / p about 0.6-0.9) and k >= 1 by design does not discount that (D11: no near-money discount in v1). The far-tail floor adds premium on top. Covers are priced at the observed tail, which protects LPs.
- In-sample with the published v3 tables: 246/256 % buckets pass (not by construction: tables are fitted on z buckets, not on these buckets).
- Raw model: realized above predicted in 66 of 256 % buckets, significantly (Wilson 95 % lower bound above p) in 37.

## Published tables: z buckets per horizon (v3)

Fitted on all windows (both halves) of all coins, per horizon. Cell = touches/windows, k, q. `realized / p` per bucket is in `calibration_z.csv`.

| dir | abs z | 1h touches/windows | 1h k | 1h q | 4h touches/windows | 4h k | 4h q | 1d touches/windows | 1d k | 1d q | 7d touches/windows | 7d k | 7d q |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| down | 0-0.25 | 0/0 |  |  | 10/12 |  |  | 135/170 | 1.00 | 8.40e-01 | 998/1172 | 1.00 | 8.68e-01 |
| down | 0.25-0.5 | 27/43 | 1.11 | 7.38e-01 | 314/511 | 1.00 | 6.49e-01 | 407/666 | 1.00 | 6.42e-01 | 627/912 | 1.00 | 7.12e-01 |
| down | 0.5-0.75 | 183/445 | 1.00 | 4.50e-01 | 474/1217 | 1.00 | 4.13e-01 | 205/492 | 1.00 | 4.54e-01 | 300/604 | 1.00 | 5.30e-01 |
| down | 0.75-1 | 460/1598 | 1.00 | 3.07e-01 | 472/1746 | 1.00 | 2.88e-01 | 117/435 | 1.00 | 3.05e-01 | 160/464 | 1.00 | 3.82e-01 |
| down | 1-1.25 | 309/2059 | 1.00 | 1.63e-01 | 259/1632 | 1.00 | 1.74e-01 | 69/332 | 1.00 | 2.47e-01 | 101/414 | 1.01 | 2.80e-01 |
| down | 1.25-1.5 | 292/2828 | 1.00 | 1.13e-01 | 135/1150 | 1.00 | 1.34e-01 | 33/279 | 1.00 | 1.54e-01 | 50/275 | 1.23 | 2.23e-01 |
| down | 1.5-1.75 | 311/4532 | 1.00 | 7.51e-02 | 86/1343 | 1.00 | 7.59e-02 | 16/284 | 1.00 | 8.33e-02 | 34/288 | 1.35 | 1.53e-01 |
| down | 1.75-2 | 141/2436 | 1.04 | 6.62e-02 | 45/914 | 1.00 | 6.24e-02 | 3/182 | 1.00 | 4.05e-02 | 17/199 | 1.84 | 1.24e-01 |
| down | 2-2.25 | 107/3217 | 1.12 | 3.89e-02 | 47/1188 | 1.41 | 5.00e-02 | 2/193 | 1.00 | 3.08e-02 | 13/156 | 3.40 | 1.27e-01 |
| down | 2.25-2.5 | 76/3354 | 1.46 | 2.73e-02 | 27/1097 | 1.84 | 3.36e-02 | 2/206 | 1.57 | 2.89e-02 | 9/151 | 5.06 | 9.97e-02 |
| down | 2.5-2.75 | 52/2347 | 3.21 | 2.77e-02 | 12/890 | 2.38 | 2.15e-02 | 1/182 | 2.55 | 2.42e-02 | 6/116 | 9.88 | 9.69e-02 |
| down | 2.75-3 | 33/2226 | 4.61 | 1.97e-02 | 12/693 | 6.52 | 2.75e-02 | 2/161 | 8.42 | 3.68e-02 | 3/56 | 10.00 | 1.27e-01 |
| down | 3-3.25 | 21/2724 | 5.95 | 1.10e-02 | 6/763 | 7.82 | 1.51e-02 | 0/140 | 1.00 | 1.90e-02 | 2/65 | 10.00 | 8.88e-02 |
| down | 3.25-3.5 | 16/2618 | 10.00 | 9.18e-03 | 4/674 | 10.00 | 1.32e-02 | 0/155 | 1.00 | 1.72e-02 | 2/58 | 10.00 | 9.90e-02 |
| down | 3.5-3.75 | 15/2041 | 10.00 | 1.12e-02 | 3/639 | 10.00 | 1.17e-02 | 1/165 | 10.00 | 2.67e-02 | 3/54 | 10.00 | 1.31e-01 |
| down | 3.75-4 | 7/1636 | 10.00 | 7.87e-03 | 2/590 | 10.00 | 1.02e-02 | 1/110 | 10.00 | 3.97e-02 | 0/22 |  |  |
| down | 4-5 | 39/9148 | 10.00 | 5.54e-03 | 2/2123 | 10.00 | 2.84e-03 | 0/381 | 1.00 | 7.05e-03 | 0/67 | 1.00 | 3.88e-02 |
| down | 5-7 | 17/12082 | 10.00 | 2.09e-03 | 0/3855 | 1.00 | 7.01e-04 | 0/554 | 1.00 | 4.86e-03 | 1/29 |  |  |
| down | >= 7 | 4/81666 | 10.00 | 1.09e-04 | 0/13195 | 1.00 | 2.05e-04 | 0/577 | 1.00 | 4.67e-03 | 0/2 |  |  |
| up | 0-0.25 | 0/0 |  |  | 12/13 |  |  | 138/174 | 1.00 | 8.39e-01 | 1023/1197 | 1.00 | 8.71e-01 |
| up | 0.25-0.5 | 21/46 | 1.00 | 5.76e-01 | 311/522 | 1.00 | 6.31e-01 | 424/675 | 1.00 | 6.58e-01 | 609/970 | 1.00 | 6.53e-01 |
| up | 0.5-0.75 | 191/469 | 1.00 | 4.45e-01 | 493/1283 | 1.00 | 4.07e-01 | 214/508 | 1.00 | 4.58e-01 | 280/660 | 1.00 | 4.56e-01 |
| up | 0.75-1 | 417/1619 | 1.00 | 2.76e-01 | 422/1764 | 1.00 | 2.56e-01 | 130/467 | 1.00 | 3.14e-01 | 169/511 | 1.00 | 3.66e-01 |
| up | 1-1.25 | 313/2141 | 1.00 | 1.59e-01 | 280/1639 | 1.00 | 1.87e-01 | 70/340 | 1.00 | 2.44e-01 | 97/419 | 1.06 | 2.67e-01 |
| up | 1.25-1.5 | 282/2984 | 1.00 | 1.04e-01 | 114/1232 | 1.00 | 1.07e-01 | 35/296 | 1.00 | 1.53e-01 | 58/339 | 1.29 | 2.07e-01 |
| up | 1.5-1.75 | 335/4568 | 1.00 | 7.99e-02 | 98/1347 | 1.00 | 8.53e-02 | 31/287 | 1.36 | 1.42e-01 | 29/269 | 1.43 | 1.43e-01 |
| up | 1.75-2 | 88/2501 | 1.00 | 4.18e-02 | 44/1052 | 1.00 | 5.32e-02 | 5/189 | 1.00 | 5.33e-02 | 24/190 | 3.02 | 1.71e-01 |
| up | 2-2.25 | 133/3499 | 1.30 | 4.37e-02 | 44/1208 | 1.38 | 4.64e-02 | 8/263 | 1.63 | 5.32e-02 | 11/163 | 3.39 | 1.07e-01 |
| up | 2.25-2.5 | 54/3087 | 1.18 | 2.18e-02 | 27/1060 | 1.97 | 3.47e-02 | 7/207 | 3.47 | 6.12e-02 | 10/91 | 10.00 | 1.75e-01 |
| up | 2.5-2.75 | 38/2450 | 2.38 | 2.02e-02 | 17/943 | 3.10 | 2.67e-02 | 7/195 | 7.74 | 6.49e-02 | 4/74 | 10.00 | 1.15e-01 |
| up | 2.75-3 | 32/2428 | 4.27 | 1.76e-02 | 6/765 | 3.76 | 1.51e-02 | 0/181 | 1.00 | 1.47e-02 | 1/72 | 10.00 | 5.99e-02 |
| up | 3-3.25 | 32/2775 | 8.42 | 1.54e-02 | 7/668 | 10.00 | 1.92e-02 | 0/194 | 1.00 | 1.38e-02 | 3/39 | 10.00 | 1.78e-01 |
| up | 3.25-3.5 | 25/2667 | 10.00 | 1.30e-02 | 7/785 | 10.00 | 1.64e-02 | 2/140 | 10.00 | 4.22e-02 | 1/31 | 10.00 | 1.32e-01 |
| up | 3.5-3.75 | 8/1930 | 10.00 | 7.34e-03 | 6/749 | 10.00 | 1.54e-02 | 1/114 | 10.00 | 3.84e-02 | 1/23 |  |  |
| up | 3.75-4 | 6/2278 | 10.00 | 5.09e-03 | 5/780 | 10.00 | 1.31e-02 | 3/136 | 10.00 | 5.39e-02 | 0/22 |  |  |
| up | 4-5 | 34/9046 | 10.00 | 4.98e-03 | 6/2090 | 10.00 | 5.54e-03 | 1/436 | 10.00 | 1.02e-02 | 1/29 |  |  |
| up | 5-7 | 10/12667 | 10.00 | 1.32e-03 | 8/4152 | 10.00 | 3.42e-03 | 5/534 | 10.00 | 1.91e-02 | 0/5 |  |  |
| up | >= 7 | 10/79845 | 10.00 | 2.09e-04 | 5/12180 | 10.00 | 8.43e-04 | 2/328 | 10.00 | 1.83e-02 | 0/0 |  |  |

## Compared alternative v2: one z table pooled over coins and horizons

`realized / p` > 1 means the raw model under-predicts at that z. This table shows the shape of the model error most clearly (most data), but was not adopted (see method).

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

## Per-horizon diagnostic

Second half, priced with tables fitted on the first halves. `actual / model` > 1: the raw model under-predicts there. `v2 pass` = fully pooled table, `v3 pass` = per-horizon table (adopted).

| horizon | dir | abs z | windows | touches | actual / model | realized | v2 priced | v2 pass | v3 priced | v3 pass |
|---|---|---|---|---|---|---|---|---|---|---|
| 1h | down | 0-1 | 562 | 140 | 0.62 | 2.49e-01 | 4.01e-01 | pass | 4.01e-01 | pass |
| 1h | down | 1-2 | 5611 | 469 | 0.57 | 8.36e-02 | 1.49e-01 | pass | 1.50e-01 | pass |
| 1h | down | 2-3 | 5543 | 117 | 1.18 | 2.11e-02 | 3.57e-02 | pass | 3.62e-02 | pass |
| 1h | down | 3-4 | 4454 | 27 | 6.41 | 6.06e-03 | 1.47e-02 | pass | 1.53e-02 | pass |
| 1h | down | 4-7 | 10106 | 22 | 384.68 | 2.18e-03 | 3.81e-03 | pass | 4.59e-03 | pass |
| 1h | down | >= 7 | 42236 | 1 | 987771914.28 | 2.37e-05 | 1.74e-04 | pass | 2.04e-04 | pass |
| 1h | up | 0-1 | 583 | 123 | 0.53 | 2.11e-01 | 3.98e-01 | pass | 3.98e-01 | pass |
| 1h | up | 1-2 | 5726 | 447 | 0.53 | 7.81e-02 | 1.47e-01 | pass | 1.47e-01 | pass |
| 1h | up | 2-3 | 5663 | 114 | 1.13 | 2.01e-02 | 3.42e-02 | pass | 3.49e-02 | pass |
| 1h | up | 3-4 | 4559 | 38 | 8.28 | 8.34e-03 | 1.43e-02 | pass | 1.51e-02 | pass |
| 1h | up | 4-7 | 10763 | 21 | 326.31 | 1.95e-03 | 3.25e-03 | pass | 3.52e-03 | pass |
| 1h | up | >= 7 | 41218 | 10 | 10074122393.96 | 2.43e-04 | 1.09e-04 | **FAIL** | 7.67e-05 | **FAIL** |
| 4h | down | 0-1 | 1543 | 498 | 0.67 | 3.23e-01 | 4.79e-01 | pass | 4.80e-01 | pass |
| 4h | down | 1-2 | 2505 | 210 | 0.51 | 8.38e-02 | 1.66e-01 | pass | 1.68e-01 | pass |
| 4h | down | 2-3 | 1952 | 34 | 0.99 | 1.74e-02 | 3.54e-02 | pass | 4.93e-02 | pass |
| 4h | down | 3-4 | 1282 | 4 | 4.70 | 3.12e-03 | 1.34e-02 | pass | 2.16e-02 | pass |
| 4h | down | 4-7 | 2960 | 1 | 46.05 | 3.38e-04 | 3.52e-03 | pass | 3.31e-03 | pass |
| 4h | down | >= 7 | 6878 | 0 | 0.00 | 0.00e+00 | 1.79e-04 | pass | 4.43e-04 | pass |
| 4h | up | 0-1 | 1575 | 506 | 0.68 | 3.21e-01 | 4.75e-01 | pass | 4.75e-01 | pass |
| 4h | up | 1-2 | 2553 | 230 | 0.55 | 9.01e-02 | 1.65e-01 | pass | 1.66e-01 | pass |
| 4h | up | 2-3 | 1981 | 44 | 1.21 | 2.22e-02 | 3.43e-02 | pass | 4.43e-02 | pass |
| 4h | up | 3-4 | 1549 | 15 | 15.11 | 9.68e-03 | 1.09e-02 | pass | 1.77e-02 | pass |
| 4h | up | 4-7 | 3047 | 9 | 522.09 | 2.95e-03 | 2.86e-03 | **FAIL** | 4.58e-03 | pass |
| 4h | up | >= 7 | 6415 | 4 | 18731280140.19 | 6.24e-04 | 1.16e-04 | **FAIL** | 8.30e-04 | pass |
| 1d | down | 0-1 | 851 | 389 | 0.78 | 4.57e-01 | 5.88e-01 | pass | 5.90e-01 | pass |
| 1d | down | 1-2 | 529 | 49 | 0.56 | 9.26e-02 | 1.68e-01 | pass | 1.84e-01 | pass |
| 1d | down | 2-3 | 367 | 0 | 0.00 | 0.00e+00 | 3.52e-02 | pass | 8.12e-02 | pass |
| 1d | down | 3-4 | 292 | 0 | 0.00 | 0.00e+00 | 1.40e-02 | pass | 7.91e-02 | pass |
| 1d | down | 4-7 | 486 | 0 | 0.00 | 0.00e+00 | 3.68e-03 | pass | 1.48e-02 | pass |
| 1d | down | >= 7 | 323 | 0 | 0.00 | 0.00e+00 | 2.26e-04 | pass | 1.05e-02 | pass |
| 1d | up | 0-1 | 879 | 409 | 0.81 | 4.65e-01 | 5.78e-01 | pass | 5.80e-01 | pass |
| 1d | up | 1-2 | 541 | 65 | 0.75 | 1.20e-01 | 1.61e-01 | pass | 1.92e-01 | pass |
| 1d | up | 2-3 | 416 | 14 | 1.89 | 3.37e-02 | 3.44e-02 | pass | 7.83e-02 | pass |
| 1d | up | 3-4 | 311 | 5 | 19.04 | 1.61e-02 | 1.29e-02 | **FAIL** | 5.57e-02 | pass |
| 1d | up | 4-7 | 513 | 5 | 1403.00 | 9.75e-03 | 3.37e-03 | **FAIL** | 2.09e-02 | pass |
| 1d | up | >= 7 | 188 | 2 | 77558867247.08 | 1.06e-02 | 1.46e-04 | **FAIL** | 1.90e-02 | pass |
| 7d | down | 0-1 | 1861 | 1272 | 0.96 | 6.84e-01 | 7.11e-01 | pass | 7.11e-01 | pass |
| 7d | down | 1-2 | 665 | 127 | 1.05 | 1.91e-01 | 1.82e-01 | **FAIL** | 2.26e-01 | pass |
| 7d | down | 2-3 | 253 | 22 | 4.00 | 8.70e-02 | 3.95e-02 | **FAIL** | 1.37e-01 | pass |
| 7d | down | 3-4 | 94 | 2 | 23.89 | 2.13e-02 | 1.46e-02 | **FAIL** | 1.29e-01 | pass |
| 7d | down | 4-7 | 55 | 0 | 0.00 | 0.00e+00 | 4.96e-03 | pass | 8.27e-02 | pass |
| 7d | up | 0-1 | 1978 | 1189 | 0.89 | 6.01e-01 | 6.84e-01 | pass | 7.06e-01 | pass |
| 7d | up | 1-2 | 671 | 100 | 0.91 | 1.49e-01 | 1.64e-01 | pass | 2.81e-01 | pass |
| 7d | up | 2-3 | 198 | 11 | 2.87 | 5.56e-02 | 3.68e-02 | **FAIL** | 1.78e-01 | pass |
| 7d | up | 3-4 | 61 | 1 | 18.57 | 1.64e-02 | 1.30e-02 | **FAIL** | 8.03e-02 | pass |
| 7d | up | 4-7 | 20 | 0 | 0.00 | 0.00e+00 | 5.02e-03 | pass | 8.03e-02 | pass |

## Findings in plain language

- **Near the money (|z| < 2) the model over-predicts:** 13547 touches where it expected 17626 (0.77x). Likely reasons (not tested separately): the 30-day realized floor keeps sigma high after volatile spells, and short-horizon returns mean-revert a little.
- **2 <= |z| < 4:** 993 touches vs 619.6 expected (1.60x).
- **The tail (|z| >= 4) is where GBM fails:** 145 touches in 244991 windows where the model expected 0.37. These are the flash moves liquidation cover exists for; the floor q prices them at their observed frequency (upper bound) instead of ~0.
- **Direction:** actual/expected 0.81 for down levels (long covers), 0.80 for up.
- **Per-horizon diagnostic:** 11 horizon x z cells fail out of sample with the fully pooled table, 1 with the per-horizon tables.
  Still failing with v3: 1h up |z| >= 7 (10/41218 touched, realized 2.4e-04 vs priced 7.7e-05).
- **Out-of-sample % buckets failing with v3:** BTC 1h up 3.0% (realized 0.0019 > priced 0.0011); BTC 1h up 5.0% (realized 0.0005 > priced 0.0001); ETH 1h up 5.0% (realized 0.0019 > priced 0.0005); ETH 1h up 7.5% (realized 0.0005 > priced 0.0001); SOL 1h down 7.5% (realized 0.0005 > priced 0.0002); SOL 1h down 10.0% (realized 0.0005 > priced 0.0002); HYPE 1h down 10.0% (realized 0.0005 > priced 0.0003); HYPE 1h up 10.0% (realized 0.0005 > priced 0.0002); HYPE 1h up 15.0% (realized 0.0005 > priced 0.0001); BTC 4h up 7.5% (realized 0.0019 > priced 0.0013); ETH 4h up 7.5% (realized 0.0056 > priced 0.0035); ETH 4h up 10.0% (realized 0.0037 > priced 0.0014); HYPE 4h up 15.0% (realized 0.0019 > priced 0.0017); BTC 7d down 2.0% (realized 0.7717 > priced 0.7267); BTC 7d down 3.0% (realized 0.6196 > priced 0.5993); ETH 7d down 10.0% (realized 0.3152 > priced 0.3121); SOL 7d down 1.0% (realized 0.9239 > priced 0.9228).

## Pool P&L simulation

At every window start the pool sells one cover per coin x direction x distance in {2.0%, 3.0%, 5.0%, 7.5%, 10.0%}, each paying 0.25% of the initial LP capital (at most 10% locked; no compounding), premium = payout x priced x (1 + 0.2), refused when priced > 0.5. Covers settle before the next window; no fees, no idle yield. OOS rows trade only the second half with tables fitted on the first half; `v3 in-sample` trades everything with the published tables.

**How to read it.** Price and claims per 100 USDC of cover, the loss ratio (claims / premiums; the 20 % loading alone targets 0.83 for a perfectly calibrated model) and drawdown do not depend on how many covers are sold. LP P&L does: this book sells a full set of covers every window (24 sets a day for 1h covers), far more than real demand. Read LP P&L as an upper bound for that assumption.

| horizon | variant | days | windows | covers sold | refused | triggered | premium per 100 | claims per 100 | loss ratio | LP P&L | LP P&L per 30 d | max drawdown | worst window |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1h | raw, OOS half | 89 | 2141 | 85636 | 4 | 285 | 0.322 | 0.333 | 1.03 | -2.2% | -0.7% | 13.50% | -2.89% |
| 1h | v1 per-bucket, OOS half | 89 | 2141 | 85596 | 44 | 283 | 1.370 | 0.331 | 0.24 | +222.5% | +74.8% | 1.66% | -1.27% |
| 1h | v2 pooled z, OOS half | 89 | 2141 | 85636 | 4 | 285 | 0.743 | 0.333 | 0.45 | +87.9% | +29.6% | 3.29% | -2.02% |
| 1h | v3 z per horizon (adopted), OOS half | 89 | 2141 | 85636 | 4 | 285 | 0.777 | 0.333 | 0.43 | +95.0% | +32.0% | 3.20% | -1.96% |
| 1h | v3 z per horizon, in-sample, full | 178 | 4282 | 171246 | 4 | 880 | 0.874 | 0.514 | 0.59 | +154.2% | +25.9% | 2.81% | -2.01% |
| 1h | v3 + PAVA (not adopted), OOS half | 89 | 2141 | 85636 | 4 | 285 | 0.716 | 0.333 | 0.46 | +82.1% | +27.6% | 3.38% | -2.05% |
| 4h | raw, OOS half | 89 | 535 | 21351 | 49 | 429 | 3.811 | 2.009 | 0.53 | +96.2% | +32.4% | 3.07% | -2.35% |
| 4h | v1 per-bucket, OOS half | 89 | 535 | 21325 | 75 | 428 | 6.790 | 2.007 | 0.30 | +255.0% | +85.8% | 1.50% | -1.26% |
| 4h | v2 pooled z, OOS half | 89 | 535 | 21351 | 49 | 429 | 4.487 | 2.009 | 0.45 | +132.2% | +44.5% | 2.64% | -2.07% |
| 4h | v3 z per horizon (adopted), OOS half | 89 | 535 | 21351 | 49 | 429 | 4.935 | 2.009 | 0.41 | +156.1% | +52.5% | 2.41% | -1.92% |
| 4h | v3 z per horizon, in-sample, full | 178 | 1070 | 42644 | 146 | 1205 | 5.296 | 2.826 | 0.53 | +263.4% | +44.3% | 3.26% | -2.70% |
| 4h | v3 + PAVA (not adopted), OOS half | 89 | 535 | 21351 | 49 | 429 | 4.770 | 2.009 | 0.42 | +147.4% | +49.6% | 2.49% | -1.97% |
| 1d | raw, OOS half | 89 | 89 | 3088 | 472 | 280 | 15.703 | 9.067 | 0.58 | +51.2% | +17.3% | 2.71% | -2.71% |
| 1d | v1 per-bucket, OOS half | 89 | 89 | 2898 | 662 | 224 | 22.236 | 7.729 | 0.35 | +105.1% | +35.4% | 1.27% | -1.27% |
| 1d | v2 pooled z, OOS half | 89 | 89 | 3088 | 472 | 280 | 16.489 | 9.067 | 0.55 | +57.3% | +19.3% | 2.60% | -2.60% |
| 1d | v3 z per horizon (adopted), OOS half | 89 | 89 | 3088 | 472 | 280 | 19.852 | 9.067 | 0.46 | +83.3% | +28.1% | 2.14% | -2.14% |
| 1d | v3 z per horizon, in-sample, full | 177 | 177 | 6064 | 1016 | 641 | 18.909 | 10.571 | 0.56 | +126.4% | +21.4% | 1.89% | -1.68% |
| 1d | v3 + PAVA (not adopted), OOS half | 89 | 89 | 3088 | 472 | 280 | 17.934 | 9.067 | 0.51 | +68.4% | +23.1% | 2.36% | -2.36% |
| 7d | raw, OOS half | 644 | 92 | 1349 | 2311 | 386 | 36.000 | 28.614 | 0.79 | +24.9% | +1.2% | 1.79% | -1.33% |
| 7d | v1 per-bucket, OOS half | 644 | 92 | 887 | 2773 | 229 | 41.572 | 25.817 | 0.62 | +34.9% | +1.6% | 0.95% | -0.87% |
| 7d | v2 pooled z, OOS half | 644 | 92 | 1349 | 2311 | 386 | 36.128 | 28.614 | 0.79 | +25.3% | +1.2% | 1.76% | -1.31% |
| 7d | v3 z per horizon (adopted), OOS half | 644 | 92 | 1252 | 2408 | 352 | 40.764 | 28.115 | 0.69 | +39.6% | +1.8% | 0.98% | -0.78% |
| 7d | v3 z per horizon, in-sample, full | 1281 | 183 | 2529 | 3851 | 715 | 38.291 | 28.272 | 0.74 | +63.3% | +1.5% | 1.83% | -0.96% |
| 7d | v3 + PAVA (not adopted), OOS half | 644 | 92 | 1252 | 2408 | 352 | 39.859 | 28.115 | 0.71 | +36.8% | +1.7% | 1.11% | -0.88% |

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

`ratio` = realized / raw predicted (`sig` = significantly under-predicted). `v3 priced` = mean priced probability with the published tables. `OOS v1/v2/v3` = out-of-sample result (second half).

| coin | hz | dir | dist | windows | touches | realized | predicted | ratio | v3 priced | OOS v1 | OOS v2 | OOS v3 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BTC | 1h | down | 1.0% | 4282 | 150 | 0.0350 | 3.88e-02 | 0.90 | 0.0485 | pass | pass | pass | pass |
| BTC | 1h | down | 2.0% | 4282 | 16 | 0.0037 | 1.71e-03 | 2.19 sig | 0.0070 | pass | pass | pass | pass |
| BTC | 1h | down | 3.0% | 4282 | 1 | 0.0002 | 1.28e-04 | 1.83 | 0.0015 | pass | pass | pass | pass |
| BTC | 1h | down | 5.0% | 4282 | 1 | 0.0002 | 2.52e-07 | 925.12 sig | 0.0002 | pass | pass | pass | pass |
| BTC | 1h | down | 7.5% | 4282 | 0 | 0.0000 | 8.76e-12 | 0.00 | 0.0001 | pass | pass | pass | pass |
| BTC | 1h | down | 10.0% | 4282 | 0 | 0.0000 | 9.27e-18 | 0.00 | 0.0001 | pass | pass | pass | pass |
| BTC | 1h | down | 15.0% | 4282 | 0 | 0.0000 | 2.44e-35 | 0.00 | 0.0001 | pass | pass | pass | pass |
| BTC | 1h | down | 20.0% | 4282 | 0 | 0.0000 | 6.75e-62 | 0.00 | 0.0001 | pass | pass | pass | pass |
| BTC | 1h | up | 1.0% | 4282 | 139 | 0.0325 | 3.99e-02 | 0.81 | 0.0481 | pass | pass | pass | pass |
| BTC | 1h | up | 2.0% | 4282 | 20 | 0.0047 | 1.85e-03 | 2.52 sig | 0.0064 | pass | pass | pass | pass |
| BTC | 1h | up | 3.0% | 4282 | 6 | 0.0014 | 1.57e-04 | 8.92 sig | 0.0015 | pass | **FAIL** | **FAIL** | **FAIL** |
| BTC | 1h | up | 5.0% | 4282 | 1 | 0.0002 | 5.49e-07 | 425.50 sig | 0.0003 | pass | **FAIL** | **FAIL** | **FAIL** |
| BTC | 1h | up | 7.5% | 4282 | 0 | 0.0000 | 9.08e-11 | 0.00 | 0.0002 | pass | pass | pass | pass |
| BTC | 1h | up | 10.0% | 4282 | 0 | 0.0000 | 1.97e-15 | 0.00 | 0.0002 | pass | pass | pass | pass |
| BTC | 1h | up | 15.0% | 4282 | 0 | 0.0000 | 1.50e-27 | 0.00 | 0.0002 | pass | pass | pass | pass |
| BTC | 1h | up | 20.0% | 4282 | 0 | 0.0000 | 3.46e-43 | 0.00 | 0.0002 | pass | pass | pass | pass |
| ETH | 1h | down | 1.0% | 4282 | 283 | 0.0661 | 1.02e-01 | 0.64 | 0.1056 | pass | pass | pass | pass |
| ETH | 1h | down | 2.0% | 4282 | 51 | 0.0119 | 6.57e-03 | 1.81 sig | 0.0160 | pass | pass | pass | pass |
| ETH | 1h | down | 3.0% | 4282 | 11 | 0.0026 | 8.40e-04 | 3.06 sig | 0.0048 | pass | pass | pass | pass |
| ETH | 1h | down | 5.0% | 4282 | 2 | 0.0005 | 1.51e-05 | 30.94 sig | 0.0005 | pass | pass | pass | pass |
| ETH | 1h | down | 7.5% | 4282 | 0 | 0.0000 | 5.18e-08 | 0.00 | 0.0002 | pass | pass | pass | pass |
| ETH | 1h | down | 10.0% | 4282 | 0 | 0.0000 | 3.51e-11 | 0.00 | 0.0001 | pass | pass | pass | pass |
| ETH | 1h | down | 15.0% | 4282 | 0 | 0.0000 | 2.47e-20 | 0.00 | 0.0001 | pass | pass | pass | pass |
| ETH | 1h | down | 20.0% | 4282 | 0 | 0.0000 | 5.39e-34 | 0.00 | 0.0001 | pass | pass | pass | pass |
| ETH | 1h | up | 1.0% | 4282 | 265 | 0.0619 | 1.04e-01 | 0.59 | 0.1066 | pass | pass | pass | pass |
| ETH | 1h | up | 2.0% | 4282 | 52 | 0.0121 | 7.06e-03 | 1.72 sig | 0.0161 | pass | pass | pass | pass |
| ETH | 1h | up | 3.0% | 4282 | 20 | 0.0047 | 9.68e-04 | 4.83 sig | 0.0044 | pass | pass | pass | **FAIL** |
| ETH | 1h | up | 5.0% | 4282 | 5 | 0.0012 | 2.35e-05 | 49.74 sig | 0.0006 | pass | **FAIL** | **FAIL** | **FAIL** |
| ETH | 1h | up | 7.5% | 4282 | 1 | 0.0002 | 1.76e-07 | 1324.16 sig | 0.0003 | pass | **FAIL** | **FAIL** | **FAIL** |
| ETH | 1h | up | 10.0% | 4282 | 0 | 0.0000 | 5.67e-10 | 0.00 | 0.0002 | pass | pass | pass | pass |
| ETH | 1h | up | 15.0% | 4282 | 0 | 0.0000 | 2.52e-16 | 0.00 | 0.0002 | pass | pass | pass | pass |
| ETH | 1h | up | 20.0% | 4282 | 0 | 0.0000 | 2.02e-24 | 0.00 | 0.0002 | pass | pass | pass | pass |
| SOL | 1h | down | 1.0% | 4282 | 389 | 0.0908 | 1.34e-01 | 0.68 | 0.1366 | pass | pass | pass | pass |
| SOL | 1h | down | 2.0% | 4282 | 67 | 0.0156 | 1.01e-02 | 1.55 sig | 0.0206 | pass | pass | pass | pass |
| SOL | 1h | down | 3.0% | 4282 | 17 | 0.0040 | 1.15e-03 | 3.45 sig | 0.0062 | pass | pass | pass | pass |
| SOL | 1h | down | 5.0% | 4282 | 2 | 0.0005 | 1.77e-05 | 26.34 sig | 0.0008 | pass | pass | pass | pass |
| SOL | 1h | down | 7.5% | 4282 | 1 | 0.0002 | 2.34e-08 | 9965.32 sig | 0.0002 | pass | **FAIL** | **FAIL** | **FAIL** |
| SOL | 1h | down | 10.0% | 4282 | 1 | 0.0002 | 4.74e-12 | 49272557.93 sig | 0.0001 | pass | **FAIL** | **FAIL** | **FAIL** |
| SOL | 1h | down | 15.0% | 4282 | 0 | 0.0000 | 2.37e-22 | 0.00 | 0.0001 | pass | pass | pass | pass |
| SOL | 1h | down | 20.0% | 4282 | 0 | 0.0000 | 1.40e-37 | 0.00 | 0.0001 | pass | pass | pass | pass |
| SOL | 1h | up | 1.0% | 4282 | 367 | 0.0857 | 1.36e-01 | 0.63 | 0.1381 | pass | pass | pass | pass |
| SOL | 1h | up | 2.0% | 4282 | 79 | 0.0184 | 1.09e-02 | 1.69 sig | 0.0207 | pass | pass | pass | pass |
| SOL | 1h | up | 3.0% | 4282 | 20 | 0.0047 | 1.33e-03 | 3.51 sig | 0.0059 | pass | pass | pass | **FAIL** |
| SOL | 1h | up | 5.0% | 4282 | 2 | 0.0005 | 2.90e-05 | 16.12 sig | 0.0009 | pass | pass | pass | pass |
| SOL | 1h | up | 7.5% | 4282 | 0 | 0.0000 | 1.01e-07 | 0.00 | 0.0003 | pass | pass | pass | pass |
| SOL | 1h | up | 10.0% | 4282 | 0 | 0.0000 | 1.19e-10 | 0.00 | 0.0002 | pass | pass | pass | pass |
| SOL | 1h | up | 15.0% | 4282 | 0 | 0.0000 | 7.27e-18 | 0.00 | 0.0002 | pass | pass | pass | pass |
| SOL | 1h | up | 20.0% | 4282 | 0 | 0.0000 | 6.73e-27 | 0.00 | 0.0002 | pass | pass | pass | pass |
| HYPE | 1h | down | 1.0% | 4279 | 856 | 0.2000 | 2.85e-01 | 0.70 | 0.2858 | pass | pass | pass | pass |
| HYPE | 1h | down | 2.0% | 4279 | 202 | 0.0472 | 5.44e-02 | 0.87 | 0.0623 | pass | pass | pass | pass |
| HYPE | 1h | down | 3.0% | 4279 | 53 | 0.0124 | 9.87e-03 | 1.26 sig | 0.0191 | pass | pass | pass | pass |
| HYPE | 1h | down | 5.0% | 4279 | 4 | 0.0009 | 4.66e-04 | 2.01 | 0.0041 | pass | pass | pass | pass |
| HYPE | 1h | down | 7.5% | 4279 | 2 | 0.0005 | 1.80e-05 | 25.95 sig | 0.0009 | pass | pass | pass | pass |
| HYPE | 1h | down | 10.0% | 4279 | 1 | 0.0002 | 5.93e-07 | 394.07 sig | 0.0002 | pass | **FAIL** | **FAIL** | **FAIL** |
| HYPE | 1h | down | 15.0% | 4279 | 0 | 0.0000 | 8.78e-11 | 0.00 | 0.0001 | pass | pass | pass | pass |
| HYPE | 1h | down | 20.0% | 4279 | 0 | 0.0000 | 3.02e-16 | 0.00 | 0.0001 | pass | pass | pass | pass |
| HYPE | 1h | up | 1.0% | 4279 | 807 | 0.1886 | 2.87e-01 | 0.66 | 0.2866 | pass | pass | pass | pass |
| HYPE | 1h | up | 2.0% | 4279 | 191 | 0.0446 | 5.70e-02 | 0.78 | 0.0641 | pass | pass | pass | pass |
| HYPE | 1h | up | 3.0% | 4279 | 47 | 0.0110 | 1.11e-02 | 0.99 | 0.0191 | pass | pass | pass | pass |
| HYPE | 1h | up | 5.0% | 4279 | 4 | 0.0009 | 6.16e-04 | 1.52 | 0.0038 | pass | pass | pass | pass |
| HYPE | 1h | up | 7.5% | 4279 | 1 | 0.0002 | 3.29e-05 | 7.10 sig | 0.0010 | pass | pass | pass | **FAIL** |
| HYPE | 1h | up | 10.0% | 4279 | 1 | 0.0002 | 1.96e-06 | 119.04 sig | 0.0004 | pass | **FAIL** | **FAIL** | **FAIL** |
| HYPE | 1h | up | 15.0% | 4279 | 1 | 0.0002 | 3.56e-09 | 65619.62 sig | 0.0002 | pass | **FAIL** | **FAIL** | **FAIL** |
| HYPE | 1h | up | 20.0% | 4279 | 0 | 0.0000 | 1.76e-12 | 0.00 | 0.0002 | pass | pass | pass | pass |
| BTC | 4h | down | 1.0% | 1070 | 176 | 0.1645 | 2.58e-01 | 0.64 | 0.2576 | pass | pass | pass | pass |
| BTC | 4h | down | 2.0% | 1070 | 32 | 0.0299 | 3.83e-02 | 0.78 | 0.0527 | pass | pass | pass | pass |
| BTC | 4h | down | 3.0% | 1070 | 6 | 0.0056 | 6.50e-03 | 0.86 | 0.0172 | pass | pass | pass | pass |
| BTC | 4h | down | 5.0% | 1070 | 1 | 0.0009 | 4.38e-04 | 2.13 | 0.0023 | pass | pass | pass | pass |
| BTC | 4h | down | 7.5% | 1070 | 0 | 0.0000 | 1.17e-05 | 0.00 | 0.0005 | pass | pass | pass | pass |
| BTC | 4h | down | 10.0% | 1070 | 0 | 0.0000 | 1.51e-07 | 0.00 | 0.0003 | pass | pass | pass | pass |
| BTC | 4h | down | 15.0% | 1070 | 0 | 0.0000 | 1.59e-12 | 0.00 | 0.0002 | pass | pass | pass | pass |
| BTC | 4h | down | 20.0% | 1070 | 0 | 0.0000 | 1.10e-19 | 0.00 | 0.0002 | pass | pass | pass | pass |
| BTC | 4h | up | 1.0% | 1070 | 158 | 0.1477 | 2.59e-01 | 0.57 | 0.2594 | pass | pass | pass | pass |
| BTC | 4h | up | 2.0% | 1070 | 37 | 0.0346 | 4.05e-02 | 0.85 | 0.0536 | pass | pass | pass | pass |
| BTC | 4h | up | 3.0% | 1070 | 16 | 0.0150 | 7.23e-03 | 2.07 sig | 0.0208 | pass | **FAIL** | pass | **FAIL** |
| BTC | 4h | up | 5.0% | 1070 | 2 | 0.0019 | 5.71e-04 | 3.28 sig | 0.0051 | pass | pass | pass | pass |
| BTC | 4h | up | 7.5% | 1070 | 1 | 0.0009 | 2.46e-05 | 38.01 sig | 0.0017 | pass | **FAIL** | **FAIL** | **FAIL** |
| BTC | 4h | up | 10.0% | 1070 | 0 | 0.0000 | 7.31e-07 | 0.00 | 0.0010 | pass | pass | pass | pass |
| BTC | 4h | up | 15.0% | 1070 | 0 | 0.0000 | 2.03e-10 | 0.00 | 0.0009 | pass | pass | pass | pass |
| BTC | 4h | up | 20.0% | 1070 | 0 | 0.0000 | 1.03e-14 | 0.00 | 0.0008 | pass | pass | pass | pass |
| ETH | 4h | down | 1.0% | 1070 | 273 | 0.2551 | 3.91e-01 | 0.65 | 0.3908 | pass | pass | pass | pass |
| ETH | 4h | down | 2.0% | 1070 | 80 | 0.0748 | 1.02e-01 | 0.74 | 0.1065 | pass | pass | pass | pass |
| ETH | 4h | down | 3.0% | 1070 | 20 | 0.0187 | 2.31e-02 | 0.81 | 0.0389 | pass | pass | pass | pass |
| ETH | 4h | down | 5.0% | 1070 | 5 | 0.0047 | 2.09e-03 | 2.23 sig | 0.0075 | pass | pass | pass | pass |
| ETH | 4h | down | 7.5% | 1070 | 0 | 0.0000 | 1.55e-04 | 0.00 | 0.0014 | pass | pass | pass | pass |
| ETH | 4h | down | 10.0% | 1070 | 0 | 0.0000 | 9.66e-06 | 0.00 | 0.0005 | pass | pass | pass | pass |
| ETH | 4h | down | 15.0% | 1070 | 0 | 0.0000 | 1.54e-08 | 0.00 | 0.0002 | pass | pass | pass | pass |
| ETH | 4h | down | 20.0% | 1070 | 0 | 0.0000 | 2.42e-12 | 0.00 | 0.0002 | pass | pass | pass | pass |
| ETH | 4h | up | 1.0% | 1070 | 256 | 0.2393 | 3.91e-01 | 0.61 | 0.3914 | pass | pass | pass | pass |
| ETH | 4h | up | 2.0% | 1070 | 72 | 0.0673 | 1.05e-01 | 0.64 | 0.1094 | pass | pass | pass | pass |
| ETH | 4h | up | 3.0% | 1070 | 24 | 0.0224 | 2.54e-02 | 0.88 | 0.0408 | pass | pass | pass | pass |
| ETH | 4h | up | 5.0% | 1070 | 8 | 0.0075 | 2.56e-03 | 2.93 sig | 0.0117 | pass | **FAIL** | pass | **FAIL** |
| ETH | 4h | up | 7.5% | 1070 | 4 | 0.0037 | 2.52e-04 | 14.83 sig | 0.0038 | pass | **FAIL** | **FAIL** | **FAIL** |
| ETH | 4h | up | 10.0% | 1070 | 2 | 0.0019 | 2.46e-05 | 75.87 sig | 0.0017 | pass | **FAIL** | **FAIL** | **FAIL** |
| ETH | 4h | up | 15.0% | 1070 | 0 | 0.0000 | 2.04e-07 | 0.00 | 0.0010 | pass | pass | pass | pass |
| ETH | 4h | up | 20.0% | 1070 | 0 | 0.0000 | 9.47e-10 | 0.00 | 0.0009 | pass | pass | pass | pass |
| SOL | 4h | down | 1.0% | 1070 | 327 | 0.3056 | 4.29e-01 | 0.71 | 0.4290 | pass | pass | pass | pass |
| SOL | 4h | down | 2.0% | 1070 | 110 | 0.1028 | 1.33e-01 | 0.77 | 0.1370 | pass | pass | pass | pass |
| SOL | 4h | down | 3.0% | 1070 | 34 | 0.0318 | 3.54e-02 | 0.90 | 0.0487 | pass | pass | pass | pass |
| SOL | 4h | down | 5.0% | 1070 | 4 | 0.0037 | 2.98e-03 | 1.26 | 0.0109 | pass | pass | pass | pass |
| SOL | 4h | down | 7.5% | 1070 | 1 | 0.0009 | 2.20e-04 | 4.26 | 0.0020 | pass | pass | pass | pass |
| SOL | 4h | down | 10.0% | 1070 | 0 | 0.0000 | 1.27e-05 | 0.00 | 0.0006 | pass | pass | pass | pass |
| SOL | 4h | down | 15.0% | 1070 | 0 | 0.0000 | 8.30e-09 | 0.00 | 0.0002 | pass | pass | pass | pass |
| SOL | 4h | down | 20.0% | 1070 | 0 | 0.0000 | 4.17e-13 | 0.00 | 0.0002 | pass | pass | pass | pass |
| SOL | 4h | up | 1.0% | 1070 | 314 | 0.2935 | 4.29e-01 | 0.68 | 0.4292 | pass | pass | pass | pass |
| SOL | 4h | up | 2.0% | 1070 | 97 | 0.0907 | 1.37e-01 | 0.66 | 0.1405 | pass | pass | pass | pass |
| SOL | 4h | up | 3.0% | 1070 | 46 | 0.0430 | 3.87e-02 | 1.11 | 0.0514 | pass | pass | pass | pass |
| SOL | 4h | up | 5.0% | 1070 | 12 | 0.0112 | 3.70e-03 | 3.03 sig | 0.0150 | pass | **FAIL** | pass | **FAIL** |
| SOL | 4h | up | 7.5% | 1070 | 0 | 0.0000 | 3.53e-04 | 0.00 | 0.0049 | pass | pass | pass | pass |
| SOL | 4h | up | 10.0% | 1070 | 0 | 0.0000 | 3.44e-05 | 0.00 | 0.0022 | pass | pass | pass | pass |
| SOL | 4h | up | 15.0% | 1070 | 0 | 0.0000 | 1.68e-07 | 0.00 | 0.0010 | pass | pass | pass | pass |
| SOL | 4h | up | 20.0% | 1070 | 0 | 0.0000 | 3.50e-10 | 0.00 | 0.0009 | pass | pass | pass | pass |
| HYPE | 4h | down | 1.0% | 1069 | 522 | 0.4883 | 5.82e-01 | 0.84 | 0.5817 | pass | pass | pass | pass |
| HYPE | 4h | down | 2.0% | 1069 | 211 | 0.1974 | 2.84e-01 | 0.69 | 0.2843 | pass | pass | pass | pass |
| HYPE | 4h | down | 3.0% | 1069 | 88 | 0.0823 | 1.25e-01 | 0.66 | 0.1308 | pass | pass | pass | pass |
| HYPE | 4h | down | 5.0% | 1069 | 17 | 0.0159 | 2.22e-02 | 0.72 | 0.0357 | pass | pass | pass | pass |
| HYPE | 4h | down | 7.5% | 1069 | 2 | 0.0019 | 2.70e-03 | 0.69 | 0.0099 | pass | pass | pass | pass |
| HYPE | 4h | down | 10.0% | 1069 | 1 | 0.0009 | 4.41e-04 | 2.12 | 0.0032 | pass | pass | pass | pass |
| HYPE | 4h | down | 15.0% | 1069 | 0 | 0.0000 | 1.69e-05 | 0.00 | 0.0005 | pass | pass | pass | pass |
| HYPE | 4h | down | 20.0% | 1069 | 0 | 0.0000 | 4.57e-07 | 0.00 | 0.0003 | pass | pass | pass | pass |
| HYPE | 4h | up | 1.0% | 1069 | 521 | 0.4874 | 5.80e-01 | 0.84 | 0.5796 | pass | pass | pass | pass |
| HYPE | 4h | up | 2.0% | 1069 | 217 | 0.2030 | 2.87e-01 | 0.71 | 0.2874 | pass | pass | pass | pass |
| HYPE | 4h | up | 3.0% | 1069 | 97 | 0.0907 | 1.31e-01 | 0.69 | 0.1357 | pass | pass | pass | pass |
| HYPE | 4h | up | 5.0% | 1069 | 20 | 0.0187 | 2.60e-02 | 0.72 | 0.0383 | pass | pass | pass | pass |
| HYPE | 4h | up | 7.5% | 1069 | 5 | 0.0047 | 3.83e-03 | 1.22 | 0.0142 | pass | pass | pass | pass |
| HYPE | 4h | up | 10.0% | 1069 | 2 | 0.0019 | 7.50e-04 | 2.50 | 0.0072 | pass | pass | pass | pass |
| HYPE | 4h | up | 15.0% | 1069 | 1 | 0.0009 | 5.26e-05 | 17.78 sig | 0.0024 | pass | **FAIL** | **FAIL** | **FAIL** |
| HYPE | 4h | up | 20.0% | 1069 | 0 | 0.0000 | 4.56e-06 | 0.00 | 0.0013 | pass | pass | pass | pass |
| BTC | 1d | down | 1.0% | 177 | 94 | 0.5311 | 6.38e-01 | 0.83 | 0.6382 | pass | pass | pass | pass |
| BTC | 1d | down | 2.0% | 177 | 47 | 0.2655 | 3.52e-01 | 0.75 | 0.3524 | pass | pass | pass | pass |
| BTC | 1d | down | 3.0% | 177 | 20 | 0.1130 | 1.73e-01 | 0.65 | 0.1732 | pass | pass | pass | pass |
| BTC | 1d | down | 5.0% | 177 | 3 | 0.0169 | 3.44e-02 | 0.49 | 0.0546 | pass | pass | pass | pass |
| BTC | 1d | down | 7.5% | 177 | 0 | 0.0000 | 5.27e-03 | 0.00 | 0.0321 | pass | pass | pass | pass |
| BTC | 1d | down | 10.0% | 177 | 0 | 0.0000 | 1.13e-03 | 0.00 | 0.0126 | pass | pass | pass | pass |
| BTC | 1d | down | 15.0% | 177 | 0 | 0.0000 | 5.02e-05 | 0.00 | 0.0058 | pass | pass | pass | pass |
| BTC | 1d | down | 20.0% | 177 | 0 | 0.0000 | 9.35e-07 | 0.00 | 0.0050 | pass | pass | pass | pass |
| BTC | 1d | up | 1.0% | 177 | 94 | 0.5311 | 6.35e-01 | 0.84 | 0.6352 | pass | pass | pass | pass |
| BTC | 1d | up | 2.0% | 177 | 42 | 0.2373 | 3.54e-01 | 0.67 | 0.3549 | pass | pass | pass | pass |
| BTC | 1d | up | 3.0% | 177 | 21 | 0.1186 | 1.79e-01 | 0.66 | 0.1898 | pass | pass | pass | pass |
| BTC | 1d | up | 5.0% | 177 | 9 | 0.0508 | 3.99e-02 | 1.28 | 0.0791 | pass | **FAIL** | pass | **FAIL** |
| BTC | 1d | up | 7.5% | 177 | 3 | 0.0169 | 7.02e-03 | 2.41 | 0.0520 | **FAIL** | **FAIL** | pass | **FAIL** |
| BTC | 1d | up | 10.0% | 177 | 0 | 0.0000 | 1.76e-03 | 0.00 | 0.0330 | pass | pass | pass | pass |
| BTC | 1d | up | 15.0% | 177 | 0 | 0.0000 | 1.58e-04 | 0.00 | 0.0209 | pass | pass | pass | pass |
| BTC | 1d | up | 20.0% | 177 | 0 | 0.0000 | 1.26e-05 | 0.00 | 0.0190 | pass | pass | pass | pass |
| ETH | 1d | down | 1.0% | 177 | 106 | 0.5989 | 7.28e-01 | 0.82 | 0.7276 | pass | pass | pass | pass |
| ETH | 1d | down | 2.0% | 177 | 71 | 0.4011 | 4.87e-01 | 0.82 | 0.4871 | pass | pass | pass | pass |
| ETH | 1d | down | 3.0% | 177 | 40 | 0.2260 | 3.02e-01 | 0.75 | 0.3019 | pass | pass | pass | pass |
| ETH | 1d | down | 5.0% | 177 | 8 | 0.0452 | 9.79e-02 | 0.46 | 0.1024 | pass | pass | pass | pass |
| ETH | 1d | down | 7.5% | 177 | 2 | 0.0113 | 2.21e-02 | 0.51 | 0.0492 | pass | pass | pass | pass |
| ETH | 1d | down | 10.0% | 177 | 1 | 0.0056 | 6.03e-03 | 0.94 | 0.0326 | pass | pass | pass | pass |
| ETH | 1d | down | 15.0% | 177 | 0 | 0.0000 | 7.32e-04 | 0.00 | 0.0089 | pass | pass | pass | pass |
| ETH | 1d | down | 20.0% | 177 | 0 | 0.0000 | 1.02e-04 | 0.00 | 0.0059 | pass | pass | pass | pass |
| ETH | 1d | up | 1.0% | 177 | 113 | 0.6384 | 7.23e-01 | 0.88 | 0.7230 | pass | pass | pass | pass |
| ETH | 1d | up | 2.0% | 177 | 68 | 0.3842 | 4.86e-01 | 0.79 | 0.4859 | pass | pass | pass | pass |
| ETH | 1d | up | 3.0% | 177 | 32 | 0.1808 | 3.06e-01 | 0.59 | 0.3078 | pass | pass | pass | pass |
| ETH | 1d | up | 5.0% | 177 | 13 | 0.0734 | 1.07e-01 | 0.68 | 0.1321 | pass | pass | pass | pass |
| ETH | 1d | up | 7.5% | 177 | 7 | 0.0395 | 2.78e-02 | 1.42 | 0.0738 | pass | **FAIL** | pass | pass |
| ETH | 1d | up | 10.0% | 177 | 1 | 0.0056 | 8.53e-03 | 0.66 | 0.0537 | pass | pass | pass | pass |
| ETH | 1d | up | 15.0% | 177 | 1 | 0.0056 | 1.40e-03 | 4.04 | 0.0275 | pass | **FAIL** | pass | pass |
| ETH | 1d | up | 20.0% | 177 | 1 | 0.0056 | 3.17e-04 | 17.80 sig | 0.0214 | pass | **FAIL** | pass | pass |
| SOL | 1d | down | 1.0% | 177 | 122 | 0.6893 | 7.46e-01 | 0.92 | 0.7463 | pass | pass | pass | pass |
| SOL | 1d | down | 2.0% | 177 | 79 | 0.4463 | 5.19e-01 | 0.86 | 0.5193 | pass | pass | pass | pass |
| SOL | 1d | down | 3.0% | 177 | 46 | 0.2599 | 3.39e-01 | 0.77 | 0.3395 | pass | pass | pass | pass |
| SOL | 1d | down | 5.0% | 177 | 13 | 0.0734 | 1.26e-01 | 0.58 | 0.1299 | pass | pass | pass | pass |
| SOL | 1d | down | 7.5% | 177 | 2 | 0.0113 | 3.11e-02 | 0.36 | 0.0516 | pass | pass | pass | pass |
| SOL | 1d | down | 10.0% | 177 | 2 | 0.0113 | 7.45e-03 | 1.52 | 0.0345 | pass | pass | pass | pass |
| SOL | 1d | down | 15.0% | 177 | 0 | 0.0000 | 5.28e-04 | 0.00 | 0.0119 | pass | pass | pass | pass |
| SOL | 1d | down | 20.0% | 177 | 0 | 0.0000 | 3.66e-05 | 0.00 | 0.0060 | pass | pass | pass | pass |
| SOL | 1d | up | 1.0% | 177 | 121 | 0.6836 | 7.41e-01 | 0.92 | 0.7413 | pass | pass | pass | pass |
| SOL | 1d | up | 2.0% | 177 | 71 | 0.4011 | 5.17e-01 | 0.78 | 0.5171 | pass | pass | pass | pass |
| SOL | 1d | up | 3.0% | 177 | 47 | 0.2655 | 3.43e-01 | 0.77 | 0.3447 | pass | pass | pass | pass |
| SOL | 1d | up | 5.0% | 177 | 22 | 0.1243 | 1.36e-01 | 0.91 | 0.1556 | pass | pass | pass | pass |
| SOL | 1d | up | 7.5% | 177 | 9 | 0.0508 | 3.90e-02 | 1.30 | 0.0781 | pass | **FAIL** | pass | **FAIL** |
| SOL | 1d | up | 10.0% | 177 | 2 | 0.0113 | 1.13e-02 | 1.00 | 0.0568 | pass | **FAIL** | pass | pass |
| SOL | 1d | up | 15.0% | 177 | 0 | 0.0000 | 1.26e-03 | 0.00 | 0.0332 | pass | pass | pass | pass |
| SOL | 1d | up | 20.0% | 177 | 0 | 0.0000 | 1.87e-04 | 0.00 | 0.0227 | pass | pass | pass | pass |
| HYPE | 1d | down | 1.0% | 177 | 137 | 0.7740 | 8.24e-01 | 0.94 | 0.8241 | pass | pass | pass | pass |
| HYPE | 1d | down | 2.0% | 177 | 92 | 0.5198 | 6.56e-01 | 0.79 | 0.6559 | pass | pass | pass | pass |
| HYPE | 1d | down | 3.0% | 177 | 69 | 0.3898 | 5.05e-01 | 0.77 | 0.5051 | pass | pass | pass | pass |
| HYPE | 1d | down | 5.0% | 177 | 28 | 0.1582 | 2.76e-01 | 0.57 | 0.2755 | pass | pass | pass | pass |
| HYPE | 1d | down | 7.5% | 177 | 8 | 0.0452 | 1.16e-01 | 0.39 | 0.1226 | pass | pass | pass | pass |
| HYPE | 1d | down | 10.0% | 177 | 3 | 0.0169 | 4.65e-02 | 0.36 | 0.0653 | pass | pass | pass | pass |
| HYPE | 1d | down | 15.0% | 177 | 1 | 0.0056 | 7.04e-03 | 0.80 | 0.0305 | pass | pass | pass | pass |
| HYPE | 1d | down | 20.0% | 177 | 0 | 0.0000 | 1.28e-03 | 0.00 | 0.0167 | pass | pass | pass | pass |
| HYPE | 1d | up | 1.0% | 177 | 140 | 0.7910 | 8.18e-01 | 0.97 | 0.8176 | pass | pass | pass | pass |
| HYPE | 1d | up | 2.0% | 177 | 105 | 0.5932 | 6.49e-01 | 0.91 | 0.6492 | pass | pass | pass | pass |
| HYPE | 1d | up | 3.0% | 177 | 78 | 0.4407 | 5.02e-01 | 0.88 | 0.5023 | pass | pass | pass | pass |
| HYPE | 1d | up | 5.0% | 177 | 48 | 0.2712 | 2.83e-01 | 0.96 | 0.2896 | pass | pass | pass | pass |
| HYPE | 1d | up | 7.5% | 177 | 22 | 0.1243 | 1.31e-01 | 0.95 | 0.1515 | pass | pass | pass | pass |
| HYPE | 1d | up | 10.0% | 177 | 9 | 0.0508 | 5.93e-02 | 0.86 | 0.0961 | pass | pass | pass | pass |
| HYPE | 1d | up | 15.0% | 177 | 3 | 0.0169 | 1.28e-02 | 1.33 | 0.0557 | pass | pass | pass | pass |
| HYPE | 1d | up | 20.0% | 177 | 1 | 0.0056 | 3.20e-03 | 1.76 | 0.0393 | pass | **FAIL** | pass | pass |
| BTC | 7d | down | 1.0% | 183 | 158 | 0.8634 | 8.70e-01 | 0.99 | 0.8704 | pass | pass | pass | pass |
| BTC | 7d | down | 2.0% | 183 | 136 | 0.7432 | 7.43e-01 | 1.00 | 0.7430 | pass | **FAIL** | **FAIL** | **FAIL** |
| BTC | 7d | down | 3.0% | 183 | 103 | 0.5628 | 6.22e-01 | 0.90 | 0.6221 | pass | **FAIL** | **FAIL** | **FAIL** |
| BTC | 7d | down | 5.0% | 183 | 66 | 0.3607 | 4.13e-01 | 0.87 | 0.4190 | pass | pass | pass | pass |
| BTC | 7d | down | 7.5% | 183 | 34 | 0.1858 | 2.27e-01 | 0.82 | 0.2592 | pass | pass | pass | pass |
| BTC | 7d | down | 10.0% | 183 | 19 | 0.1038 | 1.15e-01 | 0.90 | 0.1782 | pass | **FAIL** | pass | pass |
| BTC | 7d | down | 15.0% | 183 | 8 | 0.0437 | 2.54e-02 | 1.72 | 0.1302 | pass | **FAIL** | pass | pass |
| BTC | 7d | down | 20.0% | 183 | 1 | 0.0055 | 4.89e-03 | 1.12 | 0.1023 | pass | pass | pass | pass |
| BTC | 7d | up | 1.0% | 183 | 156 | 0.8525 | 8.63e-01 | 0.99 | 0.8631 | pass | pass | pass | pass |
| BTC | 7d | up | 2.0% | 183 | 132 | 0.7213 | 7.33e-01 | 0.98 | 0.7332 | pass | pass | pass | pass |
| BTC | 7d | up | 3.0% | 183 | 102 | 0.5574 | 6.14e-01 | 0.91 | 0.6140 | pass | pass | pass | pass |
| BTC | 7d | up | 5.0% | 183 | 72 | 0.3934 | 4.14e-01 | 0.95 | 0.4203 | pass | pass | pass | pass |
| BTC | 7d | up | 7.5% | 183 | 42 | 0.2295 | 2.41e-01 | 0.95 | 0.2773 | pass | pass | pass | pass |
| BTC | 7d | up | 10.0% | 183 | 23 | 0.1257 | 1.35e-01 | 0.93 | 0.2153 | pass | pass | pass | pass |
| BTC | 7d | up | 15.0% | 183 | 7 | 0.0383 | 4.07e-02 | 0.94 | 0.1791 | pass | pass | pass | pass |
| BTC | 7d | up | 20.0% | 183 | 4 | 0.0219 | 1.24e-02 | 1.76 | 0.1626 | pass | pass | pass | pass |
| ETH | 7d | down | 1.0% | 183 | 159 | 0.8689 | 9.06e-01 | 0.96 | 0.9056 | pass | pass | pass | pass |
| ETH | 7d | down | 2.0% | 183 | 142 | 0.7760 | 8.11e-01 | 0.96 | 0.8114 | pass | pass | pass | pass |
| ETH | 7d | down | 3.0% | 183 | 124 | 0.6776 | 7.19e-01 | 0.94 | 0.7193 | pass | pass | pass | pass |
| ETH | 7d | down | 5.0% | 183 | 90 | 0.4918 | 5.49e-01 | 0.90 | 0.5497 | pass | pass | pass | pass |
| ETH | 7d | down | 7.5% | 183 | 62 | 0.3388 | 3.71e-01 | 0.91 | 0.3815 | pass | pass | pass | pass |
| ETH | 7d | down | 10.0% | 183 | 42 | 0.2295 | 2.39e-01 | 0.96 | 0.2697 | pass | **FAIL** | **FAIL** | **FAIL** |
| ETH | 7d | down | 15.0% | 183 | 17 | 0.0929 | 8.70e-02 | 1.07 | 0.1614 | pass | **FAIL** | pass | pass |
| ETH | 7d | down | 20.0% | 183 | 10 | 0.0546 | 2.71e-02 | 2.02 sig | 0.1270 | pass | **FAIL** | pass | pass |
| ETH | 7d | up | 1.0% | 183 | 161 | 0.8798 | 8.98e-01 | 0.98 | 0.8975 | pass | pass | pass | pass |
| ETH | 7d | up | 2.0% | 183 | 132 | 0.7213 | 7.99e-01 | 0.90 | 0.7990 | pass | pass | pass | pass |
| ETH | 7d | up | 3.0% | 183 | 109 | 0.5956 | 7.06e-01 | 0.84 | 0.7060 | pass | pass | pass | pass |
| ETH | 7d | up | 5.0% | 183 | 85 | 0.4645 | 5.41e-01 | 0.86 | 0.5418 | pass | pass | pass | pass |
| ETH | 7d | up | 7.5% | 183 | 60 | 0.3279 | 3.77e-01 | 0.87 | 0.3882 | pass | pass | pass | pass |
| ETH | 7d | up | 10.0% | 183 | 38 | 0.2077 | 2.57e-01 | 0.81 | 0.2923 | pass | pass | pass | pass |
| ETH | 7d | up | 15.0% | 183 | 17 | 0.0929 | 1.15e-01 | 0.81 | 0.2055 | pass | pass | pass | pass |
| ETH | 7d | up | 20.0% | 183 | 7 | 0.0383 | 5.00e-02 | 0.77 | 0.1797 | pass | pass | pass | pass |
| SOL | 7d | down | 1.0% | 182 | 163 | 0.8956 | 9.28e-01 | 0.97 | 0.9280 | pass | **FAIL** | **FAIL** | **FAIL** |
| SOL | 7d | down | 2.0% | 182 | 147 | 0.8077 | 8.56e-01 | 0.94 | 0.8555 | pass | pass | pass | pass |
| SOL | 7d | down | 3.0% | 182 | 132 | 0.7253 | 7.83e-01 | 0.93 | 0.7833 | pass | pass | pass | pass |
| SOL | 7d | down | 5.0% | 182 | 110 | 0.6044 | 6.43e-01 | 0.94 | 0.6434 | pass | pass | pass | pass |
| SOL | 7d | down | 7.5% | 182 | 78 | 0.4286 | 4.84e-01 | 0.89 | 0.4861 | pass | pass | pass | pass |
| SOL | 7d | down | 10.0% | 182 | 62 | 0.3407 | 3.50e-01 | 0.97 | 0.3612 | pass | **FAIL** | pass | **FAIL** |
| SOL | 7d | down | 15.0% | 182 | 25 | 0.1374 | 1.64e-01 | 0.84 | 0.2112 | pass | pass | pass | pass |
| SOL | 7d | down | 20.0% | 182 | 13 | 0.0714 | 6.80e-02 | 1.05 | 0.1521 | pass | **FAIL** | pass | pass |
| SOL | 7d | up | 1.0% | 182 | 169 | 0.9286 | 9.20e-01 | 1.01 | 0.9196 | pass | pass | pass | pass |
| SOL | 7d | up | 2.0% | 182 | 153 | 0.8407 | 8.42e-01 | 1.00 | 0.8415 | pass | pass | pass | pass |
| SOL | 7d | up | 3.0% | 182 | 132 | 0.7253 | 7.67e-01 | 0.95 | 0.7666 | pass | pass | pass | pass |
| SOL | 7d | up | 5.0% | 182 | 104 | 0.5714 | 6.28e-01 | 0.91 | 0.6282 | pass | pass | pass | pass |
| SOL | 7d | up | 7.5% | 182 | 81 | 0.4451 | 4.80e-01 | 0.93 | 0.4816 | pass | pass | pass | pass |
| SOL | 7d | up | 10.0% | 182 | 61 | 0.3352 | 3.60e-01 | 0.93 | 0.3716 | pass | pass | pass | pass |
| SOL | 7d | up | 15.0% | 182 | 37 | 0.2033 | 1.95e-01 | 1.04 | 0.2487 | pass | pass | pass | pass |
| SOL | 7d | up | 20.0% | 182 | 22 | 0.1209 | 1.03e-01 | 1.17 | 0.2022 | pass | pass | pass | pass |
| HYPE | 7d | down | 1.0% | 90 | 85 | 0.9444 | 9.45e-01 | 1.00 | 0.9453 |  |  |  |  |
| HYPE | 7d | down | 2.0% | 90 | 74 | 0.8222 | 8.90e-01 | 0.92 | 0.8899 |  |  |  |  |
| HYPE | 7d | down | 3.0% | 90 | 73 | 0.8111 | 8.34e-01 | 0.97 | 0.8342 |  |  |  |  |
| HYPE | 7d | down | 5.0% | 90 | 61 | 0.6778 | 7.23e-01 | 0.94 | 0.7233 |  |  |  |  |
| HYPE | 7d | down | 7.5% | 90 | 51 | 0.5667 | 5.90e-01 | 0.96 | 0.5900 |  |  |  |  |
| HYPE | 7d | down | 10.0% | 90 | 41 | 0.4556 | 4.67e-01 | 0.97 | 0.4693 |  |  |  |  |
| HYPE | 7d | down | 15.0% | 90 | 24 | 0.2667 | 2.69e-01 | 0.99 | 0.2895 |  |  |  |  |
| HYPE | 7d | down | 20.0% | 90 | 16 | 0.1778 | 1.38e-01 | 1.29 | 0.1905 |  |  |  |  |
| HYPE | 7d | up | 1.0% | 90 | 81 | 0.9000 | 9.36e-01 | 0.96 | 0.9365 |  |  |  |  |
| HYPE | 7d | up | 2.0% | 90 | 76 | 0.8444 | 8.75e-01 | 0.97 | 0.8746 |  |  |  |  |
| HYPE | 7d | up | 3.0% | 90 | 70 | 0.7778 | 8.15e-01 | 0.95 | 0.8146 |  |  |  |  |
| HYPE | 7d | up | 5.0% | 90 | 59 | 0.6556 | 7.01e-01 | 0.93 | 0.7013 |  |  |  |  |
| HYPE | 7d | up | 7.5% | 90 | 48 | 0.5333 | 5.74e-01 | 0.93 | 0.5741 |  |  |  |  |
| HYPE | 7d | up | 10.0% | 90 | 37 | 0.4111 | 4.64e-01 | 0.89 | 0.4661 |  |  |  |  |
| HYPE | 7d | up | 15.0% | 90 | 25 | 0.2778 | 2.94e-01 | 0.94 | 0.3174 |  |  |  |  |
| HYPE | 7d | up | 20.0% | 90 | 19 | 0.2111 | 1.81e-01 | 1.16 | 0.2389 |  |  |  |  |

## Limitations (read before trusting the numbers)

The evidence is real but thinner than the tables make it look. The Wilson bounds treat every window as an independent draw, and they are not: the same window is counted at eight distances, BTC, ETH, SOL and HYPE move together (a market-wide crash is one event, counted up to four times when we pool coins), and volatility clusters in time. The effective sample is therefore much smaller than the window counts, and the true uncertainty around every k and q is wider than the bounds state. The second half of the sample also looks like a different regime from the first (more large up-moves at 1h-1d, larger moves at 7d), which is exactly why the out-of-sample check fails some buckets: the past half did not fully anticipate the next. The 1h/4h/1d evidence comes from only ~7 months of 1-hour candles, essentially one market regime; the 7d evidence spans 2023-2026 but has fewer than 200 windows per coin. Finally, the touches are measured on Hyperliquid trade-price candles, not on the oracle the covers trigger on (oracle minute history exists only in a requester-pays S3 archive and was not used).

- What would make it stronger: oracle history from the S3 archive (years, and the actual trigger price); block-bootstrap or cluster-robust intervals instead of Wilson; a scheduled refit with the out-of-sample pass rate tracked over time.
- The tables are point-in-time. A failing bucket after refit is a signal to widen the margin, not noise.
