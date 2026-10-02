"""Keeper alerts for CoverPool v2 pools (ARCHITECTURE §5.10 "Keeper"). Log-only for now (WARNING lines
starting ``[keeper] ALERT``); a notifier can tail them later.

Budget. Everything state-based rides in the keeper's existing per-poll Multicall3 ``eth_call`` (no extra
request): ``paused``, ``limits``, the sale-window and breaker-window state, ``owedAssets`` and
``queuedEta(id)`` of the operations being tracked. Floor-priced sales come from the ``getCover`` tuples the
keeper already reads. Only the timelock queue needs events: ``ConfigQueued`` (and its executed/cancelled
pair), ``LossBreakerTripped`` and ``PayoutDeferred`` are fetched by one ``eth_getLogs`` over all v2 pools
every ``every_s`` seconds (default 60 s, i.e. +1 request a minute), at most ``LOG_RANGE`` blocks per call
(the public testnet RPC caps a range at 1000 blocks), starting ``lookback`` blocks before the first scan.

Alerts (each fires once per occurrence, not per poll):
- ``config_queued``: a ConfigQueued log (kind, eta);
- ``op_ready``: a tracked op whose ``queuedEta ≤ now ≤ eta + CONFIG_GRACE`` (ready but not executed: it can
  still be cancelled, or it goes stale); ``op_stale`` once it is past the grace;
- ``breaker``: the pool turned paused while ``paidInWindow > paidWindowAssets × maxPaidPerWindowBps / 1e4``
  (the LossBreakerTripped condition), or a LossBreakerTripped log;
- ``sale_cap``: the open sale window has less than one ``minPayout`` of room (``soldInWindow + minPayout >
  cap``), once per window;
- ``floor_sale``: an active cover whose premium equals ``ceil(payout × minPremiumBps / 1e4)``;
- ``payout_deferred``: ``owedAssets`` rose (or is above 0 at startup), or a PayoutDeferred log.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Any

from eth_abi import decode
from eth_utils import keccak

from . import multicall as mc
from .poolv2 import BPS, LIMITS_TUPLE, Limits, premium_floor

log = logging.getLogger("numera.keeper")

CONFIG_GRACE_S = 3 * 86400  # CoverPool.CONFIG_GRACE (§5.5)
LOG_RANGE = 1000  # blocks per eth_getLogs (testnet RPC cap)
DEFAULT_LOG_EVERY_S = 60.0
DEFAULT_LOOKBACK_BLOCKS = 1000
OP_KINDS = ("QuoteSigner", "Limits", "PerpAllowed", "Guardian")  # enum OpKind


def topic(signature: str) -> str:
    return "0x" + keccak(text=signature).hex()


T_QUEUED = topic("ConfigQueued(bytes32,uint8,bytes,uint64)")
T_EXECUTED = topic("ConfigExecuted(bytes32)")
T_CANCELLED = topic("ConfigCancelled(bytes32)")
T_BREAKER = topic("LossBreakerTripped(uint256,uint256)")
T_DEFERRED = topic("PayoutDeferred(uint256,address,uint256)")
ALERT_TOPICS = [T_QUEUED, T_EXECUTED, T_CANCELLED, T_BREAKER, T_DEFERRED]


@dataclass(frozen=True)
class Alert:
    kind: str
    pool: str  # label
    message: str


def emit(alerts: Iterable[Alert]) -> list[Alert]:
    out = list(alerts)
    for a in out:
        log.warning("[keeper] ALERT %s %s: %s", a.kind, a.pool, a.message)
    return out


def _usdc(x: int) -> str:
    return f"{x / 1e6:,.6f}"


@dataclass
class PoolWatch:
    """Alert state of one v2 pool. ``calls`` adds its reads to the poll; ``update`` folds the results."""

    pool: str  # lower-case address
    label: str
    limits: Limits | None = None
    paused: bool | None = None
    owed: int | None = None
    ops: dict[str, tuple[int, str]] = field(default_factory=dict)  # op id (0x hex) -> (eta, kind)
    _op_alerted: set[tuple[str, str]] = field(default_factory=set)
    _cap_window: int | None = None  # windowStart of the last sale_cap alert
    _breaker_alerted: bool = False  # reset when the pool is unpaused
    _floor_alerted: set[int] = field(default_factory=set)

    def calls(self) -> list[mc.Call]:
        c, p = mc.call, self.pool
        k = ("v2", p)
        out = [
            c(p, "limits()", [], [], [LIMITS_TUPLE], (*k, "limits")),
            c(p, "paused()", [], [], ["bool"], (*k, "paused")),
            c(p, "windowStart()", [], [], ["uint64"], (*k, "windowStart")),
            c(p, "windowAssets()", [], [], ["uint256"], (*k, "windowAssets")),
            c(p, "soldInWindow()", [], [], ["uint256"], (*k, "soldInWindow")),
            c(p, "paidWindowStart()", [], [], ["uint64"], (*k, "paidWindowStart")),
            c(p, "paidWindowAssets()", [], [], ["uint256"], (*k, "paidWindowAssets")),
            c(p, "paidInWindow()", [], [], ["uint256"], (*k, "paidInWindow")),
            c(p, "owedAssets()", [], [], ["uint256"], (*k, "owedAssets")),
        ]
        for op in sorted(self.ops):
            arg = [bytes.fromhex(op[2:])]
            out.append(c(p, "queuedEta(bytes32)", ["bytes32"], arg, ["uint64"], (*k, "eta", op)))
        return out

    def update(self, out: dict[Any, Any], ts: int) -> list[Alert]:
        """Fold this poll's reads (keys from ``calls``) at block time ``ts``; returns the new alerts."""
        k = ("v2", self.pool)
        g = lambda name: out.get((*k, name))  # noqa: E731
        alerts: list[Alert] = []
        if g("limits") is not None:
            self.limits = Limits.from_tuple(g("limits"))
        lim = self.limits
        paused, owed = g("paused"), g("owedAssets")
        pws, pwa, piw = g("paidWindowStart"), g("paidWindowAssets"), g("paidInWindow")
        if paused is not None:
            breaker_state = lim is not None and None not in (pws, pwa, piw) and bool(pws)
            if paused and not self.paused and breaker_state:
                cap = int(pwa) * lim.maxPaidPerWindowBps // BPS
                if int(piw) > cap and not self._breaker_alerted:
                    self._breaker_alerted = True
                    msg = (f"pool paused by the payout breaker (LossBreakerTripped): paid {_usdc(int(piw))} "
                           ">"
                           f" cap {_usdc(cap)} USDC in the window from {int(pws)}")
                    alerts.append(Alert("breaker", self.label, msg))
            if not paused:
                self._breaker_alerted = False
            if paused and self.paused is False and not self._breaker_alerted:
                log.info("[keeper] %s: pool paused (owner or guardian)", self.label)
            self.paused = bool(paused)
        ws, wa, sold = g("windowStart"), g("windowAssets"), g("soldInWindow")
        window_open = lim is not None and None not in (ws, wa, sold) and ts < int(ws) + lim.saleWindow
        if window_open and int(ws) != self._cap_window:
            cap = int(wa) * lim.maxSoldPerWindowBps // BPS
            if int(sold) + lim.minPayout > cap:
                self._cap_window = int(ws)
                msg = (f"sale window cap reached: sold {_usdc(int(sold))} of {_usdc(cap)} USDC; the window "
                       f"resets at {int(ws) + lim.saleWindow}")
                alerts.append(Alert("sale_cap", self.label, msg))
        if owed is not None:
            owed = int(owed)
            if owed > (self.owed if self.owed is not None else 0):
                msg = f"owedAssets rose to {_usdc(owed)} USDC (payout transfer failed; buyer can claimPayout)"
                alerts.append(Alert("payout_deferred", self.label, msg))
            self.owed = owed
        for op in list(self.ops):
            eta = out.get((*k, "eta", op))
            if eta is None:
                continue
            if int(eta) == 0:  # executed or cancelled
                self.ops.pop(op)
                continue
            kind = self.ops[op][1]
            self.ops[op] = (int(eta), kind)
            eta, stale_at = int(eta), int(eta) + CONFIG_GRACE_S
            if eta <= ts <= stale_at and (op, "ready") not in self._op_alerted:
                self._op_alerted.add((op, "ready"))
                msg = f"queued {kind} op {op} executable since {eta}, not executed (stale at {stale_at})"
                alerts.append(Alert("op_ready", self.label, msg))
            elif ts > stale_at and (op, "stale") not in self._op_alerted:
                self._op_alerted.add((op, "stale"))
                msg = f"queued {kind} op {op} is stale (eta {eta}); cancel it before re-queueing"
                alerts.append(Alert("op_stale", self.label, msg))
        return alerts

    def check_cover(self, cover_id: int, payout: int, premium: int, active: bool) -> list[Alert]:
        """A cover read for the first time: alert when it was sold at the premium floor."""
        if not active or self.limits is None or cover_id in self._floor_alerted:
            return []
        if premium == premium_floor(payout, self.limits.minPremiumBps):
            self._floor_alerted.add(cover_id)
            return [Alert("floor_sale", self.label, f"cover {cover_id} sold at the premium floor: premium "
                          f"{_usdc(premium)} for payout {_usdc(payout)} USDC "
                          f"({self.limits.minPremiumBps} bps)")]  # fmt: skip
        return []

    def on_log(self, t0: str, topics: list[str], data: bytes) -> list[Alert]:
        if t0 == T_QUEUED:
            op = topics[1].lower()
            kind_i, _data, eta = decode(["uint8", "bytes", "uint64"], data)
            kind = OP_KINDS[kind_i] if kind_i < len(OP_KINDS) else str(kind_i)
            self.ops[op] = (int(eta), kind)
            return [Alert("config_queued", self.label, f"ConfigQueued {kind} op {op}, executable at {eta}")]
        if t0 in (T_EXECUTED, T_CANCELLED):
            op = topics[1].lower()
            self.ops.pop(op, None)
            log.info("[keeper] %s: op %s %s", self.label, op, "executed" if t0 == T_EXECUTED else "cancelled")
            return []
        if t0 == T_BREAKER:
            paid, cap = decode(["uint256", "uint256"], data)
            if self._breaker_alerted:
                return []
            self._breaker_alerted = True
            msg = f"LossBreakerTripped: paid {_usdc(paid)} > cap {_usdc(cap)} USDC; paused (owner unpauses)"
            return [Alert("breaker", self.label, msg)]
        if t0 == T_DEFERRED:
            (amount,) = decode(["uint256"], data)
            cover_id, buyer = int(topics[1], 16), "0x" + topics[2][-40:]
            msg = f"PayoutDeferred cover {cover_id}: {_usdc(amount)} USDC owed to {buyer} (claimPayout)"
            return [Alert("payout_deferred", self.label, msg)]
        return []


@dataclass
class LogScanner:
    """One ``eth_getLogs`` per ``every_s`` over the v2 pools, ≤ ``LOG_RANGE`` blocks per call, resuming from
    the last scanned block (a failure is retried at the next interval, nothing is skipped)."""

    rpc: Any
    watches: dict[str, PoolWatch]  # pool address -> watch
    every_s: float = DEFAULT_LOG_EVERY_S
    lookback: int = DEFAULT_LOOKBACK_BLOCKS
    clock: Callable[[], float] | None = None
    next_block: int | None = None
    _last: float | None = None

    def due(self, t: float) -> bool:
        if self.every_s <= 0 or not self.watches:
            return False
        return self._last is None or t - self._last >= self.every_s

    def scan(self, latest: int, t: float) -> list[Alert]:
        self._last = t
        if self.next_block is None:
            self.next_block = max(0, latest - self.lookback + 1)
        if self.next_block > latest:
            return []
        to = min(latest, self.next_block + LOG_RANGE - 1)
        try:
            logs = self.rpc.call("eth_getLogs", [{
                "fromBlock": hex(self.next_block), "toBlock": hex(to),
                "address": sorted(self.watches), "topics": [ALERT_TOPICS],
            }])  # fmt: skip
        except Exception as exc:  # noqa: BLE001 - alerts are best-effort; the trigger loop goes on
            log.warning("[keeper] alert log scan %d-%d failed: %s", self.next_block, to, exc)
            return []
        alerts: list[Alert] = []
        for lg in logs or []:
            w = self.watches.get(str(lg.get("address", "")).lower())
            tps = [str(x).lower() for x in lg.get("topics") or []]
            if w is None or not tps:
                continue
            raw = bytes.fromhex(str(lg.get("data", "0x"))[2:])
            alerts += w.on_log(tps[0], tps, raw)
        self.next_block = to + 1
        return alerts
