"""Calibration backtest of the one-touch model on real Hyperliquid history (ARCHITECTURE §9, D9, D11).

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
    block_n: int = 0  # counts of the monotone (PAVA) block this bucket was pooled into
    block_hits: int = 0

    @property
    def realized(self) -> float:
        return self.hits / self.n if self.n else 0.0

    def cell(self) -> dict | None:
        if self.k is None:
            return None
        return {"k": round(self.k, 4), "q": round(self.q, 8), "n": self.n, "hits": self.hits,
                "block_n": self.block_n, "block_hits": self.block_hits, "mean_p": round(self.mean_p, 8)}  # fmt: skip


def _zlabel(lo: float, hi: float) -> str:
    return f">= {lo:g}" if math.isinf(hi) else f"{lo:g}-{hi:g}"


def pava_nonincreasing(counts: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Pool-adjacent-violators: merge neighbouring (hits, n) buckets until the touch frequency is
    non-increasing in |z|; returns, per input bucket, the (hits, n) of the block it ends up in.

    The true touch frequency cannot rise as the level moves further away, so a far bucket that shows more
    touches than a nearer one is sampling noise; pooling the two is the maximum-likelihood monotone fit.
    Empty buckets (n = 0) are skipped and inherit the counts of the block before them.
    """
    blocks: list[list[int]] = []  # [hits, n, first index, last index]
    for i, (h, n) in enumerate(counts):
        if n == 0:
            continue
        blocks.append([h, n, i, i])
        while len(blocks) > 1 and blocks[-2][0] / blocks[-2][1] < blocks[-1][0] / blocks[-1][1]:
            h2, n2, _, j2 = blocks.pop()
            blocks[-1][0] += h2
            blocks[-1][1] += n2
            blocks[-1][3] = j2
    out: list[tuple[int, int]] = [(0, 0)] * len(counts)
    for h, n, a, b in blocks:
        for i in range(a, b + 1):
            out[i] = (h, n)
    for i in range(1, len(out)):  # empty buckets inside / after a block
        if out[i] == (0, 0) and counts[i][1] == 0:
            out[i] = out[i - 1]
    return out


def fit_z(parts: list[tuple[Obs, np.ndarray]], edges=Z_EDGES, monotone: bool = False) -> list[ZBucket]:
    """Pool rows (obs, mask) into |z| buckets per direction and fit (k, q).

    q = Wilson upper bound of the bucket's touch frequency, k = clamp(q / bucket mean p, 1, K_MAX) (1 if no
    touch). With ``monotone`` (compared alternative, not adopted) counts are first pooled by PAVA so the
    frequency is non-increasing in |z|, and q / k use the counts of the bucket's block.
    """
    zz = np.concatenate([np.abs(o.z[m]) for o, m in parts])
    pp = np.concatenate([o.p[m] for o, m in parts])
    hh = np.concatenate([o.hit[m] for o, m in parts])
    dd = np.concatenate([o.direction[m] for o, m in parts])
    out = []
    for direction in ("down", "up"):
        raw = []
        for lo, hi in zip(edges[:-1], edges[1:], strict=True):
            m = (dd == direction) & (zz >= lo) & (zz < hi)
            n, hits = int(m.sum()), int(hh[m].sum())
            raw.append((lo, hi, n, hits, float(pp[m].mean()) if n else 0.0))
        counts = [(h, n) for _, _, n, h, _ in raw]
        blocks = pava_nonincreasing(counts) if monotone else counts
        for (lo, hi, n, hits, mp), (bh, bn) in zip(raw, blocks, strict=True):
            k = q = None
            if n > 0 and bn >= MIN_OBS:
                q = wilson(bh, bn)[1]
                k = 1.0 if bh == 0 or mp <= 0 else min(K_MAX, max(1.0, q / mp))
            out.append(ZBucket(direction, lo, hi, n, hits, mp, k, q, bn, bh))
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


METHODS = (
    ("v1", "v1 per coin x horizon x % distance"),
    ("v2", "v2 z pooled over coins and horizons"),
    ("v3", "v3 z per horizon, pooled over coins (adopted, D11)"),
    ("v3p", "v3 + monotone pooling of thin z buckets (PAVA; not adopted)"),
)

CSV_COLUMNS = [
    "coin", "horizon", "direction", "distance", "n", "hits", "realized", "predicted_mean",
    "realized_over_predicted", "wilson_lo95", "wilson_hi95", "underpriced_significant", "mean_sigma",
    "v1_k", "v1_q", "v1_priced_in_sample",
    "oos_n_test", "oos_realized_test", "oos_v1_priced_test", "oos_v1_pass", "oos_v2_priced_test", "oos_v2_pass",
    "oos_v3_priced_test", "oos_v3_pass", "v3_priced_in_sample", "v3_pass_in_sample",
]  # fmt: skip


def write_csv(
    path: Path, buckets: list[Bucket], oos: dict[tuple, dict], v3_full: dict[tuple, Bucket]
) -> None:
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(CSV_COLUMNS)
        for b in buckets:
            key = (b.coin, b.horizon, b.direction, b.distance)
            o = oos.get(key, {})
            v3 = v3_full.get(key)
            ratio = b.realized / b.mean_p if b.mean_p > 0 else float("nan")
            w.writerow([
                b.coin, b.horizon, b.direction, f"{b.distance:.3f}", b.n, b.hits, _f(b.realized),
                _f(b.mean_p, 8), f"{ratio:.3f}", _f(b.wilson_lo), _f(b.wilson_hi),
                str(b.underpriced_significant), _f(b.mean_sigma, 4), _f(b.k, 3), _f(b.q), _f(b.priced),
                o.get("n_test", ""), _f(o.get("realized_test")),
                _f(o.get("v1_priced")), _b(o.get("v1_pass")), _f(o.get("v2_priced")), _b(o.get("v2_pass")),
                _f(o.get("v3_priced")), _b(o.get("v3_pass")),
                _f(v3.priced if v3 else None), _b(v3.passes if v3 else None),
            ])  # fmt: skip


def write_z_csv(path: Path, tables: list[tuple[str, list[ZBucket], list[ZBucket], dict]]) -> None:
    """tables: (scope, full-sample buckets, first-half buckets, OOS eval by (direction, lo)); scope is a
    horizon name (v3, published) or 'all' (v2, comparison)."""
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["scope", "direction", "abs_z_lo", "abs_z_hi", "n", "hits", "realized", "mean_p",
                    "wilson_lo95", "k", "q", "train_k", "train_q", "oos_n_test", "oos_realized_test",
                    "oos_priced_test", "oos_pass"])  # fmt: skip
        for scope, full, train, ev in tables:
            for b, t in zip(full, train, strict=True):
                e = ev.get((b.direction, b.lo), {})
                w.writerow([scope, b.direction, f"{b.lo:g}", "inf" if math.isinf(b.hi) else f"{b.hi:g}", b.n,
                            b.hits, _f(b.realized), _f(b.mean_p, 8), _f(wilson(b.hits, b.n)[0]), _f(b.k, 4),
                            _f(b.q, 8), _f(t.k, 4), _f(t.q, 8), e.get("n", ""), _f(e.get("realized")),
                            _f(e.get("priced")), _b(e.get("pass"))])  # fmt: skip


def write_tail_json(path: Path, zfull_h: dict[str, list[ZBucket]], meta: dict) -> dict:
    tables = {}
    for hz in HORIZONS:
        zbs = zfull_h[hz.name]
        fitted = [b for b in zbs if b.k is not None]
        tables[str(hz.seconds)] = {
            "horizon": hz.name,
            "cells": {d: [b.cell() for b in zbs if b.direction == d] for d in ("down", "up")},
            "default": {"k": round(max(b.k for b in fitted), 4), "q": round(max(b.q for b in fitted), 8)},
        }
    blob = {
        "schema": "z-per-horizon-v3",
        "model": MODEL_NAME,
        "generated_at": meta["generated_at"],
        "formula": "priced = max(p * k(h, dir, |z|), q(h, dir, |z|)); refuse if priced > pMax; "
        "premium = ceil(payout * priced * (1 + theta)) + fee; z = ln(level/spot) / (sigma * sqrt(T)); "
        "h = smallest calibrated horizon >= duration",
        "method": (
            f"Per calibrated horizon, windows of all coins pooled into |z| buckets per direction (decision D11). "
            f"Per bucket with >= {MIN_OBS} windows: q = Wilson one-sided 95% upper bound of realized touch "
            f"frequency; k = clamp(q / mean model p, 1, {K_MAX:g}), 1 with 0 touches. Lookup: k from the bucket "
            "holding |z|; q made non-increasing in |z| then log-linearly interpolated between bucket mid-points. "
            "null = < 30 windows (nearest populated bucket is used)."
        ),
        "z_edges": [None if math.isinf(e) else e for e in Z_EDGES],
        "horizons_s": [h.seconds for h in HORIZONS],
        "tables": tables,
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


def _fails(oos: dict, method: str, horizon: str | None = None) -> tuple[int, int]:
    rows = [v for k, v in oos.items() if horizon is None or k[1] == horizon]
    return sum(1 for v in rows if not v[f"{method}_pass"]), len(rows)


def write_markdown(path: Path, ctx: dict) -> None:
    buckets: list[Bucket] = ctx["buckets"]
    oos: dict = ctx["oos"]
    sims: dict = ctx["sims"]
    meta: dict = ctx["meta"]
    fitted = [b for b in buckets if b.k is not None]
    n_coins = len(meta["coins"])
    L: list[str] = []
    add = L.append
    add("# Calibration backtest: one-touch model on Hyperliquid history\n")
    add(
        f"Generated {meta['generated_at']} by `python -m numera_engine.backtest --coins {' '.join(meta['coins'])}` "
        f"(model `{MODEL_NAME}`, tail table `z-per-horizon-v3`, decisions D9 and D11). Source: Hyperliquid "
        "mainnet Info API `candleSnapshot`, read-only. Files: `calibration.csv` (per coin/horizon/distance "
        "bucket with out-of-sample columns for every method), `calibration_z.csv` (z buckets: per horizon = "
        "the published table, `all` = the pooled comparison), `calibration_z_by_horizon.csv` (diagnostic), "
        "`calibration.svg` (reliability plot), `tail_multipliers.json` (consumed by the quote API).\n"
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
    add("h      = smallest calibrated horizon in {1h, 4h, 1d, 7d} >= D (7d beyond)")
    add("k, q   = tail_multipliers.json tables[h] lookup(direction, |z|)   (z buckets per horizon, below)")
    add("priced = max(p * k, q)")
    add(f"refuse   prob_too_high           if priced > pMax = {P_MAX:g}")
    add("refuse   level_already_breached  if isLong and S <= L, or !isLong and S >= L")
    add(f"premium = ceil(P * priced * (1 + theta)) + fee,  theta = {THETA:g}, fee = 0 (configurable)")
    add("```")
    add(
        "Lookup: k is the value of the |z| bucket that holds |z| (an empty bucket borrows the nearest populated "
        "one, nearer-the-money first). q is first made non-increasing in |z| (each bucket takes the max of "
        "itself and all further buckets) and then interpolated log-linearly between bucket mid-points, so the "
        "price is continuous in the level and never rises as the level moves away. k >= 1 always: the engine "
        "never prices below the model, even where the model over-predicts. Quote API: `breakdown` "
        "returns `sigma, touchProb (= p), loading (= theta), premium, model` plus `tailMultiplier (= k), "
        "tailFloor (= q), pricedProb, fee, coin, z, spotSource (pool | info_api), pool`. Request may carry an "
        "optional `pool` (default: configured pool), which must be in the allowlist (configured pool + pools "
        "in deployments/<env>.json); the quote is signed for that pool. Errors `{error, reason}`: 400 "
        "`invalid_request`, `unknown_perp`, `unknown_pool`, `duration_out_of_range`; 422 "
        "`level_already_breached`, `prob_too_high`, `capacity`; 403 `chain_not_allowed`; 503 "
        "`market_data_unavailable`, `signer_unavailable`. Nonce random in [1, 2^53) so JSON numbers stay exact "
        "in JavaScript. Never signs for chainId 999.\n"
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
        "- **Tail adjustment by credibility pooling on standardized distance.** Under the model, p depends on "
        "the level only through z = ln(L/S)/(sigma sqrt(T)) (plus a drift term of size sigma sqrt(T)/2, small "
        "here). Windows with the same z are the same risk to the model, so we pool them into |z| buckets (0.25 "
        "wide up to 4, then 4-5, 5-7, >= 7), separately for down and up levels. This is actuarial credibility "
        "pooling: thin cells (177 one-day windows per coin) borrow strength from related experience, and the "
        'fitted adjustment answers "how wrong is the model at this z". Per bucket: q = Wilson one-sided 95 % '
        f"upper bound of the realized touch frequency, k = clamp(q / mean p, 1, {K_MAX:g}) (k = 1 when nothing "
        "touched)."
    )
    add(
        "- **Adopted (D11): one z table per horizon, pooled over coins only (v3).** Pooling across horizons "
        "too (v2) was tried first; the per-horizon diagnostic showed the model's error at a given z depends on "
        "the horizon (7d at |z| 2-4 was under-priced about 4x by the fully pooled table, because short "
        "horizons dominate the pooled counts). Liquidation covers live in the far tail (a 10x long is ~9 % "
        "from liquidation; with BTC 1d sigma ~2 % that is |z| ~4-5), exactly where full pooling under-prices, "
        "so the per-horizon table is the conservative choice. Compared alternatives are kept below."
    )
    add(
        "- **Out-of-sample protocol.** Each horizon's windows are split at the median start time. Every method "
        "is fitted on the first halves only and evaluated on the second halves: (a) per coin/horizon/"
        "direction/% bucket, pass if realized frequency <= mean priced probability; (b) a pool P&L "
        "simulation trading the second half."
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

    add("## Headline: compared methods, out of sample\n")
    lo_t, hi_t = TARGET_LOSS_RATIO
    add(
        "Fit on the first half of each horizon, test and trade the second half. Each horizon cell: loss ratio "
        "(claims / premiums) / price multiple (average premium per 100 USDC of cover divided by the raw model's, "
        "both with the 20 % loading) / failing % buckets (realized > priced). Max drawdown is in the "
        f"simulation table below. D9 target for the loss ratio: {lo_t}-{hi_t}.\n"
    )
    add("| method | OOS failing buckets | 1h | 4h | 1d | 7d |")
    add("|---|---|---|---|---|---|")
    raw_cells = []
    for hz in HORIZONS:
        r = sims[(hz.name, "raw")]
        raw_cells.append(f"{r.loss_ratio:.2f} / 1.00x / -")
    add(f"| raw model (k = 1, no floor) | - | {' | '.join(raw_cells)} |")
    for m, label in METHODS:
        cells = []
        for hz in HORIZONS:
            s, raw = sims[(hz.name, m)], sims[(hz.name, "raw")]
            f, n = _fails(oos, m, hz.name)
            cells.append(f"{s.loss_ratio:.2f} / {s.price_per_100 / raw.price_per_100:.2f}x / {f}/{n}")
        f, n = _fails(oos, m)
        name = f"**{label}**" if m == "v3" else label
        add(
            f"| {name} | {'**' if m == 'v3' else ''}{f}/{n}{'**' if m == 'v3' else ''} | {' | '.join(cells)} |"
        )
    add("")
    f3, n3 = _fails(oos, "v3")
    add(
        f"- Adopted v3: {f3}/{n3} % buckets fail out of sample. v1 fails fewer because its per-bucket floors are "
        "fitted on very thin cells and are therefore very wide (it prices 1h covers at ~4x the raw model); v2 "
        "is cheapest but under-prices 7d and the far tail."
    )
    add(
        "- Side effect of thin per-horizon tables: at 1d and 7d a far |z| bucket with ~100 windows and one "
        "touch gets a wide upper bound (e.g. 1 in 110 -> q ~ 4 %), and the never-cheaper-further-away rule "
        "lifts every nearer bucket to it. Quotes in that |z| range (about 3-4 for 1d) are therefore expensive. "
        "`v3p` pools such buckets with their neighbours first (PAVA: the maximum-likelihood fit with touch "
        "frequency non-increasing in |z|): cheaper there, but it fails more buckets out of sample, so the "
        "conservative v3 stays adopted (D11). Better data (oracle history) is the real fix."
    )
    add(
        "- 1h and 4h loss ratios sit below the 0.5 target: at |z| < 2 the raw model over-predicts touches "
        "(realized / p about 0.6-0.9) and k >= 1 by design does not discount that (D11: no near-money discount "
        "in v1). The far-tail floor adds premium on top. Covers are priced at the observed tail, which "
        "protects LPs."
    )
    n_pass = sum(1 for b in ctx["v3_full"].values() if b.passes)
    add(
        f"- In-sample with the published v3 tables: {n_pass}/{len(ctx['v3_full'])} % buckets pass (not by "
        "construction: tables are fitted on z buckets, not on these buckets)."
    )
    add(
        f"- Raw model: realized above predicted in {sum(1 for b in fitted if b.realized > b.mean_p)} of {len(fitted)} "
        f"% buckets, significantly (Wilson 95 % lower bound above p) in {sum(1 for b in fitted if b.underpriced_significant)}.\n"
    )

    add("## Published tables: z buckets per horizon (v3)\n")
    add(
        "Fitted on all windows (both halves) of all coins, per horizon. Cell = touches/windows, k, q. "
        "`realized / p` per bucket is in `calibration_z.csv`.\n"
    )
    add(
        "| dir | abs z | "
        + " | ".join(f"{h.name} touches/windows | {h.name} k | {h.name} q" for h in HORIZONS)
        + " |"
    )
    add("|---|---|" + "---|---|---|" * len(HORIZONS))
    zfull_h = ctx["zfull_h"]
    for i, b0 in enumerate(zfull_h[HORIZONS[0].name]):
        cells = []
        for hz in HORIZONS:
            b = zfull_h[hz.name][i]
            kk = "" if b.k is None else f"{b.k:.2f}"
            qq = "" if b.q is None else f"{b.q:.2e}"
            cells.append(f"{b.hits}/{b.n} | {kk} | {qq}")
        add(f"| {b0.direction} | {_zlabel(b0.lo, b0.hi)} | {' | '.join(cells)} |")
    add("")

    add("## Compared alternative v2: one z table pooled over coins and horizons\n")
    add(
        "`realized / p` > 1 means the raw model under-predicts at that z. This table shows the shape of the "
        "model error most clearly (most data), but was not adopted (see method).\n"
    )
    add("| dir | abs z | windows | touches | realized | mean model p | realized / p | k | q |")
    add("|---|---|---|---|---|---|---|---|---|")
    for b in ctx["zfull_all"]:
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

    add("## Per-horizon diagnostic\n")
    add(
        "Second half, priced with tables fitted on the first halves. `actual / model` > 1: the raw model "
        "under-predicts there. `v2 pass` = fully pooled table, `v3 pass` = per-horizon table (adopted).\n"
    )
    add(
        "| horizon | dir | abs z | windows | touches | actual / model | realized | v2 priced | v2 pass | v3 priced | v3 pass |"
    )
    add("|---|---|---|---|---|---|---|---|---|---|---|")
    for r2, r3 in zip(ctx["diag_v2"], ctx["diag_v3"], strict=True):
        if r3["n"] == 0:
            continue
        am = r3["hits"] / r3["expected"] if r3["expected"] > 0 else float("inf")
        add(
            f"| {r3['horizon']} | {r3['direction']} | {_zlabel(r3['lo'], r3['hi'])} | {r3['n']} | {r3['hits']} | "
            f"{am:.2f} | {r3['realized']:.2e} | {r2['priced']:.2e} | {'pass' if r2['pass'] else '**FAIL**'} | "
            f"{r3['priced']:.2e} | {'pass' if r3['pass'] else '**FAIL**'} |"
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
        "settle before the next window; no fees, no idle yield. OOS rows trade only the second half with "
        "tables fitted on the first half; `v3 in-sample` trades everything with the published tables.\n"
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
        "`ratio` = realized / raw predicted (`sig` = significantly under-predicted). `v3 priced` = mean priced "
        "probability with the published tables. `OOS v1/v2/v3` = out-of-sample result (second half).\n"
    )
    add(
        "| coin | hz | dir | dist | windows | touches | realized | predicted | ratio | v3 priced | OOS v1 | OOS v2 | OOS v3 |"
    )
    add("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for b in fitted:
        key = (b.coin, b.horizon, b.direction, b.distance)
        o = oos.get(key)
        v3 = ctx["v3_full"][key]
        ratio = b.realized / b.mean_p if b.mean_p > 0 else float("inf")
        res = ["" if o is None else ("pass" if o[f"{m}_pass"] else "**FAIL**") for m, _ in METHODS]
        add(
            f"| {b.coin} | {b.horizon} | {b.direction} | {b.distance:.1%} | {b.n} | {b.hits} | {b.realized:.4f} | "
            f"{b.mean_p:.2e} | {ratio:.2f}{' sig' if b.underpriced_significant else ''} | {v3.priced:.4f} | "
            f"{' | '.join(res)} |"
        )
    add("")
    add("## Limitations (read before trusting the numbers)\n")
    add(
        "The evidence is real but thinner than the tables make it look. The Wilson bounds treat every window as "
        "an independent draw, and they are not: the same window is counted at eight distances, BTC, ETH, SOL "
        "and HYPE move together (a market-wide crash is one event, counted up to four times when we pool "
        "coins), and volatility clusters in time. The effective sample is therefore much smaller than the "
        "window counts, and the true uncertainty around every k and q is wider than the bounds state. The "
        "second half of the sample also looks like a different regime from the first (more large up-moves "
        "at 1h-1d, larger moves at 7d), which is exactly why the out-of-sample check fails some buckets: the "
        "past half did not fully anticipate the next. The 1h/4h/1d evidence comes from only ~7 months of "
        "1-hour candles, essentially one market regime; the 7d evidence spans 2023-2026 but has fewer than "
        "200 windows per coin. Finally, the touches are measured on Hyperliquid trade-price candles, not on "
        "the oracle the covers trigger on (oracle minute history exists only in a requester-pays S3 archive "
        "and was not used).\n"
    )
    add(
        "- What would make it stronger: oracle history from the S3 archive (years, and the actual trigger "
        "price); block-bootstrap or cluster-robust intervals instead of Wilson; a scheduled refit with the "
        "out-of-sample pass rate tracked over time."
    )
    add(
        "- The tables are point-in-time. A failing bucket after refit is a signal to widen the margin, not noise."
    )
    path.write_text("\n".join(L) + "\n", encoding="utf-8")


def _findings(ctx: dict) -> str:
    buckets: list[Bucket] = ctx["buckets"]
    zall: list[ZBucket] = ctx["zfull_all"]
    out = []
    near = [b for b in zall if b.k is not None and b.hi <= 2]
    a, e = _ratio(near)
    out.append(
        f"- **Near the money (|z| < 2) the model over-predicts:** {a} touches where it expected {e:.0f} "
        f"({a / e:.2f}x). Likely reasons (not tested separately): the 30-day realized floor keeps sigma "
        "high after volatile spells, and short-horizon returns mean-revert a little."
    )
    mid = [b for b in zall if b.k is not None and 2 <= b.lo and b.hi <= 4]
    a, e = _ratio(mid)
    out.append(f"- **2 <= |z| < 4:** {a} touches vs {e:.1f} expected ({a / e:.2f}x).")
    far = [b for b in zall if b.n and b.lo >= 4]
    a, e = _ratio(far)
    out.append(
        f"- **The tail (|z| >= 4) is where GBM fails:** {a} touches in {sum(b.n for b in far)} windows where "
        f"the model expected {e:.2f}. These are the flash moves liquidation cover exists for; the floor q "
        "prices them at their observed frequency (upper bound) instead of ~0."
    )
    fitted = [b for b in buckets if b.k is not None]
    (ad, ed) = _ratio([b for b in fitted if b.direction == "down"])
    (au, eu) = _ratio([b for b in fitted if b.direction == "up"])
    out.append(
        f"- **Direction:** actual/expected {ad / ed:.2f} for down levels (long covers), {au / eu:.2f} for up."
    )
    f2 = [r for r in ctx["diag_v2"] if r["n"] and not r["pass"]]
    f3 = [r for r in ctx["diag_v3"] if r["n"] and not r["pass"]]
    out.append(
        f"- **Per-horizon diagnostic:** {len(f2)} horizon x z cells fail out of sample with the fully pooled "
        f"table, {len(f3)} with the per-horizon tables."
    )
    if f3:
        out.append(
            "  Still failing with v3: "
            + "; ".join(
                f"{r['horizon']} {r['direction']} |z| {_zlabel(r['lo'], r['hi'])} ({r['hits']}/{r['n']} touched, "
                f"realized {r['realized']:.1e} vs priced {r['priced']:.1e})"
                for r in f3
            )
            + "."
        )
    fb = [(k, v) for k, v in ctx["oos"].items() if not v["v3_pass"]]
    if fb:
        out.append(
            "- **Out-of-sample % buckets failing with v3:** "
            + "; ".join(
                f"{c} {h} {d} {x:.1%} (realized {v['realized_test']:.4f} > priced {v['v3_priced']:.4f})"
                for (c, h, d, x), v in fb[:20]
            )
            + ("; ..." if len(fb) > 20 else "")
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

    def train_mask(hz: Horizon, ob: Obs) -> np.ndarray:
        return ob.start_ms < split_t[hz.name]

    # v2 (comparison): pooled over every coin and horizon
    zfull_all = fit_z([(ob, np.ones(len(ob), dtype=bool)) for _, _, ob in each()])
    ztrain_all = fit_z([(ob, train_mask(hz, ob)) for hz, _, ob in each()])
    table_v2 = z_table(ztrain_all)
    # v3 (adopted, D11): pooled over coins, one table per horizon
    zfull_h, ztrain_h, table_v3, table_v3_full, table_v3p = {}, {}, {}, {}, {}
    for hz in HORIZONS:
        obs = obs_all[hz.name].values()
        zfull_h[hz.name] = fit_z([(ob, np.ones(len(ob), dtype=bool)) for ob in obs])
        ztrain_h[hz.name] = fit_z([(ob, train_mask(hz, ob)) for ob in obs])
        table_v3[hz.name], table_v3_full[hz.name] = z_table(ztrain_h[hz.name]), z_table(zfull_h[hz.name])
        table_v3p[hz.name] = z_table(fit_z([(ob, train_mask(hz, ob)) for ob in obs], monotone=True))

    buckets: list[Bucket] = []
    v3_full: dict[tuple, Bucket] = {}
    oos: dict[tuple, dict] = {}
    priced: dict[str, dict[str, dict[str, np.ndarray]]] = {
        k: defaultdict(dict) for k in ("v1", "v2", "v3", "v3full", "v3p")
    }
    for hz, coin, ob in each():
        buckets += aggregate(coin, hz.name, ob)
        tr, te = train_mask(hz, ob), ~train_mask(hz, ob)
        train_v1 = v1_fit(aggregate(coin, hz.name, ob, tr))
        pr = {
            "v1": v1_priced(ob, train_v1),
            "v2": v2_priced(ob, table_v2),
            "v3": v2_priced(ob, table_v3[hz.name]),
            "v3full": v2_priced(ob, table_v3_full[hz.name]),
            "v3p": v2_priced(ob, table_v3p[hz.name]),
        }
        for k, v in pr.items():
            priced[k][hz.name][coin] = v
        for b in aggregate(coin, hz.name, ob, priced=pr["v3full"]):
            v3_full[(coin, hz.name, b.direction, b.distance)] = b
        tests = {m: aggregate(coin, hz.name, ob, te, priced=pr[m]) for m, _ in METHODS}
        for i, a in enumerate(tests["v1"]):
            if a.n < MIN_OBS or (a.direction, a.distance) not in train_v1:
                continue
            row = {"n_test": a.n, "realized_test": a.realized}
            for m, _ in METHODS:
                t = tests[m][i]
                row[f"{m}_priced"], row[f"{m}_pass"] = t.priced, bool(t.passes)
            oos[(coin, hz.name, a.direction, a.distance)] = row

    def test_parts(hz: Horizon, method: str) -> list:
        return [(ob, ~train_mask(hz, ob), priced[method][hz.name][c]) for c, ob in obs_all[hz.name].items()]

    # OOS per z bucket for the csv, and the per-horizon diagnostic for v2 and v3
    z_eval_all = {}
    for b in ztrain_all:
        parts = [p for hz in HORIZONS for p in test_parts(hz, "v2")]
        z_eval_all[(b.direction, b.lo)] = _z_eval(parts, b.lo, b.hi, b.direction)
    z_eval_h = {hz.name: {(b.direction, b.lo): _z_eval(test_parts(hz, "v3"), b.lo, b.hi, b.direction)
                          for b in ztrain_h[hz.name]} for hz in HORIZONS}  # fmt: skip
    diag_v2, diag_v3 = [], []
    for hz in HORIZONS:
        for direction in ("down", "up"):
            for lo, hi in ZGROUPS:
                base = {"horizon": hz.name, "direction": direction, "lo": lo, "hi": hi}
                diag_v2.append(base | _z_eval(test_parts(hz, "v2"), lo, hi, direction))
                diag_v3.append(base | _z_eval(test_parts(hz, "v3"), lo, hi, direction))

    sims: dict[tuple[str, str], SimResult] = {}
    sim_list: list[SimResult] = []
    for hz in HORIZONS:
        ob, t0 = obs_all[hz.name], split_t[hz.name]
        variants = [
            ("raw", "raw, OOS half", None, t0),
            ("v1", "v1 per-bucket, OOS half", priced["v1"][hz.name], t0),
            ("v2", "v2 pooled z, OOS half", priced["v2"][hz.name], t0),
            ("v3", "v3 z per horizon (adopted), OOS half", priced["v3"][hz.name], t0),
            ("v3full", "v3 z per horizon, in-sample, full", priced["v3full"][hz.name], None),
            ("v3p", "v3 + PAVA (not adopted), OOS half", priced["v3p"][hz.name], t0),
        ]
        for key, label, pr_, tf in variants:
            s = simulate_pool(label, hz, ob, pr_, t_from=tf)
            sims[(hz.name, key)] = s
            sim_list.append(s)

    meta = {"generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%MZ"), "coins": coins,
            "ranges": ranges, "windows": windows}  # fmt: skip
    write_csv(out_dir / "calibration.csv", buckets, oos, v3_full)
    write_z_csv(
        out_dir / "calibration_z.csv",
        [(hz.name, zfull_h[hz.name], ztrain_h[hz.name], z_eval_h[hz.name]) for hz in HORIZONS]
        + [("all", zfull_all, ztrain_all, z_eval_all)],
    )
    with (out_dir / "calibration_z_by_horizon.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["horizon", "direction", "abs_z_lo", "abs_z_hi", "n_test", "hits_test", "expected_test",
                    "realized_test", "v2_priced_test", "v2_pass", "v3_priced_test", "v3_pass"])  # fmt: skip
        for r2, r3 in zip(diag_v2, diag_v3, strict=True):
            w.writerow([r3["horizon"], r3["direction"], r3["lo"], "inf" if math.isinf(r3["hi"]) else r3["hi"],
                        r3["n"], r3["hits"], f"{r3['expected']:.4f}", _f(r3["realized"]), _f(r2["priced"]),
                        r2["pass"], _f(r3["priced"]), r3["pass"]])  # fmt: skip
    blob = write_tail_json(out_dir / "tail_multipliers.json", zfull_h, meta)
    pts = [(b.mean_p, b.realized, HZ_COLORS[b.horizon], "circle" if b.direction == "down" else "square",
            f"{b.coin} {b.horizon} {b.direction} {b.distance:.1%}: {b.hits}/{b.n}")
           for b in buckets if b.n >= MIN_OBS and b.hits]  # fmt: skip
    pts += [(b.mean_p, b.realized, "#000000", "circle" if b.direction == "down" else "square",
             f"pooled {b.direction} |z| {_zlabel(b.lo, b.hi)}: {b.hits}/{b.n}")
            for b in zfull_all if b.n >= MIN_OBS and b.hits]  # fmt: skip
    legend = [*HZ_COLORS.items(), ("z bucket, all pooled", "#000000")]
    (out_dir / "calibration.svg").write_text(
        reliability_svg(pts, legend, "Predicted vs realized touch frequency (log-log)"), encoding="utf-8"
    )
    ctx = {"buckets": buckets, "zfull_all": zfull_all, "zfull_h": zfull_h, "oos": oos, "sims": sims,
           "sim_list": sim_list, "meta": meta, "diag_v2": diag_v2, "diag_v3": diag_v3, "v3_full": v3_full,
           "tail": blob}  # fmt: skip
    write_markdown(out_dir / "calibration.md", ctx)
    print(f"[backtest] wrote {out_dir}", flush=True)
    return ctx


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Calibration backtest of the one-touch model")
    ap.add_argument("--coins", nargs="+", default=["BTC", "ETH", "SOL", "HYPE"])
    ap.add_argument("--out", type=Path, default=REPORTS_DIR)
    args = ap.parse_args(argv)
    ctx = run(args.coins, args.out)
    for m, label in METHODS:
        f, n = _fails(ctx["oos"], m)
        print(f"[backtest] OOS failing % buckets {label}: {f}/{n}")
    for s in ctx["sim_list"]:
        print(f"[backtest] pool {s.horizon:>3} {s.label:<38} sold {s.sold:>6} refused {s.refused:>5} "
              f"price/100 {s.price_per_100:.3f} loss ratio {s.loss_ratio:.2f} maxDD {s.max_dd:.2%}")  # fmt: skip


if __name__ == "__main__":
    main()
