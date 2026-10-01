"""Calibration backtest of the one-touch model on real Hyperliquid history (ARCHITECTURE §9, decision D9).

    python -m numera_engine.backtest --coins BTC ETH SOL HYPE

For each coin, horizon and distance, compare the model's predicted touch probability (sigma estimated
strictly from data before the start) with whether the price actually touched the level within the
window (candle low/high). The tail adjustment (k, q) is fitted on the standardized distance
z = ln(H/S) / (sigma sqrt(T)), pooled over all coins and horizons (v2). The previous per-bucket fit (v1,
per coin x horizon x distance) is kept as a side-by-side comparison. Both are checked out of sample and
run through a pool P&L simulation.

Writes engine/reports/: calibration.md, calibration.csv (per % bucket), calibration_z.csv (pooled z
buckets), calibration_z_by_horizon.csv (diagnostic), calibration.svg, tail_multipliers.json (v2 schema).
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
from .pricing import DISTANCES, P_MAX, THETA, Z_EDGES, ZTailTable, touch_prob
from .vol import DAYS_PER_YEAR, HOURS_PER_YEAR, sigma_series

REPORTS_DIR = Path(__file__).resolve().parent.parent / "reports"
HL_DAILY_START_MS = int(dt.datetime(2023, 2, 26, tzinfo=dt.UTC).timestamp() * 1000)
MIN_OBS = 30
K_MAX = 10.0
Z_ONE_SIDED_95 = 1.6448536269514722
TARGET_LOSS_RATIO = (0.5, 0.8)


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
    z: np.ndarray  # ln(H/S) / (sigma sqrt(T)), signed (< 0 for down levels)

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
        sd = sigma * math.sqrt(T)
        for d in distances:
            Hd, Hu = S * (1 - d), S * (1 + d)
            rows.append(
                (int(s.t[i]), "down", d, sigma, touch_prob(S, Hd, sigma, T), lo <= Hd, math.log(1 - d) / sd)
            )
            rows.append(
                (int(s.t[i]), "up", d, sigma, touch_prob(S, Hu, sigma, T), hi >= Hu, math.log(1 + d) / sd)
            )
    cols = list(zip(*rows, strict=True)) if rows else [[]] * 7
    return Obs(
        start_ms=np.array(cols[0], dtype=np.int64),
        direction=np.array(cols[1], dtype=object),
        distance=np.array(cols[2], dtype=float),
        sigma=np.array(cols[3], dtype=float),
        p=np.array(cols[4], dtype=float),
        hit=np.array(cols[5], dtype=bool),
        z=np.array(cols[6], dtype=float),
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
        carries the risk. k = 1 when nothing touched: no evidence the model under-predicts, and the
        sample-size uncertainty is already in q.
    """
    if n < MIN_OBS:
        return None
    q = wilson(hits, n)[1]
    k = 1.0 if hits == 0 or mean_p <= 0 else min(K_MAX, max(1.0, q / mean_p))
    return k, q


@dataclass
class Bucket:
    """Per (coin, horizon, direction, % distance): the calibration view of ARCHITECTURE §9."""

    coin: str
    horizon: str
    direction: str
    distance: float
    n: int
    hits: int
    mean_p: float
    mean_sigma: float
    k: float | None  # v1 fit on these rows
    q: float | None
    priced: float | None  # mean over windows of the priced probability (v1 in-sample by default)

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


def _bucket_mask(obs: Obs, direction: str, d: float) -> np.ndarray:
    return (obs.direction == direction) & np.isclose(obs.distance, d)


def aggregate(coin: str, hz: str, obs: Obs, mask: np.ndarray | None = None, priced: np.ndarray | None = None):
    """Buckets per (direction, distance) over ``mask``. v1 (k, q) is fitted on these rows. ``priced`` is a
    per-row priced probability to evaluate (default: v1 in-sample)."""
    if mask is None:
        mask = np.ones(len(obs), dtype=bool)
    out = []
    for direction in ("down", "up"):
        for d in DISTANCES:
            m = mask & _bucket_mask(obs, direction, d)
            n, hits = int(m.sum()), int(obs.hit[m].sum())
            mp = float(obs.p[m].mean()) if n else 0.0
            kq = fit_tail(hits, n, mp)
            if priced is not None:
                pr = float(np.minimum(priced[m], 1.0).mean()) if n else None
            else:
                pr = float(np.maximum(obs.p[m] * kq[0], kq[1]).mean()) if kq and n else None
            out.append(
                Bucket(coin, hz, direction, d, n, hits, mp, float(obs.sigma[m].mean()) if n else 0.0,
                       kq[0] if kq else None, kq[1] if kq else None, pr)
            )  # fmt: skip
    return out


def v1_fit(buckets: list[Bucket]) -> dict[tuple[str, float], tuple[float, float]]:
    return {(b.direction, b.distance): (b.k, b.q) for b in buckets if b.k is not None}


def v1_priced(obs: Obs, fit: dict[tuple[str, float], tuple[float, float]]) -> np.ndarray:
    """Per-row max(p*k, q) with the per-(coin, horizon) bucket fit; rows without a fit stay at p."""
    out = obs.p.copy()
    for (direction, d), (k, q) in fit.items():
        m = _bucket_mask(obs, direction, d)
        out[m] = np.maximum(obs.p[m] * k, q)
    return out


# -- v2: pooled z buckets --------------------------------------------------------------------------


@dataclass
class ZBucket:
    direction: str
    lo: float
    hi: float
    n: int
    hits: int
    mean_p: float
    k: float | None
    q: float | None

    @property
    def realized(self) -> float:
        return self.hits / self.n if self.n else 0.0

    def cell(self) -> dict | None:
        if self.k is None:
            return None
        return {"k": round(self.k, 4), "q": round(self.q, 8), "n": self.n, "hits": self.hits,
                "mean_p": round(self.mean_p, 8)}  # fmt: skip


def _zlabel(lo: float, hi: float) -> str:
    return f">= {lo:g}" if math.isinf(hi) else f"{lo:g}-{hi:g}"


def fit_z(parts: list[tuple[Obs, np.ndarray]], edges=Z_EDGES) -> list[ZBucket]:
    """Pool rows (obs, mask) of all coins and horizons into |z| buckets per direction and fit (k, q)."""
    zz = np.concatenate([np.abs(o.z[m]) for o, m in parts])
    pp = np.concatenate([o.p[m] for o, m in parts])
    hh = np.concatenate([o.hit[m] for o, m in parts])
    dd = np.concatenate([o.direction[m] for o, m in parts])
    out = []
    for direction in ("down", "up"):
        for lo, hi in zip(edges[:-1], edges[1:], strict=True):
            m = (dd == direction) & (zz >= lo) & (zz < hi)
            n, hits = int(m.sum()), int(hh[m].sum())
            mp = float(pp[m].mean()) if n else 0.0
            kq = fit_tail(hits, n, mp)
            out.append(ZBucket(direction, lo, hi, n, hits, mp, kq[0] if kq else None, kq[1] if kq else None))
    return out


def z_table(zbs: list[ZBucket], edges=Z_EDGES) -> ZTailTable:
    return ZTailTable(tuple(edges), {d: [b.cell() for b in zbs if b.direction == d] for d in ("down", "up")})


def v2_priced(obs: Obs, table: ZTailTable) -> np.ndarray:
    """Per-row max(p * k_z, q_z) with the pooled table (same lookup as the live quote API)."""
    out = np.empty(len(obs))
    cache: dict[tuple[bool, float], tuple[float, float]] = {}
    for i, (direction, z, p) in enumerate(zip(obs.direction, obs.z, obs.p, strict=True)):
        key = (direction == "down", round(abs(float(z)), 6))
        if key not in cache:
            a = table.kq(key[0], key[1])
            cache[key] = (a.k, a.q)
        k, q = cache[key]
        out[i] = max(p * k, q)
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
    premium: float  # sums in units of initial LP capital
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
    priced_by_coin: dict[str, np.ndarray] | None = None,
    t_from: int | None = None,
    theta: float = THETA,
    p_max: float = P_MAX,
) -> SimResult:
    """At every window start the pool sells one cover per (coin, direction, distance in SIM_DISTANCES), each
    paying SIM_PAYOUT_FRACTION of the initial LP capital (no compounding), premium = payout * priced
    probability * (1 + theta), refusing when the priced probability > pMax. ``priced_by_coin`` holds a
    per-row priced probability (default: raw model p). Covers settle before the next window."""
    steps: dict[int, list[tuple[float, bool]]] = defaultdict(list)
    for coin, ob in obs_by_coin.items():
        pr = ob.p if priced_by_coin is None else priced_by_coin[coin]
        sim = np.zeros(len(ob), dtype=bool)
        for d in SIM_DISTANCES:
            sim |= np.isclose(ob.distance, d)
        if t_from is not None:
            sim &= ob.start_ms >= t_from
        for t, pp, hit in zip(ob.start_ms[sim], pr[sim], ob.hit[sim], strict=True):
            steps[int(t)].append((float(pp), bool(hit)))
    eq, peak, max_dd, worst = 1.0, 1.0, 0.0, 0.0
    sold = refused = trig = 0
    prem_sum = paid_sum = 0.0
    ts = sorted(steps)
    for t in ts:
        pnl = 0.0
        for pp, hit in steps[t]:
            if pp > p_max:
                refused += 1
                continue
            sold += 1
            prem = SIM_PAYOUT_FRACTION * pp * (1 + theta)
            prem_sum += prem
            pnl += prem
            if hit:
                trig += 1
                paid_sum += SIM_PAYOUT_FRACTION
                pnl -= SIM_PAYOUT_FRACTION
        worst = min(worst, pnl / eq)
        eq += pnl
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
    "v1_k", "v1_q", "v1_priced_in_sample",
    "oos_n_test", "oos_realized_test", "oos_v1_priced_test", "oos_v1_pass", "oos_v2_priced_test", "oos_v2_pass", "oos_v2b_priced_test", "oos_v2b_pass",
    "v2_priced_in_sample", "v2_pass_in_sample",
]  # fmt: skip


def write_csv(
    path: Path, buckets: list[Bucket], oos: dict[tuple, dict], v2_full: dict[tuple, Bucket]
) -> None:
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(CSV_COLUMNS)
        for b in buckets:
            key = (b.coin, b.horizon, b.direction, b.distance)
            o = oos.get(key, {})
            v2 = v2_full.get(key)
            ratio = b.realized / b.mean_p if b.mean_p > 0 else float("nan")
            w.writerow([
                b.coin, b.horizon, b.direction, f"{b.distance:.3f}", b.n, b.hits, _f(b.realized),
                _f(b.mean_p, 8), f"{ratio:.3f}", _f(b.wilson_lo), _f(b.wilson_hi),
                str(b.underpriced_significant), _f(b.mean_sigma, 4), _f(b.k, 3), _f(b.q), _f(b.priced),
                o.get("n_test", ""), _f(o.get("realized_test")), _f(o.get("v1_priced")), _b(o.get("v1_pass")),
                _f(o.get("v2_priced")), _b(o.get("v2_pass")),
                _f(o.get("v2b_priced")), _b(o.get("v2b_pass")),
                _f(v2.priced if v2 else None), _b(v2.passes if v2 else None),
            ])  # fmt: skip


def write_z_csv(path: Path, full: list[ZBucket], train: list[ZBucket], test_eval: dict) -> None:
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["direction", "abs_z_lo", "abs_z_hi", "n", "hits", "realized", "mean_p", "wilson_lo95",
                    "k", "q", "train_k", "train_q", "oos_n_test", "oos_realized_test", "oos_priced_test",
                    "oos_pass"])  # fmt: skip
        for b, t in zip(full, train, strict=True):
            e = test_eval.get((b.direction, b.lo), {})
            w.writerow([b.direction, f"{b.lo:g}", "inf" if math.isinf(b.hi) else f"{b.hi:g}", b.n, b.hits,
                        _f(b.realized), _f(b.mean_p, 8), _f(wilson(b.hits, b.n)[0]), _f(b.k, 4), _f(b.q, 8),
                        _f(t.k, 4), _f(t.q, 8), e.get("n", ""), _f(e.get("realized")), _f(e.get("priced")),
                        _b(e.get("pass"))])  # fmt: skip


def write_tail_json(path: Path, zbs: list[ZBucket], meta: dict) -> dict:
    fitted = [b for b in zbs if b.k is not None]
    blob = {
        "schema": "z-pooled-v2",
        "model": MODEL_NAME,
        "generated_at": meta["generated_at"],
        "formula": "priced = max(p * k(dir, |z|), q(dir, |z|)); refuse if priced > pMax; "
        "premium = ceil(payout * priced * (1 + theta)) + fee; z = ln(level/spot) / (sigma * sqrt(T))",
        "method": (
            f"Windows of all coins and horizons pooled into |z| buckets per direction. Per bucket with >= "
            f"{MIN_OBS} windows: q = Wilson one-sided 95% upper bound of realized touch frequency; "
            f"k = clamp(q / mean model p, 1, {K_MAX:g}), 1 with 0 touches. Lookup: k from the bucket holding "
            "|z|; q made non-increasing in |z| then log-linearly interpolated between bucket mid-points. "
            "null = < 30 windows (nearest populated bucket is used)."
        ),
        "z_edges": [None if math.isinf(e) else e for e in Z_EDGES],
        "cells": {d: [b.cell() for b in zbs if b.direction == d] for d in ("down", "up")},
        "default": {"k": round(max(b.k for b in fitted), 4), "q": round(max(b.q for b in fitted), 8)},
        "data": meta["ranges"],
    }
    path.write_text(json.dumps(blob, indent=1), encoding="utf-8")
    return blob


def reliability_svg(points: list[tuple[float, float, str, str, str]], legend: list[tuple[str, str]],
                    title: str) -> str:  # fmt: skip
    """Log-log reliability plot. points: (predicted, realized, color, 'circle'|'square', tooltip)."""
    W, Hh, m = 680, 540, 64
    lo_e, hi_e = -6.0, 0.0

    def sx(v: float) -> float:
        return m + (math.log10(max(v, 10**lo_e)) - lo_e) / (hi_e - lo_e) * (W - 2 * m)

    def sy(v: float) -> float:
        return Hh - m - (math.log10(max(v, 10**lo_e)) - lo_e) / (hi_e - lo_e) * (Hh - 2 * m)

    P = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{Hh}" viewBox="0 0 {W} {Hh}" '
        'font-family="sans-serif" font-size="12"><rect width="100%" height="100%" fill="white"/>',
        f'<text x="{W / 2}" y="24" text-anchor="middle" font-size="15">{title}</text>',
    ]
    for e in range(int(lo_e), int(hi_e) + 1):
        v = 10.0**e
        P.append(f'<line x1="{sx(v):.1f}" y1="{m}" x2="{sx(v):.1f}" y2="{Hh - m}" stroke="#eee"/>')
        P.append(f'<line x1="{m}" y1="{sy(v):.1f}" x2="{W - m}" y2="{sy(v):.1f}" stroke="#eee"/>')
        P.append(f'<text x="{sx(v):.1f}" y="{Hh - m + 16}" text-anchor="middle">1e{e}</text>')
        P.append(f'<text x="{m - 6}" y="{sy(v) + 4:.1f}" text-anchor="end">1e{e}</text>')
    P.append(f'<line x1="{sx(10**lo_e):.1f}" y1="{sy(10**lo_e):.1f}" x2="{sx(1):.1f}" y2="{sy(1):.1f}" '
             'stroke="#888" stroke-dasharray="4 3"/>')  # fmt: skip
    P.append(f'<rect x="{m}" y="{m}" width="{W - 2 * m}" height="{Hh - 2 * m}" fill="none" stroke="#333"/>')
    P.append(f'<text x="{W / 2}" y="{Hh - 20}" text-anchor="middle">model predicted p (bucket mean)</text>')
    P.append(f'<text x="18" y="{Hh / 2}" text-anchor="middle" transform="rotate(-90 18 {Hh / 2})">'
             "realized touch frequency</text>")  # fmt: skip
    for x, y, col, shape, tip in points:
        X, Y = sx(x), sy(y)
        t = f"<title>{tip}</title>"
        if shape == "circle":
            P.append(
                f'<circle cx="{X:.1f}" cy="{Y:.1f}" r="3.5" fill="{col}" fill-opacity="0.75">{t}</circle>'
            )
        else:
            P.append(f'<rect x="{X - 3:.1f}" y="{Y - 3:.1f}" width="6" height="6" fill="{col}" '
                     f'fill-opacity="0.75">{t}</rect>')  # fmt: skip
    lx = m + 12
    for i, (name, col) in enumerate(legend):
        P.append(f'<circle cx="{lx}" cy="{m + 16 + 16 * i}" r="4" fill="{col}"/>'
                 f'<text x="{lx + 10}" y="{m + 20 + 16 * i}">{name}</text>')  # fmt: skip
    y0 = m + 32 + 16 * len(legend)
    P.append(f'<text x="{lx}" y="{y0}">circle = down (long cover), square = up (short cover)</text>')
    P.append(
        f'<text x="{lx}" y="{y0 + 16}">dashed = perfect calibration; above it = model under-predicts</text>'
    )
    P.append(f'<text x="{lx}" y="{y0 + 32}">buckets with 0 touches not drawn</text>')
    P.append("</svg>")
    return "\n".join(P)


HZ_COLORS = {"1h": "#1f77b4", "4h": "#2ca02c", "1d": "#ff7f0e", "7d": "#d62728"}


def _ratio(bs) -> tuple[int, float]:
    return sum(b.hits for b in bs), sum(b.mean_p * b.n for b in bs)


ZGROUPS = ((0, 1), (1, 2), (2, 3), (3, 4), (4, 7), (7, math.inf))


def write_markdown(path: Path, ctx: dict) -> None:
    buckets: list[Bucket] = ctx["buckets"]
    zfull: list[ZBucket] = ctx["zfull"]
    oos: dict = ctx["oos"]
    sims: dict = ctx["sims"]
    meta: dict = ctx["meta"]
    diag: list[dict] = ctx["diag"]
    fitted = [b for b in buckets if b.k is not None]
    n_coins = len(meta["coins"])
    L: list[str] = []
    add = L.append
    add("# Calibration backtest: one-touch model on Hyperliquid history\n")
    add(
        f"Generated {meta['generated_at']} by `python -m numera_engine.backtest --coins {' '.join(meta['coins'])}` "
        f"(model `{MODEL_NAME}`, tail table `z-pooled-v2`, decision D9). Source: Hyperliquid mainnet Info API "
        "`candleSnapshot`, read-only. Files: `calibration.csv` (per coin/horizon/distance bucket, v1 and v2 "
        "out-of-sample columns), `calibration_z.csv` (pooled z buckets = the published table), "
        "`calibration_z_by_horizon.csv` (diagnostic), `calibration.svg` (reliability plot), "
        "`tail_multipliers.json` (consumed by the quote API).\n"
    )

    add("## Pricing formula (engine v1, final)\n")
    add(
        "For a cover on perp `i`, direction `isLong`, trigger level `L` (px6), payout `P` (USDC, 6 dec), "
        "duration `D` seconds:\n"
    )
    add("```")
    add(
        "S      = pool.priceSource().oraclePx6(i) / 1e6 via eth_call (D10: what buyCover checks); spotRef = it"
    )
    add(
        "         fallback if that read fails: testnet Info API metaAndAssetCtxs.oraclePx (breakdown.spotSource)"
    )
    add(
        "sigma  = max(EWMA_0.94(1h log returns), realized sigma over the last 30 days), annualized x sqrt(24*365)"
    )
    add("         from mainnet Info API 1h candles of the same coin (read-only); used for every duration")
    add("T      = D / (365*24*3600)")
    add("b      = ln(L/S),  s = sigma*sqrt(T)")
    add("p      = N((b + s^2/2)/s) + (S/L) N((b - s^2/2)/s)          if L < S  (long cover, down level)")
    add("p      = N((-b - s^2/2)/s) + (S/L) N((-b + s^2/2)/s)        if L > S  (short cover, up level)")
    add("z      = b / s                                              (standardized distance)")
    add("k, q   = tail_multipliers.json lookup(direction, |z|)       (pooled z buckets, below)")
    add("priced = max(p * k, q)")
    add(f"refuse   prob_too_high           if priced > pMax = {P_MAX:g}")
    add("refuse   level_already_breached  if isLong and S <= L, or !isLong and S >= L")
    add(f"premium = ceil(P * priced * (1 + theta)) + fee,  theta = {THETA:g}, fee = 0 (configurable)")
    add("```")
    add(
        "Lookup: k is the value of the |z| bucket that holds |z| (an empty bucket borrows the nearest populated "
        "one, nearer-the-money first). q is first made non-increasing in |z| (each bucket takes the max of "
        "itself and all further buckets) and then interpolated log-linearly between bucket mid-points, so the "
        "price is continuous in the level and never rises as the level moves away. Quote API: `breakdown` "
        "returns `sigma, touchProb (= p), loading (= theta), premium, model` plus `tailMultiplier (= k), "
        "tailFloor (= q), pricedProb, fee, coin, z, spotSource (pool | info_api), pool`. Request may carry an "
        "optional `pool` (default: configured pool), which must be in the allowlist (configured pool + pools "
        "in deployments/<env>.json); the quote is signed for that pool. Errors `{error, reason}`: 400 "
        "`invalid_request`, `unknown_perp`, `unknown_pool`, `duration_out_of_range`; 422 "
        "`level_already_breached`, `prob_too_high`, `capacity`; "
        "403 `chain_not_allowed`; 503 `market_data_unavailable`, `signer_unavailable`. Nonce random in "
        "[1, 2^53) so JSON numbers stay exact in JavaScript. Never signs for chainId 999.\n"
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
        "horizon uses daily candles for sigma (1h history is too short for enough 7d windows)."
    )
    add(
        "- **Windows.** Non-overlapping (step = horizon), aligned to multiples of the horizon since the unix "
        "epoch. S = open of the first candle. Levels 1, 2, 3, 5, 7.5, 10, 15, 20 % below S (`down`, long cover) "
        "and above S (`up`, short cover). Touched if min(low) <= S(1-d) or max(high) >= S(1+d) in the window. "
        "Windows with a missing candle are skipped."
    )
    add(
        "- **Model.** Closed-form one-touch probability under driftless GBM (ARCHITECTURE §7; checked against "
        "Monte Carlo in `tests/test_pricing.py`)."
    )
    add(
        "- **Tail adjustment by credibility pooling (v2).** Under the model, p depends on the level only through "
        "the standardized distance z = ln(L/S)/(sigma sqrt(T)) (plus a drift term of size sigma sqrt(T)/2, small "
        "at these horizons). A 1h BTC window at z = -3 and a 7d HYPE window at z = -3 are therefore the same "
        "risk to the model, so we pool every window of every coin and horizon into |z| buckets (0.25 wide up "
        "to 4, then 4-5, 5-7, >= 7), separately for down and up levels. This is actuarial credibility pooling: "
        "thin cells (177 one-day windows per coin) borrow strength from the whole book, and the fitted "
        'adjustment answers "how wrong is the model at this z", which is what we need to correct. Per bucket: '
        f"q = Wilson one-sided 95 % upper bound of the realized touch frequency, k = clamp(q / mean p, 1, {K_MAX:g}) "
        "(k = 1 when nothing touched). Whether pooling across horizons is fair is checked, not assumed: see "
        "the per-horizon diagnostic."
    )
    add(
        "- **v1 for comparison.** The first version fitted (k, q) separately per coin x horizon x direction x "
        "% distance (n = 177 windows for 1d). Kept here only as the side-by-side baseline."
    )
    add(
        "- **Out-of-sample protocol.** Each horizon's windows are split at the median start time. The tail "
        "table is fitted on the first halves only (pooled) and evaluated on the second halves: (a) per "
        "coin/horizon/direction/% bucket, pass if realized frequency <= mean priced probability; (b) a pool "
        "P&L simulation trading the second half."
    )
    add(
        "- **Caveat: candles are trade prices, not the oracle.** Covers trigger on the oracle (validator median "
        "of 8 venues). HL trade wicks on thin books usually go further than the oracle, so candle touches "
        "probably over-count oracle touches (conservative for the pool; not verified). A payout also needs a "
        "`trigger()` call that sees the breach on-chain.\n"
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

    add("## Headline: v2 (pooled z) against targets, side by side with v1 (per bucket)\n")
    lo_t, hi_t = TARGET_LOSS_RATIO
    add(
        f"Target (D9): out-of-sample loss ratio per horizon in {lo_t}-{hi_t}; report how many buckets fail "
        "realized <= priced. All numbers below are out of sample (fit on first half, trade/test second half). "
        "Price multiple = average premium per 100 USDC of cover / the raw model's (both with the 20 % loading).\n"
    )
    add(
        "| horizon | raw: loss ratio | raw: max DD | v1: price x raw | v1: loss ratio | v1: max DD | v1: failing buckets "
        "| v2: price x raw | v2: loss ratio | v2: max DD | v2: failing buckets | v2 in target? |"
    )
    add("|---|---|---|---|---|---|---|---|---|---|---|---|")
    tot = {"v1": 0, "v2": 0, "n": 0}
    for hz in HORIZONS:
        raw, s1, s2 = sims[(hz.name, "raw")], sims[(hz.name, "v1")], sims[(hz.name, "v2")]
        rows = [v for k, v in oos.items() if k[1] == hz.name]
        f1 = sum(1 for v in rows if not v["v1_pass"])
        f2 = sum(1 for v in rows if not v["v2_pass"])
        tot["v1"] += f1
        tot["v2"] += f2
        tot["n"] += len(rows)
        ok = (
            "yes"
            if lo_t <= s2.loss_ratio <= hi_t
            else ("no (below: over-priced)" if s2.loss_ratio < lo_t else "no (above)")
        )
        add(
            f"| {hz.name} | {raw.loss_ratio:.2f} | {raw.max_dd:.1%} | {s1.price_per_100 / raw.price_per_100:.2f} | "
            f"{s1.loss_ratio:.2f} | {s1.max_dd:.1%} | {f1}/{len(rows)} | {s2.price_per_100 / raw.price_per_100:.2f} | "
            f"{s2.loss_ratio:.2f} | {s2.max_dd:.1%} | {f2}/{len(rows)} | {ok} |"
        )
    add("")
    add(
        f"- Out-of-sample failing buckets (realized > priced), all horizons: **v2 {tot['v2']}/{tot['n']}**, "
        f"v1 {tot['v1']}/{tot['n']}."
    )
    add(
        "- Why 1h and 4h stay below the 0.5 loss-ratio target: at |z| < 2 the raw model over-predicts touches "
        "(realized / p about 0.6-0.9, table below) and k >= 1 by design cannot discount that, while the "
        "tail floor adds premium for the far levels the simulated book also sells. Reaching 0.5-0.8 there "
        "would need k < 1 near the money (a §7 change: 'model never prices below realized' would then hold "
        "only through q). Not done: reported instead, per D9 ('don't game them')."
    )
    add(
        "- The v2 failures are concentrated where the per-horizon diagnostic shows pooling is unfair: 7d at "
        "moderate z (2-4) and up-moves at large z for 1h-1d. Short horizons dominate the pooled counts, so the "
        "pooled table reflects them; v2b (separate table per horizon) halves the failures at a higher price."
    )
    n_pass_v2 = sum(1 for b in ctx["v2_full"].values() if b.passes)
    add(
        f"- In-sample with the published v2 table: {n_pass_v2}/{len(ctx['v2_full'])} buckets pass (not by construction: "
        "the table is fitted on pooled z buckets, not on these buckets)."
    )
    zf = [b for b in zfull if b.k is not None]
    add(
        f"- Pooled table: {len(zf)} of {len(zfull)} z buckets have >= {MIN_OBS} windows; k ranges "
        f"{min(b.k for b in zf):.2f}-{max(b.k for b in zf):.2f}; q ranges {min(b.q for b in zf):.2e}-{max(b.q for b in zf):.3f}."
    )
    add(
        f"- Raw model: realized above predicted in {sum(1 for b in fitted if b.realized > b.mean_p)} of {len(fitted)} "
        f"% buckets, significantly (Wilson 95 % lower bound above p) in {sum(1 for b in fitted if b.underpriced_significant)}.\n"
    )

    add("### Alternative not adopted: v2b = pool coins, separate z table per horizon\n")
    add(
        "Same method, but the z table is fitted per horizon (pooling only across coins). Shown because the "
        "per-horizon diagnostic below finds that the model's error at a given z differs by horizon.\n"
    )
    add("| horizon | v2b: price x raw | v2b: loss ratio | v2b: max DD | v2b: failing buckets |")
    add("|---|---|---|---|---|")
    tb = 0
    for hz in HORIZONS:
        raw, sb = sims[(hz.name, "raw")], sims[(hz.name, "v2b")]
        rows = [v for k, v in oos.items() if k[1] == hz.name]
        fb = sum(1 for v in rows if not v["v2b_pass"])
        tb += fb
        add(
            f"| {hz.name} | {sb.price_per_100 / raw.price_per_100:.2f} | {sb.loss_ratio:.2f} | {sb.max_dd:.1%} | "
            f"{fb}/{len(rows)} |"
        )
    add(f"\nv2b failing buckets, all horizons: {tb}/{tot['n']}.\n")

    add("## Pooled z buckets (the published table)\n")
    add(
        "Fitted on all windows (both halves). `realized / p` > 1 means the raw model under-predicts at that z.\n"
    )
    add("| dir | abs z | windows | touches | realized | mean model p | realized / p | k | q |")
    add("|---|---|---|---|---|---|---|---|---|")
    for b in zfull:
        if b.n == 0:
            continue
        r = b.realized / b.mean_p if b.mean_p > 0 else float("inf")
        kk = "" if b.k is None else f"{b.k:.2f}"
        qq = "" if b.q is None else f"{b.q:.2e}"
        add(
            f"| {b.direction} | {_zlabel(b.lo, b.hi)} | {b.n} | {b.hits} | {b.realized:.2e} | {b.mean_p:.2e} | "
            f"{r:.2f} | {kk} | {qq} |"
        )
    add("")

    add("## Per-horizon diagnostic (is pooling across horizons fair?)\n")
    add(
        "Second half, priced with the table fitted on first halves. `actual / model` > 1: the raw model "
        "under-predicts in this horizon at this z; `pass` compares realized with the mean priced probability.\n"
    )
    add("| horizon | dir | abs z | windows | touches | actual / model | realized | mean priced | pass |")
    add("|---|---|---|---|---|---|---|---|---|")
    for r in diag:
        if r["n"] == 0:
            continue
        am = r["hits"] / r["expected"] if r["expected"] > 0 else float("inf")
        add(
            f"| {r['horizon']} | {r['direction']} | {_zlabel(r['lo'], r['hi'])} | {r['n']} | {r['hits']} | {am:.2f} | "
            f"{r['realized']:.2e} | {r['priced']:.2e} | {'pass' if r['pass'] else '**FAIL**'} |"
        )
    add("")

    add("## Findings in plain language\n")
    add(_findings(ctx))
    add("")

    add("## Pool P&L simulation\n")
    add(
        f"At every window start the pool sells one cover per coin x direction x distance in "
        f"{{{', '.join(f'{d:.1%}' for d in SIM_DISTANCES)}}}, each paying {SIM_PAYOUT_FRACTION:.2%} of the "
        f"initial LP capital (at most {SIM_PAYOUT_FRACTION * 2 * len(SIM_DISTANCES) * n_coins:.0%} locked; no "
        f"compounding), premium = payout x priced x (1 + {THETA:g}), refused when priced > {P_MAX:g}. Covers "
        "settle before the next window; no fees, no idle yield. `raw` = model p with the loading only, "
        "`v1` = per-bucket table, `v2` = pooled z table; OOS rows trade only the second half with tables "
        "fitted on the first half; `v2 in-sample` trades everything with the published table.\n"
    )
    add(
        "**How to read it.** Price and claims per 100 USDC of cover, the loss ratio (claims / premiums; the "
        "20 % loading alone targets 0.83 for a perfectly calibrated model) and drawdown do not depend on how "
        "many covers are sold. LP P&L does: this book sells a full set of covers every window (24 sets a day "
        "for 1h covers), far more than real demand. Read LP P&L as an upper bound for that assumption.\n"
    )
    add(
        "| horizon | variant | days | windows | covers sold | refused | triggered | premium per 100 | "
        "claims per 100 | loss ratio | LP P&L | LP P&L per 30 d | max drawdown | worst window |"
    )
    add("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for s in ctx["sim_list"]:
        add(
            f"| {s.horizon} | {s.label} | {s.days:.0f} | {s.steps} | {s.sold} | {s.refused} | {s.triggered} | "
            f"{s.price_per_100:.3f} | {s.claims_per_100:.3f} | {s.loss_ratio:.2f} | {s.ret:+.1%} | "
            f"{s.ret_30d:+.1%} | {s.max_dd:.2%} | {s.worst_step:+.2%} |"
        )
    add("")

    add("## Expected vs actual touches (raw model)\n")
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
    add("")

    add("## Calibration table per coin / horizon / distance\n")
    add(
        "`ratio` = realized / raw predicted (`sig` = significantly under-predicted). `v2 priced` = mean priced "
        "probability with the published pooled table. `OOS v1/v2` = out-of-sample result (second half).\n"
    )
    add(
        "| coin | hz | dir | dist | windows | touches | realized | predicted | ratio | v2 priced | OOS v1 | OOS v2 |"
    )
    add("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for b in fitted:
        key = (b.coin, b.horizon, b.direction, b.distance)
        o = oos.get(key)
        v2 = ctx["v2_full"][key]
        ratio = b.realized / b.mean_p if b.mean_p > 0 else float("inf")
        o1 = "" if o is None else ("pass" if o["v1_pass"] else "**FAIL**")
        o2 = "" if o is None else ("pass" if o["v2_pass"] else "**FAIL**")
        add(
            f"| {b.coin} | {b.horizon} | {b.direction} | {b.distance:.1%} | {b.n} | {b.hits} | {b.realized:.4f} | "
            f"{b.mean_p:.2e} | {ratio:.2f}{' sig' if b.underpriced_significant else ''} | {v2.priced:.4f} | {o1} | {o2} |"
        )
    add("")
    add("## Limitations\n")
    add(
        "- Trade-price candles approximate the oracle (see method). Oracle minute history exists only in a "
        "requester-pays S3 archive and was not used."
    )
    add("- 1h history is ~7 months for every coin: essentially one market regime. 7d windows span 2023-2026.")
    add(
        "- Windows are not independent (the same window at 8 distances; correlated coins; volatility "
        "clustering). Wilson bounds treat them as independent, so true uncertainty is larger, and the pooled "
        "buckets look more certain than they are."
    )
    add(
        "- Pooling assumes the model's error depends on z, not on the horizon or coin. The per-horizon "
        "diagnostic shows where that is not true; such cells need a horizon-specific adjustment or more data."
    )
    add(
        "- The table is point-in-time; it must be refitted on a schedule and the out-of-sample pass rate tracked."
    )
    path.write_text("\n".join(L) + "\n", encoding="utf-8")


def _findings(ctx: dict) -> str:
    buckets: list[Bucket] = ctx["buckets"]
    zfull: list[ZBucket] = ctx["zfull"]
    out = []
    near = [b for b in zfull if b.k is not None and b.hi <= 2]
    a, e = _ratio(near)
    out.append(
        f"- **Near the money (|z| < 2) the model over-predicts:** {a} touches where it expected {e:.0f} "
        f"({a / e:.2f}x). Likely reasons (not tested separately): the 30-day realized floor keeps sigma "
        "high after volatile spells, and short-horizon returns mean-revert a little."
    )
    mid = [b for b in zfull if b.k is not None and 2 <= b.lo and b.hi <= 4]
    a, e = _ratio(mid)
    out.append(f"- **2 <= |z| < 4:** {a} touches vs {e:.1f} expected ({a / e:.2f}x).")
    far = [b for b in zfull if b.n and b.lo >= 4]
    a, e = _ratio(far)
    out.append(
        f"- **The tail (|z| >= 4) is where GBM fails:** {a} touches in {sum(b.n for b in far)} windows where "
        f"the model expected {e:.2f}. These are the flash moves liquidation cover exists for; the floor q "
        "prices them at their observed frequency (upper bound) instead of ~0."
    )
    fitted = [b for b in buckets if b.k is not None]
    dn = [b for b in fitted if b.direction == "down"]
    up = [b for b in fitted if b.direction == "up"]
    (ad, ed), (au, eu) = _ratio(dn), _ratio(up)
    out.append(
        f"- **Direction:** actual/expected {ad / ed:.2f} for down levels (long covers), {au / eu:.2f} for up."
    )
    fails = [r for r in ctx["diag"] if r["n"] and not r["pass"]]
    if fails:
        out.append(
            "- **Per-horizon cells that fail with the pooled table** (out of sample): "
            + "; ".join(
                f"{r['horizon']} {r['direction']} |z| {_zlabel(r['lo'], r['hi'])} "
                f"({r['hits']}/{r['n']} touched, priced {r['priced']:.1e})"
                for r in fails
            )
            + ". Pooling across horizons is not perfectly fair there."
        )
    else:
        out.append("- **Every per-horizon z cell passes out of sample** with the pooled table.")
    f2 = [(k, v) for k, v in ctx["oos"].items() if not v["v2_pass"]]
    if f2:
        out.append(
            "- **Out-of-sample % buckets failing with v2:** "
            + "; ".join(
                f"{c} {h} {d} {x:.1%} (realized {v['realized_test']:.4f} > priced {v['v2_priced']:.4f})"
                for (c, h, d, x), v in f2[:12]
            )
            + ("; ..." if len(f2) > 12 else "")
            + "."
        )
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


def _z_eval(parts: list[tuple[Obs, np.ndarray, np.ndarray]], lo: float, hi: float, direction: str) -> dict:
    """Realized vs mean priced over rows (obs, mask, priced) with |z| in [lo, hi)."""
    n = hits = 0
    exp_ = pr = 0.0
    for o, m, priced in parts:
        mm = m & (o.direction == direction) & (np.abs(o.z) >= lo) & (np.abs(o.z) < hi)
        n += int(mm.sum())
        hits += int(o.hit[mm].sum())
        exp_ += float(o.p[mm].sum())
        pr += float(np.minimum(priced[mm], 1.0).sum())
    realized = hits / n if n else 0.0
    mean_pr = pr / n if n else 0.0
    return {"n": n, "hits": hits, "expected": exp_, "realized": realized, "priced": mean_pr,
            "pass": realized <= mean_pr + 1e-12}  # fmt: skip


def run(coins: list[str], out_dir: Path = REPORTS_DIR, info_url: str = MAINNET_INFO_URL) -> dict:
    client = InfoClient(info_url)
    now_ms = int(time.time() * 1000)
    out_dir.mkdir(parents=True, exist_ok=True)
    ranges: dict = {}
    windows: dict = {}
    obs_all: dict[str, dict[str, Obs]] = defaultdict(dict)  # horizon -> coin -> obs
    for coin in coins:
        print(f"[backtest] fetching {coin} ...", flush=True)
        ser = fetch_series(client, coin, now_ms)
        ranges[coin] = {iv: ser[iv][1] for iv in ser}
        windows[coin] = {}
        for hz in HORIZONS:
            ob = observations(ser[hz.interval][0], hz)
            obs_all[hz.name][coin] = ob
            windows[coin][hz.name] = len(np.unique(ob.start_ms))

    # time split per horizon (median start across coins)
    split_t = {}
    for hz in HORIZONS:
        allstarts = np.unique(np.concatenate([ob.start_ms for ob in obs_all[hz.name].values()]))
        split_t[hz.name] = int(allstarts[len(allstarts) // 2])

    def each():
        for hz in HORIZONS:
            for coin, ob in obs_all[hz.name].items():
                yield hz, coin, ob

    # v2 tables: pooled over every coin and horizon
    zfull = fit_z([(ob, np.ones(len(ob), dtype=bool)) for _, _, ob in each()])
    ztrain = fit_z([(ob, ob.start_ms < split_t[hz.name]) for hz, _, ob in each()])
    table_full, table_train = z_table(zfull), z_table(ztrain)
    # v2b (comparison only): pooled over coins, but a separate z table per horizon
    table_train_h = {
        hz.name: z_table(fit_z([(ob, ob.start_ms < split_t[hz.name]) for ob in obs_all[hz.name].values()]))
        for hz in HORIZONS
    }

    buckets: list[Bucket] = []
    v2_full: dict[tuple, Bucket] = {}
    oos: dict[tuple, dict] = {}
    priced: dict[str, dict[str, dict[str, np.ndarray]]] = {
        k: defaultdict(dict) for k in ("v1", "v2", "v2full", "v2b")
    }
    for hz, coin, ob in each():
        bs = aggregate(coin, hz.name, ob)
        buckets += bs
        tr, te = ob.start_ms < split_t[hz.name], ob.start_ms >= split_t[hz.name]
        p1 = v1_priced(ob, v1_fit(aggregate(coin, hz.name, ob, tr)))
        p2 = v2_priced(ob, table_train)
        p2f = v2_priced(ob, table_full)
        priced["v2b"][hz.name][coin] = p2b = v2_priced(ob, table_train_h[hz.name])
        priced["v1"][hz.name][coin], priced["v2"][hz.name][coin], priced["v2full"][hz.name][coin] = (
            p1,
            p2,
            p2f,
        )
        for b in aggregate(coin, hz.name, ob, priced=p2f):
            v2_full[(coin, hz.name, b.direction, b.distance)] = b
        t1 = aggregate(coin, hz.name, ob, te, priced=p1)
        t2 = aggregate(coin, hz.name, ob, te, priced=p2)
        t2b = aggregate(coin, hz.name, ob, te, priced=p2b)
        train_v1 = v1_fit(aggregate(coin, hz.name, ob, tr))
        for a, b, c in zip(t1, t2, t2b, strict=True):
            if a.n < MIN_OBS or (a.direction, a.distance) not in train_v1:
                continue
            oos[(coin, hz.name, a.direction, a.distance)] = {
                "n_test": a.n, "realized_test": a.realized, "v1_priced": a.priced, "v1_pass": bool(a.passes),
                "v2_priced": b.priced, "v2_pass": bool(b.passes), "v2b_priced": c.priced,
                "v2b_pass": bool(c.passes),
            }  # fmt: skip

    # z-bucket OOS (pooled) and per-horizon diagnostic
    z_test_eval = {}
    for b in ztrain:
        parts = [(ob, ob.start_ms >= split_t[hz.name], priced["v2"][hz.name][c]) for hz, c, ob in each()]
        z_test_eval[(b.direction, b.lo)] = _z_eval(parts, b.lo, b.hi, b.direction)
    diag = []
    for hz in HORIZONS:
        parts = [
            (ob, ob.start_ms >= split_t[hz.name], priced["v2"][hz.name][c])
            for c, ob in obs_all[hz.name].items()
        ]
        for direction in ("down", "up"):
            for lo, hi in ZGROUPS:
                diag.append({"horizon": hz.name, "direction": direction, "lo": lo, "hi": hi,
                             **_z_eval(parts, lo, hi, direction)})  # fmt: skip

    sims: dict[tuple[str, str], SimResult] = {}
    sim_list: list[SimResult] = []
    for hz in HORIZONS:
        ob, t0 = obs_all[hz.name], split_t[hz.name]
        variants = [
            ("raw", "raw, OOS half", None, t0),
            ("v1", "v1 per-bucket, OOS half", priced["v1"][hz.name], t0),
            ("v2", "v2 pooled z, OOS half", priced["v2"][hz.name], t0),
            ("v2full", "v2 pooled z, in-sample, full", priced["v2full"][hz.name], None),
            ("v2b", "v2b z per horizon, OOS half", priced["v2b"][hz.name], t0),
        ]
        for key, label, pr, tf in variants:
            s = simulate_pool(label, hz, ob, pr, t_from=tf)
            sims[(hz.name, key)] = s
            sim_list.append(s)

    meta = {"generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%MZ"), "coins": coins,
            "ranges": ranges, "windows": windows}  # fmt: skip
    write_csv(out_dir / "calibration.csv", buckets, oos, v2_full)
    write_z_csv(out_dir / "calibration_z.csv", zfull, ztrain, z_test_eval)
    with (out_dir / "calibration_z_by_horizon.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["horizon", "direction", "abs_z_lo", "abs_z_hi", "n_test", "hits_test", "expected_test",
                    "realized_test", "priced_test", "pass"])  # fmt: skip
        for r in diag:
            w.writerow([r["horizon"], r["direction"], r["lo"], "inf" if math.isinf(r["hi"]) else r["hi"], r["n"],
                        r["hits"], f"{r['expected']:.4f}", _f(r["realized"]), _f(r["priced"]), r["pass"]])  # fmt: skip
    blob = write_tail_json(out_dir / "tail_multipliers.json", zfull, meta)
    pts = [(b.mean_p, b.realized, HZ_COLORS[b.horizon], "circle" if b.direction == "down" else "square",
            f"{b.coin} {b.horizon} {b.direction} {b.distance:.1%}: {b.hits}/{b.n}")
           for b in buckets if b.n >= MIN_OBS and b.hits]  # fmt: skip
    pts += [(b.mean_p, b.realized, "#000000", "circle" if b.direction == "down" else "square",
             f"pooled {b.direction} |z| {_zlabel(b.lo, b.hi)}: {b.hits}/{b.n}")
            for b in zfull if b.n >= MIN_OBS and b.hits]  # fmt: skip
    legend = [*HZ_COLORS.items(), ("pooled z bucket", "#000000")]
    (out_dir / "calibration.svg").write_text(
        reliability_svg(pts, legend, "Predicted vs realized touch frequency (log-log)"), encoding="utf-8"
    )
    ctx = {"buckets": buckets, "zfull": zfull, "ztrain": ztrain, "oos": oos, "sims": sims, "sim_list": sim_list,
           "meta": meta, "diag": diag, "v2_full": v2_full, "z_test_eval": z_test_eval, "tail": blob}  # fmt: skip
    write_markdown(out_dir / "calibration.md", ctx)
    print(f"[backtest] wrote {out_dir}", flush=True)
    return ctx


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Calibration backtest of the one-touch model")
    ap.add_argument("--coins", nargs="+", default=["BTC", "ETH", "SOL", "HYPE"])
    ap.add_argument("--out", type=Path, default=REPORTS_DIR)
    args = ap.parse_args(argv)
    ctx = run(args.coins, args.out)
    oos = ctx["oos"].values()
    print(f"[backtest] OOS failing % buckets: v2 {sum(1 for o in oos if not o['v2_pass'])}/{len(oos)}, "
          f"v1 {sum(1 for o in oos if not o['v1_pass'])}/{len(oos)}, "
          f"v2b {sum(1 for o in oos if not o['v2b_pass'])}/{len(oos)}")  # fmt: skip
    for s in ctx["sim_list"]:
        print(f"[backtest] pool {s.horizon:>3} {s.label:<30} sold {s.sold:>6} refused {s.refused:>5} "
              f"price/100 {s.price_per_100:.3f} loss ratio {s.loss_ratio:.2f} maxDD {s.max_dd:.2%}")  # fmt: skip
    for r in ctx["diag"]:
        if r["n"] and not r["pass"]:
            print(f"[backtest] diag FAIL {r['horizon']} {r['direction']} |z| {_zlabel(r['lo'], r['hi'])}: "
                  f"{r['hits']}/{r['n']} realized {r['realized']:.2e} priced {r['priced']:.2e}")  # fmt: skip


if __name__ == "__main__":
    main()
