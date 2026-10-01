"""Calibration backtest of the one-touch model on real Hyperliquid history (ARCHITECTURE §9, D9, D11, D13).

    python -m numera_engine.backtest --coins BTC ETH SOL HYPE

For each coin, horizon and distance, compare the model's predicted touch probability (sigma estimated
strictly from data before the start) with whether the price actually touched the level within the
window (candle low/high). The tail adjustment (k, q) is fitted per horizon on the standardized distance
z = ln(H/S) / (sigma sqrt(T)), pooled over coins. v4 (D13, published): the 1d table is fitted on daily
candles (2023-2026) and thin |z| buckets are pooled with their nearer neighbours before the Wilson bound.
v3 (D11, the previous tables, 1d on 1h candles) and rejected thin-bucket alternatives are evaluated side
by side, in sample and out of sample, and run through a pool P&L simulation.

Writes engine/reports/: calibration.md, calibration.csv (per % bucket), calibration_z.csv (z buckets),
calibration_z_by_horizon.csv (diagnostic), calibration.svg, tail_multipliers.json (z-per-horizon-v4).
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
TARGET_LOSS_RATIO = (0.4, 0.8)  # D13 (D9 had 0.5-0.8)


@dataclass(frozen=True)
class Horizon:
    name: str
    seconds: int
    interval: str  # candle interval used
    bars: int  # candles per window (= step between starts, non-overlapping)


HORIZONS = (  # published tables (D13: 1d on daily candles = exact intraday touch for a 00:00 UTC window)
    Horizon("1h", 3600, "1h", 1),
    Horizon("4h", 4 * 3600, "1h", 4),
    Horizon("1d", 86400, "1d", 1),
    Horizon("7d", 7 * 86400, "1d", 7),
)
# D11 data set for the 1d table (24 one-hour candles, ~7 months, sigma from 1h candles like the live engine).
# Not published; kept to compare old vs new and to check the 1d table under the live engine's sigma.
LEGACY_1D = Horizon("1d-1h", 86400, "1h", 24)
DATASETS = (*HORIZONS, LEGACY_1D)
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


# -- z buckets per horizon (v3 = D11, v4 = D13) ----------------------------------------------------

N_POOL = 300  # D13: a |z| bucket's floor rests on >= N_POOL windows with >= 1 touch (nearward pooling)


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
    block_n: int = 0  # counts q was fitted on: the bucket's own, or its pool (v4) / block (alternatives)
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


def nearward_pool(counts: list[tuple[int, int]], n_pool: int = N_POOL, min_hits: int = 1) -> list[tuple[int, int]]:
    """D13 (adopted). Per |z| bucket (ordered near -> far), the (hits, n) its floor q is fitted on: its own
    counts if it has >= ``n_pool`` windows and >= ``min_hits`` touches, else its counts pooled with its
    nearer-the-money neighbours, one at a time, until the pool qualifies (or nothing nearer is left).
    Empty buckets stay (0, 0).

    Why the result is still an upper bound for the bucket: the true touch frequency cannot rise with |z|, so
    every nearer bucket touches at least as often as bucket i. The pooled frequency of buckets j..i (j <= i)
    is therefore >= that of bucket i, and the Wilson upper bound of the pooled counts bounds bucket i from
    above (conservatively). The pool never reaches into the further, safer tail, so a bucket's floor is never
    diluted by data that are safer than it; data-rich buckets keep their own counts.
    """
    out: list[tuple[int, int]] = []
    for i, (_, n) in enumerate(counts):
        if n == 0:
            out.append((0, 0))
            continue
        ph = pn = 0
        for j in range(i, -1, -1):
            ph, pn = ph + counts[j][0], pn + counts[j][1]
            if pn >= n_pool and ph >= min_hits:
                break
        out.append((ph, pn))
    return out


def merge_tail_inward(counts: list[tuple[int, int]], n_pool: int = N_POOL, min_hits: int = 1) -> list[tuple[int, int]]:
    """Rejected alternative (D13). Partition the buckets, from the far tail inwards, into adjacent blocks with
    >= ``n_pool`` windows and >= ``min_hits`` touches (a short near-money remainder joins its neighbouring
    block); each bucket uses its block's counts. Flaw: the nearest member of a block is averaged with safer,
    further buckets, so the block bound is not an upper bound for it (under-prices the block's inner edge)."""
    blocks: list[list[int]] = []  # [hits, n, first index, last index]
    cur: list[int] | None = None
    for i in range(len(counts) - 1, -1, -1):
        h, n = counts[i]
        cur = cur or [0, 0, i, i]
        cur[0], cur[1], cur[2] = cur[0] + h, cur[1] + n, i
        if cur[1] >= n_pool and cur[0] >= min_hits:
            blocks.append(cur)
            cur = None
    if cur is not None:
        if blocks:
            blocks[-1][0] += cur[0]
            blocks[-1][1] += cur[1]
            blocks[-1][2] = cur[2]
        else:
            blocks.append(cur)
    out: list[tuple[int, int]] = [(0, 0)] * len(counts)
    for h, n, a, b in blocks:
        for i in range(a, b + 1):
            out[i] = (h, n)
    return out


def isotonic_nonincreasing(values: list[float], weights: list[float]) -> list[float]:
    """Weighted least-squares fit of ``values`` that is non-increasing in index (pool adjacent violators)."""
    blocks: list[list[float]] = []  # [weighted sum, weight, first index, last index]
    for i, (v, w) in enumerate(zip(values, weights, strict=True)):
        blocks.append([v * w, w, i, i])
        while len(blocks) > 1 and blocks[-2][0] / blocks[-2][1] < blocks[-1][0] / blocks[-1][1]:
            s, w2, _, j = blocks.pop()
            blocks[-1][0] += s
            blocks[-1][1] += w2
            blocks[-1][3] = j
    out = [0.0] * len(values)
    for s, w, a, b in blocks:
        for i in range(int(a), int(b) + 1):
            out[i] = s / w
    return out


def pava_nonincreasing(counts: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Pool-adjacent-violators: merge neighbouring (hits, n) buckets until the touch frequency is
    non-increasing in |z|; returns, per input bucket, the (hits, n) of the block it ends up in.

    The maximum-likelihood monotone fit (D11 compared alternative, rejected). Empty buckets (n = 0) are
    skipped and inherit the counts of the block before them.
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


THIN_METHODS = ("none", "nearward", "merge", "isotonic", "pava")


def fit_z(parts: list[tuple[Obs, np.ndarray]], edges=Z_EDGES, method: str = "none",
          n_pool: int = N_POOL) -> list[ZBucket]:  # fmt: skip
    """Pool rows (obs, mask) into |z| buckets per direction and fit (k, q).

    q = Wilson one-sided 95 % upper bound of the touch frequency on the counts chosen by ``method``:
    "none" = the bucket's own counts (v3, D11); "nearward" = ``nearward_pool`` (v4, D13); "merge" =
    ``merge_tail_inward``; "pava" = ``pava_nonincreasing``; "isotonic" = own Wilson bounds, then a
    non-increasing isotonic fit weighted by n. k = clamp(q / bucket mean p, 1, K_MAX), 1 if those counts
    have no touch. A cell needs >= MIN_OBS windows behind q and >= 1 window of its own.
    """
    if method not in THIN_METHODS:
        raise ValueError(f"unknown thin-bucket method {method}")
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
        blocks = {
            "none": lambda c: c,
            "isotonic": lambda c: c,
            "nearward": lambda c: nearward_pool(c, n_pool),
            "merge": lambda c: merge_tail_inward(c, n_pool),
            "pava": pava_nonincreasing,
        }[method](counts)
        qs = [wilson(bh, bn)[1] if n > 0 and bn >= MIN_OBS else None
              for (_, _, n, _, _), (bh, bn) in zip(raw, blocks, strict=True)]  # fmt: skip
        if method == "isotonic":
            idx = [i for i, q in enumerate(qs) if q is not None]
            for i, v in zip(idx, isotonic_nonincreasing([qs[i] for i in idx], [raw[i][2] for i in idx]),
                            strict=True):  # fmt: skip
                qs[i] = v
        for (lo, hi, n, hits, mp), (bh, bn), q in zip(raw, blocks, qs, strict=True):
            k = None
            if q is not None:
                k = 1.0 if bh == 0 or mp <= 0 else min(K_MAX, max(1.0, q / mp))
            out.append(ZBucket(direction, lo, hi, n, hits, mp, k, q, bn, bh))
    return out


def z_table(zbs: list[ZBucket], edges=Z_EDGES) -> ZTailTable:
    return ZTailTable(tuple(edges), {d: [b.cell() for b in zbs if b.direction == d] for d in ("down", "up")})


def v2_priced(obs: Obs, table: ZTailTable) -> np.ndarray:
    """Per-row max(p * k_z, q_z) with a z table (same lookup as the live quote API, vectorized)."""
    out = np.empty(len(obs))
    zabs = np.abs(obs.z.astype(float))
    for direction in ("down", "up"):
        m = obs.direction == direction
        if m.any():
            k, q = table.kq_many(direction == "down", zabs[m])
            out[m] = np.maximum(obs.p[m] * k, q)
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


METHODS = (  # key, thin-bucket method, N, label
    ("v3", "none", N_POOL, "v3 (D11): own bucket counts"),
    ("v4", "nearward", N_POOL, f"v4 (D13): thin buckets pooled nearward (>= {N_POOL} windows, >= 1 touch)"),
    ("v4n100", "nearward", 100, "v4 with N = 100 (sensitivity)"),
    ("v4n1000", "nearward", 1000, "v4 with N = 1000 (sensitivity)"),
    ("v4m", "merge", N_POOL, f"adjacent blocks merged tail-inward (>= {N_POOL}, >= 1 touch; rejected)"),
    ("v4i", "isotonic", N_POOL, "isotonic fit of the Wilson bounds, weighted by n (rejected)"),
    ("v3p", "pava", N_POOL, "PAVA on counts (D11 alternative, rejected)"),
)
PUBLISHED = "v4"
CROSS = "v4@1d"  # 1d windows with the live engine's sigma (1h candles), priced with the v4 1d table
PRICING_KEYS = [m for m, *_ in METHODS] + [CROSS]


def _row(m: str, d1: str = "1d") -> dict[str, tuple[str, str]]:
    return {"1h": ("1h", m), "4h": ("4h", m), "1d": (d1, m), "7d": ("7d", m)}


ROWS = (  # headline rows: key, label, horizon -> (data set, pricing key)
    ("old", "v3 = main (D11): 1d table on 1h candles", _row("v3", "1d-1h")),
    ("v3d", "v3 rule, 1d table on daily candles (data change only)", _row("v3")),
    ("v4", "v4 (D13, adopted): daily candles for 1d + nearward pooling", _row("v4")),
    ("v4n100", "v4 with N = 100 (sensitivity)", _row("v4n100")),
    ("v4n1000", "v4 with N = 1000 (sensitivity)", _row("v4n1000")),
    ("v4m", "daily 1d + adjacent blocks merged tail-inward (rejected)", _row("v4m")),
    ("v4i", "daily 1d + isotonic fit of Wilson bounds weighted by n (rejected)", _row("v4i")),
    ("v3p", "daily 1d + PAVA on counts (rejected)", _row("v3p")),
)
TARGET_OOS_FAILS = 24

CSV_BASE = [
    "coin", "dataset", "direction", "distance", "n", "hits", "realized", "predicted_mean",
    "realized_over_predicted", "wilson_lo95", "wilson_hi95", "underpriced_significant", "mean_sigma",
]  # fmt: skip


def write_csv(path: Path, buckets: list[Bucket], oos: dict, ins: dict) -> None:
    cols = list(CSV_BASE)
    for pk in PRICING_KEYS:
        cols += [f"{pk}_priced_in_sample", f"{pk}_pass_in_sample", f"{pk}_oos_n_test", f"{pk}_oos_realized_test",
                 f"{pk}_oos_priced_test", f"{pk}_oos_pass"]  # fmt: skip
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for b in buckets:
            key = (b.coin, b.direction, b.distance)
            ratio = b.realized / b.mean_p if b.mean_p > 0 else float("nan")
            row = [b.coin, b.horizon, b.direction, f"{b.distance:.3f}", b.n, b.hits, _f(b.realized),
                   _f(b.mean_p, 8), f"{ratio:.3f}", _f(b.wilson_lo), _f(b.wilson_hi),
                   str(b.underpriced_significant), _f(b.mean_sigma, 4)]  # fmt: skip
            for pk in PRICING_KEYS:
                i = ins.get((b.horizon, pk), {}).get(key, {})
                o = oos.get((b.horizon, pk), {}).get(key, {})
                row += [_f(i.get("priced")), _b(i.get("pass")), o.get("n", ""), _f(o.get("realized")),
                        _f(o.get("priced")), _b(o.get("pass"))]  # fmt: skip
            w.writerow(row)


def write_z_csv(path: Path, tables: list[tuple[str, list[ZBucket], list[ZBucket], dict]]) -> None:
    """tables: (scope 'dataset:method', full-sample buckets, first-half buckets, OOS eval by (direction, lo))."""
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["scope", "direction", "abs_z_lo", "abs_z_hi", "n", "hits", "realized", "mean_p",
                    "wilson_lo95", "pool_n", "pool_hits", "k", "q", "train_k", "train_q", "oos_n_test",
                    "oos_realized_test", "oos_priced_test", "oos_pass"])  # fmt: skip
        for scope, full, train, ev in tables:
            for b, t in zip(full, train, strict=True):
                e = ev.get((b.direction, b.lo), {})
                w.writerow([scope, b.direction, f"{b.lo:g}", "inf" if math.isinf(b.hi) else f"{b.hi:g}", b.n,
                            b.hits, _f(b.realized), _f(b.mean_p, 8), _f(wilson(b.hits, b.n)[0]), b.block_n,
                            b.block_hits, _f(b.k, 4), _f(b.q, 8), _f(t.k, 4), _f(t.q, 8), e.get("n", ""),
                            _f(e.get("realized")), _f(e.get("priced")), _b(e.get("pass"))])  # fmt: skip


SIGMA_NOTE = {
    "1h": "max(EWMA 0.94 of 1h log returns, 30-day realized), 1h candles (= live engine)",
    "1d": "max(EWMA 0.94 of daily log returns, 30-day realized), daily candles",
}


def write_tail_json(path: Path, zfull: dict[str, list[ZBucket]], meta: dict) -> dict:
    tables = {}
    for hz in HORIZONS:
        zbs = zfull[hz.name]
        fitted = [b for b in zbs if b.k is not None]
        tables[str(hz.seconds)] = {
            "horizon": hz.name,
            "candles": hz.interval,
            "sigma_fit": SIGMA_NOTE[hz.interval],
            "cells": {d: [b.cell() for b in zbs if b.direction == d] for d in ("down", "up")},
            "default": {"k": round(max(b.k for b in fitted), 4), "q": round(max(b.q for b in fitted), 8)},
        }
    blob = {
        "schema": "z-per-horizon-v4",
        "model": MODEL_NAME,
        "generated_at": meta["generated_at"],
        "formula": "priced = max(p * k(h, dir, |z|), q(h, dir, |z|)); refuse if priced > pMax; "
        "premium = ceil(payout * priced * (1 + theta)) + fee; z = ln(level/spot) / (sigma * sqrt(T)); "
        "h = smallest calibrated horizon >= duration",
        "method": (
            "Per calibrated horizon, windows of all coins pooled into |z| buckets per direction (D11). 1h and 4h "
            "tables from 1h candles, 1d and 7d tables from daily candles (D13). Per bucket: q = Wilson one-sided "
            f"95% upper bound of the touch frequency on the bucket's own counts if it has >= {N_POOL} windows and "
            ">= 1 touch, else on its counts pooled with its nearer-the-money neighbours until it does (D13 "
            "nearward pooling; block_n/block_hits = those counts); k = clamp(q / bucket mean model p, 1, "
            f"{K_MAX:g}), 1 if the counts have no touch. Lookup: k from the bucket holding |z|; q made "
            "non-increasing in |z| then log-linearly interpolated between bucket mid-points. null = empty bucket "
            "or < 30 windows behind q (nearest populated bucket is used)."
        ),
        "n_pool": N_POOL,
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
CURVE_Z = (2.0, 2.5, 3.0, 3.25, 3.5, 3.75, 4.0, 4.5, 5.0, 6.0)


def _fails(d: dict | None, d11: bool = False) -> tuple[int, int]:
    """(failing, evaluated) % buckets. ``d11``: only buckets that also have >= 30 first-half windows of that
    coin (D11's criterion, from per-coin fitting); it drops HYPE at 1d/7d, which starts after the split."""
    rows = [v for v in (d or {}).values() if v.get("train_ok", True) or not d11]
    return sum(1 for v in rows if not v["pass"]), len(rows)


def headline(ctx: dict, row: tuple) -> dict:
    """Per horizon and total: in-sample fails, OOS fails (all buckets with >= 30 test windows, and D11's
    criterion), OOS loss ratio, OOS price multiple vs raw."""
    _, _, spec = row
    out: dict = {"is": [0, 0], "oos": [0, 0], "oos_d11": [0, 0]}
    for hz, (ds, pk) in spec.items():
        fi, ni = _fails(ctx["ins"].get((ds, pk)))
        fo, no = _fails(ctx["oos"].get((ds, pk)))
        f11, n11 = _fails(ctx["oos"].get((ds, pk)), d11=True)
        s, raw = ctx["sims"][(ds, pk)], ctx["sims"][(ds, "raw")]
        out[hz] = {"is": (fi, ni), "oos": (fo, no), "oos_d11": (f11, n11), "lr": s.loss_ratio,
                   "mult": s.price_per_100 / raw.price_per_100}  # fmt: skip
        for k, (f, n) in (("is", (fi, ni)), ("oos", (fo, no)), ("oos_d11", (f11, n11))):
            out[k][0] += f
            out[k][1] += n
    return out


def write_markdown(path: Path, ctx: dict) -> None:
    buckets: list[Bucket] = ctx["buckets"]
    sims: dict = ctx["sims"]
    meta: dict = ctx["meta"]
    zfull: dict = ctx["zfull"]
    pub = [b for b in buckets if b.horizon in {h.name for h in HORIZONS}]
    fitted = [b for b in pub if b.n >= MIN_OBS]
    n_coins = len(meta["coins"])
    heads = {r[0]: headline(ctx, r) for r in ROWS}
    L: list[str] = []
    add = L.append
    add("# Calibration backtest: one-touch model on Hyperliquid history\n")
    add(
        f"Generated {meta['generated_at']} by `python -m numera_engine.backtest --coins {' '.join(meta['coins'])}` "
        f"(model `{MODEL_NAME}`, tail table `z-per-horizon-v4`, decisions D9, D11, D13). Source: Hyperliquid "
        "mainnet Info API `candleSnapshot`, read-only. Files: `calibration.csv` (per coin / data set / % distance "
        "bucket, in-sample and out-of-sample columns for every method), `calibration_z.csv` (z buckets per data "
        "set and method, `1d:v4` etc. are the published tables), `calibration_z_by_horizon.csv` (diagnostic), "
        "`calibration.svg` (reliability plot), `tail_multipliers.json` (consumed by the quote API).\n"
    )

    add("## Pricing formula (engine v1, final)\n")
    add(
        "For a cover on perp `i`, direction `isLong`, trigger level `L` (px6), payout `P` (USDC, 6 dec), "
        "duration `D` seconds:\n"
    )
    add("```")
    add("S      = pool.priceSource().oraclePx6(i) / 1e6 via eth_call (D10: what buyCover checks); spotRef = it")
    add("         fallback if that read fails: testnet Info API metaAndAssetCtxs.oraclePx (breakdown.spotSource)")
    add("sigma  = max(EWMA_0.94(1h log returns), realized sigma over the last 30 days), annualized x sqrt(24*365)")
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
        "one, nearer-the-money first). q is made non-increasing in |z| (each bucket takes the max of itself and "
        "all further buckets) and then interpolated log-linearly between bucket mid-points, so the price is "
        "continuous in the level and never rises as the level moves away. k >= 1 always. The formula and the "
        "quote API are unchanged by D13; only the numbers in `tail_multipliers.json` change.\n"
    )

    add("## What changed in v4 (D13)\n")
    add(
        "1. **The 1d table is fitted on daily candles** (BTC/ETH from 2023-02-26, SOL 2023-03-04, HYPE "
        "2024-12-05; zero-volume rows dropped), the same source the 7d table uses. A window is one UTC day: "
        "S = the daily open, touched if the daily low (high) reached the level, which is the exact intraday "
        "touch for that window. This multiplies the 1d sample by about six (v3 had ~177 days per coin from "
        "the only ~7 months of 1h candles the API keeps)."
    )
    add(
        f"2. **Thin |z| buckets are pooled with their nearer neighbours** (nearward pooling, N = {N_POOL}). "
        "The true touch frequency cannot rise as the level moves away, so every nearer bucket touches at least "
        "as often as a given bucket; the pooled frequency of that bucket and its nearer neighbours is therefore "
        "at least its own, and the Wilson upper bound of the pooled counts is still an upper bound for it, "
        f"only a tighter one. A bucket with fewer than {N_POOL} windows or no touch borrows its nearer "
        f"neighbours one at a time until the pool has >= {N_POOL} windows and >= 1 touch; data-rich buckets "
        f"keep their own counts. Every floor then rests on >= {N_POOL} windows (one touch in {N_POOL} has a bound "
        "of about 1.5 %, one in 110 had 4 %), so the never-cheaper-further-away rule no longer carries one thin "
        "bucket's wide bound into every nearer, data-rich bucket. The pool never reaches into the further, safer "
        f"tail, so no bucket's floor is diluted. N = {N_POOL} (10 x the 30-window minimum) was fixed before "
        "the run; N = 100 and 1000 are reported as a sensitivity check."
    )
    add(
        "3. **Rejected alternatives** (all evaluated below): (a) merging adjacent buckets into fixed blocks "
        "from the tail inwards until each has >= N windows and >= 1 touch: the nearest member of each block is "
        "averaged with safer, further buckets, so the block's bound is not an upper bound for it, and that "
        "inner edge is exactly the |z| 3-5 region liquidation covers live in; (b) isotonic regression of the "
        "Wilson bounds weighted by n: it averages upper bounds from samples of different size, which is not a "
        "confidence bound for anything; (c) PAVA on the counts (D11's v3p): the maximum-likelihood monotone "
        "fit, but its pooled bound again under-covers the nearest member of each block.\n"
    )

    add("## Method\n")
    add(
        '- **Question.** When the engine says "probability p that the price touches level L within T", does '
        "that happen with frequency p or less in real Hyperliquid data?"
    )
    add(
        "- **Data.** 1h and 4h horizons: 1-hour candles (the Info API keeps only the latest ~5000). 1d and 7d: "
        "daily candles from 2023-02-26 on; zero-volume rows and earlier rows dropped (HL-traded data only). "
        "The D11 1d data set (24 one-hour candles per day, `1d-1h`) is kept for the old-vs-new comparison."
    )
    add(
        "- **No look-ahead.** At each window start, sigma = max(EWMA lambda=0.94 of log returns, 30-day realized), "
        "annualized, from candles that closed before the start only (30-day warm-up skipped). 1h/4h windows "
        "(and `1d-1h`) use 1h candles, exactly like the live engine; 1d and 7d windows use daily candles."
    )
    add(
        "- **Sigma for the 1d table (choice and mismatch).** Daily sigma is the only estimator available over "
        "2023-2026 (1h history is ~7 months), and it is the one the 7d table already uses, so the 1d table is "
        "fitted on z computed with daily sigma. The live engine computes sigma from 1h candles for every "
        "duration. The mismatch is measured below on the ~7 months where both exist (same days), and the 1d "
        "table is validated directly under the live sigma: the 1d windows of the `1d-1h` set (sigma from 1h "
        "candles) are priced with the v4 1d table fitted on the first half of the daily set. All of those "
        "windows lie after that half, so this check is out of sample."
    )
    add(
        "- **Windows.** Non-overlapping (step = horizon), aligned to multiples of the horizon since the unix "
        "epoch (UTC midnight for 1d). Levels 1, 2, 3, 5, 7.5, 10, 15, 20 % below S (`down`, long cover) and "
        "above S (`up`, short cover). Touched if min(low) <= S(1-d) or max(high) >= S(1+d) in the window. "
        "Windows with a missing candle are skipped."
    )
    add(
        "- **Tail tables (D11, unchanged in structure).** Per horizon, all coins pooled into |z| buckets (0.25 "
        "wide up to 4, then 4-5, 5-7, >= 7), per direction. Per bucket q = Wilson one-sided 95 % upper bound "
        f"(on the counts chosen by the thin-bucket rule), k = clamp(q / mean p, 1, {K_MAX:g})."
    )
    add(
        "- **Out-of-sample protocol.** Each data set's windows are split at the median start time. Every method "
        "is fitted on the first half only and evaluated on the second half: (a) per coin/horizon/direction/% "
        "bucket with >= 30 second-half windows (D11 also required >= 30 first-half windows of that coin; both "
        "counts are reported), pass if realized frequency <= mean priced probability; (b) a "
        "pool P&L simulation trading the second half. In-sample = tables fitted on all windows, evaluated on "
        "all windows (per % bucket with >= 30 windows)."
    )
    add(
        "- **Caveat: candles are trade prices, not the oracle.** Covers trigger on the oracle (validator median "
        "of 8 venues). HL trade wicks on thin books usually go further than the oracle, so candle touches "
        "probably over-count oracle touches (conservative for the pool; not verified).\n"
    )

    add("## Data actually used\n")
    add("| coin | candles | first (UTC) | last (UTC) | count | windows per data set |")
    add("|---|---|---|---|---|---|")
    for coin in meta["coins"]:
        for iv in ("1h", "1d"):
            r = meta["ranges"][coin][iv]
            wins = ", ".join(f"{d.name}: {meta['windows'][coin][d.name]}" for d in DATASETS if d.interval == iv)
            add(f"| {coin} | {iv} | {r['first']} | {r['last']} | {r['count']} | {wins} |")
    add("")

    add("## Headline: old (v3, main) vs new (v4)\n")
    lo_t, hi_t = TARGET_LOSS_RATIO
    add(
        "Per horizon: in-sample failing % buckets / out-of-sample failing % buckets / OOS loss ratio (claims / "
        "premiums) / OOS price multiple (average premium per 100 USDC of cover divided by the raw model's on the "
        f"same windows, both with the 20 % loading). D13 targets: OOS failing <= {TARGET_OOS_FAILS}/240, loss "
        f"ratio {lo_t}-{hi_t}. The old row is D11's published configuration re-run on today's data. `OOS fails "
        "(D11)` counts like D11 did (only buckets whose coin also has >= 30 first-half windows: HYPE starts "
        "after the 1d/7d split, so its 1d/7d buckets drop out); `OOS fails (all)` also tests HYPE's 1d/7d "
        "buckets, priced by tables fitted on the other coins' first half, which the coin-pooled tables allow.\n"
    )
    add("| method | in-sample fails | OOS fails (D11) | OOS fails (all) | 1h | 4h | 1d | 7d |")
    add("|---|---|---|---|---|---|---|---|")
    for key, label, _ in ROWS:
        h = heads[key]
        cells = []
        for hz in HZ_NAMES:
            c = h[hz]
            cells.append(f"{c['is'][0]}/{c['is'][1]} / {c['oos'][0]}/{c['oos'][1]} / {c['lr']:.2f} / {c['mult']:.2f}x")
        bold = "**" if key in ("old", PUBLISHED) else ""
        add(f"| {bold}{label}{bold} | {h['is'][0]}/{h['is'][1]} | {bold}{h['oos_d11'][0]}/{h['oos_d11'][1]}{bold} | "
            f"{h['oos'][0]}/{h['oos'][1]} | {' | '.join(cells)} |")  # fmt: skip
    add("")
    add("Horizon cells: in-sample fails / OOS fails (all) / OOS loss ratio / OOS price multiple.\n")
    raw_cells = " | ".join(f"{sims[(ds, 'raw')].loss_ratio:.2f}" for ds in ("1h", "4h", "1d", "7d"))
    add(f"Raw model (k = 1, no floor) OOS loss ratio, 1h / 4h / 1d / 7d: {raw_cells}; on the old 1d set "
        f"(`1d-1h`): {sims[('1d-1h', 'raw')].loss_ratio:.2f}.\n")  # fmt: skip
    cr = ctx["cross"]
    add(
        f"**1d table under the live engine's sigma** (`1d-1h` windows, sigma from 1h candles, priced with the v4 "
        f"1d table fitted on the first half of the daily set; second half of `1d-1h`, the same windows the old "
        f"row is tested on): OOS failing {cr['oos'][0]}/{cr['oos'][1]}, loss ratio {cr['lr']:.2f}, price "
        f"multiple {cr['mult']:.2f}x; in-sample (published table) {cr['is'][0]}/{cr['is'][1]} failing.\n"
    )
    add(_sigma_text(ctx))
    add("")

    add("### What a quote costs: floor q by |z| (down levels), old v3 vs new v4\n")
    add("Published tables (all windows). The priced probability is max(p * k, q); in the far tail q dominates.\n")
    add("| abs z | " + " | ".join(f"{h} old q | {h} new q" for h in HZ_NAMES) + " |")
    add("|---|" + "---|---|" * len(HZ_NAMES))
    for z in CURVE_Z:
        cells = []
        for hz in HZ_NAMES:
            old = ctx["tables_full"][(_row("v3", "1d-1h")[hz][0], "v3")].kq(True, z).q
            new = ctx["tables_full"][(hz, PUBLISHED)].kq(True, z).q
            cells.append(f"{old:.2%} | {new:.2%}")
        add(f"| {z:g} | {' | '.join(cells)} |")
    add("")

    add("## Published tables: z buckets per horizon (v4)\n")
    add(
        "Fitted on all windows of all coins, per horizon. Cell = own touches/windows, pooled touches/windows "
        "behind q (`=` when the bucket's own counts are used), k, q.\n"
    )
    add("| dir | abs z | " + " | ".join(f"{h} own | {h} pool | {h} k | {h} q" for h in HZ_NAMES) + " |")
    add("|---|---|" + "---|---|---|---|" * len(HZ_NAMES))
    for i, b0 in enumerate(zfull[(HZ_NAMES[0], PUBLISHED)]):
        cells = []
        for hz in HZ_NAMES:
            b = zfull[(hz, PUBLISHED)][i]
            kk = "" if b.k is None else f"{b.k:.2f}"
            qq = "" if b.q is None else f"{b.q:.2e}"
            pool = "=" if (b.block_hits, b.block_n) == (b.hits, b.n) else f"{b.block_hits}/{b.block_n}"
            cells.append(f"{b.hits}/{b.n} | {pool} | {kk} | {qq}")
        add(f"| {b0.direction} | {_zlabel(b0.lo, b0.hi)} | {' | '.join(cells)} |")
    add("")

    add("## Per-horizon diagnostic (out of sample)\n")
    add(
        "Second half, priced with tables fitted on the first halves. `actual / model` > 1: the raw model "
        "under-predicts there. Old = v3 as on main (1d on 1h candles), new = v4.\n"
    )
    add("| horizon | dir | abs z | old windows | old touches | old priced | old | new windows | new touches | "
        "new actual / model | new realized | new priced | new |")  # fmt: skip
    add("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for ro, rn in zip(ctx["diag"]["old"], ctx["diag"][PUBLISHED], strict=True):
        if ro["n"] == 0 and rn["n"] == 0:
            continue
        am = rn["hits"] / rn["expected"] if rn["expected"] > 0 else float("inf")
        add(
            f"| {rn['horizon']} | {rn['direction']} | {_zlabel(rn['lo'], rn['hi'])} | {ro['n']} | {ro['hits']} | "
            f"{ro['priced']:.2e} | {'pass' if ro['pass'] else '**FAIL**'} | {rn['n']} | {rn['hits']} | {am:.2f} | "
            f"{rn['realized']:.2e} | {rn['priced']:.2e} | {'pass' if rn['pass'] else '**FAIL**'} |"
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
        "tables fitted on the first half; `in-sample` rows trade everything with the tables fitted on everything.\n"
    )
    add(
        "**How to read it.** Price and claims per 100 USDC of cover, the loss ratio (claims / premiums; the "
        "20 % loading alone targets 0.83 for a perfectly calibrated model) and drawdown do not depend on how "
        "many covers are sold. LP P&L does: this book sells a full set of covers every window, far more than "
        "real demand. Read LP P&L as an upper bound for that assumption.\n"
    )
    add(
        "| data set | variant | days | windows | covers sold | refused | triggered | premium per 100 | "
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
    add("| data set | direction | windows x distances | expected (sum p) | actual | actual / expected |")
    add("|---|---|---|---|---|---|")
    for d in DATASETS:
        for direction in ("down", "up"):
            bs = [b for b in buckets if b.horizon == d.name and b.direction == direction]
            act, exp_ = _ratio(bs)
            add(
                f"| {d.name} | {direction} | {sum(b.n for b in bs)} | {exp_:.1f} | {act} | "
                f"{act / exp_ if exp_ else float('nan'):.2f} |"
            )
    add("")

    add("## Calibration table per coin / horizon / distance (published data sets)\n")
    add(
        "`ratio` = realized / raw predicted (`sig` = significantly under-predicted). `v4 priced` = mean priced "
        "probability with the published tables (in-sample). OOS = second half priced with first-half tables.\n"
    )
    add("| coin | hz | dir | dist | windows | touches | realized | predicted | ratio | v4 priced | in-sample v4 | "
        "OOS v3 | OOS v4 |")  # fmt: skip
    add("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for b in fitted:
        key = (b.coin, b.direction, b.distance)
        ins = ctx["ins"][(b.horizon, PUBLISHED)].get(key)
        res = []
        for pk in ("v3", PUBLISHED):
            o = ctx["oos"][(b.horizon, pk)].get(key)
            res.append("" if o is None else ("pass" if o["pass"] else "**FAIL**"))
        ratio = b.realized / b.mean_p if b.mean_p > 0 else float("inf")
        add(
            f"| {b.coin} | {b.horizon} | {b.direction} | {b.distance:.1%} | {b.n} | {b.hits} | {b.realized:.4f} | "
            f"{b.mean_p:.2e} | {ratio:.2f}{' sig' if b.underpriced_significant else ''} | "
            f"{ins['priced']:.4f} | {'pass' if ins['pass'] else '**FAIL**'} | {' | '.join(res)} |"
        )
    add("")
    add("## Limitations (read before trusting the numbers)\n")
    add(
        "The evidence is real but thinner than the tables make it look. The Wilson bounds treat every window as "
        "an independent draw, and they are not: the same window is counted at eight distances, BTC, ETH, SOL "
        "and HYPE move together (a market-wide crash is one event, counted up to four times when we pool "
        "coins), and volatility clusters in time. The effective sample is therefore much smaller than the "
        "window counts, and the true uncertainty around every k and q is wider than the bounds state. The 1h "
        "and 4h evidence still comes from only ~7 months of 1-hour candles, essentially one market regime; the "
        "1d and 7d evidence spans 2023-2026 but 7d has fewer than 200 windows per coin. Touches are measured on "
        "Hyperliquid trade-price candles, not on the oracle the covers trigger on (oracle minute history exists "
        "only in a requester-pays S3 archive and was not used).\n"
    )
    add(
        "- **D13-specific.** (1) The 1d table is fitted on z with daily sigma, while the live engine uses 1h "
        "sigma (see the sigma comparison above); the check under the live sigma covers only ~7 months, and "
        "1d windows always start at 00:00 UTC whereas a live 1d quote can start at any time (intraday "
        "seasonality is not modelled). (2) Nearward pooling is conservative only if the touch frequency really "
        "is non-increasing in |z|; that holds for the true probability, not for a bucket's noisy estimate, "
        "which is the point. Its bound overstates the frequency of a pooled bucket by design (it carries some "
        f"nearer-money touches). (3) N = {N_POOL} is a judgement, not an estimate; the sensitivity rows show "
        "how much it matters. (4) Daily candles before an asset's HL listing do not exist; HYPE has ~10 months."
    )
    add(
        "- What would make it stronger: oracle history from the S3 archive (years, and the actual trigger "
        "price); block-bootstrap or cluster-robust intervals instead of Wilson; a scheduled refit with the "
        "out-of-sample pass rate tracked over time."
    )
    add("- The tables are point-in-time. A failing bucket after refit is a signal to widen the margin, not noise.")
    path.write_text("\n".join(L) + "\n", encoding="utf-8")


HZ_NAMES = [h.name for h in HORIZONS]


def _sigma_text(ctx: dict) -> str:
    sr = ctx["sigma_ratio"]
    parts = []
    for coin, r in sr.items():
        if len(r):
            parts.append(f"{coin} {np.median(r):.2f} (10-90 %: {np.quantile(r, 0.1):.2f}-{np.quantile(r, 0.9):.2f}, "
                         f"{len(r)} days)")  # fmt: skip
    allr = np.concatenate([r for r in sr.values() if len(r)]) if sr else np.array([])
    head = f"pooled median {np.median(allr):.2f}" if len(allr) else "no overlap"
    return (
        "**Sigma mismatch, measured.** Ratio live sigma (1h candles) / fit sigma (daily candles) at the same "
        f"window starts: {head}; per coin {'; '.join(parts)}. A ratio above 1 means the live engine sees a "
        "smaller |z| than the table was fitted on for the same level, so it looks up a nearer, more expensive "
        "bucket and a larger p (conservative); below 1 the opposite."
    )


def _findings(ctx: dict) -> str:
    zall = [b for hz in HZ_NAMES for b in ctx["zfull"][(hz, PUBLISHED)]]
    out = []
    near = [b for b in zall if b.n and b.hi <= 2]
    a, e = _ratio(near)
    out.append(
        f"- **Near the money (|z| < 2) the model over-predicts:** {a} touches where it expected {e:.0f} "
        f"({a / e if e else float('nan'):.2f}x), all horizons pooled. Likely reasons (not tested separately): the 30-day realized floor "
        "keeps sigma high after volatile spells, and short-horizon returns mean-revert a little."
    )
    mid = [b for b in zall if b.n and 2 <= b.lo and b.hi <= 4]
    a, e = _ratio(mid)
    out.append(f"- **2 <= |z| < 4:** {a} touches vs {e:.1f} expected ({a / e if e else float('nan'):.2f}x).")
    far = [b for b in zall if b.n and b.lo >= 4]
    a, e = _ratio(far)
    out.append(
        f"- **The tail (|z| >= 4) is where GBM fails:** {a} touches in {sum(b.n for b in far)} windows where "
        f"the model expected {e:.2f}. These are the flash moves liquidation cover exists for; the floor q "
        "prices them at their observed frequency (upper bound) instead of ~0."
    )
    for hz in HZ_NAMES:
        cells = [b for b in ctx["zfull"][(hz, PUBLISHED)] if b.k is not None]
        pooled = [b for b in cells if (b.block_hits, b.block_n) != (b.hits, b.n)]
        down = [b for b in pooled if b.direction == "down"]
        out.append(
            f"- **{hz}: {len(pooled)} of {len(cells)} fitted buckets use nearward pooling**"
            + (": down " + "; ".join(f"{_zlabel(b.lo, b.hi)} {b.hits}/{b.n} -> {b.block_hits}/{b.block_n}"
                                     for b in down) if down else "")  # fmt: skip
            + "."
        )
    fo = [r for r in ctx["diag"]["old"] if r["n"] and not r["pass"]]
    fn = [r for r in ctx["diag"][PUBLISHED] if r["n"] and not r["pass"]]
    out.append(f"- **Per-horizon diagnostic:** {len(fo)} horizon x z cells fail out of sample with v3 (main), {len(fn)} with v4.")
    if fn:
        out.append(
            "  Still failing with v4: "
            + "; ".join(
                f"{r['horizon']} {r['direction']} |z| {_zlabel(r['lo'], r['hi'])} ({r['hits']}/{r['n']} touched, "
                f"realized {r['realized']:.1e} vs priced {r['priced']:.1e})"
                for r in fn
            )
            + "."
        )
    fb = [(hz, k, v) for hz in HZ_NAMES for k, v in ctx["oos"][(hz, PUBLISHED)].items() if not v["pass"]]
    if fb:
        out.append(
            "- **Out-of-sample % buckets failing with v4:** "
            + "; ".join(
                f"{c} {hz} {d} {x:.1%} (realized {v['realized']:.4f} > priced {v['priced']:.4f})"
                for hz, (c, d, x), v in fb[:30]
            )
            + ("; ..." if len(fb) > 30 else "")
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


def evaluate(obs_all: dict[str, dict[str, Obs]], coins: list[str]) -> dict:
    """Fit every method on every data set (first half and all windows), price, and evaluate. No network."""
    split_t = {}
    for d in DATASETS:
        allstarts = np.unique(np.concatenate([ob.start_ms for ob in obs_all[d.name].values()]))
        split_t[d.name] = int(allstarts[len(allstarts) // 2])

    def train(d: str, ob: Obs) -> np.ndarray:
        return ob.start_ms < split_t[d]

    zfull, ztrain, tables_full, tables_tr = {}, {}, {}, {}
    for d in DATASETS:
        obs = list(obs_all[d.name].values())
        for m, thin, n_pool, _ in METHODS:
            zfull[(d.name, m)] = fit_z([(ob, np.ones(len(ob), dtype=bool)) for ob in obs], method=thin, n_pool=n_pool)
            ztrain[(d.name, m)] = fit_z([(ob, train(d.name, ob)) for ob in obs], method=thin, n_pool=n_pool)
            tables_full[(d.name, m)] = z_table(zfull[(d.name, m)])
            tables_tr[(d.name, m)] = z_table(ztrain[(d.name, m)])
    tables_full[("1d-1h", CROSS)] = tables_full[("1d", PUBLISHED)]
    tables_tr[("1d-1h", CROSS)] = tables_tr[("1d", PUBLISHED)]

    buckets: list[Bucket] = []
    oos: dict = defaultdict(dict)
    ins: dict = defaultdict(dict)
    priced_oos: dict = defaultdict(dict)
    priced_full: dict = defaultdict(dict)
    for d in DATASETS:
        for coin, ob in obs_all[d.name].items():
            buckets += aggregate(coin, d.name, ob)
            tr = train(d.name, ob)
            train_b = aggregate(coin, d.name, ob, tr)
            for pk in PRICING_KEYS:
                if (d.name, pk) not in tables_tr:
                    continue
                po, pf = v2_priced(ob, tables_tr[(d.name, pk)]), v2_priced(ob, tables_full[(d.name, pk)])
                priced_oos[(d.name, pk)][coin], priced_full[(d.name, pk)][coin] = po, pf
                full_b = aggregate(coin, d.name, ob, priced=pf)
                test_b = aggregate(coin, d.name, ob, ~tr, priced=po)
                for a, b_tr, b_te in zip(full_b, train_b, test_b, strict=True):
                    key = (coin, a.direction, a.distance)
                    if a.n >= MIN_OBS:
                        ins[(d.name, pk)][key] = {"n": a.n, "realized": a.realized, "priced": a.priced,
                                                  "pass": bool(a.passes)}  # fmt: skip
                    if b_te.n >= MIN_OBS:  # tables pool coins: a coin needs no first-half windows of its own
                        oos[(d.name, pk)][key] = {"n": b_te.n, "realized": b_te.realized, "priced": b_te.priced,
                                                  "pass": bool(b_te.passes), "train_ok": b_tr.n >= MIN_OBS}  # fmt: skip

    sims: dict[tuple[str, str], SimResult] = {}
    sim_list: list[SimResult] = []
    labels = {m: label for m, _, _, label in METHODS} | {CROSS: "v4 1d table, live sigma (1h candles)"}
    for d in DATASETS:
        ob, t0 = obs_all[d.name], split_t[d.name]
        s = simulate_pool("raw model, OOS half", d, ob, None, t_from=t0)
        sims[(d.name, "raw")] = s
        sim_list.append(s)
        for pk in PRICING_KEYS:
            if (d.name, pk) not in priced_oos:
                continue
            s = simulate_pool(f"{labels[pk]}, OOS half", d, ob, priced_oos[(d.name, pk)], t_from=t0)
            sims[(d.name, pk)] = s
            sim_list.append(s)
            sf = simulate_pool(f"{labels[pk]}, in-sample, all", d, ob, priced_full[(d.name, pk)], t_from=None)
            sims[(d.name, pk + ":full")] = sf
            if pk in ("v3", PUBLISHED, CROSS):
                sim_list.append(sf)

    def test_parts(d: str, pk: str) -> list:
        return [(ob, ~train(d, ob), priced_oos[(d, pk)][c]) for c, ob in obs_all[d].items()]

    diag: dict[str, list[dict]] = {}
    for key, _, spec in ROWS:
        if key not in ("old", PUBLISHED):
            continue
        rows = []
        for hz, (d, pk) in spec.items():
            for direction in ("down", "up"):
                for lo, hi in ZGROUPS:
                    rows.append({"horizon": hz, "direction": direction, "lo": lo, "hi": hi}
                                | _z_eval(test_parts(d, pk), lo, hi, direction))  # fmt: skip
        diag[key] = rows
    z_eval = {(d.name, m): {(b.direction, b.lo): _z_eval(test_parts(d.name, m), b.lo, b.hi, b.direction)
                            for b in ztrain[(d.name, m)]}
              for d in DATASETS for m in ("v3", PUBLISHED)}  # fmt: skip

    sigma_ratio = {}
    for coin in coins:
        a, b = obs_all["1d"].get(coin), obs_all["1d-1h"].get(coin)
        if a is None or b is None:
            continue
        sa = dict(zip(a.start_ms.tolist(), a.sigma.tolist(), strict=True))
        sb = dict(zip(b.start_ms.tolist(), b.sigma.tolist(), strict=True))
        sigma_ratio[coin] = np.array([sb[t] / sa[t] for t in sorted(set(sa) & set(sb))])

    ctx = {"buckets": buckets, "zfull": zfull, "ztrain": ztrain, "tables_full": tables_full,
           "tables_tr": tables_tr, "oos": oos, "ins": ins, "sims": sims, "sim_list": sim_list, "diag": diag,
           "z_eval": z_eval, "split_t": split_t, "sigma_ratio": sigma_ratio}  # fmt: skip
    ctx["cross"] = headline(ctx, ("cross", "", {"1d": ("1d-1h", CROSS)}))["1d"]
    first_1d1h = min(int(ob.start_ms.min()) for ob in obs_all["1d-1h"].values() if len(ob))
    ctx["cross_is_oos"] = first_1d1h >= split_t["1d"]
    return ctx


def run(coins: list[str], out_dir: Path = REPORTS_DIR, info_url: str = MAINNET_INFO_URL) -> dict:
    client = InfoClient(info_url)
    now_ms = int(time.time() * 1000)
    out_dir.mkdir(parents=True, exist_ok=True)
    ranges: dict = {}
    windows: dict = {}
    obs_all: dict[str, dict[str, Obs]] = defaultdict(dict)  # data set -> coin -> obs
    for coin in coins:
        print(f"[backtest] fetching {coin} ...", flush=True)
        ser = fetch_series(client, coin, now_ms)
        ranges[coin] = {iv: ser[iv][1] for iv in ser}
        windows[coin] = {}
        for d in DATASETS:
            ob = observations(ser[d.interval][0], d)
            obs_all[d.name][coin] = ob
            windows[coin][d.name] = len(np.unique(ob.start_ms))

    ctx = evaluate(obs_all, coins)
    meta = {"generated_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%MZ"), "coins": coins,
            "ranges": ranges, "windows": windows}  # fmt: skip
    ctx["meta"] = meta
    write_csv(out_dir / "calibration.csv", ctx["buckets"], ctx["oos"], ctx["ins"])
    write_z_csv(
        out_dir / "calibration_z.csv",
        [(f"{d}:{m}", ctx["zfull"][(d, m)], ctx["ztrain"][(d, m)], ctx["z_eval"][(d, m)])
         for d in [*HZ_NAMES, "1d-1h"] for m in (PUBLISHED, "v3")],
    )  # fmt: skip
    with (out_dir / "calibration_z_by_horizon.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["horizon", "direction", "abs_z_lo", "abs_z_hi", "old_n_test", "old_hits_test",
                    "old_priced_test", "old_pass", "n_test", "hits_test", "expected_test", "realized_test",
                    "v4_priced_test", "v4_pass"])  # fmt: skip
        for ro, rn in zip(ctx["diag"]["old"], ctx["diag"][PUBLISHED], strict=True):
            w.writerow([rn["horizon"], rn["direction"], rn["lo"], "inf" if math.isinf(rn["hi"]) else rn["hi"],
                        ro["n"], ro["hits"], _f(ro["priced"]), ro["pass"], rn["n"], rn["hits"],
                        f"{rn['expected']:.4f}", _f(rn["realized"]), _f(rn["priced"]), rn["pass"]])  # fmt: skip
    ctx["tail"] = write_tail_json(out_dir / "tail_multipliers.json",
                                  {hz: ctx["zfull"][(hz, PUBLISHED)] for hz in HZ_NAMES}, meta)  # fmt: skip
    pts = [(b.mean_p, b.realized, HZ_COLORS[b.horizon], "circle" if b.direction == "down" else "square",
            f"{b.coin} {b.horizon} {b.direction} {b.distance:.1%}: {b.hits}/{b.n}")
           for b in ctx["buckets"] if b.horizon in HZ_COLORS and b.n >= MIN_OBS and b.hits]  # fmt: skip
    pts += [(b.mean_p, b.realized, "#000000", "circle" if b.direction == "down" else "square",
             f"{hz} {b.direction} |z| {_zlabel(b.lo, b.hi)}: {b.hits}/{b.n}")
            for hz in HZ_NAMES for b in ctx["zfull"][(hz, PUBLISHED)] if b.n >= MIN_OBS and b.hits]  # fmt: skip
    legend = [*HZ_COLORS.items(), ("z bucket (per horizon, coins pooled)", "#000000")]
    (out_dir / "calibration.svg").write_text(
        reliability_svg(pts, legend, "Predicted vs realized touch frequency (log-log)"), encoding="utf-8"
    )
    write_markdown(out_dir / "calibration.md", ctx)
    print(f"[backtest] wrote {out_dir}", flush=True)
    return ctx


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Calibration backtest of the one-touch model")
    ap.add_argument("--coins", nargs="+", default=["BTC", "ETH", "SOL", "HYPE"])
    ap.add_argument("--out", type=Path, default=REPORTS_DIR)
    args = ap.parse_args(argv)
    ctx = run(args.coins, args.out)
    for row in ROWS:
        label, h = row[1], headline(ctx, row)
        cells = "  ".join(f"{hz} {h[hz]['oos'][0]}/{h[hz]['oos'][1]} LR {h[hz]['lr']:.2f} x{h[hz]['mult']:.2f}"
                          for hz in HZ_NAMES)  # fmt: skip
        print(f"[backtest] {label:<62} IS {h['is'][0]}/{h['is'][1]} OOS(D11) {h['oos_d11'][0]}/{h['oos_d11'][1]} "
              f"OOS(all) {h['oos'][0]}/{h['oos'][1]}  {cells}")  # fmt: skip
    c = ctx["cross"]
    print(f"[backtest] 1d table under live sigma: OOS {c['oos'][0]}/{c['oos'][1]} LR {c['lr']:.2f} "
          f"x{c['mult']:.2f} (windows after the 1d split: {ctx['cross_is_oos']})")  # fmt: skip


if __name__ == "__main__":
    main()
