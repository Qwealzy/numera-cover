"""One-touch (barrier-hit) probability and premium (docs/how-it-works.md §7).

Model: driftless GBM in price, i.e. dS = sigma S dW, so X_t = ln(S_t/S_0) is Brownian motion with drift
nu = -sigma^2/2 and volatility sigma. For a barrier H and b = ln(H/S):

Down barrier (H < S, b < 0), first-passage of a drifted Brownian motion below b (reflection principle +
Girsanov):
    P(min_{t<=T} X_t <= b) = N((b - nu T)/(s)) + exp(2 nu b / sigma^2) N((b + nu T)/(s)),   s = sigma sqrt(T)
With nu = -sigma^2/2: exp(2 nu b/sigma^2) = exp(-b) = S/H, hence
    p_down = N((b + sigma^2 T/2)/s) + (S/H) N((b - sigma^2 T/2)/s)          (how-it-works §7 step 3)

Up barrier (H > S, b > 0): apply the same result to -X (drift -nu, barrier -b):
    P(max X_t >= b) = N((-b + nu T)/s) + exp(2 nu b / sigma^2) N((-b - nu T)/s)
                    = N((-b - sigma^2 T/2)/s) + (S/H) N((-b + sigma^2 T/2)/s)
Note the mirror is NOT symmetric in distance: with nu < 0 the log-price drifts down, so an up barrier at
+x% is slightly less likely than a down barrier at -x% (in log terms); and a +x% move is a smaller log
move than -x%. Both effects are captured exactly by the formula. Verified against Monte Carlo in
tests/test_pricing.py.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from scipy.special import ndtr

SECONDS_PER_YEAR = 365 * 24 * 3600
THETA = 0.20
P_MAX = 0.5
HORIZONS_S = (3600, 4 * 3600, 24 * 3600, 7 * 24 * 3600)
DISTANCES = (0.01, 0.02, 0.03, 0.05, 0.075, 0.10, 0.15, 0.20)


class QuoteRefusedError(Exception):
    """Quote must be refused. ``code`` is the §6 error code."""

    def __init__(self, code: str, reason: str) -> None:
        super().__init__(f"{code}: {reason}")
        self.code = code
        self.reason = reason


def touch_prob(S: float, H: float, sigma: float, T: float) -> float:
    """Probability that driftless GBM started at S touches H within T years (annualized sigma).

    Direction follows the barrier: H < S is a down barrier, H > S an up barrier, H == S is already touched.
    """
    if S <= 0 or H <= 0:
        raise ValueError("prices must be positive")
    if sigma < 0 or T < 0:
        raise ValueError("sigma and T must be non-negative")
    if H == S:
        return 1.0
    if sigma == 0 or T == 0:
        return 0.0
    s = sigma * math.sqrt(T)
    half = 0.5 * sigma * sigma * T
    b = math.log(H / S)
    if H < S:
        p = ndtr((b + half) / s) + (S / H) * ndtr((b - half) / s)
    else:
        p = ndtr((-b - half) / s) + (S / H) * ndtr((-b + half) / s)
    return float(min(1.0, max(0.0, p)))


def touch_prob_directional(S: float, level: float, sigma: float, T: float, is_long: bool) -> float:
    """§3 direction semantics: isLong covers trigger at oraclePx <= level, short covers at >= level."""
    if (is_long and S <= level) or (not is_long and S >= level):
        return 1.0
    return touch_prob(S, level, sigma, T)


def priced_prob(p: float, k: float = 1.0, q_floor: float = 0.0) -> float:
    """Probability the pool charges for: max(model p x tail multiplier k, empirical tail floor q)."""
    return max(p * k, q_floor)


def premium(
    payout: int,
    p: float,
    k: float = 1.0,
    theta: float = THETA,
    p_max: float = P_MAX,
    fee: int = 0,
    q_floor: float = 0.0,
) -> int:
    """Premium in USDC base units (6 dec), rounded up. §7 step 6 with the empirical floor q (see TailTable):
    premium = payout * min(max(p*k, q), pMax) * (1 + theta) + fee; refuse when max(p*k, q) > pMax.
    With q = 0 this is exactly the docs/how-it-works.md §7 step 6 formula.
    """
    if payout <= 0:
        raise ValueError("payout must be positive")
    if not 0 <= p <= 1:
        raise ValueError("p must be a probability")
    if k < 1:
        raise ValueError("tail multiplier k must be >= 1")
    if not 0 <= q_floor <= 1:
        raise ValueError("q_floor must be a probability")
    pk = priced_prob(p, k, q_floor)
    if pk > p_max:
        raise QuoteRefusedError("prob_too_high", f"priced touch probability {pk:.4f} exceeds pMax {p_max}")
    return int(math.ceil(payout * pk * (1 + theta))) + int(fee)


# -- tail adjustment table -------------------------------------------------------------------------


@dataclass(frozen=True)
class TailAdj:
    k: float  # multiplier on model p, >= 1
    q: float  # empirical floor on the priced probability


@dataclass
class TailTable:
    """Per (coin, direction, horizon, distance) cell: {"k", "q", "n", "hits"} or null (< 30 obs).

    Loaded from engine/reports/tail_multipliers.json (written by the backtest).
    """

    coins: dict[str, dict[str, dict[str, dict[str, dict[str, float] | None]]]]
    horizons_s: tuple[int, ...] = HORIZONS_S
    distances: tuple[float, ...] = DISTANCES
    default: TailAdj = TailAdj(1.0, 0.0)

    @staticmethod
    def load(path: str | Path) -> TailTable:
        blob: dict[str, Any] = json.loads(Path(path).read_text())
        d = blob.get("default", {"k": 1.0, "q": 0.0})
        return TailTable(
            coins=blob["coins"],
            horizons_s=tuple(int(h) for h in blob["horizons_s"]),
            distances=tuple(float(x) for x in blob["distances"]),
            default=TailAdj(float(d["k"]), float(d["q"])),
        )

    def _cell(self, coin: str, direction: str, h: int, d: float) -> TailAdj | None:
        v = self.coins.get(coin, {}).get(direction, {}).get(str(h), {}).get(_dkey(d))
        return None if v is None else TailAdj(float(v["k"]), float(v["q"]))

    def lookup(self, coin: str, is_long: bool, duration_s: float, distance: float) -> TailAdj:
        """Conservative lookup of (k, q) for a quote.

        - horizon: smallest calibrated horizon >= duration (the longest one beyond the grid);
        - k: max of the two bracketing distance cells;
        - q: log-linear interpolation in distance between the bracketing cells (touch frequency falls with
          distance), clamped to the grid ends;
        - coin without cells (not backtested): max k and max q across backtested coins at those cells.
        """
        direction = "down" if is_long else "up"
        h = next((x for x in self.horizons_s if x >= duration_s), self.horizons_s[-1])
        ds = self.distances
        lo = max([x for x in ds if x <= distance + 1e-12], default=ds[0])
        hi = min([x for x in ds if x >= distance - 1e-12], default=ds[-1])
        coins = [coin] if coin in self.coins else list(self.coins)
        best: TailAdj | None = None
        for c in coins:
            a, b = self._cell(c, direction, h, lo), self._cell(c, direction, h, hi)
            if a is None and b is None:
                continue
            a, b = a or b, b or a
            assert a is not None and b is not None
            k = max(a.k, b.k)
            if hi > lo and a is not b and a.q > 0 and b.q > 0:
                w = (distance - lo) / (hi - lo)
                q = math.exp((1 - w) * math.log(a.q) + w * math.log(b.q))
            else:  # on a grid point, beyond the grid, or a zero floor: take the larger (conservative)
                q = max(a.q, b.q)
            cand = TailAdj(max(1.0, k), q)
            best = cand if best is None else TailAdj(max(best.k, cand.k), max(best.q, cand.q))
        return best or TailAdj(max(1.0, self.default.k), self.default.q)

    def k(self, coin: str, is_long: bool, duration_s: float, distance: float) -> float:
        return self.lookup(coin, is_long, duration_s, distance).k

    def adjust(
        self, coin: str, is_long: bool, duration_s: float, S: float, H: float, sigma: float
    ) -> TailAdj:
        return self.lookup(coin, is_long, duration_s, abs(H / S - 1))


def _dkey(d: float) -> str:
    return f"{d:.3f}"


# -- v2: pooled standardized-distance table -------------------------------------------------------

Z_EDGES: tuple[float, ...] = tuple(i * 0.25 for i in range(17)) + (5.0, 7.0, math.inf)


def z_score(S: float, H: float, sigma: float, T: float) -> float:
    """Standardized, direction-signed distance z = ln(H/S) / (sigma sqrt(T)); < 0 for a down level.

    Under the model p depends on z (plus a small drift term in sigma sqrt(T)), so windows with equal z are
    exchangeable across coins and horizons and can be pooled.
    """
    if sigma <= 0 or T <= 0:
        return -math.inf if H < S else math.inf
    return math.log(H / S) / (sigma * math.sqrt(T))


@dataclass
class ZTailTable:
    """k(direction, |z| bucket) and floor q(direction, |z|) pooled over coins and horizons.

    ``cells[direction]`` is a list aligned with the buckets [edges[i], edges[i+1]); each entry is
    {"k", "q", "n", "hits", "mean_p"} or None (< 30 windows). Lookup:
    - k: the bucket containing |z| (empty bucket: nearest populated bucket, nearer-the-money first);
    - q: first made non-increasing in |z| (q_i = max over buckets at or beyond i, conservative), then
      interpolated log-linearly between bucket mid-points and clamped at the ends, so the price is
      continuous in the level and never rises as the level moves further away.
    """

    edges: tuple[float, ...]
    cells: dict[str, list[dict[str, float] | None]]
    default: TailAdj = TailAdj(1.0, 0.0)

    def __post_init__(self) -> None:
        e = self.edges
        self._mids = [
            (e[i] + e[i + 1]) / 2 if math.isfinite(e[i + 1]) else e[i] + 1.0 for i in range(len(e) - 1)
        ]
        self._k: dict[str, list[float]] = {}
        self._logq: dict[str, list[float]] = {}
        for direction, cells in self.cells.items():
            if len(cells) != len(e) - 1:
                raise ValueError("cells do not match edges")
            filled = [_nearest_populated(cells, i) for i in range(len(cells))]
            if all(c is None for c in filled):
                continue
            ks = [max(1.0, float(c["k"])) for c in filled]  # type: ignore[index]
            qs = [float(c["q"]) for c in filled]  # type: ignore[index]
            for i in range(len(qs) - 2, -1, -1):  # non-increasing in |z|
                qs[i] = max(qs[i], qs[i + 1])
            self._k[direction] = ks
            self._logq[direction] = [math.log(max(q, 1e-12)) for q in qs]

    @staticmethod
    def from_blob(blob: dict[str, Any]) -> ZTailTable:
        edges = tuple(math.inf if x is None else float(x) for x in blob["z_edges"])
        d = blob.get("default", {"k": 1.0, "q": 0.0})
        return ZTailTable(
            edges, {k: blob["cells"][k] for k in ("down", "up")}, TailAdj(float(d["k"]), float(d["q"]))
        )

    def kq(self, is_long: bool, zabs: float) -> TailAdj:
        direction = "down" if is_long else "up"
        if direction not in self._k:
            return self.default
        i = max(0, min(len(self._mids) - 1, _bisect_right(self.edges, zabs) - 1))
        mids, lq = self._mids, self._logq[direction]
        if zabs <= mids[0]:
            logq = lq[0]
        elif zabs >= mids[-1]:
            logq = lq[-1]
        else:
            j = _bisect_right(mids, zabs) - 1
            w = (zabs - mids[j]) / (mids[j + 1] - mids[j])
            logq = (1 - w) * lq[j] + w * lq[j + 1]
        return TailAdj(self._k[direction][i], math.exp(logq))

    def kq_many(self, is_long: bool, zabs: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Vectorized ``kq`` (same lookup) for the backtest: arrays (k, q) for an array of |z|."""
        zabs = np.asarray(zabs, dtype=float)
        direction = "down" if is_long else "up"
        if direction not in self._k:
            return np.full(zabs.shape, self.default.k), np.full(zabs.shape, self.default.q)
        i = np.clip(np.searchsorted(np.array(self.edges), zabs, side="right") - 1, 0, len(self._mids) - 1)
        q = np.exp(np.interp(zabs, np.array(self._mids), np.array(self._logq[direction])))
        return np.array(self._k[direction])[i], q

    def adjust(
        self, coin: str, is_long: bool, duration_s: float, S: float, H: float, sigma: float
    ) -> TailAdj:
        return self.kq(is_long, abs(z_score(S, H, sigma, duration_s / SECONDS_PER_YEAR)))


def _nearest_populated(cells: list, i: int) -> dict | None:
    if cells[i] is not None:
        return cells[i]
    for step in range(1, len(cells)):
        for j in (i - step, i + step):  # nearer-the-money first: higher touch frequency, conservative
            if 0 <= j < len(cells) and cells[j] is not None:
                return cells[j]
    return None


def _bisect_right(xs, x: float) -> int:
    lo, hi = 0, len(xs)
    while lo < hi:
        mid = (lo + hi) // 2
        if x < xs[mid]:
            hi = mid
        else:
            lo = mid + 1
    return lo


@dataclass
class HorizonZTable:
    """v3: one ZTailTable per calibrated horizon, each pooled over coins only.

    A quote uses the table of the smallest calibrated horizon >= its duration (the longest beyond the grid).
    """

    horizons_s: tuple[int, ...]
    tables: dict[int, ZTailTable]

    def table_for(self, duration_s: float) -> ZTailTable:
        h = next((x for x in self.horizons_s if x >= duration_s), self.horizons_s[-1])
        return self.tables[h]

    def adjust(
        self, coin: str, is_long: bool, duration_s: float, S: float, H: float, sigma: float
    ) -> TailAdj:
        return self.table_for(duration_s).adjust(coin, is_long, duration_s, S, H, sigma)

    @staticmethod
    def from_blob(blob: dict[str, Any]) -> HorizonZTable:
        tables = {}
        for h, t in blob["tables"].items():
            default = t.get("default") or {"k": 1, "q": 0}
            sub = {"z_edges": blob["z_edges"], "cells": t["cells"], "default": default}
            tables[int(h)] = ZTailTable.from_blob(sub)
        return HorizonZTable(tuple(sorted(tables)), tables)


def load_tail_table(path: str | Path) -> TailTable | ZTailTable | HorizonZTable:
    """Load tail_multipliers.json: per-horizon z tables (v3 / v4: same shape, v4 differs only in
    how thin buckets are fitted), v2 pooled z table, or v1 per-bucket table."""
    blob: dict[str, Any] = json.loads(Path(path).read_text(encoding="utf-8"))
    if blob.get("schema") in ("z-per-horizon-v3", "z-per-horizon-v4"):
        return HorizonZTable.from_blob(blob)
    if blob.get("schema") == "z-pooled-v2":
        return ZTailTable.from_blob(blob)
    return TailTable.load(path)
