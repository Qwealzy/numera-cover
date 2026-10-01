# Calibration backtest: one-touch model on Hyperliquid history

Generated 2026-10-01T17:52Z by `python -m numera_engine.backtest --coins BTC ETH SOL HYPE` (model `gbm-touch-v1`). Source: Hyperliquid mainnet Info API `candleSnapshot`, read-only. Files: `calibration.csv` (every bucket, incl. out-of-sample columns), `calibration.svg` (reliability plot), `tail_multipliers.json` (consumed by the quote API).

## Method

- **Question.** When the engine says "probability p that the price touches level L within T", does that happen with frequency p or less in real Hyperliquid data?
- **Data.** Horizons 1h, 4h, 1d: 1-hour candles (the Info API keeps only the latest ~5000). Horizon 7d: 1-day candles from 2023-02-26 on; zero-volume rows and earlier rows dropped (HL-traded data only).
- **No look-ahead.** At each window start, sigma = max(EWMA lambda=0.94 of log returns, 30-day realized), annualized, from candles that closed before the start only. A 30-day warm-up is skipped. The 7d horizon uses daily candles for sigma too (1h history is too short for enough 7d windows); the live engine uses 1h sigma for every duration.
- **Windows.** Non-overlapping (step = horizon), aligned to multiples of the horizon since the unix epoch so all coins share start times. S = open of the first candle. Levels 1, 2, 3, 5, 7.5, 10, 15, 20 % below S (`down`, what a long cover pays on) and above S (`up`, short cover). Touched if min(low) <= S(1-d) or max(high) >= S(1+d) in the window. Windows with a missing candle are skipped.
- **Model.** Closed-form one-touch probability under driftless GBM (ARCHITECTURE §7; checked against Monte Carlo in `tests/test_pricing.py`).
- **Tail adjustment.** Per bucket (coin, horizon, direction, distance) with >= 30 windows: q = one-sided 95 % Wilson upper bound of the realized touch frequency, k = clamp(q / mean model p, 1, 10), and k = 1 when nothing touched (no evidence of under-prediction). The pool charges for max(p x k, q). k keeps the price moving with current volatility; the floor q makes sure a quote never goes below what history allows, including far levels where GBM says ~0 but a flash crash happened (or could have: with zero touches q is still ~2.7/n).
- **Pass criterion** (ARCHITECTURE §9): realized frequency <= mean priced probability in every bucket with >= 30 windows. In-sample this holds by construction, so the **out-of-sample** check is the real test: fit (k, q) on the first half of each series (by time), price the second half with it.
- **Caveat: candles are trade prices, not the oracle.** Covers trigger on the oracle (validator median of 8 venues). HL trade wicks on thin books usually go further than the oracle, so candle touches over-count oracle touches (conservative for the pool). A payout also needs a `trigger()` call that sees the breach on-chain; sub-second wicks the keeper misses make real payouts rarer still.

## Data actually used

| coin | candles | first (UTC) | last (UTC) | count | windows per horizon |
|---|---|---|---|---|---|
| BTC | 1h | 2026-03-07 07:00 | 2026-10-01 16:00 | 5002 | 1h: 4281, 4h: 1070, 1d: 177 |
| BTC | 1d | 2023-02-26 00:00 | 2026-09-30 00:00 | 1313 | 7d: 183 |
| ETH | 1h | 2026-03-07 07:00 | 2026-10-01 16:00 | 5002 | 1h: 4281, 4h: 1070, 1d: 177 |
| ETH | 1d | 2023-02-26 00:00 | 2026-09-30 00:00 | 1313 | 7d: 183 |
| SOL | 1h | 2026-03-07 07:00 | 2026-10-01 16:00 | 5002 | 1h: 4281, 4h: 1070, 1d: 177 |
| SOL | 1d | 2023-03-04 00:00 | 2026-09-30 00:00 | 1307 | 7d: 182 |
| HYPE | 1h | 2026-03-07 10:00 | 2026-10-01 16:00 | 4999 | 1h: 4278, 4h: 1069, 1d: 177 |
| HYPE | 1d | 2024-12-05 00:00 | 2026-09-30 00:00 | 665 | 7d: 90 |

## Headline

- **256 of 256 buckets have >= 30 windows** (4 coins x 4 horizons x 2 directions x 8 distances).
- Raw model (no adjustment): realized above predicted in 66 buckets, significantly (Wilson 95 % lower bound above p) in **37**. Overall the model *over*-predicts touches near the money and *under*-predicts the far tail (details below).
- In-sample with (k, q): 256/256 pass (by construction).
- **Out-of-sample** (fit on first half, test on second half): **239/240 pass** with max(p x k, q); with k alone (no floor) 201/240.
- k: min 1.00, median 1.01, max 10.00 (cap 10); 135 buckets have k > 1.

## Findings in plain language

- **Near the money the model is conservative.** For levels 1-3 % away over 1h-1d, 9694 touches happened where the model expected 12966 (0.75x). Likely reasons (not tested separately): the 30-day realized floor keeps sigma high after volatile spells, and short-horizon returns mean-revert a little, so GBM over-states how often nearby levels are hit.
- **In the far tail the model under-prices.** For levels >= 5 % away within 1-4h, 118 touches happened where GBM expected 79.5 (1.48x). The gap is worst at the extremes: 17 buckets where GBM gives p < 1e-4 still saw 26 touches in 63128 windows. Across all horizons the 20 % level was touched 94 times vs 78 expected. These are the flash moves liquidation cover exists for; this is why the price is max(p x k, q) and the floor q carries this risk.
- **Significantly under-predicted buckets (37):** SOL 1h down 10.0%: 1/4281 touched vs p = 4.7e-12; HYPE 1h up 15.0%: 1/4278 touched vs p = 3.6e-09; SOL 1h down 7.5%: 1/4281 touched vs p = 2.3e-08; ETH 1h up 7.5%: 1/4281 touched vs p = 1.8e-07; BTC 1h down 5.0%: 1/4281 touched vs p = 2.5e-07; BTC 1h up 5.0%: 1/4281 touched vs p = 5.5e-07; HYPE 1h down 10.0%: 1/4278 touched vs p = 5.9e-07; HYPE 1h up 10.0%: 1/4278 touched vs p = 2.0e-06; .... Full list: `underpriced_significant` in the CSV.
- **Direction:** actual/expected touches 0.81 for down levels (long covers) and 0.80 for up levels (short covers).
  - 1h: 4135 touches vs 5579 expected (0.74x).
  - 4h: 3822 touches vs 5250 expected (0.73x).
  - 1d: 2077 touches vs 2509 expected (0.83x).
  - 7d: 4647 touches vs 4907 expected (0.95x).
- **Out-of-sample failures (1/240):** BTC 1d up 7.5% (realized 0.0337 > priced 0.0314). In these buckets the second half was riskier than the first half: a fitted adjustment is not a guarantee and must be refitted as data arrives.

## Expected vs actual touches

Sum of raw model p over all windows (= expected number of touches) vs touches that happened; all coins, all distances.

| horizon | direction | windows x distances | expected (sum p) | actual | actual / expected |
|---|---|---|---|---|---|
| 1h | down | 136968 | 2762.6 | 2110 | 0.76 |
| 1h | up | 136968 | 2815.9 | 2025 | 0.72 |
| 4h | down | 34232 | 2607.5 | 1910 | 0.73 |
| 4h | up | 34232 | 2642.5 | 1912 | 0.72 |
| 1d | down | 5664 | 1247.7 | 994 | 0.80 |
| 1d | up | 5664 | 1261.2 | 1083 | 0.86 |
| 7d | down | 5104 | 2446.9 | 2326 | 0.95 |
| 7d | up | 5104 | 2460.3 | 2321 | 0.94 |

By distance (all coins, horizons and directions):

| distance | expected | actual | actual / expected |
|---|---|---|---|
| 1.0% | 10562.8 | 7858 | 0.74 |
| 2.0% | 3590.1 | 3101 | 0.86 |
| 3.0% | 1915.7 | 1704 | 0.89 |
| 5.0% | 974.8 | 881 | 0.90 |
| 7.5% | 578.0 | 527 | 0.91 |
| 10.0% | 375.9 | 349 | 0.93 |
| 15.0% | 169.3 | 167 | 0.99 |
| 20.0% | 78.0 | 94 | 1.20 |

## Pool P&L simulation

At every window start the pool sells one cover per coin x direction x distance in {2.0%, 3.0%, 5.0%, 7.5%, 10.0%}, each paying 0.25% of the initial LP capital (at most 10% locked; no compounding), premium = payout x max(p x k, q) x (1 + 0.2), refused when max(p x k, q) > 0.5. Covers settle before the next window; no fees, no idle yield. Variants: `raw` = model p with the 20 % loading only; `k only OOS` = multiplier fitted on the first half, no floor; `fitted OOS` = (k, q) fitted on the first half, trading only the second half (the honest number); `fitted in-sample` = the published (k, q) on the same data (optimistic).

**How to read it.** Price and claims per 100 USDC of cover, the loss ratio (claims / premiums; the 20 % loading alone targets 0.83) and drawdown do not depend on how many covers are sold. LP P&L does: this book sells one full set of covers every window, which for 1h covers means 24 sets a day, far more than real demand. Read LP P&L as an upper bound for this demand assumption, not as a forecast.

| horizon | variant | days | windows | covers sold | refused | triggered | premium per 100 | claims per 100 | loss ratio | LP P&L | LP P&L per 30 d | max drawdown | worst window |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1h | raw, full | 178 | 4281 | 171206 | 4 | 880 | 0.527 | 0.514 | 0.97 | +5.7% | +1.0% | 22.16% | -3.55% |
| 1h | fitted in-sample, full | 178 | 4281 | 171163 | 47 | 876 | 1.279 | 0.512 | 0.40 | +328.1% | +55.2% | 1.98% | -1.56% |
| 1h | raw, 2nd half | 89 | 2141 | 85636 | 4 | 285 | 0.323 | 0.333 | 1.03 | -2.2% | -0.7% | 13.49% | -2.89% |
| 1h | k only OOS, 2nd half | 89 | 2141 | 85596 | 44 | 283 | 0.461 | 0.331 | 0.72 | +27.9% | +9.4% | 6.52% | -2.35% |
| 1h | fitted OOS, 2nd half | 89 | 2141 | 85596 | 44 | 283 | 1.371 | 0.331 | 0.24 | +222.6% | +74.9% | 1.66% | -1.27% |
| 4h | raw, full | 178 | 1070 | 42644 | 146 | 1205 | 4.550 | 2.826 | 0.62 | +183.9% | +30.9% | 4.65% | -2.79% |
| 4h | fitted in-sample, full | 178 | 1070 | 42604 | 186 | 1204 | 6.294 | 2.826 | 0.45 | +369.4% | +62.1% | 3.19% | -2.68% |
| 4h | raw, 2nd half | 89 | 535 | 21351 | 49 | 429 | 3.811 | 2.009 | 0.53 | +96.2% | +32.4% | 3.07% | -2.35% |
| 4h | k only OOS, 2nd half | 89 | 535 | 21325 | 75 | 428 | 4.149 | 2.007 | 0.48 | +114.2% | +38.4% | 2.70% | -2.28% |
| 4h | fitted OOS, 2nd half | 89 | 535 | 21325 | 75 | 428 | 6.790 | 2.007 | 0.30 | +255.0% | +85.8% | 1.50% | -1.26% |
| 1d | raw, full | 177 | 177 | 6064 | 1016 | 641 | 16.780 | 10.571 | 0.63 | +94.1% | +16.0% | 2.53% | -2.06% |
| 1d | fitted in-sample, full | 177 | 177 | 5852 | 1228 | 575 | 20.585 | 9.826 | 0.48 | +157.4% | +26.7% | 1.30% | -1.30% |
| 1d | raw, 2nd half | 89 | 89 | 3088 | 472 | 280 | 15.703 | 9.067 | 0.58 | +51.2% | +17.3% | 2.71% | -2.71% |
| 1d | k only OOS, 2nd half | 89 | 89 | 3012 | 548 | 258 | 16.682 | 8.566 | 0.51 | +61.1% | +20.6% | 2.53% | -2.53% |
| 1d | fitted OOS, 2nd half | 89 | 89 | 2898 | 662 | 224 | 22.236 | 7.729 | 0.35 | +105.1% | +35.4% | 1.27% | -1.27% |
| 7d | raw, full | 1281 | 183 | 2529 | 3851 | 715 | 35.301 | 28.272 | 0.80 | +44.4% | +1.0% | 2.17% | -1.40% |
| 7d | fitted in-sample, full | 1281 | 183 | 1995 | 4385 | 503 | 41.803 | 25.213 | 0.60 | +82.7% | +1.9% | 0.99% | -0.56% |
| 7d | raw, 2nd half | 644 | 92 | 1349 | 2311 | 386 | 36.000 | 28.614 | 0.79 | +24.9% | +1.2% | 1.79% | -1.33% |
| 7d | k only OOS, 2nd half | 644 | 92 | 1143 | 2517 | 311 | 36.737 | 27.209 | 0.74 | +27.2% | +1.3% | 1.54% | -1.24% |
| 7d | fitted OOS, 2nd half | 644 | 92 | 887 | 2773 | 229 | 41.572 | 25.817 | 0.62 | +34.9% | +1.6% | 0.95% | -0.87% |

**What the simulation says (second half, out of sample):**

- 1h: raw model loss ratio 1.03 (max drawdown 13.5%); with k 0.72 (6.5%); with k and floor 0.24 (1.7%) at 4.2x the raw price.
- 4h: raw model loss ratio 0.53 (max drawdown 3.1%); with k 0.48 (2.7%); with k and floor 0.30 (1.5%) at 1.8x the raw price.
- 1d: raw model loss ratio 0.58 (max drawdown 2.7%); with k 0.51 (2.5%); with k and floor 0.35 (1.3%) at 1.4x the raw price.
- 7d: raw model loss ratio 0.79 (max drawdown 1.8%); with k 0.74 (1.5%); with k and floor 0.62 (1.0%) at 1.2x the raw price.
- The trade-off is explicit: the raw GBM price is not safe for short covers (its 1h loss ratio is around 1 even with a 20 % loading, because the tail is under-priced). k fixes most of that. The floor q makes every bucket pass out of sample but raises the price most for the shortest covers (ratios above), so the pool is very profitable on paper. With more data (longer oracle history, pooling coins) the floor tightens and prices come down; v1 deliberately errs on the side of LP solvency.

## Calibration table

All buckets with >= 30 windows. `ratio` = realized / predicted (raw model); `sig` = significantly under-predicted. `priced` = mean of max(p x k, q). `OOS` = out-of-sample result with (k, q) fitted on the first half.

| coin | hz | dir | dist | windows | touches | realized | predicted | ratio | k | q | priced | OOS |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BTC | 1h | down | 1.0% | 4281 | 150 | 0.0350 | 3.88e-02 | 0.90 | 1.03 | 0.0400 | 0.0576 | pass |
| BTC | 1h | down | 2.0% | 4281 | 16 | 0.0037 | 1.71e-03 | 2.19 sig | 3.29 | 0.0056 | 0.0107 | pass |
| BTC | 1h | down | 3.0% | 4281 | 1 | 0.0002 | 1.28e-04 | 1.83 | 8.19 | 0.0010 | 0.0021 | pass |
| BTC | 1h | down | 5.0% | 4281 | 1 | 0.0002 | 2.52e-07 | 925.12 sig | 10.00 | 0.0010 | 0.0010 | pass |
| BTC | 1h | down | 7.5% | 4281 | 0 | 0.0000 | 8.76e-12 | 0.00 | 1.00 | 0.0006 | 0.0006 | pass |
| BTC | 1h | down | 10.0% | 4281 | 0 | 0.0000 | 9.27e-18 | 0.00 | 1.00 | 0.0006 | 0.0006 | pass |
| BTC | 1h | down | 15.0% | 4281 | 0 | 0.0000 | 2.44e-35 | 0.00 | 1.00 | 0.0006 | 0.0006 | pass |
| BTC | 1h | down | 20.0% | 4281 | 0 | 0.0000 | 6.75e-62 | 0.00 | 1.00 | 0.0006 | 0.0006 | pass |
| BTC | 1h | up | 1.0% | 4281 | 138 | 0.0322 | 3.99e-02 | 0.81 | 1.00 | 0.0370 | 0.0552 | pass |
| BTC | 1h | up | 2.0% | 4281 | 20 | 0.0047 | 1.85e-03 | 2.52 sig | 3.63 | 0.0067 | 0.0128 | pass |
| BTC | 1h | up | 3.0% | 4281 | 6 | 0.0014 | 1.57e-04 | 8.92 sig | 10.00 | 0.0027 | 0.0042 | pass |
| BTC | 1h | up | 5.0% | 4281 | 1 | 0.0002 | 5.49e-07 | 425.50 sig | 10.00 | 0.0010 | 0.0010 | pass |
| BTC | 1h | up | 7.5% | 4281 | 0 | 0.0000 | 9.08e-11 | 0.00 | 1.00 | 0.0006 | 0.0006 | pass |
| BTC | 1h | up | 10.0% | 4281 | 0 | 0.0000 | 1.97e-15 | 0.00 | 1.00 | 0.0006 | 0.0006 | pass |
| BTC | 1h | up | 15.0% | 4281 | 0 | 0.0000 | 1.51e-27 | 0.00 | 1.00 | 0.0006 | 0.0006 | pass |
| BTC | 1h | up | 20.0% | 4281 | 0 | 0.0000 | 3.46e-43 | 0.00 | 1.00 | 0.0006 | 0.0006 | pass |
| BTC | 4h | down | 1.0% | 1070 | 176 | 0.1645 | 2.58e-01 | 0.64 | 1.00 | 0.1840 | 0.2713 | pass |
| BTC | 4h | down | 2.0% | 1070 | 32 | 0.0299 | 3.83e-02 | 0.78 | 1.04 | 0.0397 | 0.0574 | pass |
| BTC | 4h | down | 3.0% | 1070 | 6 | 0.0056 | 6.50e-03 | 0.86 | 1.66 | 0.0108 | 0.0190 | pass |
| BTC | 4h | down | 5.0% | 1070 | 1 | 0.0009 | 4.38e-04 | 2.13 | 9.54 | 0.0042 | 0.0081 | pass |
| BTC | 4h | down | 7.5% | 1070 | 0 | 0.0000 | 1.17e-05 | 0.00 | 1.00 | 0.0025 | 0.0025 | pass |
| BTC | 4h | down | 10.0% | 1070 | 0 | 0.0000 | 1.51e-07 | 0.00 | 1.00 | 0.0025 | 0.0025 | pass |
| BTC | 4h | down | 15.0% | 1070 | 0 | 0.0000 | 1.59e-12 | 0.00 | 1.00 | 0.0025 | 0.0025 | pass |
| BTC | 4h | down | 20.0% | 1070 | 0 | 0.0000 | 1.10e-19 | 0.00 | 1.00 | 0.0025 | 0.0025 | pass |
| BTC | 4h | up | 1.0% | 1070 | 158 | 0.1477 | 2.59e-01 | 0.57 | 1.00 | 0.1664 | 0.2684 | pass |
| BTC | 4h | up | 2.0% | 1070 | 37 | 0.0346 | 4.05e-02 | 0.85 | 1.11 | 0.0450 | 0.0645 | pass |
| BTC | 4h | up | 3.0% | 1070 | 16 | 0.0150 | 7.23e-03 | 2.07 sig | 3.10 | 0.0224 | 0.0388 | pass |
| BTC | 4h | up | 5.0% | 1070 | 2 | 0.0019 | 5.71e-04 | 3.28 sig | 9.87 | 0.0056 | 0.0109 | pass |
| BTC | 4h | up | 7.5% | 1070 | 1 | 0.0009 | 2.46e-05 | 38.01 sig | 10.00 | 0.0042 | 0.0044 | pass |
| BTC | 4h | up | 10.0% | 1070 | 0 | 0.0000 | 7.31e-07 | 0.00 | 1.00 | 0.0025 | 0.0025 | pass |
| BTC | 4h | up | 15.0% | 1070 | 0 | 0.0000 | 2.03e-10 | 0.00 | 1.00 | 0.0025 | 0.0025 | pass |
| BTC | 4h | up | 20.0% | 1070 | 0 | 0.0000 | 1.03e-14 | 0.00 | 1.00 | 0.0025 | 0.0025 | pass |
| BTC | 1d | down | 1.0% | 177 | 94 | 0.5311 | 6.38e-01 | 0.83 | 1.00 | 0.5918 | 0.6523 | pass |
| BTC | 1d | down | 2.0% | 177 | 47 | 0.2655 | 3.52e-01 | 0.75 | 1.00 | 0.3234 | 0.3830 | pass |
| BTC | 1d | down | 3.0% | 177 | 20 | 0.1130 | 1.73e-01 | 0.65 | 1.00 | 0.1581 | 0.2033 | pass |
| BTC | 1d | down | 5.0% | 177 | 3 | 0.0169 | 3.44e-02 | 0.49 | 1.21 | 0.0416 | 0.0609 | pass |
| BTC | 1d | down | 7.5% | 177 | 0 | 0.0000 | 5.27e-03 | 0.00 | 1.00 | 0.0151 | 0.0183 | pass |
| BTC | 1d | down | 10.0% | 177 | 0 | 0.0000 | 1.13e-03 | 0.00 | 1.00 | 0.0151 | 0.0156 | pass |
| BTC | 1d | down | 15.0% | 177 | 0 | 0.0000 | 5.02e-05 | 0.00 | 1.00 | 0.0151 | 0.0151 | pass |
| BTC | 1d | down | 20.0% | 177 | 0 | 0.0000 | 9.35e-07 | 0.00 | 1.00 | 0.0151 | 0.0151 | pass |
| BTC | 1d | up | 1.0% | 177 | 94 | 0.5311 | 6.35e-01 | 0.84 | 1.00 | 0.5918 | 0.6496 | pass |
| BTC | 1d | up | 2.0% | 177 | 42 | 0.2373 | 3.54e-01 | 0.67 | 1.00 | 0.2936 | 0.3733 | pass |
| BTC | 1d | up | 3.0% | 177 | 21 | 0.1186 | 1.79e-01 | 0.66 | 1.00 | 0.1645 | 0.2095 | pass |
| BTC | 1d | up | 5.0% | 177 | 9 | 0.0508 | 3.99e-02 | 1.28 | 2.14 | 0.0854 | 0.1220 | pass |
| BTC | 1d | up | 7.5% | 177 | 3 | 0.0169 | 7.02e-03 | 2.41 | 5.93 | 0.0416 | 0.0716 | **FAIL** |
| BTC | 1d | up | 10.0% | 177 | 0 | 0.0000 | 1.76e-03 | 0.00 | 1.00 | 0.0151 | 0.0160 | pass |
| BTC | 1d | up | 15.0% | 177 | 0 | 0.0000 | 1.58e-04 | 0.00 | 1.00 | 0.0151 | 0.0151 | pass |
| BTC | 1d | up | 20.0% | 177 | 0 | 0.0000 | 1.26e-05 | 0.00 | 1.00 | 0.0151 | 0.0151 | pass |
| BTC | 7d | down | 1.0% | 183 | 158 | 0.8634 | 8.70e-01 | 0.99 | 1.03 | 0.8999 | 0.9150 | pass |
| BTC | 7d | down | 2.0% | 183 | 136 | 0.7432 | 7.43e-01 | 1.00 | 1.07 | 0.7925 | 0.8224 | pass |
| BTC | 7d | down | 3.0% | 183 | 103 | 0.5628 | 6.22e-01 | 0.90 | 1.00 | 0.6218 | 0.6609 | pass |
| BTC | 7d | down | 5.0% | 183 | 66 | 0.3607 | 4.13e-01 | 0.87 | 1.02 | 0.4207 | 0.4724 | pass |
| BTC | 7d | down | 7.5% | 183 | 34 | 0.1858 | 2.27e-01 | 0.82 | 1.05 | 0.2375 | 0.2880 | pass |
| BTC | 7d | down | 10.0% | 183 | 19 | 0.1038 | 1.15e-01 | 0.90 | 1.28 | 0.1469 | 0.1927 | pass |
| BTC | 7d | down | 15.0% | 183 | 8 | 0.0437 | 2.54e-02 | 1.72 | 2.99 | 0.0759 | 0.1158 | pass |
| BTC | 7d | down | 20.0% | 183 | 1 | 0.0055 | 4.89e-03 | 1.12 | 4.93 | 0.0241 | 0.0412 | pass |
| BTC | 7d | up | 1.0% | 183 | 156 | 0.8525 | 8.63e-01 | 0.99 | 1.03 | 0.8904 | 0.9052 | pass |
| BTC | 7d | up | 2.0% | 183 | 132 | 0.7213 | 7.33e-01 | 0.98 | 1.05 | 0.7723 | 0.8007 | pass |
| BTC | 7d | up | 3.0% | 183 | 102 | 0.5574 | 6.14e-01 | 0.91 | 1.00 | 0.6165 | 0.6537 | pass |
| BTC | 7d | up | 5.0% | 183 | 72 | 0.3934 | 4.14e-01 | 0.95 | 1.10 | 0.4540 | 0.5062 | pass |
| BTC | 7d | up | 7.5% | 183 | 42 | 0.2295 | 2.41e-01 | 0.95 | 1.18 | 0.2844 | 0.3391 | pass |
| BTC | 7d | up | 10.0% | 183 | 23 | 0.1257 | 1.35e-01 | 0.93 | 1.27 | 0.1715 | 0.2187 | pass |
| BTC | 7d | up | 15.0% | 183 | 7 | 0.0383 | 4.07e-02 | 0.94 | 1.70 | 0.0691 | 0.0997 | pass |
| BTC | 7d | up | 20.0% | 183 | 4 | 0.0219 | 1.24e-02 | 1.76 | 3.86 | 0.0478 | 0.0761 | pass |
| ETH | 1h | down | 1.0% | 4281 | 283 | 0.0661 | 1.03e-01 | 0.64 | 1.00 | 0.0726 | 0.1162 | pass |
| ETH | 1h | down | 2.0% | 4281 | 51 | 0.0119 | 6.57e-03 | 1.81 sig | 2.28 | 0.0150 | 0.0263 | pass |
| ETH | 1h | down | 3.0% | 4281 | 11 | 0.0026 | 8.40e-04 | 3.06 sig | 4.99 | 0.0042 | 0.0081 | pass |
| ETH | 1h | down | 5.0% | 4281 | 2 | 0.0005 | 1.51e-05 | 30.94 sig | 10.00 | 0.0014 | 0.0015 | pass |
| ETH | 1h | down | 7.5% | 4281 | 0 | 0.0000 | 5.18e-08 | 0.00 | 1.00 | 0.0006 | 0.0006 | pass |
| ETH | 1h | down | 10.0% | 4281 | 0 | 0.0000 | 3.51e-11 | 0.00 | 1.00 | 0.0006 | 0.0006 | pass |
| ETH | 1h | down | 15.0% | 4281 | 0 | 0.0000 | 2.47e-20 | 0.00 | 1.00 | 0.0006 | 0.0006 | pass |
| ETH | 1h | down | 20.0% | 4281 | 0 | 0.0000 | 5.39e-34 | 0.00 | 1.00 | 0.0006 | 0.0006 | pass |
| ETH | 1h | up | 1.0% | 4281 | 264 | 0.0617 | 1.04e-01 | 0.59 | 1.00 | 0.0680 | 0.1158 | pass |
| ETH | 1h | up | 2.0% | 4281 | 52 | 0.0121 | 7.06e-03 | 1.72 sig | 2.16 | 0.0152 | 0.0265 | pass |
| ETH | 1h | up | 3.0% | 4281 | 20 | 0.0047 | 9.68e-04 | 4.83 sig | 6.95 | 0.0067 | 0.0129 | pass |
| ETH | 1h | up | 5.0% | 4281 | 5 | 0.0012 | 2.35e-05 | 49.74 sig | 10.00 | 0.0024 | 0.0026 | pass |
| ETH | 1h | up | 7.5% | 4281 | 1 | 0.0002 | 1.76e-07 | 1324.16 sig | 10.00 | 0.0010 | 0.0010 | pass |
| ETH | 1h | up | 10.0% | 4281 | 0 | 0.0000 | 5.67e-10 | 0.00 | 1.00 | 0.0006 | 0.0006 | pass |
| ETH | 1h | up | 15.0% | 4281 | 0 | 0.0000 | 2.52e-16 | 0.00 | 1.00 | 0.0006 | 0.0006 | pass |
| ETH | 1h | up | 20.0% | 4281 | 0 | 0.0000 | 2.02e-24 | 0.00 | 1.00 | 0.0006 | 0.0006 | pass |
| ETH | 4h | down | 1.0% | 1070 | 273 | 0.2551 | 3.91e-01 | 0.65 | 1.00 | 0.2777 | 0.3971 | pass |
| ETH | 4h | down | 2.0% | 1070 | 80 | 0.0748 | 1.02e-01 | 0.74 | 1.00 | 0.0891 | 0.1234 | pass |
| ETH | 4h | down | 3.0% | 1070 | 20 | 0.0187 | 2.31e-02 | 0.81 | 1.16 | 0.0268 | 0.0411 | pass |
| ETH | 4h | down | 5.0% | 1070 | 5 | 0.0047 | 2.09e-03 | 2.23 sig | 4.58 | 0.0096 | 0.0181 | pass |
| ETH | 4h | down | 7.5% | 1070 | 0 | 0.0000 | 1.55e-04 | 0.00 | 1.00 | 0.0025 | 0.0026 | pass |
| ETH | 4h | down | 10.0% | 1070 | 0 | 0.0000 | 9.66e-06 | 0.00 | 1.00 | 0.0025 | 0.0025 | pass |
| ETH | 4h | down | 15.0% | 1070 | 0 | 0.0000 | 1.54e-08 | 0.00 | 1.00 | 0.0025 | 0.0025 | pass |
| ETH | 4h | down | 20.0% | 1070 | 0 | 0.0000 | 2.42e-12 | 0.00 | 1.00 | 0.0025 | 0.0025 | pass |
| ETH | 4h | up | 1.0% | 1070 | 256 | 0.2393 | 3.91e-01 | 0.61 | 1.00 | 0.2613 | 0.3952 | pass |
| ETH | 4h | up | 2.0% | 1070 | 72 | 0.0673 | 1.05e-01 | 0.64 | 1.00 | 0.0810 | 0.1217 | pass |
| ETH | 4h | up | 3.0% | 1070 | 24 | 0.0224 | 2.54e-02 | 0.88 | 1.23 | 0.0312 | 0.0471 | pass |
| ETH | 4h | up | 5.0% | 1070 | 8 | 0.0075 | 2.56e-03 | 2.93 sig | 5.17 | 0.0132 | 0.0247 | pass |
| ETH | 4h | up | 7.5% | 1070 | 4 | 0.0037 | 2.52e-04 | 14.83 sig | 10.00 | 0.0083 | 0.0105 | pass |
| ETH | 4h | up | 10.0% | 1070 | 2 | 0.0019 | 2.46e-05 | 75.87 sig | 10.00 | 0.0056 | 0.0058 | pass |
| ETH | 4h | up | 15.0% | 1070 | 0 | 0.0000 | 2.04e-07 | 0.00 | 1.00 | 0.0025 | 0.0025 | pass |
| ETH | 4h | up | 20.0% | 1070 | 0 | 0.0000 | 9.47e-10 | 0.00 | 1.00 | 0.0025 | 0.0025 | pass |
| ETH | 1d | down | 1.0% | 177 | 106 | 0.5989 | 7.28e-01 | 0.82 | 1.00 | 0.6575 | 0.7316 | pass |
| ETH | 1d | down | 2.0% | 177 | 71 | 0.4011 | 4.87e-01 | 0.82 | 1.00 | 0.4628 | 0.5152 | pass |
| ETH | 1d | down | 3.0% | 177 | 40 | 0.2260 | 3.02e-01 | 0.75 | 1.00 | 0.2816 | 0.3351 | pass |
| ETH | 1d | down | 5.0% | 177 | 8 | 0.0452 | 9.79e-02 | 0.46 | 1.00 | 0.0784 | 0.1168 | pass |
| ETH | 1d | down | 7.5% | 177 | 2 | 0.0113 | 2.21e-02 | 0.51 | 1.52 | 0.0336 | 0.0530 | pass |
| ETH | 1d | down | 10.0% | 177 | 1 | 0.0056 | 6.03e-03 | 0.94 | 4.13 | 0.0249 | 0.0448 | pass |
| ETH | 1d | down | 15.0% | 177 | 0 | 0.0000 | 7.32e-04 | 0.00 | 1.00 | 0.0151 | 0.0154 | pass |
| ETH | 1d | down | 20.0% | 177 | 0 | 0.0000 | 1.02e-04 | 0.00 | 1.00 | 0.0151 | 0.0151 | pass |
| ETH | 1d | up | 1.0% | 177 | 113 | 0.6384 | 7.23e-01 | 0.88 | 1.00 | 0.6953 | 0.7356 | pass |
| ETH | 1d | up | 2.0% | 177 | 68 | 0.3842 | 4.86e-01 | 0.79 | 1.00 | 0.4456 | 0.5075 | pass |
| ETH | 1d | up | 3.0% | 177 | 32 | 0.1808 | 3.06e-01 | 0.59 | 1.00 | 0.2331 | 0.3206 | pass |
| ETH | 1d | up | 5.0% | 177 | 13 | 0.0734 | 1.07e-01 | 0.68 | 1.05 | 0.1125 | 0.1448 | pass |
| ETH | 1d | up | 7.5% | 177 | 7 | 0.0395 | 2.78e-02 | 1.42 | 2.57 | 0.0714 | 0.1085 | pass |
| ETH | 1d | up | 10.0% | 177 | 1 | 0.0056 | 8.53e-03 | 0.66 | 2.92 | 0.0249 | 0.0431 | pass |
| ETH | 1d | up | 15.0% | 177 | 1 | 0.0056 | 1.40e-03 | 4.04 | 10.00 | 0.0249 | 0.0369 | pass |
| ETH | 1d | up | 20.0% | 177 | 1 | 0.0056 | 3.17e-04 | 17.80 sig | 10.00 | 0.0249 | 0.0274 | pass |
| ETH | 7d | down | 1.0% | 183 | 159 | 0.8689 | 9.06e-01 | 0.96 | 1.00 | 0.9046 | 0.9175 | pass |
| ETH | 7d | down | 2.0% | 183 | 142 | 0.7760 | 8.11e-01 | 0.96 | 1.01 | 0.8224 | 0.8469 | pass |
| ETH | 7d | down | 3.0% | 183 | 124 | 0.6776 | 7.19e-01 | 0.94 | 1.02 | 0.7315 | 0.7668 | pass |
| ETH | 7d | down | 5.0% | 183 | 90 | 0.4918 | 5.49e-01 | 0.90 | 1.01 | 0.5523 | 0.6029 | pass |
| ETH | 7d | down | 7.5% | 183 | 62 | 0.3388 | 3.71e-01 | 0.91 | 1.07 | 0.3983 | 0.4599 | pass |
| ETH | 7d | down | 10.0% | 183 | 42 | 0.2295 | 2.39e-01 | 0.96 | 1.19 | 0.2844 | 0.3477 | pass |
| ETH | 7d | down | 15.0% | 183 | 17 | 0.0929 | 8.70e-02 | 1.07 | 1.54 | 0.1344 | 0.1832 | pass |
| ETH | 7d | down | 20.0% | 183 | 10 | 0.0546 | 2.71e-02 | 2.02 sig | 3.30 | 0.0893 | 0.1339 | pass |
| ETH | 7d | up | 1.0% | 183 | 161 | 0.8798 | 8.98e-01 | 0.98 | 1.02 | 0.9139 | 0.9262 | pass |
| ETH | 7d | up | 2.0% | 183 | 132 | 0.7213 | 7.99e-01 | 0.90 | 1.00 | 0.7723 | 0.8134 | pass |
| ETH | 7d | up | 3.0% | 183 | 109 | 0.5956 | 7.06e-01 | 0.84 | 1.00 | 0.6535 | 0.7226 | pass |
| ETH | 7d | up | 5.0% | 183 | 85 | 0.4645 | 5.41e-01 | 0.86 | 1.00 | 0.5252 | 0.5810 | pass |
| ETH | 7d | up | 7.5% | 183 | 60 | 0.3279 | 3.77e-01 | 0.87 | 1.03 | 0.3871 | 0.4416 | pass |
| ETH | 7d | up | 10.0% | 183 | 38 | 0.2077 | 2.57e-01 | 0.81 | 1.02 | 0.2611 | 0.3126 | pass |
| ETH | 7d | up | 15.0% | 183 | 17 | 0.0929 | 1.15e-01 | 0.81 | 1.17 | 0.1344 | 0.1758 | pass |
| ETH | 7d | up | 20.0% | 183 | 7 | 0.0383 | 5.00e-02 | 0.77 | 1.38 | 0.0691 | 0.0974 | pass |
| SOL | 1h | down | 1.0% | 4281 | 389 | 0.0909 | 1.34e-01 | 0.68 | 1.00 | 0.0984 | 0.1533 | pass |
| SOL | 1h | down | 2.0% | 4281 | 67 | 0.0157 | 1.01e-02 | 1.55 sig | 1.89 | 0.0191 | 0.0315 | pass |
| SOL | 1h | down | 3.0% | 4281 | 17 | 0.0040 | 1.15e-03 | 3.45 sig | 5.13 | 0.0059 | 0.0111 | pass |
| SOL | 1h | down | 5.0% | 4281 | 2 | 0.0005 | 1.77e-05 | 26.34 sig | 10.00 | 0.0014 | 0.0016 | pass |
| SOL | 1h | down | 7.5% | 4281 | 1 | 0.0002 | 2.34e-08 | 9965.32 sig | 10.00 | 0.0010 | 0.0010 | pass |
| SOL | 1h | down | 10.0% | 4281 | 1 | 0.0002 | 4.74e-12 | 49272557.93 sig | 10.00 | 0.0010 | 0.0010 | pass |
| SOL | 1h | down | 15.0% | 4281 | 0 | 0.0000 | 2.37e-22 | 0.00 | 1.00 | 0.0006 | 0.0006 | pass |
| SOL | 1h | down | 20.0% | 4281 | 0 | 0.0000 | 1.40e-37 | 0.00 | 1.00 | 0.0006 | 0.0006 | pass |
| SOL | 1h | up | 1.0% | 4281 | 366 | 0.0855 | 1.36e-01 | 0.63 | 1.00 | 0.0928 | 0.1528 | pass |
| SOL | 1h | up | 2.0% | 4281 | 79 | 0.0185 | 1.09e-02 | 1.69 sig | 2.03 | 0.0222 | 0.0363 | pass |
| SOL | 1h | up | 3.0% | 4281 | 20 | 0.0047 | 1.33e-03 | 3.51 sig | 5.06 | 0.0067 | 0.0126 | pass |
| SOL | 1h | up | 5.0% | 4281 | 2 | 0.0005 | 2.90e-05 | 16.12 sig | 10.00 | 0.0014 | 0.0017 | pass |
| SOL | 1h | up | 7.5% | 4281 | 0 | 0.0000 | 1.01e-07 | 0.00 | 1.00 | 0.0006 | 0.0006 | pass |
| SOL | 1h | up | 10.0% | 4281 | 0 | 0.0000 | 1.19e-10 | 0.00 | 1.00 | 0.0006 | 0.0006 | pass |
| SOL | 1h | up | 15.0% | 4281 | 0 | 0.0000 | 7.27e-18 | 0.00 | 1.00 | 0.0006 | 0.0006 | pass |
| SOL | 1h | up | 20.0% | 4281 | 0 | 0.0000 | 6.74e-27 | 0.00 | 1.00 | 0.0006 | 0.0006 | pass |
| SOL | 4h | down | 1.0% | 1070 | 327 | 0.3056 | 4.29e-01 | 0.71 | 1.00 | 0.3292 | 0.4441 | pass |
| SOL | 4h | down | 2.0% | 1070 | 110 | 0.1028 | 1.33e-01 | 0.77 | 1.00 | 0.1191 | 0.1620 | pass |
| SOL | 4h | down | 3.0% | 1070 | 34 | 0.0318 | 3.54e-02 | 0.90 | 1.18 | 0.0418 | 0.0611 | pass |
| SOL | 4h | down | 5.0% | 1070 | 4 | 0.0037 | 2.98e-03 | 1.26 | 2.79 | 0.0083 | 0.0149 | pass |
| SOL | 4h | down | 7.5% | 1070 | 1 | 0.0009 | 2.20e-04 | 4.26 | 10.00 | 0.0042 | 0.0062 | pass |
| SOL | 4h | down | 10.0% | 1070 | 0 | 0.0000 | 1.27e-05 | 0.00 | 1.00 | 0.0025 | 0.0025 | pass |
| SOL | 4h | down | 15.0% | 1070 | 0 | 0.0000 | 8.30e-09 | 0.00 | 1.00 | 0.0025 | 0.0025 | pass |
| SOL | 4h | down | 20.0% | 1070 | 0 | 0.0000 | 4.17e-13 | 0.00 | 1.00 | 0.0025 | 0.0025 | pass |
| SOL | 4h | up | 1.0% | 1070 | 314 | 0.2935 | 4.29e-01 | 0.68 | 1.00 | 0.3169 | 0.4411 | pass |
| SOL | 4h | up | 2.0% | 1070 | 97 | 0.0907 | 1.37e-01 | 0.66 | 1.00 | 0.1061 | 0.1585 | pass |
| SOL | 4h | up | 3.0% | 1070 | 46 | 0.0430 | 3.87e-02 | 1.11 | 1.41 | 0.0544 | 0.0784 | pass |
| SOL | 4h | up | 5.0% | 1070 | 12 | 0.0112 | 3.70e-03 | 3.03 sig | 4.84 | 0.0179 | 0.0317 | pass |
| SOL | 4h | up | 7.5% | 1070 | 0 | 0.0000 | 3.53e-04 | 0.00 | 1.00 | 0.0025 | 0.0028 | pass |
| SOL | 4h | up | 10.0% | 1070 | 0 | 0.0000 | 3.44e-05 | 0.00 | 1.00 | 0.0025 | 0.0025 | pass |
| SOL | 4h | up | 15.0% | 1070 | 0 | 0.0000 | 1.68e-07 | 0.00 | 1.00 | 0.0025 | 0.0025 | pass |
| SOL | 4h | up | 20.0% | 1070 | 0 | 0.0000 | 3.50e-10 | 0.00 | 1.00 | 0.0025 | 0.0025 | pass |
| SOL | 1d | down | 1.0% | 177 | 122 | 0.6893 | 7.46e-01 | 0.92 | 1.00 | 0.7433 | 0.7710 | pass |
| SOL | 1d | down | 2.0% | 177 | 79 | 0.4463 | 5.19e-01 | 0.86 | 1.00 | 0.5081 | 0.5581 | pass |
| SOL | 1d | down | 3.0% | 177 | 46 | 0.2599 | 3.39e-01 | 0.77 | 1.00 | 0.3174 | 0.3788 | pass |
| SOL | 1d | down | 5.0% | 177 | 13 | 0.0734 | 1.26e-01 | 0.58 | 1.00 | 0.1125 | 0.1546 | pass |
| SOL | 1d | down | 7.5% | 177 | 2 | 0.0113 | 3.11e-02 | 0.36 | 1.08 | 0.0336 | 0.0497 | pass |
| SOL | 1d | down | 10.0% | 177 | 2 | 0.0113 | 7.45e-03 | 1.52 | 4.51 | 0.0336 | 0.0562 | pass |
| SOL | 1d | down | 15.0% | 177 | 0 | 0.0000 | 5.28e-04 | 0.00 | 1.00 | 0.0151 | 0.0152 | pass |
| SOL | 1d | down | 20.0% | 177 | 0 | 0.0000 | 3.66e-05 | 0.00 | 1.00 | 0.0151 | 0.0151 | pass |
| SOL | 1d | up | 1.0% | 177 | 121 | 0.6836 | 7.41e-01 | 0.92 | 1.00 | 0.7380 | 0.7654 | pass |
| SOL | 1d | up | 2.0% | 177 | 71 | 0.4011 | 5.17e-01 | 0.78 | 1.00 | 0.4628 | 0.5406 | pass |
| SOL | 1d | up | 3.0% | 177 | 47 | 0.2655 | 3.43e-01 | 0.77 | 1.00 | 0.3234 | 0.3818 | pass |
| SOL | 1d | up | 5.0% | 177 | 22 | 0.1243 | 1.36e-01 | 0.91 | 1.26 | 0.1708 | 0.2168 | pass |
| SOL | 1d | up | 7.5% | 177 | 9 | 0.0508 | 3.90e-02 | 1.30 | 2.19 | 0.0854 | 0.1227 | pass |
| SOL | 1d | up | 10.0% | 177 | 2 | 0.0113 | 1.13e-02 | 1.00 | 2.96 | 0.0336 | 0.0540 | pass |
| SOL | 1d | up | 15.0% | 177 | 0 | 0.0000 | 1.26e-03 | 0.00 | 1.00 | 0.0151 | 0.0155 | pass |
| SOL | 1d | up | 20.0% | 177 | 0 | 0.0000 | 1.87e-04 | 0.00 | 1.00 | 0.0151 | 0.0151 | pass |
| SOL | 7d | down | 1.0% | 182 | 163 | 0.8956 | 9.28e-01 | 0.97 | 1.00 | 0.9273 | 0.9360 | pass |
| SOL | 7d | down | 2.0% | 182 | 147 | 0.8077 | 8.56e-01 | 0.94 | 1.00 | 0.8511 | 0.8701 | pass |
| SOL | 7d | down | 3.0% | 182 | 132 | 0.7253 | 7.83e-01 | 0.93 | 1.00 | 0.7761 | 0.8046 | pass |
| SOL | 7d | down | 5.0% | 182 | 110 | 0.6044 | 6.43e-01 | 0.94 | 1.03 | 0.6621 | 0.7011 | pass |
| SOL | 7d | down | 7.5% | 182 | 78 | 0.4286 | 4.84e-01 | 0.89 | 1.01 | 0.4895 | 0.5392 | pass |
| SOL | 7d | down | 10.0% | 182 | 62 | 0.3407 | 3.50e-01 | 0.97 | 1.14 | 0.4004 | 0.4612 | pass |
| SOL | 7d | down | 15.0% | 182 | 25 | 0.1374 | 1.64e-01 | 0.84 | 1.13 | 0.1847 | 0.2349 | pass |
| SOL | 7d | down | 20.0% | 182 | 13 | 0.0714 | 6.80e-02 | 1.05 | 1.61 | 0.1095 | 0.1537 | pass |
| SOL | 7d | up | 1.0% | 182 | 169 | 0.9286 | 9.20e-01 | 1.01 | 1.04 | 0.9541 | 0.9625 | pass |
| SOL | 7d | up | 2.0% | 182 | 153 | 0.8407 | 8.42e-01 | 1.00 | 1.05 | 0.8802 | 0.8969 | pass |
| SOL | 7d | up | 3.0% | 182 | 132 | 0.7253 | 7.67e-01 | 0.95 | 1.01 | 0.7761 | 0.7994 | pass |
| SOL | 7d | up | 5.0% | 182 | 104 | 0.5714 | 6.28e-01 | 0.91 | 1.00 | 0.6303 | 0.6651 | pass |
| SOL | 7d | up | 7.5% | 182 | 81 | 0.4451 | 4.80e-01 | 0.93 | 1.05 | 0.5060 | 0.5525 | pass |
| SOL | 7d | up | 10.0% | 182 | 61 | 0.3352 | 3.60e-01 | 0.93 | 1.10 | 0.3948 | 0.4471 | pass |
| SOL | 7d | up | 15.0% | 182 | 37 | 0.2033 | 1.95e-01 | 1.04 | 1.32 | 0.2565 | 0.3136 | pass |
| SOL | 7d | up | 20.0% | 182 | 22 | 0.1209 | 1.03e-01 | 1.17 | 1.61 | 0.1663 | 0.2187 | pass |
| HYPE | 1h | down | 1.0% | 4278 | 856 | 0.2001 | 2.85e-01 | 0.70 | 1.00 | 0.2103 | 0.3088 | pass |
| HYPE | 1h | down | 2.0% | 4278 | 202 | 0.0472 | 5.44e-02 | 0.87 | 1.00 | 0.0528 | 0.0790 | pass |
| HYPE | 1h | down | 3.0% | 4278 | 53 | 0.0124 | 9.87e-03 | 1.26 sig | 1.57 | 0.0155 | 0.0256 | pass |
| HYPE | 1h | down | 5.0% | 4278 | 4 | 0.0009 | 4.66e-04 | 2.01 | 4.46 | 0.0021 | 0.0040 | pass |
| HYPE | 1h | down | 7.5% | 4278 | 2 | 0.0005 | 1.80e-05 | 25.95 sig | 10.00 | 0.0014 | 0.0016 | pass |
| HYPE | 1h | down | 10.0% | 4278 | 1 | 0.0002 | 5.93e-07 | 394.07 sig | 10.00 | 0.0010 | 0.0011 | pass |
| HYPE | 1h | down | 15.0% | 4278 | 0 | 0.0000 | 8.78e-11 | 0.00 | 1.00 | 0.0006 | 0.0006 | pass |
| HYPE | 1h | down | 20.0% | 4278 | 0 | 0.0000 | 3.02e-16 | 0.00 | 1.00 | 0.0006 | 0.0006 | pass |
| HYPE | 1h | up | 1.0% | 4278 | 806 | 0.1884 | 2.87e-01 | 0.66 | 1.00 | 0.1984 | 0.3056 | pass |
| HYPE | 1h | up | 2.0% | 4278 | 191 | 0.0446 | 5.70e-02 | 0.78 | 1.00 | 0.0501 | 0.0789 | pass |
| HYPE | 1h | up | 3.0% | 4278 | 47 | 0.0110 | 1.11e-02 | 0.99 | 1.25 | 0.0139 | 0.0229 | pass |
| HYPE | 1h | up | 5.0% | 4278 | 4 | 0.0009 | 6.16e-04 | 1.52 | 3.38 | 0.0021 | 0.0039 | pass |
| HYPE | 1h | up | 7.5% | 4278 | 1 | 0.0002 | 3.29e-05 | 7.10 sig | 10.00 | 0.0010 | 0.0014 | pass |
| HYPE | 1h | up | 10.0% | 4278 | 1 | 0.0002 | 1.96e-06 | 119.04 sig | 10.00 | 0.0010 | 0.0011 | pass |
| HYPE | 1h | up | 15.0% | 4278 | 1 | 0.0002 | 3.56e-09 | 65619.62 sig | 10.00 | 0.0010 | 0.0010 | pass |
| HYPE | 1h | up | 20.0% | 4278 | 0 | 0.0000 | 1.76e-12 | 0.00 | 1.00 | 0.0006 | 0.0006 | pass |
| HYPE | 4h | down | 1.0% | 1069 | 522 | 0.4883 | 5.82e-01 | 0.84 | 1.00 | 0.5135 | 0.6001 | pass |
| HYPE | 4h | down | 2.0% | 1069 | 211 | 0.1974 | 2.84e-01 | 0.69 | 1.00 | 0.2182 | 0.3111 | pass |
| HYPE | 4h | down | 3.0% | 1069 | 88 | 0.0823 | 1.25e-01 | 0.66 | 1.00 | 0.0972 | 0.1521 | pass |
| HYPE | 4h | down | 5.0% | 1069 | 17 | 0.0159 | 2.22e-02 | 0.72 | 1.06 | 0.0235 | 0.0372 | pass |
| HYPE | 4h | down | 7.5% | 1069 | 2 | 0.0019 | 2.70e-03 | 0.69 | 2.09 | 0.0056 | 0.0099 | pass |
| HYPE | 4h | down | 10.0% | 1069 | 1 | 0.0009 | 4.41e-04 | 2.12 | 9.49 | 0.0042 | 0.0080 | pass |
| HYPE | 4h | down | 15.0% | 1069 | 0 | 0.0000 | 1.69e-05 | 0.00 | 1.00 | 0.0025 | 0.0025 | pass |
| HYPE | 4h | down | 20.0% | 1069 | 0 | 0.0000 | 4.57e-07 | 0.00 | 1.00 | 0.0025 | 0.0025 | pass |
| HYPE | 4h | up | 1.0% | 1069 | 521 | 0.4874 | 5.80e-01 | 0.84 | 1.00 | 0.5125 | 0.5978 | pass |
| HYPE | 4h | up | 2.0% | 1069 | 217 | 0.2030 | 2.87e-01 | 0.71 | 1.00 | 0.2240 | 0.3145 | pass |
| HYPE | 4h | up | 3.0% | 1069 | 97 | 0.0907 | 1.31e-01 | 0.69 | 1.00 | 0.1062 | 0.1599 | pass |
| HYPE | 4h | up | 5.0% | 1069 | 20 | 0.0187 | 2.60e-02 | 0.72 | 1.03 | 0.0268 | 0.0419 | pass |
| HYPE | 4h | up | 7.5% | 1069 | 5 | 0.0047 | 3.83e-03 | 1.22 | 2.50 | 0.0096 | 0.0164 | pass |
| HYPE | 4h | up | 10.0% | 1069 | 2 | 0.0019 | 7.50e-04 | 2.50 | 7.52 | 0.0056 | 0.0106 | pass |
| HYPE | 4h | up | 15.0% | 1069 | 1 | 0.0009 | 5.26e-05 | 17.78 sig | 10.00 | 0.0042 | 0.0046 | pass |
| HYPE | 4h | up | 20.0% | 1069 | 0 | 0.0000 | 4.56e-06 | 0.00 | 1.00 | 0.0025 | 0.0025 | pass |
| HYPE | 1d | down | 1.0% | 177 | 137 | 0.7740 | 8.24e-01 | 0.94 | 1.00 | 0.8214 | 0.8436 | pass |
| HYPE | 1d | down | 2.0% | 177 | 92 | 0.5198 | 6.56e-01 | 0.79 | 1.00 | 0.5808 | 0.6678 | pass |
| HYPE | 1d | down | 3.0% | 177 | 69 | 0.3898 | 5.05e-01 | 0.77 | 1.00 | 0.4514 | 0.5337 | pass |
| HYPE | 1d | down | 5.0% | 177 | 28 | 0.1582 | 2.76e-01 | 0.57 | 1.00 | 0.2084 | 0.3023 | pass |
| HYPE | 1d | down | 7.5% | 177 | 8 | 0.0452 | 1.16e-01 | 0.39 | 1.00 | 0.0784 | 0.1370 | pass |
| HYPE | 1d | down | 10.0% | 177 | 3 | 0.0169 | 4.65e-02 | 0.36 | 1.00 | 0.0416 | 0.0664 | pass |
| HYPE | 1d | down | 15.0% | 177 | 1 | 0.0056 | 7.04e-03 | 0.80 | 3.54 | 0.0249 | 0.0417 | pass |
| HYPE | 1d | down | 20.0% | 177 | 0 | 0.0000 | 1.28e-03 | 0.00 | 1.00 | 0.0151 | 0.0158 | pass |
| HYPE | 1d | up | 1.0% | 177 | 140 | 0.7910 | 8.18e-01 | 0.97 | 1.02 | 0.8367 | 0.8575 | pass |
| HYPE | 1d | up | 2.0% | 177 | 105 | 0.5932 | 6.49e-01 | 0.91 | 1.00 | 0.6521 | 0.6896 | pass |
| HYPE | 1d | up | 3.0% | 177 | 78 | 0.4407 | 5.02e-01 | 0.88 | 1.00 | 0.5025 | 0.5512 | pass |
| HYPE | 1d | up | 5.0% | 177 | 48 | 0.2712 | 2.83e-01 | 0.96 | 1.16 | 0.3293 | 0.3927 | pass |
| HYPE | 1d | up | 7.5% | 177 | 22 | 0.1243 | 1.31e-01 | 0.95 | 1.31 | 0.1708 | 0.2265 | pass |
| HYPE | 1d | up | 10.0% | 177 | 9 | 0.0508 | 5.93e-02 | 0.86 | 1.44 | 0.0854 | 0.1237 | pass |
| HYPE | 1d | up | 15.0% | 177 | 3 | 0.0169 | 1.28e-02 | 1.33 | 3.26 | 0.0416 | 0.0675 | pass |
| HYPE | 1d | up | 20.0% | 177 | 1 | 0.0056 | 3.20e-03 | 1.76 | 7.78 | 0.0249 | 0.0428 | pass |
| HYPE | 7d | down | 1.0% | 90 | 85 | 0.9444 | 9.45e-01 | 1.00 | 1.03 | 0.9727 | 0.9786 |  |
| HYPE | 7d | down | 2.0% | 90 | 74 | 0.8222 | 8.90e-01 | 0.92 | 1.00 | 0.8788 | 0.8973 |  |
| HYPE | 7d | down | 3.0% | 90 | 73 | 0.8111 | 8.34e-01 | 0.97 | 1.04 | 0.8695 | 0.8872 |  |
| HYPE | 7d | down | 5.0% | 90 | 61 | 0.6778 | 7.23e-01 | 0.94 | 1.04 | 0.7526 | 0.7811 |  |
| HYPE | 7d | down | 7.5% | 90 | 51 | 0.5667 | 5.90e-01 | 0.96 | 1.10 | 0.6494 | 0.6912 |  |
| HYPE | 7d | down | 10.0% | 90 | 41 | 0.4556 | 4.67e-01 | 0.97 | 1.16 | 0.5419 | 0.5940 |  |
| HYPE | 7d | down | 15.0% | 90 | 24 | 0.2667 | 2.69e-01 | 0.99 | 1.30 | 0.3493 | 0.4097 |  |
| HYPE | 7d | down | 20.0% | 90 | 16 | 0.1778 | 1.38e-01 | 1.29 | 1.84 | 0.2532 | 0.3200 |  |
| HYPE | 7d | up | 1.0% | 90 | 81 | 0.9000 | 9.36e-01 | 0.96 | 1.00 | 0.9409 | 0.9465 |  |
| HYPE | 7d | up | 2.0% | 90 | 76 | 0.8444 | 8.75e-01 | 0.97 | 1.03 | 0.8971 | 0.9084 |  |
| HYPE | 7d | up | 3.0% | 90 | 70 | 0.7778 | 8.15e-01 | 0.95 | 1.03 | 0.8412 | 0.8577 |  |
| HYPE | 7d | up | 5.0% | 90 | 59 | 0.6556 | 7.01e-01 | 0.93 | 1.04 | 0.7323 | 0.7584 |  |
| HYPE | 7d | up | 7.5% | 90 | 48 | 0.5333 | 5.74e-01 | 0.93 | 1.08 | 0.6176 | 0.6537 |  |
| HYPE | 7d | up | 10.0% | 90 | 37 | 0.4111 | 4.64e-01 | 0.89 | 1.07 | 0.4978 | 0.5396 |  |
| HYPE | 7d | up | 15.0% | 90 | 25 | 0.2778 | 2.94e-01 | 0.94 | 1.23 | 0.3611 | 0.4119 |  |
| HYPE | 7d | up | 20.0% | 90 | 19 | 0.2111 | 1.81e-01 | 1.16 | 1.60 | 0.2898 | 0.3482 |  |

## Limitations

- Trade-price candles approximate the oracle (see method). Oracle minute history exists only in a requester-pays S3 archive and was not used.
- 1h history is ~7 months for every coin: essentially one market regime. The 7d buckets span 2023-2026 but have < 200 windows each.
- Buckets are not independent (the same windows at different distances; correlated coins). Wilson bounds treat windows as independent; volatility clustering makes true uncertainty larger.
- The floor q is a historical frequency for a fixed % distance, so in calm regimes it can dominate p x k and over-price near-the-money covers. That is a deliberate conservative choice for v1.
- (k, q) are point-in-time. They should be refitted on a schedule and the out-of-sample pass rate tracked; a failing bucket is a signal to widen the margin, not noise to ignore.
