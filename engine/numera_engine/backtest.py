"""Calibration backtest of the one-touch model on real Hyperliquid history (ARCHITECTURE §9).

    python -m numera_engine.backtest --coins BTC ETH SOL HYPE

For each coin, horizon and distance, compare the model's predicted touch probability (sigma estimated
strictly from data before the start) with whether the price actually touched the level within the
window (candle low/high). Fits the tail adjustment (k, q) per bucket, checks it out of sample, and
simulates a pool selling covers at the resulting premiums.
Writes engine/reports/calibration.{csv,md,svg} and engine/reports/tail_multipliers.json.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import math
import time
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import MODEL_NAME
from .data import INTERVAL_MS, MAINNET_INFO_URL, Candle, InfoClient
from .pricing import DISTANCES, P_MAX, THETA, touch_prob
from .vol import DAYS_PER_YEAR, HOURS_PER_YEAR, sigma_series

REPORTS_DIR = Path(__file__).resolve().parent.parent / "reports"
HL_DAILY_START_MS = int(dt.datetime(2023, 2, 26, tzinfo=dt.UTC).timestamp() * 1000)
MIN_OBS = 30
K_MAX = 10.0
Z_ONE_SIDED_95 = 1.6448536269514722


@dataclass(frozen=True)
class Horizon:
    name: str
    seconds: int
    interval: str  # candle interval used
    bars: int  # candles per window (= step between starts, non-overlapping)


HORIZONS = (
    Horizon("1h", 3600, "1h", 1),
    Horizon("4h", 4 * 3600, "1h", 4),
    Horizon("1d", 86400, "1h", 24),
    Horizon("7d", 7 * 86400, "1d", 7),
)
PERIODS_PER_YEAR = {"1h": HOURS_PER_YEAR, "1d": DAYS_PER_YEAR}
FLOOR_PERIODS = {"1h": 30 * 24, "1d": 30}


# -- observations ----------------------------------------------------------------------------------


@dataclass
class Series:
    t: np.ndarray
    o: np.ndarray
    h: np.ndarray
    low: np.ndarray
    c: np.ndarray

    @staticmethod
    def from_candles(cs: list[Candle]) -> Series:
        return Series(
            t=np.array([x.t for x in cs], dtype=np.int64),
            o=np.array([x.o for x in cs]),
            h=np.array([x.h for x in cs]),
            low=np.array([x.low for x in cs]),
            c=np.array([x.c for x in cs]),
        )


@dataclass
class Obs:
    """Column arrays, one row per (window start, direction, distance)."""

    start_ms: np.ndarray
    direction: np.ndarray  # "down" | "up"
    distance: np.ndarray
    sigma: np.ndarray
    p: np.ndarray
    hit: np.ndarray

    def __len__(self) -> int:
        return len(self.p)


def observations(s: Series, hz: Horizon, distances=DISTANCES) -> Obs:
    """Non-overlapping windows of ``hz.bars`` candles, starts aligned to multiples of the horizon since the
    unix epoch (so all coins share start times). S = open of the first window candle; sigma uses only
    closes strictly before the window (sigma_series index i-1). Windows with missing candles are skipped."""
    step_ms = INTERVAL_MS[hz.interval]
    win_ms = hz.bars * step_ms
    sig = sigma_series(s.c, PERIODS_PER_YEAR[hz.interval], FLOOR_PERIODS[hz.interval])
    T = hz.seconds / (365 * 86400)
    rows: list[tuple] = []
    for i in range(1, len(s.t) - hz.bars + 1):
        if s.t[i] % win_ms or np.isnan(sig[i - 1]):
            continue
        j = i + hz.bars
        if s.t[j - 1] - s.t[i - 1] != win_ms:  # gap in candles
            continue
        S, sigma = float(s.o[i]), float(sig[i - 1])
        lo, hi = float(np.min(s.low[i:j])), float(np.max(s.h[i:j]))
        for d in distances:
            Hd, Hu = S * (1 - d), S * (1 + d)
            rows.append((int(s.t[i]), "down", d, sigma, touch_prob(S, Hd, sigma, T), lo <= Hd))
            rows.append((int(s.t[i]), "up", d, sigma, touch_prob(S, Hu, sigma, T), hi >= Hu))
    cols = list(zip(*rows, strict=True)) if rows else [[]] * 6
    return Obs(
        start_ms=np.array(cols[0], dtype=np.int64),
        direction=np.array(cols[1], dtype=object),
        distance=np.array(cols[2], dtype=float),
        sigma=np.array(cols[3], dtype=float),
        p=np.array(cols[4], dtype=float),
        hit=np.array(cols[5], dtype=bool),
    )


# -- statistics ------------------------------------------------------------------------------------


def wilson(hits: int, n: int, z: float = Z_ONE_SIDED_95) -> tuple[float, float]:
    """Wilson score interval for a binomial proportion (one-sided 95 % bounds with the default z)."""
    if n == 0:
        return 0.0, 1.0
    ph = hits / n
    den = 1 + z * z / n
    centre = (ph + z * z / (2 * n)) / den
    half = z * math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n)) / den
    return max(0.0, centre - half), min(1.0, centre + half)


def fit_tail(hits: int, n: int, mean_p: float) -> tuple[float, float] | None:
    """(k, q) for one bucket, or None if n < MIN_OBS.

    q = Wilson one-sided 95 % upper bound of the realized touch frequency (also with zero touches: we
        cannot rule out a frequency up to ~2.7/n). Floor on the priced probability.
    k = clamp(q / mean predicted p, 1, K_MAX). Multiplier on the model p, so the price still scales with
        current volatility. Capped because where the ratio is larger, mean p is ~0 and the floor q already
        carries the risk; an uncapped k would explode when applied to nearer distances.
        k = 1 when nothing touched: there is no evidence the model under-predicts, and the sample-size
        uncertainty is already in q (otherwise k would scale a legitimate high-vol p by up to K_MAX).
    """
    if n < MIN_OBS:
        return None
    q = wilson(hits, n)[1]
    k = 1.0 if hits == 0 or mean_p <= 0 else min(K_MAX, max(1.0, q / mean_p))
    return k, q


@dataclass
class Bucket:
    coin: str
    horizon: str
    direction: str
    distance: float
    n: int
    hits: int
    mean_p: float
    mean_sigma: float
    k: float | None
    q: float | None
    priced: float | None  # mean over windows of max(p_i * k, q): what the pool would have charged

    @property
    def realized(self) -> float:
        return self.hits / self.n if self.n else 0.0

    @property
    def wilson_lo(self) -> float:
        return wilson(self.hits, self.n)[0]

    @property
    def wilson_hi(self) -> float:
        return wilson(self.hits, self.n)[1]

    @property
    def underpriced_significant(self) -> bool:
        """Raw model p is below the one-sided 95 % lower bound of the realized frequency."""
        return self.hits > 0 and self.wilson_lo > self.mean_p

    @property
    def passes(self) -> bool | None:
        return None if self.priced is None else self.realized <= self.priced + 1e-12


def aggregate(
    coin: str,
    hz: str,
    obs: Obs,
    mask: np.ndarray | None = None,
    fit: dict[tuple[str, float], tuple[float, float]] | None = None,
) -> list[Bucket]:
    """Buckets per (direction, distance). (k, q) are fitted on these rows unless ``fit`` supplies them
    (out-of-sample evaluation)."""
    if mask is None:
        mask = np.ones(len(obs), dtype=bool)
    out = []
    for direction in ("down", "up"):
        for d in DISTANCES:
            m = mask & (obs.direction == direction) & np.isclose(obs.distance, d)
            n, hits = int(m.sum()), int(obs.hit[m].sum())
            mp = float(obs.p[m].mean()) if n else 0.0
            kq = fit.get((direction, d)) if fit is not None else fit_tail(hits, n, mp)
            priced = None
            if kq is not None and n:
                priced = float(np.maximum(obs.p[m] * kq[0], kq[1]).mean())
            out.append(
                Bucket(
                    coin, hz, direction, d, n, hits, mp, float(obs.sigma[m].mean()) if n else 0.0,
                    kq[0] if kq else None, kq[1] if kq else None, priced,
                )
            )  # fmt: skip
    return out


# -- pool P&L simulation ---------------------------------------------------------------------------

SIM_DISTANCES = (0.02, 0.03, 0.05, 0.075, 0.10)
SIM_PAYOUT_FRACTION = 0.0025  # each cover pays 0.25 % of the initial LP capital


@dataclass
class SimResult:
    label: str
    horizon: str
    days: float
    steps: int
    sold: int
    refused: int
    triggered: int
    premium: float  # sums in units of initial equity
    paid: float
    ret: float
    max_dd: float
    worst_step: float

    @property
    def loss_ratio(self) -> float:
        return self.paid / self.premium if self.premium else float("nan")

    @property
    def ret_30d(self) -> float:
        return self.ret / self.days * 30 if self.days else float("nan")

    @property
    def price_per_100(self) -> float:
        """Average premium per 100 USDC of payout sold."""
        return 100 * self.premium / (self.sold * SIM_PAYOUT_FRACTION) if self.sold else float("nan")

    @property
    def claims_per_100(self) -> float:
        return 100 * self.paid / (self.sold * SIM_PAYOUT_FRACTION) if self.sold else float("nan")


def simulate_pool(
    label: str,
    hz: Horizon,
    obs_by_coin: dict[str, Obs],
    fit_by_coin: dict[str, dict[tuple[str, float], tuple[float, float]]],
    t_from: int | None = None,
    theta: float = THETA,
    p_max: float = P_MAX,
) -> SimResult:
    """At every window start the pool sells one cover per (coin, direction, distance in SIM_DISTANCES), each
    paying SIM_PAYOUT_FRACTION of the initial LP capital (no compounding), premium = payout * max(p*k, q) * (1 + theta), refusing
    when max(p*k, q) > pMax. Covers of a step settle before the next step (windows do not overlap), so
    locked capital never exceeds 2 * len(SIM_DISTANCES) * n_coins * SIM_PAYOUT_FRACTION of equity."""
    steps: dict[int, list[tuple[float, bool]]] = defaultdict(list)  # t -> [(priced prob, hit)]
    for coin, ob in obs_by_coin.items():
        fit = fit_by_coin.get(coin, {})
        for t, direction, d, p, hit in zip(ob.start_ms, ob.direction, ob.distance, ob.p, ob.hit, strict=True):
            if (t_from is not None and t < t_from) or not any(math.isclose(d, x) for x in SIM_DISTANCES):
                continue
            k, q = fit.get((direction, float(d)), (1.0, 0.0))
            steps[int(t)].append((max(p * k, q), bool(hit)))
    eq, peak, max_dd, worst = 1.0, 1.0, 0.0, 0.0
    sold = refused = trig = 0
    prem_sum = paid_sum = 0.0
    ts = sorted(steps)
    for t in ts:
        start_eq = eq
        payout = SIM_PAYOUT_FRACTION
        pnl = 0.0
        for pp, hit in steps[t]:
            if pp > p_max:
                refused += 1
                continue
            sold += 1
            prem = payout * pp * (1 + theta)
            prem_sum += prem
            pnl += prem
            if hit:
                trig += 1
                paid_sum += payout
                pnl -= payout
        eq = start_eq + pnl
        worst = min(worst, pnl / start_eq)
        peak = max(peak, eq)
        max_dd = max(max_dd, 1 - eq / peak)
    days = ((ts[-1] - ts[0]) / 1000 + hz.seconds) / 86400 if ts else 0.0
    return SimResult(label, hz.name, days, len(ts), sold, refused, trig, prem_sum, paid_sum, eq - 1, max_dd,
                     worst)  # fmt: skip


# -- reporting -------------------------------------------------------------------------------------


def _iso(ms: int) -> str:
    return dt.datetime.fromtimestamp(ms / 1000, tz=dt.UTC).strftime("%Y-%m-%d %H:%M")


def _f(v: float | None, nd: int = 6) -> str:
    return "" if v is None else f"{v:.{nd}f}"


def _b(v: bool | None) -> str:
    return "" if v is None else str(v)


CSV_COLUMNS = [
    "coin", "horizon", "direction", "distance", "n", "hits", "realized", "predicted_mean",
    "realized_over_predicted", "wilson_lo95", "wilson_hi95", "underpriced_significant", "mean_sigma",
    "k", "q_floor", "priced_mean", "pass",
    "oos_k_train", "oos_q_train", "oos_n_test", "oos_realized_test", "oos_priced_test", "oos_pass",
    "oos_priced_test_k_only", "oos_pass_k_only",
]  # fmt: skip


def write_csv(path: Path, buckets: list[Bucket], oos: dict[tuple, dict]) -> None:
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(CSV_COLUMNS)
        for b in buckets:
            o = oos.get((b.coin, b.horizon, b.direction, b.distance), {})
            ratio = b.realized / b.mean_p if b.mean_p > 0 else float("nan")
            w.writerow([
                b.coin, b.horizon, b.direction, f"{b.distance:.3f}", b.n, b.hits, _f(b.realized),
                _f(b.mean_p, 8), f"{ratio:.3f}", _f(b.wilson_lo), _f(b.wilson_hi),
                str(b.underpriced_significant), _f(b.mean_sigma, 4),
                _f(b.k, 3), _f(b.q), _f(b.priced), _b(b.passes),
                _f(o.get("k_train"), 3), _f(o.get("q_train")), o.get("n_test", ""), _f(o.get("realized_test")),
                _f(o.get("priced_test")), _b(o.get("pass")), _f(o.get("priced_test_k_only")),
                _b(o.get("pass_k_only")),
            ])  # fmt: skip


def write_tail_json(path: Path, buckets: list[Bucket], meta: dict) -> dict:
    coins: dict = {}
    for b in buckets:
        h = str(next(x.seconds for x in HORIZONS if x.name == b.horizon))
        cell = None if b.k is None else {"k": round(b.k, 4), "q": round(b.q, 6), "n": b.n, "hits": b.hits}
        coins.setdefault(b.coin, {}).setdefault(b.direction, {}).setdefault(h, {})[f"{b.distance:.3f}"] = cell
    fitted = [b for b in buckets if b.k is not None]
    blob = {
        "model": MODEL_NAME,
        "generated_at": meta["generated_at"],
        "method": (
            f"Per (coin, direction, horizon, distance) bucket with >= {MIN_OBS} windows: q = Wilson one-sided "
            f"95% upper bound of realized touch frequency; k = clamp(q / mean model p, 1, {K_MAX}), 1 with 0 touches. Priced "
            "probability = max(p*k, q). Lookup: horizon = smallest bucket >= duration; k = max of the "
            "bracketing distance buckets; q = log-linear interpolation between them. null = < 30 windows."
        ),
        "horizons_s": [h.seconds for h in HORIZONS],
        "distances": list(DISTANCES),
        "default": {"k": round(max(b.k for b in fitted), 4), "q": round(max(b.q for b in fitted), 6)},
        "data": meta["ranges"],
        "coins": coins,
    }
    path.write_text(json.dumps(blob, indent=1), encoding="utf-8")
    return blob


def reliability_svg(buckets: list[Bucket]) -> str:
    """Log-log reliability plot: one point per bucket with >= MIN_OBS windows and >= 1 touch."""
    W, Hh, m = 680, 540, 64
    lo_e, hi_e = -5.0, 0.0

    def sx(v: float) -> float:
        return m + (math.log10(max(v, 10**lo_e)) - lo_e) / (hi_e - lo_e) * (W - 2 * m)

    def sy(v: float) -> float:
        return Hh - m - (math.log10(max(v, 10**lo_e)) - lo_e) / (hi_e - lo_e) * (Hh - 2 * m)

    colors = {"1h": "#1f77b4", "4h": "#2ca02c", "1d": "#ff7f0e", "7d": "#d62728"}
    P = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{Hh}" viewBox="0 0 {W} {Hh}" '
        'font-family="sans-serif" font-size="12"><rect width="100%" height="100%" fill="white"/>',
        f'<text x="{W / 2}" y="24" text-anchor="middle" font-size="15">Predicted vs realized touch '
        "frequency per bucket (log-log)</text>",
    ]
    for e in range(int(lo_e), int(hi_e) + 1):
        v = 10.0**e
        P.append(f'<line x1="{sx(v):.1f}" y1="{m}" x2="{sx(v):.1f}" y2="{Hh - m}" stroke="#eee"/>')
        P.append(f'<line x1="{m}" y1="{sy(v):.1f}" x2="{W - m}" y2="{sy(v):.1f}" stroke="#eee"/>')
        P.append(f'<text x="{sx(v):.1f}" y="{Hh - m + 16}" text-anchor="middle">1e{e}</text>')
        P.append(f'<text x="{m - 6}" y="{sy(v) + 4:.1f}" text-anchor="end">1e{e}</text>')
    P.append(
        f'<line x1="{sx(10**lo_e):.1f}" y1="{sy(10**lo_e):.1f}" x2="{sx(1):.1f}" y2="{sy(1):.1f}" '
        'stroke="#888" stroke-dasharray="4 3"/>'
    )
    P.append(f'<rect x="{m}" y="{m}" width="{W - 2 * m}" height="{Hh - 2 * m}" fill="none" stroke="#333"/>')
    P.append(f'<text x="{W / 2}" y="{Hh - 20}" text-anchor="middle">model predicted p (bucket mean)</text>')
    P.append(
        f'<text x="18" y="{Hh / 2}" text-anchor="middle" transform="rotate(-90 18 {Hh / 2})">'
        "realized touch frequency</text>"
    )
    for b in buckets:
        if b.n < MIN_OBS or b.hits == 0:
            continue
        x, y, col = sx(b.mean_p), sy(b.realized), colors[b.horizon]
        tip = f"<title>{b.coin} {b.horizon} {b.direction} {b.distance:.1%}: {b.hits}/{b.n}</title>"
        if b.direction == "down":
            P.append(
                f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3.5" fill="{col}" fill-opacity="0.75">{tip}</circle>'
            )
        else:
            P.append(
                f'<rect x="{x - 3:.1f}" y="{y - 3:.1f}" width="6" height="6" fill="{col}" '
                f'fill-opacity="0.75">{tip}</rect>'
            )
    lx = m + 12
    for i, (name, col) in enumerate(colors.items()):
        P.append(
            f'<circle cx="{lx}" cy="{m + 16 + 16 * i}" r="4" fill="{col}"/>'
            f'<text x="{lx + 10}" y="{m + 20 + 16 * i}">{name}</text>'
        )
    P.append(f'<text x="{lx}" y="{m + 96}">circle = down (long cover), square = up (short cover)</text>')
    P.append(
        f'<text x="{lx}" y="{m + 112}">dashed = perfect calibration; above it = model under-predicts</text>'
    )
    P.append(f'<text x="{lx}" y="{m + 128}">buckets with 0 touches not drawn</text>')
    P.append("</svg>")
    return "\n".join(P)


def _ratio(bs: list[Bucket]) -> tuple[int, float]:
    return sum(b.hits for b in bs), sum(b.mean_p * b.n for b in bs)


def write_markdown(path: Path, buckets: list[Bucket], oos: dict, sims: list[SimResult], meta: dict) -> None:
    L: list[str] = []
    add = L.append
    fitted = [b for b in buckets if b.k is not None]
    n_coins = len(meta["coins"])
    add("# Calibration backtest: one-touch model on Hyperliquid history\n")
    add(
        f"Generated {meta['generated_at']} by `python -m numera_engine.backtest --coins {' '.join(meta['coins'])}` "
        f"(model `{MODEL_NAME}`). Source: Hyperliquid mainnet Info API `candleSnapshot`, read-only. "
        "Files: `calibration.csv` (every bucket, incl. out-of-sample columns), `calibration.svg` (reliability "
        "plot), `tail_multipliers.json` (consumed by the quote API).\n"
    )
    add("## Method\n")
    add(
        '- **Question.** When the engine says "probability p that the price touches level L within T", does '
        "that happen with frequency p or less in real Hyperliquid data?"
    )
    add(
        "- **Data.** Horizons 1h, 4h, 1d: 1-hour candles (the Info API keeps only the latest ~5000). Horizon 7d: "
        "1-day candles from 2023-02-26 on; zero-volume rows and earlier rows dropped (HL-traded data only)."
    )
    add(
        "- **No look-ahead.** At each window start, sigma = max(EWMA lambda=0.94 of log returns, 30-day realized), "
        "annualized, from candles that closed before the start only. A 30-day warm-up is skipped. The 7d "
        "horizon uses daily candles for sigma too (1h history is too short for enough 7d windows); the live "
        "engine uses 1h sigma for every duration."
    )
    add(
        "- **Windows.** Non-overlapping (step = horizon), aligned to multiples of the horizon since the unix "
        "epoch so all coins share start times. S = open of the first candle. Levels 1, 2, 3, 5, 7.5, 10, 15, "
        "20 % below S (`down`, what a long cover pays on) and above S (`up`, short cover). Touched if "
        "min(low) <= S(1-d) or max(high) >= S(1+d) in the window. Windows with a missing candle are skipped."
    )
    add(
        "- **Model.** Closed-form one-touch probability under driftless GBM (ARCHITECTURE §7; checked against "
        "Monte Carlo in `tests/test_pricing.py`)."
    )
    add(
        f"- **Tail adjustment.** Per bucket (coin, horizon, direction, distance) with >= {MIN_OBS} windows: "
        "q = one-sided 95 % Wilson upper bound of the realized touch frequency, k = clamp(q / mean model p, "
        f"1, {K_MAX:g}), and k = 1 when nothing touched (no evidence of under-prediction). The pool charges for max(p x k, q). k keeps the price moving with current "
        "volatility; the floor q makes sure a quote never goes below what history allows, including far "
        "levels where GBM says ~0 but a flash crash happened (or could have: with zero touches q is still "
        "~2.7/n)."
    )
    add(
        "- **Pass criterion** (ARCHITECTURE §9): realized frequency <= mean priced probability in every bucket "
        "with >= 30 windows. In-sample this holds by construction, so the **out-of-sample** check is the "
        "real test: fit (k, q) on the first half of each series (by time), price the second half with it."
    )
    add(
        "- **Caveat: candles are trade prices, not the oracle.** Covers trigger on the oracle (validator median "
        "of 8 venues). HL trade wicks on thin books usually go further than the oracle, so candle touches "
        "over-count oracle touches (conservative for the pool). A payout also needs a `trigger()` call that "
        "sees the breach on-chain; sub-second wicks the keeper misses make real payouts rarer still.\n"
    )

    add("## Data actually used\n")
    add("| coin | candles | first (UTC) | last (UTC) | count | windows per horizon |")
    add("|---|---|---|---|---|---|")
    for coin in meta["coins"]:
        for iv in ("1h", "1d"):
            r = meta["ranges"][coin][iv]
            wins = ", ".join(
                f"{h.name}: {meta['windows'][coin][h.name]}" for h in HORIZONS if h.interval == iv
            )
            add(f"| {coin} | {iv} | {r['first']} | {r['last']} | {r['count']} | {wins} |")
    add("")

    oos_rows = list(oos.values())
    n_pass = sum(1 for b in fitted if b.passes)
    raw_over = [b for b in fitted if b.realized > b.mean_p]
    sig = [b for b in fitted if b.underpriced_significant]
    ks = [b.k for b in fitted]
    add("## Headline\n")
    add(
        f"- **{len(fitted)} of {len(buckets)} buckets have >= {MIN_OBS} windows** ({n_coins} coins x 4 horizons x "
        "2 directions x 8 distances)."
    )
    add(
        f"- Raw model (no adjustment): realized above predicted in {len(raw_over)} buckets, significantly "
        f"(Wilson 95 % lower bound above p) in **{len(sig)}**. Overall the model *over*-predicts touches near "
        "the money and *under*-predicts the far tail (details below)."
    )
    add(f"- In-sample with (k, q): {n_pass}/{len(fitted)} pass (by construction).")
    add(
        f"- **Out-of-sample** (fit on first half, test on second half): **{sum(1 for o in oos_rows if o['pass'])}/"
        f"{len(oos_rows)} pass** with max(p x k, q); with k alone (no floor) "
        f"{sum(1 for o in oos_rows if o['pass_k_only'])}/{len(oos_rows)}."
    )
    add(
        f"- k: min {min(ks):.2f}, median {float(np.median(ks)):.2f}, max {max(ks):.2f} (cap {K_MAX:g}); "
        f"{sum(1 for k in ks if k > 1.0001)} buckets have k > 1.\n"
    )

    add("## Findings in plain language\n")
    add(_findings(buckets, oos))
    add("")

    add("## Expected vs actual touches\n")
    add(
        "Sum of raw model p over all windows (= expected number of touches) vs touches that happened; all "
        "coins, all distances.\n"
    )
    add("| horizon | direction | windows x distances | expected (sum p) | actual | actual / expected |")
    add("|---|---|---|---|---|---|")
    for hz in HORIZONS:
        for direction in ("down", "up"):
            bs = [b for b in buckets if b.horizon == hz.name and b.direction == direction]
            act, exp_ = _ratio(bs)
            add(
                f"| {hz.name} | {direction} | {sum(b.n for b in bs)} | {exp_:.1f} | {act} | "
                f"{act / exp_ if exp_ else float('nan'):.2f} |"
            )
    add("\nBy distance (all coins, horizons and directions):\n")
    add("| distance | expected | actual | actual / expected |")
    add("|---|---|---|---|")
    for d in DISTANCES:
        act, exp_ = _ratio([b for b in buckets if math.isclose(b.distance, d)])
        add(f"| {d:.1%} | {exp_:.1f} | {act} | {act / exp_ if exp_ else float('inf'):.2f} |")
    add("")

    add("## Pool P&L simulation\n")
    add(
        f"At every window start the pool sells one cover per coin x direction x distance in "
        f"{{{', '.join(f'{d:.1%}' for d in SIM_DISTANCES)}}}, each paying {SIM_PAYOUT_FRACTION:.2%} of the "
        f"initial LP capital (at most {SIM_PAYOUT_FRACTION * 2 * len(SIM_DISTANCES) * n_coins:.0%} locked; no "
        "compounding), "
        f"premium = payout x max(p x k, q) x (1 + {THETA:g}), refused when max(p x k, q) > {P_MAX:g}. Covers "
        "settle before the next window; no fees, no idle yield. Variants: `raw` = model p with the 20 % "
        "loading only; `k only OOS` = multiplier fitted on the first half, no floor; `fitted OOS` = (k, q) "
        "fitted on the first half, trading only the second half (the honest number); `fitted in-sample` = the "
        "published (k, q) on the same data (optimistic).\n"
    )
    add(
        "**How to read it.** Price and claims per 100 USDC of cover, the loss ratio (claims / premiums; the "
        "20 % loading alone targets 0.83) and drawdown do not depend on how many covers are sold. LP P&L does: "
        "this book sells one full set of covers every window, which for 1h covers means 24 sets a day, far "
        "more than real demand. Read LP P&L as an upper bound for this demand assumption, not as a forecast.\n"
    )
    add(
        "| horizon | variant | days | windows | covers sold | refused | triggered | premium per 100 | "
        "claims per 100 | loss ratio | LP P&L | LP P&L per 30 d | max drawdown | worst window |"
    )
    add("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for s in sims:
        add(
            f"| {s.horizon} | {s.label} | {s.days:.0f} | {s.steps} | {s.sold} | {s.refused} | {s.triggered} | "
            f"{s.price_per_100:.3f} | {s.claims_per_100:.3f} | {s.loss_ratio:.2f} | {s.ret:+.1%} | "
            f"{s.ret_30d:+.1%} | {s.max_dd:.2%} | {s.worst_step:+.2%} |"
        )
    add("")
    by = {(s.horizon, s.label): s for s in sims}
    add("**What the simulation says (second half, out of sample):**\n")
    for hz in HORIZONS:
        raw, ko, fo = (
            by[(hz.name, lbl)] for lbl in ("raw, 2nd half", "k only OOS, 2nd half", "fitted OOS, 2nd half")
        )
        add(
            f"- {hz.name}: raw model loss ratio {raw.loss_ratio:.2f} (max drawdown {raw.max_dd:.1%}); with k "
            f"{ko.loss_ratio:.2f} ({ko.max_dd:.1%}); with k and floor {fo.loss_ratio:.2f} ({fo.max_dd:.1%}) at "
            f"{fo.price_per_100 / raw.price_per_100:.1f}x the raw price."
        )
    add(
        "- The trade-off is explicit: the raw GBM price is not safe for short covers (its 1h loss ratio is "
        "around 1 even with a 20 % loading, because the tail is under-priced). k fixes most of that. The floor "
        "q makes every bucket pass out of sample but raises the price most for the shortest covers (ratios "
        "above), so the pool is very profitable on paper. With more data (longer oracle history, pooling "
        "coins) the floor tightens and prices come down; v1 deliberately errs on the side of LP solvency.\n"
    )

    add("## Calibration table\n")
    add(
        "All buckets with >= 30 windows. `ratio` = realized / predicted (raw model); `sig` = significantly "
        "under-predicted. `priced` = mean of max(p x k, q). `OOS` = out-of-sample result with (k, q) fitted on "
        "the first half.\n"
    )
    add(
        "| coin | hz | dir | dist | windows | touches | realized | predicted | ratio | k | q | priced | OOS |"
    )
    add("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for b in fitted:
        o = oos.get((b.coin, b.horizon, b.direction, b.distance))
        ratio = b.realized / b.mean_p if b.mean_p > 0 else float("inf")
        oo = "" if o is None else ("pass" if o["pass"] else "**FAIL**")
        add(
            f"| {b.coin} | {b.horizon} | {b.direction} | {b.distance:.1%} | {b.n} | {b.hits} | {b.realized:.4f} | "
            f"{b.mean_p:.2e} | {ratio:.2f}{' sig' if b.underpriced_significant else ''} | {b.k:.2f} | "
            f"{b.q:.4f} | {b.priced:.4f} | {oo} |"
        )
    add("")
    add("## Limitations\n")
    add(
        "- Trade-price candles approximate the oracle (see method). Oracle minute history exists only in a "
        "requester-pays S3 archive and was not used."
    )
    add(
        "- 1h history is ~7 months for every coin: essentially one market regime. The 7d buckets span 2023-2026 "
        "but have < 200 windows each."
    )
    add(
        "- Buckets are not independent (the same windows at different distances; correlated coins). Wilson "
        "bounds treat windows as independent; volatility clustering makes true uncertainty larger."
    )
    add(
        "- The floor q is a historical frequency for a fixed % distance, so in calm regimes it can dominate p x k "
        "and over-price near-the-money covers. That is a deliberate conservative choice for v1."
    )
    add(
        "- (k, q) are point-in-time. They should be refitted on a schedule and the out-of-sample pass rate "
        "tracked; a failing bucket is a signal to widen the margin, not noise to ignore."
    )
    path.write_text("\n".join(L) + "\n", encoding="utf-8")


def _findings(buckets: list[Bucket], oos: dict) -> str:
    fitted = [b for b in buckets if b.k is not None]
    out = []
    near = [b for b in fitted if b.distance <= 0.03 and b.horizon in ("1h", "4h", "1d")]
    act, exp_ = _ratio(near)
    out.append(
        f"- **Near the money the model is conservative.** For levels 1-3 % away over 1h-1d, {act} touches "
        f"happened where the model expected {exp_:.0f} ({act / exp_:.2f}x). Likely reasons (not tested "
        "separately): the 30-day realized floor keeps sigma high after volatile spells, and short-horizon "
        "returns mean-revert a little, so GBM over-states how often nearby levels are hit."
    )
    far = [b for b in fitted if b.distance >= 0.05 and b.horizon in ("1h", "4h")]
    act, exp_ = _ratio(far)
    tiny = [b for b in far if b.hits > 0 and b.mean_p < 1e-4]
    out.append(
        f"- **In the far tail the model under-prices.** For levels >= 5 % away within 1-4h, {act} touches "
        f"happened where GBM expected {exp_:.1f} ({act / exp_:.2f}x). The gap is worst at the extremes: "
        f"{len(tiny)} buckets where GBM gives p < 1e-4 still saw {sum(b.hits for b in tiny)} touches in "
        f"{sum(b.n for b in tiny)} windows. Across all horizons the 20 % level was touched "
        f"{_ratio([b for b in fitted if b.distance >= 0.2])[0]} times vs "
        f"{_ratio([b for b in fitted if b.distance >= 0.2])[1]:.0f} expected. These are the flash moves "
        "liquidation cover exists for; this is why the price is max(p x k, q) and the floor q carries this risk."
    )
    sig = sorted(
        (b for b in fitted if b.underpriced_significant), key=lambda b: -b.realized / max(b.mean_p, 1e-15)
    )
    if sig:
        out.append(
            f"- **Significantly under-predicted buckets ({len(sig)}):** "
            + "; ".join(
                f"{b.coin} {b.horizon} {b.direction} {b.distance:.1%}: {b.hits}/{b.n} touched vs p = "
                f"{b.mean_p:.1e}"
                for b in sig[:8]
            )
            + ("; ..." if len(sig) > 8 else "")
            + ". Full list: `underpriced_significant` in the CSV."
        )
    dn = [b for b in fitted if b.direction == "down"]
    up = [b for b in fitted if b.direction == "up"]
    (ad, ed), (au, eu) = _ratio(dn), _ratio(up)
    out.append(
        f"- **Direction:** actual/expected touches {ad / ed:.2f} for down levels (long covers) and "
        f"{au / eu:.2f} for up levels (short covers)."
    )
    for hz in HORIZONS:
        bs = [b for b in fitted if b.horizon == hz.name]
        a, e = _ratio(bs)
        out.append(f"  - {hz.name}: {a} touches vs {e:.0f} expected ({a / e:.2f}x).")
    fails = [(key, v) for key, v in oos.items() if not v["pass"]]
    if fails:
        out.append(
            f"- **Out-of-sample failures ({len(fails)}/{len(oos)}):** "
            + "; ".join(
                f"{c} {h} {d} {x:.1%} (realized {v['realized_test']:.4f} > priced {v['priced_test']:.4f})"
                for (c, h, d, x), v in fails[:10]
            )
            + ("; ..." if len(fails) > 10 else "")
            + ". In these buckets the second half was riskier than the first half: a fitted adjustment is not "
            "a guarantee and must be refitted as data arrives."
        )
    else:
        out.append(f"- **Out of sample, every bucket passed** ({len(oos)}/{len(oos)}).")
    return "\n".join(out)


# -- driver ----------------------------------------------------------------------------------------


def fetch_series(client: InfoClient, coin: str, now_ms: int) -> dict[str, tuple[Series, dict]]:
    out = {}
    h_ms, d_ms = INTERVAL_MS["1h"], INTERVAL_MS["1d"]
    end_h = now_ms // h_ms * h_ms - h_ms  # open time of the last fully closed hour
    hc = client.candles(coin, "1h", end_h - 5200 * h_ms, end_h)
    end_d = now_ms // d_ms * d_ms - d_ms
    dc = client.candles(coin, "1d", HL_DAILY_START_MS, end_d)
    dc = [c for c in dc if c.v > 0 and c.t >= HL_DAILY_START_MS]
    for iv, cs in (("1h", hc), ("1d", dc)):
        if len(cs) < 40:
            raise RuntimeError(f"not enough {iv} candles for {coin}: {len(cs)}")
        info = {"first": _iso(cs[0].t), "last": _iso(cs[-1].t), "count": len(cs)}
        out[iv] = (Series.from_candles(cs), info)
    return out


def _fit_map(buckets: list[Bucket]) -> dict[tuple[str, float], tuple[float, float]]:
    return {(b.direction, b.distance): (b.k, b.q) for b in buckets if b.k is not None}


def run(coins: list[str], out_dir: Path = REPORTS_DIR, info_url: str = MAINNET_INFO_URL) -> dict:
    client = InfoClient(info_url)
    now_ms = int(time.time() * 1000)
    out_dir.mkdir(parents=True, exist_ok=True)
    buckets: list[Bucket] = []
    oos: dict[tuple, dict] = {}
    ranges: dict = {}
    windows: dict = {}
    obs_all: dict[str, dict[str, Obs]] = defaultdict(dict)  # horizon -> coin -> obs
    fit_full: dict[str, dict[str, dict]] = defaultdict(dict)  # horizon -> coin -> fit
    fit_train: dict[str, dict[str, dict]] = defaultdict(dict)
    split_t: dict[str, int] = {}
    for coin in coins:
        print(f"[backtest] fetching {coin} ...", flush=True)
        ser = fetch_series(client, coin, now_ms)
        ranges[coin] = {iv: ser[iv][1] for iv in ser}
        windows[coin] = {}
        for hz in HORIZONS:
            ob = observations(ser[hz.interval][0], hz)
            obs_all[hz.name][coin] = ob
            windows[coin][hz.name] = len(np.unique(ob.start_ms))
            bs = aggregate(coin, hz.name, ob)
            buckets += bs
            fit_full[hz.name][coin] = _fit_map(bs)
    # out-of-sample: one split time per horizon (median start across coins) so the pool sim halves align
    for hz in HORIZONS:
        allstarts = np.unique(np.concatenate([ob.start_ms for ob in obs_all[hz.name].values()]))
        t_split = int(allstarts[len(allstarts) // 2])
        split_t[hz.name] = t_split
        for coin, ob in obs_all[hz.name].items():
            train = aggregate(coin, hz.name, ob, ob.start_ms < t_split)
            fit = _fit_map(train)
            fit_train[hz.name][coin] = fit
            test = aggregate(coin, hz.name, ob, ob.start_ms >= t_split, fit=fit)
            k_only = {key: (kq[0], 0.0) for key, kq in fit.items()}
            test_k = aggregate(coin, hz.name, ob, ob.start_ms >= t_split, fit=k_only)
            for te, tk in zip(test, test_k, strict=True):
                if te.priced is None or te.n < MIN_OBS:
                    continue
                k, q = fit[(te.direction, te.distance)]
                oos[(coin, hz.name, te.direction, te.distance)] = {
                    "k_train": k, "q_train": q, "n_test": te.n, "realized_test": te.realized,
                    "priced_test": te.priced, "pass": bool(te.passes),
                    "priced_test_k_only": tk.priced, "pass_k_only": bool(tk.passes),
                }  # fmt: skip
    sims: list[SimResult] = []
    for hz in HORIZONS:
        ob = obs_all[hz.name]
        sims.append(simulate_pool("raw, full", hz, ob, {}))
        sims.append(simulate_pool("fitted in-sample, full", hz, ob, fit_full[hz.name]))
        sims.append(simulate_pool("raw, 2nd half", hz, ob, {}, t_from=split_t[hz.name]))
        k_only = {c: {key: (kq[0], 0.0) for key, kq in f.items()} for c, f in fit_train[hz.name].items()}
        sims.append(simulate_pool("k only OOS, 2nd half", hz, ob, k_only, t_from=split_t[hz.name]))
        sims.append(
            simulate_pool("fitted OOS, 2nd half", hz, ob, fit_train[hz.name], t_from=split_t[hz.name])
        )
    meta = {
        "generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%MZ"),
        "coins": coins,
        "ranges": ranges,
        "windows": windows,
    }
    write_csv(out_dir / "calibration.csv", buckets, oos)
    blob = write_tail_json(out_dir / "tail_multipliers.json", buckets, meta)
    (out_dir / "calibration.svg").write_text(reliability_svg(buckets), encoding="utf-8")
    write_markdown(out_dir / "calibration.md", buckets, oos, sims, meta)
    print(f"[backtest] wrote {out_dir}", flush=True)
    return {"buckets": buckets, "oos": oos, "sims": sims, "tail": blob, "meta": meta}


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Calibration backtest of the one-touch model")
    ap.add_argument("--coins", nargs="+", default=["BTC", "ETH", "SOL", "HYPE"])
    ap.add_argument("--out", type=Path, default=REPORTS_DIR)
    args = ap.parse_args(argv)
    res = run(args.coins, args.out)
    fitted = [b for b in res["buckets"] if b.k is not None]
    oos = res["oos"].values()
    print(
        f"[backtest] buckets >= {MIN_OBS} windows: {len(fitted)}; in-sample pass "
        f"{sum(1 for b in fitted if b.passes)}; OOS pass {sum(1 for o in oos if o['pass'])}/{len(oos)} "
        f"(k only: {sum(1 for o in oos if o['pass_k_only'])}); k {min(b.k for b in fitted):.2f}-"
        f"{max(b.k for b in fitted):.2f}"
    )
    for s in res["sims"]:
        print(
            f"[backtest] pool {s.horizon:>3} {s.label:<24} sold {s.sold:>6} refused {s.refused:>5} "
            f"price/100 {s.price_per_100:.3f} loss ratio {s.loss_ratio:.2f} LP {s.ret:+.1%} "
            f"({s.ret_30d:+.1%}/30d) maxDD {s.max_dd:.2%}"
        )


if __name__ == "__main__":
    main()
