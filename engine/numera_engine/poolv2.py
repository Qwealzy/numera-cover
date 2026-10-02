"""CoverPool v2 support for the Quote API (ARCHITECTURE §5.3, §5.10, §6 "v2 contract follow-up").

The engine never signs a quote a v2 pool would reject on its floors, allowlist or capacity. This module
holds the pure replicas of the contract's checks (unit- and property-tested against a Python model of the
contract in tests/test_poolv2.py) and the reader that fetches a pool's v2 state in ONE Multicall3
``eth_call`` with a short cache.

Version detection (§6): a pool is v2 when the deployments file says so, or when ``minPremiumBps()``
succeeds on it (the getter does not exist on v1). The probe rides in the same multicall as the state read,
and its answer is cached for the life of the process (a contract's code does not change).
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from . import multicall as mc

BPS = 10_000
LIMITS_TUPLE = "(uint16,uint16,uint64,uint16,uint256,uint16,uint16,uint32,uint16,uint16,uint16)"
DEFAULT_STATE_CACHE_S = 2.0


@dataclass(frozen=True)
class Limits:  # ICoverPool.Limits, field order of §5.2
    maxUtilizationBps: int  # noqa: N815 - contract field names
    perPerpCapBps: int  # noqa: N815
    maxDuration: int  # noqa: N815
    maxSpotDeviationBps: int  # noqa: N815
    minPayout: int  # noqa: N815
    minPremiumBps: int  # noqa: N815
    minLevelDistanceBps: int  # noqa: N815
    saleWindow: int  # noqa: N815
    maxSoldPerWindowBps: int  # noqa: N815
    maxBuyerWindowShareBps: int  # noqa: N815
    maxPaidPerWindowBps: int  # noqa: N815

    @staticmethod
    def from_tuple(t: Any) -> Limits:
        return Limits(*(int(x) for x in t))


@dataclass(frozen=True)
class V2State:
    """What check 2 (allowlist, floor), 3 (level distance), 5 and 6 of buyCover need, for one
    (pool, perp, buyer), read at one block."""

    limits: Limits
    perp_allowed: bool
    capacity_base: int  # B
    locked: int  # lockedAssets
    locked_by_perp: int  # lockedByPerp[perp]
    window_start: int
    window_assets: int
    sold_in_window: int
    buyer_start: int  # buyerWindow[buyer].start
    buyer_sold: int  # buyerWindow[buyer].sold
    paused: bool
    block_ts: int


# -- pure replicas of the contract -------------------------------------------------------------------


def premium_floor(payout: int, min_premium_bps: int) -> int:
    """``Math.ceilDiv(payout × minPremiumBps, 10000)``: the least premium check 2 accepts."""
    return -(-payout * min_premium_bps // BPS)


def raise_to_floor(model_premium: int, payout: int, min_premium_bps: int) -> tuple[int, bool]:
    """(premium to sign, floorApplied): the model premium, raised to the on-chain floor when below it."""
    floor = premium_floor(payout, min_premium_bps)
    return (floor, True) if model_premium < floor else (model_premium, False)


def level_distance_bps(limits: Limits) -> int:
    """Distance (bps of spot) the engine requires between spot S and the level on a v2 pool:
    ``m + d + ceil(m·d / 10000)`` with ``m = minLevelDistanceBps``, ``d = maxSpotDeviationBps`` (56 bps at
    the testnet limits 25 and 30).

    The contract measures ``|px − level| ≥ px × m`` against the oracle price ``px`` at purchase, and ``px``
    may differ from the quoted ``spotRef = S`` by up to ``d``. Write ``px = S(1 + δ)``, ``|δ| ≤ d``. Short
    cover, ``level = S(1 + x)``: ``level − px ≥ px·m`` iff ``x ≥ m + δ(1 + m)``, worst at ``δ = d``:
    ``x ≥ m + d + m·d``. Long cover, ``level = S(1 − x)``: ``x ≥ m − δ(1 − m)``, worst ``m + d − m·d``. So
    ``m + d + m·d`` covers both (``m + d`` alone misses the short side by ``m·d``; the property test in
    tests/test_poolv2.py found it).
    """
    m, d = limits.minLevelDistanceBps, limits.maxSpotDeviationBps
    return m + d + -(-m * d // BPS)


def level_too_close(spot6: int, level6: int, bps: int) -> bool:
    """``|S − level| × 10000 < S × bps`` (integer, as the contract)."""
    return abs(spot6 - level6) * BPS < spot6 * bps


def contract_level_ok(px6: int, level6: int, min_level_distance_bps: int) -> bool:
    """The contract's own check 3 level floor at oracle ``px6`` (for tests and the property)."""
    return abs(px6 - level6) * BPS >= px6 * min_level_distance_bps


@dataclass(frozen=True)
class CapacityRefusal:
    check: str  # "utilization" | "perp_cap" | "sale_window" | "buyer_window"
    after: int
    cap: int

    @property
    def reason(self) -> str:
        what = {
            "utilization": "pool utilization (lockedAssets + payout vs capacityBase x maxUtilizationBps)",
            "perp_cap": "per-perp cap (lockedByPerp + payout vs capacityBase x perPerpCapBps)",
            "sale_window": "sale-window cap (sold in window + payout vs window assets x maxSoldPerWindowBps)",
            "buyer_window": "buyer's share of the sale-window cap (maxBuyerWindowShareBps)",
        }[self.check]
        return f"payout would exceed the on-chain {what}: {self.after} > {self.cap} (USDC 6 dec)"


@dataclass(frozen=True)
class SaleWindow:
    """Check 6 inputs as the contract would compute them at time ``now``."""

    reset: bool
    cap: int  # W × maxSoldPerWindowBps / 10000
    sold: int  # 0 after a reset
    buyer_cap: int  # cap × maxBuyerWindowShareBps / 10000
    buyer_sold: int  # 0 after a reset or for a buyer last seen in an older window
    ends_at: int | None  # windowStart + saleWindow while the window is open, else None (next sale opens one)


def sale_window(s: V2State, now: int) -> SaleWindow:
    """§5.3 check 6, exactly: ``reset = now ≥ windowStart + saleWindow``; ``W = reset ? B : windowAssets``;
    ``cap = W × maxSold / 1e4``; ``sold = reset ? 0 : soldInWindow``; buyer: ``bSold = (reset || bw.start ≠
    windowStart) ? 0 : bw.sold``, ``buyerCap = cap × maxBuyerShare / 1e4`` (on the integer cap)."""
    lim = s.limits
    reset = now >= s.window_start + lim.saleWindow
    cap = (s.capacity_base if reset else s.window_assets) * lim.maxSoldPerWindowBps // BPS
    sold = 0 if reset else s.sold_in_window
    b_sold = 0 if (reset or s.buyer_start != s.window_start) else s.buyer_sold
    buyer_cap = cap * lim.maxBuyerWindowShareBps // BPS
    return SaleWindow(reset, cap, sold, buyer_cap, b_sold, None if reset else s.window_start + lim.saleWindow)


def capacity_refusal(s: V2State, payout: int, now: int, until: int | None = None) -> CapacityRefusal | None:
    """Checks 5 and 6 of buyCover, in the contract's order; None when a sale of ``payout`` passes them at
    every block time in ``[now, until]`` (``until`` defaults to ``now``; the Quote API passes the quote's
    deadline, the last second buyCover can run).

    Check 5 does not depend on the time. Check 6 has two regimes: the open window (``t < windowStart +
    saleWindow``: the window-start snapshot and what was sold in it) and the reset (``t ≥`` that end: a fresh
    cap on the current B, nothing sold). When the window ends inside ``[now, until]`` the sale must pass
    both, because the reset cap on a B that shrank since the window opened can be the smaller one."""
    lim, b = s.limits, s.capacity_base
    after, cap = s.locked + payout, b * lim.maxUtilizationBps // BPS
    if after > cap:
        return CapacityRefusal("utilization", after, cap)
    after, cap = s.locked_by_perp + payout, b * lim.perPerpCapBps // BPS
    if after > cap:
        return CapacityRefusal("perp_cap", after, cap)
    end = s.window_start + lim.saleWindow
    times = [now] if until is None or not now < end <= until else [now, end]
    for t in times:
        w = sale_window(s, t)
        if w.sold + payout > w.cap:
            return CapacityRefusal("sale_window", w.sold + payout, w.cap)
        if w.buyer_sold + payout > w.buyer_cap:
            return CapacityRefusal("buyer_window", w.buyer_sold + payout, w.buyer_cap)
    return None


# -- chain reads -------------------------------------------------------------------------------------


def state_calls(pool: str, perp: int, buyer: str) -> list[mc.Call]:
    """The v2 probe and state for (pool, perp, buyer): one Multicall3 batch (allowFailure on each)."""
    c = mc.call
    return [
        c(pool, "minPremiumBps()", [], [], ["uint16"], "probe"),
        c(pool, "limits()", [], [], [LIMITS_TUPLE], "limits"),
        c(pool, "perpAllowed(uint32)", ["uint32"], [perp], ["bool"], "perpAllowed"),
        c(pool, "capacityBase()", [], [], ["uint256"], "capacityBase"),
        c(pool, "lockedAssets()", [], [], ["uint256"], "locked"),
        c(pool, "lockedByPerp(uint32)", ["uint32"], [perp], ["uint256"], "lockedByPerp"),
        c(pool, "windowStart()", [], [], ["uint64"], "windowStart"),
        c(pool, "windowAssets()", [], [], ["uint256"], "windowAssets"),
        c(pool, "soldInWindow()", [], [], ["uint256"], "soldInWindow"),
        c(pool, "buyerWindow(address)", ["address"], [buyer], ["uint64", "uint192"], "buyerWindow"),
        c(pool, "paused()", [], [], ["bool"], "paused"),
        mc.block_timestamp("ts"),
    ]


def v1_calls(pool: str) -> list[mc.Call]:
    """What a v1 pool's buyCover gates on besides the quote itself: ``paused()`` (whenNotPaused) and the
    public ``minPayout()`` (PayoutTooSmall). One Multicall3 batch."""
    c = mc.call
    return [
        c(pool, "paused()", [], [], ["bool"], "paused"),
        c(pool, "minPayout()", [], [], ["uint256"], "minPayout"),
    ]


@dataclass(frozen=True)
class V1Gate:
    paused: bool
    min_payout: int


class V2ReadError(RuntimeError):
    """A v2 pool's state could not be read (RPC failure or a failed sub-call)."""


def decode_state(out: dict[Any, Any]) -> V2State | None:
    """Multicall results keyed by ``state_calls`` keys -> V2State; None when the probe failed (a v1 pool).
    Raises V2ReadError when the probe succeeded but another read failed."""
    if out.get("probe") is None:
        return None
    missing = [k for k, v in out.items() if v is None]
    if missing:
        raise V2ReadError(f"v2 pool state read failed for {', '.join(map(str, missing))}")
    bw_start, bw_sold = out["buyerWindow"]
    return V2State(
        limits=Limits.from_tuple(out["limits"]),
        perp_allowed=bool(out["perpAllowed"]),
        capacity_base=int(out["capacityBase"]),
        locked=int(out["locked"]),
        locked_by_perp=int(out["lockedByPerp"]),
        window_start=int(out["windowStart"]),
        window_assets=int(out["windowAssets"]),
        sold_in_window=int(out["soldInWindow"]),
        buyer_start=int(bw_start),
        buyer_sold=int(bw_sold),
        paused=bool(out["paused"]),
        block_ts=int(out["ts"]),
    )


class V2StateReader:
    """Per-pool version cache + one-``eth_call`` state reads, cached ``ttl_s`` per (pool, perp, buyer).

    ``read`` returns None for a v1 pool (``read_v1`` then gives its pause flag and minPayout). Versions:
    "v2" from the deployments file (``known``) or a successful probe; "v1" when the probe sub-call failed
    inside a multicall that itself succeeded. An RPC failure caches nothing and raises V2ReadError (the
    caller decides: refuse for a known v2 pool, quote as v1 for an unknown one)."""

    def __init__(self, rpc: Any, known: dict[str, str] | None = None, ttl_s: float = DEFAULT_STATE_CACHE_S,
                 clock: Callable[[], float] = time.monotonic) -> None:  # fmt: skip
        self.rpc, self.ttl_s, self.clock = rpc, ttl_s, clock
        self.versions: dict[str, str] = {k.lower(): v for k, v in (known or {}).items() if v}
        self._hits: dict[tuple[str, int, str], tuple[float, V2State]] = {}
        self._v1_hits: dict[str, tuple[float, V1Gate | None]] = {}
        self._lock = threading.Lock()

    def version(self, pool: str) -> str | None:
        return self.versions.get(pool.lower())

    def read(self, pool: str, perp: int, buyer: str) -> V2State | None:
        p = pool.lower()
        if self.versions.get(p) == "v1":
            return None
        key = (p, perp, buyer.lower())
        now = self.clock()
        with self._lock:
            hit = self._hits.get(key)
            if hit and now - hit[0] < self.ttl_s:
                return hit[1]
        calls = state_calls(pool, perp, buyer)
        try:
            res = mc.aggregate(self.rpc, calls)
        except Exception as exc:  # noqa: BLE001 - RPC down, rate limit, ...
            raise V2ReadError(f"pool state read failed: {exc}") from exc
        out = dict(zip((c.key for c in calls), res, strict=True))
        state = decode_state(out)
        with self._lock:
            if state is None:
                if self.versions.get(p) == "v2":  # listed as v2 but the getter failed: do not quote blind
                    raise V2ReadError(f"pool {pool} is listed as v2 but minPremiumBps() failed")
                self.versions[p] = "v1"
                return None
            self.versions[p] = "v2"
            self._hits[key] = (now, state)
        return state

    def read_v1(self, pool: str) -> V1Gate | None:
        """``paused()`` and ``minPayout()`` of a v1 pool, cached ``ttl_s`` per pool. None when either getter
        failed (not a CoverPool ABI we know); V2ReadError on an RPC failure (nothing cached)."""
        p = pool.lower()
        now = self.clock()
        with self._lock:
            hit = self._v1_hits.get(p)
            if hit and now - hit[0] < self.ttl_s:
                return hit[1]
        calls = v1_calls(pool)
        try:
            paused, min_payout = mc.aggregate(self.rpc, calls)
        except Exception as exc:  # noqa: BLE001 - RPC down, rate limit, ...
            raise V2ReadError(f"pool state read failed: {exc}") from exc
        gate = None if paused is None or min_payout is None else V1Gate(bool(paused), int(min_payout))
        with self._lock:
            self._v1_hits[p] = (now, gate)
        return gate
