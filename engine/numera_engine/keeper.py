"""Keeper: watch CoverPool covers; trigger(id) on breach, expire(id) after expiry (how-it-works §5, §8).

    KEEPER_KEY=0x... python -m numera_engine.keeper                        # all pools in deployments file
    KEEPER_KEY=0x... python -m numera_engine.keeper --pool 0xA --pool 0xB  # chosen pools
    python -m numera_engine.keeper --dry-run --duration 300                # read-only: log, never send

Design: covers are discovered by **state, not logs**. Each poll is one ``eth_call`` to
Multicall3 that reads, for every pool, ``coverCount()`` and ``getCover(id)`` for the ids still active plus
a few ids past the last one seen, the pools' price sources ``oraclePx6(perp)`` (what ``trigger`` itself
checks, so a decision cannot disagree with the contract) and the block timestamp. Final covers
(Paid/Expired) leave the local active set and are never read again. No ``eth_getLogs`` at all.

The decision is a pure function (``decide``) over that active set; the RPC client (``rpc.FailoverRpc``)
rotates through an endpoint list with exponential backoff on ``-32005``. Transactions are sent from
KEEPER_KEY through the same client. Never sends transactions to chainId 999.
"""

from __future__ import annotations

import argparse
import logging
import os
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Any

from . import multicall as mc
from .rpc import FailoverRpc, host, resolve_rpcs  # noqa: F401 - resolve_rpcs re-exported (tests, CLI)

log = logging.getLogger("numera.keeper")

MAINNET_CHAIN_ID = 999
LOOKAHEAD = 2  # ids past the last seen one read every poll: a new cover is found in the same call
BACKFILL_CHUNK = 50  # getCover reads per extra eth_call when more new ids exist than the lookahead
BACKFILL_MAX = 500  # new ids read per poll at most (startup on a busy pool spreads over several polls)
RESEND_AFTER_S = 30.0  # a cover still active this long after our tx is retried (e.g. the tx reverted)


class Status(IntEnum):  # mirrors `enum Status { None, Active, Paid, Expired }`
    NONE = 0
    ACTIVE = 1
    PAID = 2
    EXPIRED = 3


@dataclass(frozen=True)
class Cover:
    id: int
    buyer: str
    perp_index: int
    is_long: bool
    level: int  # px6
    payout: int
    expiry: int  # unix s
    status: Status = Status.ACTIVE


@dataclass(frozen=True)
class Action:
    kind: str  # "trigger" | "expire"
    cover_id: int
    reason: str


# -- pure logic ------------------------------------------------------------------------------------


def is_breached(is_long: bool, level: int, px6: int) -> bool:
    """§3: long cover triggers at oraclePx <= level, short cover at oraclePx >= level."""
    return px6 <= level if is_long else px6 >= level


def decide(covers: Iterable[Cover], prices: Mapping[int, int | None], now: int) -> list[Action]:
    """Actions for the current block time ``now``.

    Contract rules: trigger needs now <= expiry and a breach; expire needs now > expiry. A cover whose price
    is unknown is left alone (never trigger on missing data). Triggers are ordered by payout (largest first)
    so that, with a limited per-block budget, the most valuable claims go first.
    """
    triggers: list[tuple[int, Action]] = []
    expires: list[Action] = []
    for c in covers:
        if c.status != Status.ACTIVE:
            continue
        if now > c.expiry:
            expires.append(Action("expire", c.id, f"now {now} > expiry {c.expiry}"))
            continue
        px = prices.get(c.perp_index)
        if px is None or px <= 0:
            continue
        if is_breached(c.is_long, c.level, px):
            op = "<=" if c.is_long else ">="
            triggers.append((c.payout, Action("trigger", c.id, f"oracle {px} {op} level {c.level}")))
    triggers.sort(key=lambda t: (-t[0], t[1].cover_id))
    return [a for _, a in triggers] + sorted(expires, key=lambda a: a.cover_id)


def cover_from_tuple(cover_id: int, t: Sequence[Any] | None) -> Cover | None:
    """``getCover`` return tuple (buyer, perpIndex, isLong, level, payout, premium, start, expiry, status)."""
    if t is None:
        return None
    buyer, perp, is_long, level, payout, _premium, _start, expiry, status = t
    try:
        st = Status(int(status))
    except ValueError:
        return None
    return Cover(cover_id, str(buyer), int(perp), bool(is_long), int(level), int(payout), int(expiry), st)


@dataclass
class PoolBook:
    """Active-cover set of one pool, rebuilt from ``getCover`` reads (pure bookkeeping, no I/O).

    ``known``: ids 1..known have been read at least once. Final covers are dropped from ``active`` and
    never read again, so steady-state cost is one getCover per live cover plus ``LOOKAHEAD`` probes.
    """

    pool: str
    label: str
    source: str | None = None
    known: int = 0
    count: int = 0
    active: dict[int, Cover] = field(default_factory=dict)

    def ids_to_read(self, lookahead: int = LOOKAHEAD) -> list[int]:
        return sorted(self.active) + list(range(self.known + 1, self.known + 1 + lookahead))

    def apply(self, count: int | None, covers: Mapping[int, Cover | None]) -> list[int]:
        """Fold one round of reads; returns the ids that exist but have not been read yet (backfill).

        A ``None`` entry is a failed read: an active cover keeps its last state and an unread id is read
        again next time. ``count`` None (failed coverCount read) keeps the previous count.
        """
        if count is not None:
            self.count = max(self.count, int(count))
        for cid, c in covers.items():
            if c is None or c.status == Status.NONE:
                continue
            if c.status == Status.ACTIVE:
                self.active[cid] = c
            else:
                self.active.pop(cid, None)
        while self.known < self.count and covers.get(self.known + 1) is not None:
            self.known += 1
        return list(range(self.known + 1, self.count + 1))

    def perps(self) -> set[int]:
        return {c.perp_index for c in self.active.values()}


def due(actions: Iterable[Action], sent: Mapping[int, float], t: float,
        resend_after: float = RESEND_AFTER_S) -> list[Action]:  # fmt: skip
    """Actions not already sent within ``resend_after`` seconds (``sent``: cover id -> send time)."""
    return [a for a in actions if a.cover_id not in sent or t - sent[a.cover_id] >= resend_after]


@dataclass(frozen=True)
class PoolPlan:
    pool: str
    label: str
    price_source: str | None = None  # from the deployments file (only used to cross-check the chain)


def plan_pools(deployment: Any, pools: list[str] | None) -> list[PoolPlan]:
    """Which pools to watch: every pool in the deployment, or the given addresses (labelled if known)."""
    if pools is None:
        if deployment is None or not deployment.pools:
            raise ValueError("no --pool given and no pools in the deployments file")
        pools = [p.pool for p in deployment.pools]
    out = []
    for addr in pools:
        info = deployment.find(addr) if deployment is not None else None
        out.append(
            PoolPlan(addr.lower(), info.name if info else addr.lower(), info.price_source if info else None)
        )
    return out


# -- chain I/O (thin) ------------------------------------------------------------------------------

POOL_ABI: list[dict[str, Any]] = [
    {"type": "function", "name": "trigger", "stateMutability": "nonpayable",
     "inputs": [{"name": "coverId", "type": "uint256"}], "outputs": []},
    {"type": "function", "name": "expire", "stateMutability": "nonpayable",
     "inputs": [{"name": "coverId", "type": "uint256"}], "outputs": []},
]  # fmt: skip


class Sender:
    """Builds, signs and sends trigger/expire from KEEPER_KEY through the failover RPC (web3 for building)."""

    def __init__(self, rpc: FailoverRpc, private_key: str) -> None:
        from eth_account import Account
        from web3 import Web3

        from .rpc import failover_provider

        chain_id = int(rpc.call("eth_chainId"), 16)
        if chain_id == MAINNET_CHAIN_ID:
            raise RuntimeError("keeper refuses to send on chainId 999 (mainnet)")
        self.w3 = Web3(failover_provider(rpc))
        self.account = Account.from_key(private_key)
        self.chain_id = chain_id

    def send(self, pool: str, action: Action) -> str:
        from web3 import Web3

        c = self.w3.eth.contract(address=Web3.to_checksum_address(pool), abi=POOL_ABI)
        fn = getattr(c.functions, action.kind)(action.cover_id)
        tx = fn.build_transaction({
            "from": self.account.address,
            "nonce": self.w3.eth.get_transaction_count(self.account.address, "pending"),
            "chainId": self.chain_id,
        })  # fmt: skip
        signed = self.account.sign_transaction(tx)
        h = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        return "0x" + bytes(h).hex().removeprefix("0x")


class Keeper:
    """Polls every pool with one Multicall3 ``eth_call`` and acts on the decisions."""

    def __init__(
        self,
        rpc: FailoverRpc,
        plans: list[PoolPlan],
        watch_perps: Iterable[int] = (),
        sender: Sender | None = None,
        dry_run: bool = False,
        price_source_override: str | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if sender is None and not dry_run:
            raise ValueError("a Sender is needed unless dry_run")
        self.rpc = rpc
        self.books = [PoolBook(p.pool, p.label) for p in plans]
        self.plans = plans
        self.watch_perps = sorted(set(watch_perps))
        self.sender = sender
        self.dry_run = dry_run
        self.override = price_source_override
        self.clock = clock
        self.sent: dict[str, dict[int, float]] = {b.pool: {} for b in self.books}
        self.chain_id: int | None = None

    # -- startup --------------------------------------------------------------------------------------

    def start(self) -> None:
        """Chain id guard, then every pool's price source in one call."""
        self.chain_id = int(self.rpc.call("eth_chainId"), 16)
        if self.chain_id == MAINNET_CHAIN_ID:
            raise RuntimeError("keeper refuses to run on chainId 999 (mainnet)")
        if self.override:
            if len(self.books) != 1:
                raise ValueError("a price-source override needs exactly one pool")
            self.books[0].source = self.override.lower()
        listed = {p.pool: p.price_source for p in self.plans}
        todo = [b for b in self.books if b.source is None]
        for b, src in zip(todo, mc.aggregate(self.rpc, [mc.price_source(b.pool) for b in todo]), strict=True):
            if src is None:
                raise RuntimeError(f"[{b.label}] cannot read pool.priceSource() at {b.pool}")
            b.source = str(src).lower()
            if listed.get(b.pool) and listed[b.pool] != b.source:
                log.warning("[keeper] %s: on-chain priceSource %s differs from the deployments file %s",
                            b.label, b.source, listed[b.pool])  # fmt: skip
        for b in self.books:
            log.info("[keeper] watching %s pool=%s priceSource=%s", b.label, b.pool, b.source)

    # -- one poll -------------------------------------------------------------------------------------

    def _price_keys(self) -> list[tuple[str, int]]:
        """(source, perp) pairs read every poll: the configured perps plus every active cover's perp."""
        keys: set[tuple[str, int]] = set()
        for b in self.books:
            assert b.source is not None
            keys |= {(b.source, p) for p in set(self.watch_perps) | b.perps()}
        return sorted(keys)

    def read(self) -> tuple[int, dict[str, dict[int, int | None]]]:
        """Refresh every book; returns (block timestamp, prices by source and perp)."""
        calls = [mc.block_timestamp("ts")]
        for i, b in enumerate(self.books):
            calls.append(mc.cover_count(b.pool, ("count", i)))
            calls += [mc.get_cover(b.pool, cid, ("cover", i, cid)) for cid in b.ids_to_read()]
        price_keys = self._price_keys()
        calls += [mc.oracle_px6(s, p, ("px", s, p)) for s, p in price_keys]
        out = dict(zip((c.key for c in calls), mc.aggregate(self.rpc, calls), strict=True))
        if out["ts"] is None:
            raise RuntimeError("Multicall3.getCurrentBlockTimestamp() failed")
        prices: dict[str, dict[int, int | None]] = {}
        for s, p in price_keys:
            prices.setdefault(s, {})[p] = out[("px", s, p)]
        missing: dict[int, list[int]] = {}
        for i, b in enumerate(self.books):
            covers = {k[2]: cover_from_tuple(k[2], v) for k, v in out.items()
                      if isinstance(k, tuple) and k[0] == "cover" and k[1] == i}  # fmt: skip
            missing[i] = b.apply(out[("count", i)], covers)[:BACKFILL_MAX]
        self._backfill(missing, prices)
        return int(out["ts"]), prices

    def _backfill(self, missing: dict[int, list[int]], prices: dict[str, dict[int, int | None]]) -> None:
        """Read new ids beyond the lookahead (startup, or a burst of purchases) in extra calls."""
        todo = [(i, cid) for i, ids in missing.items() for cid in ids]
        for start in range(0, len(todo), BACKFILL_CHUNK):
            chunk = todo[start : start + BACKFILL_CHUNK]
            calls = [mc.get_cover(self.books[i].pool, cid, ("cover", i, cid)) for i, cid in chunk]
            res = dict(zip((c.key for c in calls), mc.aggregate(self.rpc, calls), strict=True))
            for i in {i for i, _ in chunk}:
                covers = {k[2]: cover_from_tuple(k[2], v) for k, v in res.items() if k[1] == i}
                self.books[i].apply(None, covers)
        # prices for perps first seen in the backfill
        new = [(s, p) for s, p in self._price_keys() if p not in prices.get(s, {})]
        if new:
            calls = [mc.oracle_px6(s, p, (s, p)) for s, p in new]
            for (s, p), v in zip(new, mc.aggregate(self.rpc, calls), strict=True):
                prices.setdefault(s, {})[p] = v

    def poll(self) -> list[tuple[str, Action, str]]:
        r0 = self.rpc.requests
        now, prices = self.read()
        t = self.clock()
        done = []
        for b in self.books:
            sent = self.sent[b.pool]
            for cid in [c for c in sent if c not in b.active]:
                del sent[cid]  # final now (or never was): forget
            assert b.source is not None
            for a in due(decide(b.active.values(), prices.get(b.source, {}), now), sent, t):
                sent[a.cover_id] = t
                if self.dry_run:
                    log.info("[keeper] dry-run: would send %s(%s) on %s (%s)", a.kind, a.cover_id, b.label,
                             a.reason)  # fmt: skip
                    done.append((b.label, a, "dry-run"))
                    continue
                assert self.sender is not None
                try:
                    txh = self.sender.send(b.pool, a)
                except Exception as exc:  # noqa: BLE001 - e.g. reverted because the price moved back
                    log.warning("[keeper] %s(%s) on %s failed: %s", a.kind, a.cover_id, b.label, exc)
                    continue
                log.info("[keeper] %s(%s) on %s sent %s (%s)", a.kind, a.cover_id, b.label, txh, a.reason)
                done.append((b.label, a, txh))
        cur = self.rpc.current.url if self.rpc.current else "-"
        log.info("[keeper] poll ok pools=%d active=%d reqs=%d rpm=%d rpc=%s", len(self.books),
                 sum(len(b.active) for b in self.books), self.rpc.requests - r0, self.rpc.per_minute(),
                 host(cur))  # fmt: skip
        return done

    def run(self, poll_s: float = 3.0, duration_s: float = 0.0, sleep: Callable[[float], None] = time.sleep,
            stop: Callable[[], bool] = lambda: False) -> None:  # fmt: skip
        t0 = self.clock()
        try:
            while not stop():
                t = self.clock()
                if duration_s and t - t0 >= duration_s:
                    break
                try:
                    self.poll()
                except Exception as exc:  # noqa: BLE001 - keep watching; the RPC layer already backed off
                    log.warning("[keeper] poll failed: %s", exc)
                sleep(max(0.0, poll_s - (self.clock() - t)))
        except KeyboardInterrupt:
            pass
        self.summary(self.clock() - t0)

    def summary(self, elapsed: float) -> None:
        per = ", ".join(f"{host(e.url)} req={e.requests} rl={e.rate_limits} err={e.errors}"
                        for e in self.rpc.endpoints)  # fmt: skip
        rate = self.rpc.requests / (elapsed / 60) if elapsed > 0 else 0.0
        log.info("[keeper] stopped after %.0fs: requests=%d (%.1f/min) rate_limited=%d [%s]", elapsed,
                 self.rpc.requests, rate, self.rpc.rate_limits, per)  # fmt: skip


def main(argv: list[str] | None = None) -> None:
    from .deployments import default_path
    from .deployments import load as load_deployment

    ap = argparse.ArgumentParser(description="Numera keeper (state polling via Multicall3, RPC failover)")
    ap.add_argument("--deployments", default=str(default_path("testnet")), help="deployments/<env>.json")
    ap.add_argument("--rpc", action="append", default=None,
                    help="RPC URL, repeatable, in priority order (default: NUMERA_RPCS env, comma-separated; "
                         "else the deployments rpc, the official testnet RPC, chain.link)")  # fmt: skip
    ap.add_argument("--pool", action="append", default=None, help="pool address (repeatable; default: all)")
    ap.add_argument("--price-source", default=None, help="override pool.priceSource() (single pool only)")
    ap.add_argument("--poll", type=float, default=3.0, help="seconds between polls (default 3)")
    ap.add_argument("--dry-run", action="store_true", help="read only: log the txs it would send")
    ap.add_argument("--duration", type=float, default=0.0, help="stop after this many seconds (0 = never)")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    key = os.environ.get("KEEPER_KEY", "").strip()
    if not key and not args.dry_run:
        raise SystemExit("set KEEPER_KEY (or pass --dry-run)")
    dep = load_deployment(args.deployments)
    if args.price_source and (args.pool is None or len(args.pool) != 1):
        raise SystemExit("--price-source needs exactly one --pool")
    urls = resolve_rpcs(args.rpc, os.environ.get("NUMERA_RPCS"), dep.rpc if dep else None)
    rpc = FailoverRpc(urls)
    log.info("[keeper] rpcs: %s%s", " > ".join(host(u) for u in urls), " (dry run)" if args.dry_run else "")
    plans = plan_pools(dep, args.pool)
    sender = None if args.dry_run else Sender(rpc, key)
    keeper = Keeper(rpc, plans, watch_perps=dep.perps.values() if dep else (), sender=sender,
                    dry_run=args.dry_run, price_source_override=args.price_source)  # fmt: skip
    keeper.start()
    keeper.run(args.poll, args.duration)


if __name__ == "__main__":
    main()
