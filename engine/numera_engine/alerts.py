"""Keeper alerts for CoverPool v2 pools (ARCHITECTURE §5.10 "Keeper"). Log-only for now (WARNING lines
starting ``[keeper] ALERT``); a notifier can tail them later.

Budget. Everything state-based rides in the keeper's existing per-poll Multicall3 ``eth_call`` (no extra
request): ``paused``, ``limits``, the sale-window and breaker-window state, ``owedAssets``,
``configDelay``/``CONFIG_GRACE`` (until read once) and ``queuedEta(id)`` of the operations being tracked.
Floor-priced sales come from the ``getCover`` tuples the keeper already reads. Only the timelock queue
needs events: ``ConfigQueued`` (and its executed/cancelled pair), ``LossBreakerTripped`` and
``PayoutDeferred`` are fetched by one ``eth_getLogs`` over all v2 pools every ``every_s`` seconds (default
60 s, i.e. +1 request a minute), at most ``LOG_RANGE`` blocks per call (the public testnet RPC caps a range
at 1000 blocks), starting ``lookback`` blocks before the first scan.

Startup catch-up. An op queued before that lookback is still executable (or cancellable) for
``configDelay + CONFIG_GRACE`` seconds after it was queued, so after a restart the keeper would never alert
on it. The first scan therefore also walks back, newest block first, over the ``configDelay +
CONFIG_GRACE`` (read from the pools) before the lookback, at one block a second (HyperEVM small blocks,
docs/research/hyperliquid.md) and never before the oldest pool's deploy block when it is known. It asks for
``ConfigQueued`` only, in ``LOG_RANGE`` chunks, at most ``catchup_per_scan`` requests per poll (the RPC
client's -32005 backoff applies to each) and ``catchup_cap`` requests in all. Each id found is only
*seeded*: the next poll reads its ``queuedEta`` and drops it silently when it is 0 (executed or cancelled).
Once the catch-up is done the budget is back to one ``eth_getLogs`` per ``every_s``.

Alerts (each fires once per occurrence, not per poll):
- ``config_queued``: a ConfigQueued log (kind, eta), or a still-queued op found by the catch-up;
- ``op_ready``: a tracked op whose ``queuedEta ≤ now ≤ eta + CONFIG_GRACE`` (ready but not executed: it can
  still be cancelled, or it goes stale); ``op_stale`` once it is past the grace;
- ``breaker``: the pool turned paused while ``paidInWindow > paidWindowAssets × maxPaidPerWindowBps / 1e4``
  (the LossBreakerTripped condition), or a LossBreakerTripped log mined after the last block at which the
  pool was seen unpaused (the breaker only trips an unpaused pool, so an older log was followed by an
  unpause and is history); deduplicated by tx hash;
- ``sale_cap``: the open sale window has less than one ``minPayout`` of room (``soldInWindow + minPayout >
  cap``), once per window;
- ``floor_sale``: an active cover whose premium equals ``ceil(payout × minPremiumBps / 1e4)``;
- ``payout_deferred``: a PayoutDeferred log, once per coverId. A rise of ``owedAssets`` is logged at INFO
  (its log follows within ``every_s``); it is the alert only when the log scan is off. ``owedAssets > 0`` at
  startup with no PayoutDeferred in the first scan is one alert (the deferral is older than the lookback).
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

CONFIG_GRACE_S = 3 * 86400  # CoverPool.CONFIG_GRACE (§5.5); the pool's own value is read when available
LOG_RANGE = 1000  # blocks per eth_getLogs (testnet RPC cap)
DEFAULT_LOG_EVERY_S = 60.0
DEFAULT_LOOKBACK_BLOCKS = 1000
DEFAULT_BLOCKS_PER_S = 1.0  # HyperEVM small blocks, 1 s (docs/research/hyperliquid.md)
DEFAULT_CATCHUP_CAP = 300  # eth_getLogs in all for the startup catch-up (testnet 600 s + 3 d ~ 260)
DEFAULT_CATCHUP_PER_SCAN = 10  # ... and per poll, so the trigger loop is never held up for long
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


def _queued(data: bytes) -> tuple[str, int]:
    """(kind name, eta) of a ConfigQueued log's data."""
    kind_i, _data, eta = decode(["uint8", "bytes", "uint64"], data)
    return (OP_KINDS[kind_i] if kind_i < len(OP_KINDS) else str(kind_i)), int(eta)


@dataclass
class PoolWatch:
    """Alert state of one v2 pool. ``calls`` adds its reads to the poll; ``update`` folds the results."""

    pool: str  # lower-case address
    label: str
    limits: Limits | None = None
    paused: bool | None = None
    owed: int | None = None
    config_delay: int | None = None  # configDelay(), read once
    config_grace: int | None = None  # CONFIG_GRACE(), read once
    deploy_block: int | None = None  # lower bound for the startup catch-up, when known
    logs_on: bool = True  # False when the log scan is off: owedAssets rises are then the alert
    ops: dict[str, tuple[int, str]] = field(default_factory=dict)  # op id (0x hex) -> (eta, kind)
    _op_alerted: set[tuple[str, str]] = field(default_factory=set)
    _seeded: set[str] = field(default_factory=set)  # ops found by the catch-up, not yet read
    _cap_window: int | None = None  # windowStart of the last sale_cap alert
    _breaker_alerted: bool = False  # reset when the pool is unpaused
    _breaker_txs: set[str] = field(default_factory=set)
    _unpaused_block: int | None = None  # last poll block at which the pool was seen unpaused
    _floor_alerted: set[int] = field(default_factory=set)
    _deferred_alerted: set[int] = field(default_factory=set)  # coverIds

    @property
    def catchup_s(self) -> int:
        """Seconds a queued op stays actionable: ``configDelay + CONFIG_GRACE`` (the constant when unread)."""
        return (self.config_delay or 0) + (self.config_grace or CONFIG_GRACE_S)

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
        if self.config_delay is None or self.config_grace is None:
            out.append(c(p, "configDelay()", [], [], ["uint64"], (*k, "configDelay")))
            out.append(c(p, "CONFIG_GRACE()", [], [], ["uint64"], (*k, "CONFIG_GRACE")))
        for op in sorted(self.ops):
            arg = [bytes.fromhex(op[2:])]
            out.append(c(p, "queuedEta(bytes32)", ["bytes32"], arg, ["uint64"], (*k, "eta", op)))
        return out

    def update(self, out: dict[Any, Any], ts: int, block: int | None = None) -> list[Alert]:
        """Fold this poll's reads (keys from ``calls``) at block time ``ts`` and block number ``block``;
        returns the new alerts."""
        k = ("v2", self.pool)
        g = lambda name: out.get((*k, name))  # noqa: E731
        alerts: list[Alert] = []
        if g("limits") is not None:
            self.limits = Limits.from_tuple(g("limits"))
        if g("configDelay") is not None:
            self.config_delay = int(g("configDelay"))
        if g("CONFIG_GRACE") is not None:
            self.config_grace = int(g("CONFIG_GRACE"))
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
                if block is not None:
                    self._unpaused_block = int(block)
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
            if self.owed is not None and owed > self.owed:
                msg = f"owedAssets rose to {_usdc(owed)} USDC (payout transfer failed; buyer can claimPayout)"
                if self.logs_on:  # the PayoutDeferred log names the cover: that is the alert
                    log.info("[keeper] %s: %s", self.label, msg)
                else:
                    alerts.append(Alert("payout_deferred", self.label, msg))
            elif self.owed is None and owed > 0 and not self.logs_on:
                msg = f"owedAssets is {_usdc(owed)} USDC at startup (deferred payouts; claimPayout)"
                alerts.append(Alert("payout_deferred", self.label, msg))
            self.owed = owed
        grace = self.config_grace or CONFIG_GRACE_S
        for op in list(self.ops):
            eta = out.get((*k, "eta", op))
            if eta is None:
                continue
            seeded = op in self._seeded
            self._seeded.discard(op)
            if int(eta) == 0:  # executed or cancelled
                self.ops.pop(op)
                continue
            kind = self.ops[op][1]
            self.ops[op] = (int(eta), kind)
            eta, stale_at = int(eta), int(eta) + grace
            if eta <= ts <= stale_at and (op, "ready") not in self._op_alerted:
                self._op_alerted.add((op, "ready"))
                msg = f"queued {kind} op {op} executable since {eta}, not executed (stale at {stale_at})"
                alerts.append(Alert("op_ready", self.label, msg))
            elif ts > stale_at and (op, "stale") not in self._op_alerted:
                self._op_alerted.add((op, "stale"))
                msg = f"queued {kind} op {op} is stale (eta {eta}); cancel it before re-queueing"
                alerts.append(Alert("op_stale", self.label, msg))
            elif seeded and ts < eta:
                msg = f"{kind} op {op} is queued, executable at {eta} (found by the startup catch-up)"
                alerts.append(Alert("config_queued", self.label, msg))
        return alerts

    def startup_owed(self) -> list[Alert]:
        """After the first log scan: ``owedAssets > 0`` that no PayoutDeferred in it explains."""
        if self.logs_on and self.owed and not self._deferred_alerted:
            msg = (f"owedAssets is {_usdc(self.owed)} USDC at startup, deferred before the scanned blocks "
                   "(buyers can claimPayout)")
            return [Alert("payout_deferred", self.label, msg)]
        return []

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

    def seed_op(self, op: str, data: bytes) -> None:
        """A ConfigQueued found by the startup catch-up: track it silently until its queuedEta is read."""
        op = op.lower()
        if op not in self.ops:
            kind, eta = _queued(data)
            self.ops[op] = (eta, kind)
            self._seeded.add(op)

    def on_log(self, t0: str, topics: list[str], data: bytes, block: int | None = None,
               tx: str | None = None) -> list[Alert]:  # fmt: skip
        if t0 == T_QUEUED:
            op = topics[1].lower()
            kind, eta = _queued(data)
            self.ops[op] = (eta, kind)
            self._seeded.discard(op)
            return [Alert("config_queued", self.label, f"ConfigQueued {kind} op {op}, executable at {eta}")]
        if t0 in (T_EXECUTED, T_CANCELLED):
            op = topics[1].lower()
            self.ops.pop(op, None)
            self._seeded.discard(op)
            log.info("[keeper] %s: op %s %s", self.label, op, "executed" if t0 == T_EXECUTED else "cancelled")
            return []
        if t0 == T_BREAKER:
            paid, cap = decode(["uint256", "uint256"], data)
            if tx is not None:
                if tx.lower() in self._breaker_txs:
                    return []
                self._breaker_txs.add(tx.lower())
            if block is not None and self._unpaused_block is not None and block <= self._unpaused_block:
                log.info("[keeper] %s: LossBreakerTripped at block %d is history (unpaused at %d)",
                         self.label, block, self._unpaused_block)  # fmt: skip
                return []
            if self._breaker_alerted:
                return []
            self._breaker_alerted = True
            msg = f"LossBreakerTripped: paid {_usdc(paid)} > cap {_usdc(cap)} USDC; paused (owner unpauses)"
            return [Alert("breaker", self.label, msg)]
        if t0 == T_DEFERRED:
            (amount,) = decode(["uint256"], data)
            cover_id, buyer = int(topics[1], 16), "0x" + topics[2][-40:]
            if cover_id in self._deferred_alerted:
                return []
            self._deferred_alerted.add(cover_id)
            msg = f"PayoutDeferred cover {cover_id}: {_usdc(amount)} USDC owed to {buyer} (claimPayout)"
            return [Alert("payout_deferred", self.label, msg)]
        return []


@dataclass
class LogScanner:
    """One ``eth_getLogs`` per ``every_s`` over the v2 pools, ≤ ``LOG_RANGE`` blocks per call, resuming from
    the last scanned block (a failure is retried at the next interval, nothing is skipped), plus the startup
    catch-up of ``ConfigQueued`` logs (module docstring), which runs on every poll until it is done."""

    rpc: Any
    watches: dict[str, PoolWatch]  # pool address -> watch
    every_s: float = DEFAULT_LOG_EVERY_S
    lookback: int = DEFAULT_LOOKBACK_BLOCKS
    clock: Callable[[], float] | None = None
    next_block: int | None = None
    catchup_cap: int = DEFAULT_CATCHUP_CAP
    catchup_per_scan: int = DEFAULT_CATCHUP_PER_SCAN
    blocks_per_s: float = DEFAULT_BLOCKS_PER_S
    catchup_requests: int = 0
    catchup_range: tuple[int, int] | None = None  # (oldest, newest) block of the catch-up, once planned
    _catchup: tuple[int, int] | None = None  # (oldest, next newest) still to scan
    _first_done: bool = False
    _last: float | None = None

    def due(self, t: float) -> bool:
        if self.every_s <= 0 or not self.watches:
            return False
        return self._last is None or t - self._last >= self.every_s or self._catchup is not None

    def scan(self, latest: int, t: float) -> list[Alert]:
        alerts: list[Alert] = []
        if self._last is None or t - self._last >= self.every_s:
            alerts += self._forward(latest, t)
        if self._catchup is not None:
            self._catch_up()
        return alerts

    def _get_logs(self, frm: int, to: int, topics: list[str]) -> list[dict[str, Any]]:
        return self.rpc.call("eth_getLogs", [{
            "fromBlock": hex(frm), "toBlock": hex(to), "address": sorted(self.watches), "topics": [topics],
        }]) or []  # fmt: skip

    def _forward(self, latest: int, t: float) -> list[Alert]:
        self._last = t
        if self.next_block is None:
            self.next_block = max(0, latest - self.lookback + 1)
            self._plan_catchup(latest)
        if self.next_block > latest:
            return []
        to = min(latest, self.next_block + LOG_RANGE - 1)
        try:
            logs = self._get_logs(self.next_block, to, ALERT_TOPICS)
        except Exception as exc:  # noqa: BLE001 - alerts are best-effort; the trigger loop goes on
            log.warning("[keeper] alert log scan %d-%d failed: %s", self.next_block, to, exc)
            return []
        alerts: list[Alert] = []
        for lg in logs:
            w = self.watches.get(str(lg.get("address", "")).lower())
            tps = [str(x).lower() for x in lg.get("topics") or []]
            if w is None or not tps:
                continue
            raw = bytes.fromhex(str(lg.get("data", "0x"))[2:])
            bn = lg.get("blockNumber")
            alerts += w.on_log(tps[0], tps, raw, int(bn, 16) if bn else None, lg.get("transactionHash"))
        self.next_block = to + 1
        if not self._first_done:
            self._first_done = True
            for w in self.watches.values():
                alerts += w.startup_owed()
        return alerts

    def _plan_catchup(self, latest: int) -> None:
        newest = self.next_block - 1 if self.next_block is not None else latest
        span = max(w.catchup_s for w in self.watches.values())
        oldest = max(0, latest - int(span * self.blocks_per_s) + 1)
        deploys = [w.deploy_block for w in self.watches.values()]
        if deploys and all(d is not None for d in deploys):
            oldest = max(oldest, min(d for d in deploys if d is not None))
        if self.catchup_cap <= 0 or oldest > newest:
            return
        self.catchup_range = (oldest, newest)
        self._catchup = (oldest, newest)
        log.info("[keeper] alert catch-up: ConfigQueued over blocks %d-%d (%d s of configDelay + "
                 "CONFIG_GRACE, <= %d eth_getLogs, %d per poll)", oldest, newest, span, self.catchup_cap,
                 self.catchup_per_scan)  # fmt: skip

    def _catch_up(self) -> None:
        assert self._catchup is not None
        oldest, hi = self._catchup
        n = 0
        while hi >= oldest and n < self.catchup_per_scan and self.catchup_requests < self.catchup_cap:
            frm = max(oldest, hi - LOG_RANGE + 1)
            n += 1
            self.catchup_requests += 1
            try:
                logs = self._get_logs(frm, hi, [T_QUEUED])
            except Exception as exc:  # noqa: BLE001 - retried from the same block at the next poll
                log.warning("[keeper] alert catch-up %d-%d failed: %s", frm, hi, exc)
                break
            for lg in logs:
                w = self.watches.get(str(lg.get("address", "")).lower())
                tps = [str(x).lower() for x in lg.get("topics") or []]
                if w is not None and len(tps) > 1 and tps[0] == T_QUEUED:
                    w.seed_op(tps[1], bytes.fromhex(str(lg.get("data", "0x"))[2:]))
            hi = frm - 1
        if hi < oldest:
            self._catchup = None
            log.info("[keeper] alert catch-up done: %d eth_getLogs, %d op(s) seeded", self.catchup_requests,
                     sum(len(w._seeded) for w in self.watches.values()))  # fmt: skip
        elif self.catchup_requests >= self.catchup_cap:
            self._catchup = None
            log.warning("[keeper] alert catch-up stopped at its cap of %d eth_getLogs: blocks %d-%d not "
                        "scanned for queued ops", self.catchup_cap, oldest, hi)  # fmt: skip
        else:
            self._catchup = (oldest, hi)
