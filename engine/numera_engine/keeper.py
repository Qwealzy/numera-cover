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

Tx hygiene (audit L4): EIP-1559 fees under a maxFeePerGas ceiling (``--max-fee-gwei``), at most
``--max-tx-per-poll`` txs per poll (triggers first), a resend after 30 s replaces our still-pending tx on the
same nonce with bumped fees (RBF) instead of queueing behind it, and the keeper's HYPE balance is logged at
startup and every ``--balance-every`` seconds, with a WARNING below ``--min-balance``.

CoverPool v2 pools (ARCHITECTURE §5.10): the trigger/expire loop is unchanged. A pool is v2 when the
deployments file says so or ``minPremiumBps()`` answers at startup; for those the keeper logs ``ALERT``
lines (alerts.py): breaker tripped, sale cap reached, floor-priced sale, deferred payout, queued and
ready-but-unexecuted config ops. The state reads ride in the same per-poll multicall; the timelock events
cost one ``eth_getLogs`` per ``--alert-logs-every`` seconds (0 disables the log scan), after a bounded
startup catch-up of ``ConfigQueued`` logs over ``configDelay + CONFIG_GRACE`` (alerts.py docstring).
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
from .alerts import DEFAULT_LOG_EVERY_S, DEFAULT_LOOKBACK_BLOCKS, LogScanner, PoolWatch, emit
from .rpc import FailoverRpc, host, resolve_rpcs  # noqa: F401 - resolve_rpcs re-exported (tests, CLI)

log = logging.getLogger("numera.keeper")

MAINNET_CHAIN_ID = 999
LOOKAHEAD = 2  # ids past the last seen one read every poll: a new cover is found in the same call
BACKFILL_CHUNK = 50  # getCover reads per extra eth_call when more new ids exist than the lookahead
BACKFILL_MAX = 500  # new ids read per poll at most (startup on a busy pool spreads over several polls)
RESEND_AFTER_S = 30.0  # a cover still active this long after our tx is retried (e.g. the tx reverted)
GWEI = 10**9
WEI_PER_HYPE = 10**18
# maxFeePerGas ceiling (audit L4). Testnet base fee is 0.1 gwei (2026-10-02); 10 gwei is 100x that, and a
# trigger (~60k gas) then costs at most ~0.0006 HYPE. Above the ceiling the keeper waits rather than overpays.
DEFAULT_MAX_FEE_GWEI = 10.0
DEFAULT_MAX_TX_PER_POLL = 5  # txs sent per poll at most (triggers first); the rest go next poll
DEFAULT_MIN_BALANCE_HYPE = 0.01  # warn below this keeper balance (~16 triggers at the fee ceiling)
DEFAULT_BALANCE_EVERY_S = 600.0  # balance re-checked this often (and at startup)


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
    premium: int = 0


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
    buyer, perp, is_long, level, payout, premium, _start, expiry, status = t
    try:
        st = Status(int(status))
    except ValueError:
        return None
    return Cover(cover_id, str(buyer), int(perp), bool(is_long), int(level), int(payout), int(expiry), st,
                 int(premium))  # fmt: skip


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
class SentTx:
    hash: str
    nonce: int
    max_fee: int  # wei per gas
    tip: int  # maxPriorityFeePerGas, wei per gas


class GasCapError(RuntimeError):
    """The fee needed now (or for a replacement) is above the configured maxFeePerGas ceiling."""


def bump(x: int) -> int:
    """+12.5 % and +1 wei: above the 10 % minimum nodes require to replace a pending tx (also from 0)."""
    return x + x // 8 + 1


def choose_nonce(latest: int, pending: int, prev: SentTx | None) -> int:
    """Reuse our previous tx's nonce (replace-by-fee) only while that tx is really pending in the node:
    ``latest <= prev.nonce < pending``. Otherwise ``pending``: the tx was mined (e.g. reverted), or it was
    dropped together with a lower nonce, and reusing its nonce would sit behind a gap forever."""
    if prev is not None and latest <= prev.nonce < pending:
        return prev.nonce
    return pending


def choose_fees(base_fee: int, tip: int, cap: int, prev: SentTx | None = None) -> tuple[int, int]:
    """(maxFeePerGas, maxPriorityFeePerGas) under the ceiling ``cap``.

    Fresh tx: 2 x base fee + tip (headroom for base fee rises), clipped to ``cap``. Replacement: at least
    ``bump`` of the previous fees. Raises GasCapError when the base fee itself, or a replacement's required
    bump, is above the cap: better to wait a poll than overpay or send an underpriced replacement."""
    if base_fee > cap:
        raise GasCapError(f"base fee {base_fee} wei above the cap {cap} wei")
    max_fee = 2 * base_fee + tip
    if prev is not None:
        max_fee, tip = max(max_fee, bump(prev.max_fee)), max(tip, bump(prev.tip))
        if max_fee > cap:
            raise GasCapError(f"replacement needs maxFeePerGas {max_fee} wei, above the cap {cap} wei")
    max_fee = min(max_fee, cap)
    return max_fee, min(tip, max_fee)


@dataclass(frozen=True)
class PoolPlan:
    pool: str
    label: str
    price_source: str | None = None  # from the deployments file (only used to cross-check the chain)
    version: str | None = None  # "v2" from the deployments file; None = probe at startup
    deploy_tx: str | None = None  # pool creation tx (deployments file): bounds the v2 alert catch-up


def plan_pools(deployment: Any, pools: list[str] | None) -> list[PoolPlan]:
    """Which pools to watch: every pool in the deployment, or the given addresses (labelled if known)."""
    if pools is None:
        if deployment is None or not deployment.pools:
            raise ValueError("no --pool given and no pools in the deployments file")
        pools = [p.pool for p in deployment.pools]
    out = []
    for addr in pools:
        info = deployment.find(addr) if deployment is not None else None
        out.append(PoolPlan(addr.lower(), info.name if info else addr.lower(),
                            info.price_source if info else None, info.version if info else None,
                            info.deploy_tx if info else None))  # fmt: skip
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

    def __init__(self, rpc: FailoverRpc, private_key: str,
                 max_fee_wei: int = int(DEFAULT_MAX_FEE_GWEI * GWEI)) -> None:  # fmt: skip
        from eth_account import Account
        from web3 import Web3

        from .rpc import failover_provider

        chain_id = int(rpc.call("eth_chainId"), 16)
        if chain_id == MAINNET_CHAIN_ID:
            raise RuntimeError("keeper refuses to send on chainId 999 (mainnet)")
        if max_fee_wei <= 0:
            raise ValueError("max_fee_wei must be > 0")
        self.rpc = rpc
        self.w3 = Web3(failover_provider(rpc))
        self.account = Account.from_key(private_key)
        self.chain_id = chain_id
        self.max_fee_wei = max_fee_wei

    @property
    def address(self) -> str:
        return self.account.address

    def _fee_inputs(self) -> tuple[int, int]:
        blk = self.rpc.call("eth_getBlockByNumber", ["latest", False])
        base = int(blk.get("baseFeePerGas") or self.rpc.call("eth_gasPrice"), 16)
        try:
            tip = int(self.rpc.call("eth_maxPriorityFeePerGas"), 16)
        except Exception:  # noqa: BLE001 - not every node serves it; HyperEVM answers 0
            tip = 0
        return base, tip

    def send(self, pool: str, action: Action, prev: SentTx | None = None) -> SentTx:
        """Sign and send ``action``. With ``prev`` (our earlier tx for the same cover) still pending, the
        same nonce is reused with bumped fees (replace-by-fee); fees never exceed ``max_fee_wei``."""
        from web3 import Web3

        addr = self.account.address
        latest = int(self.rpc.call("eth_getTransactionCount", [addr, "latest"]), 16)
        pending = int(self.rpc.call("eth_getTransactionCount", [addr, "pending"]), 16)
        nonce = choose_nonce(latest, pending, prev)
        replacing = prev if prev is not None and nonce == prev.nonce else None
        base, tip = self._fee_inputs()
        max_fee, tip = choose_fees(base, tip, self.max_fee_wei, replacing)
        c = self.w3.eth.contract(address=Web3.to_checksum_address(pool), abi=POOL_ABI)
        fn = getattr(c.functions, action.kind)(action.cover_id)
        tx = fn.build_transaction({
            "from": addr,
            "nonce": nonce,
            "chainId": self.chain_id,
            "maxFeePerGas": max_fee,
            "maxPriorityFeePerGas": tip,
        })  # fmt: skip
        signed = self.account.sign_transaction(tx)
        h = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        if replacing:
            log.info("[keeper] replacing %s (nonce %d) with maxFee %d wei", replacing.hash, nonce, max_fee)
        return SentTx("0x" + bytes(h).hex().removeprefix("0x"), nonce, max_fee, tip)


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
        max_tx_per_poll: int = DEFAULT_MAX_TX_PER_POLL,
        balance_address: str | None = None,
        min_balance_wei: int = int(DEFAULT_MIN_BALANCE_HYPE * WEI_PER_HYPE),
        balance_every_s: float = DEFAULT_BALANCE_EVERY_S,
        alert_logs_every_s: float = DEFAULT_LOG_EVERY_S,
        alert_lookback_blocks: int = DEFAULT_LOOKBACK_BLOCKS,
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
        self.txs: dict[str, dict[int, SentTx]] = {b.pool: {} for b in self.books}  # last tx per cover (RBF)
        self.chain_id: int | None = None
        if max_tx_per_poll < 1:
            raise ValueError("max_tx_per_poll must be >= 1")
        self.max_tx_per_poll = max_tx_per_poll
        self.balance_address = balance_address
        self.min_balance_wei = min_balance_wei
        self.balance_every_s = balance_every_s
        self._balance_at: float | None = None
        self.last_balance: int | None = None
        self.watches: dict[str, PoolWatch] = {}  # v2 pools, filled by start()
        self.scanner = LogScanner(rpc, self.watches, alert_logs_every_s, alert_lookback_blocks)
        self.alerts: list[Any] = []  # every alert emitted (tests, summary)
        self._block: int | None = None  # latest block number of the last poll (v2 pools only)

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
        versions = {p.pool: p.version for p in self.plans}
        todo = [b for b in self.books if b.source is None]
        probe = [b for b in self.books if versions.get(b.pool) is None]  # v2 probe: minPremiumBps()
        calls = [mc.price_source(b.pool) for b in todo]
        calls += [mc.call(b.pool, "minPremiumBps()", [], [], ["uint16"], ("probe", b.pool)) for b in probe]
        res = mc.aggregate(self.rpc, calls) if calls else []
        for b, ok in zip(probe, res[len(todo):], strict=True):
            versions[b.pool] = "v2" if ok is not None else "v1"
        logs_on = self.scanner.every_s > 0
        deploy_txs = {p.pool: p.deploy_tx for p in self.plans}
        for b in self.books:
            if versions.get(b.pool) == "v2":
                w = PoolWatch(b.pool, b.label, logs_on=logs_on)
                if logs_on and deploy_txs.get(b.pool):
                    w.deploy_block = self._deploy_block(b.pool, str(deploy_txs[b.pool]))
                self.watches[b.pool] = w
        for b, src in zip(todo, res[: len(todo)], strict=True):
            if src is None:
                raise RuntimeError(f"[{b.label}] cannot read pool.priceSource() at {b.pool}")
            b.source = str(src).lower()
            if listed.get(b.pool) and listed[b.pool] != b.source:
                log.warning("[keeper] %s: on-chain priceSource %s differs from the deployments file %s",
                            b.label, b.source, listed[b.pool])  # fmt: skip
        for b in self.books:
            log.info("[keeper] watching %s pool=%s priceSource=%s version=%s", b.label, b.pool, b.source,
                     versions.get(b.pool))  # fmt: skip
        self.check_balance(self.clock())

    def _deploy_block(self, pool: str, tx_hash: str) -> int | None:
        """Block of the pool's creation tx (one request, once): nothing is logged before it, so the alert
        catch-up stops there. None when the receipt cannot be read or created another address."""
        try:
            r = self.rpc.call("eth_getTransactionReceipt", [tx_hash])
        except Exception as exc:  # noqa: BLE001 - only narrows the catch-up; without it the scan is longer
            log.warning("[keeper] deploy receipt %s unreadable: %s", tx_hash, exc)
            return None
        if not isinstance(r, dict) or str(r.get("contractAddress") or "").lower() != pool.lower():
            log.warning("[keeper] deploy tx %s did not create %s; catch-up not bounded by it", tx_hash, pool)
            return None
        return int(str(r["blockNumber"]), 16)

    def check_balance(self, t: float) -> int | None:
        """Log the keeper's HYPE balance; WARNING when below ``min_balance_wei`` (audit L4). Runs at startup
        and then every ``balance_every_s``; a failed read only logs."""
        if self.balance_address is None:
            return None
        self._balance_at = t
        try:
            wei = int(self.rpc.call("eth_getBalance", [self.balance_address, "latest"]), 16)
        except Exception as exc:  # noqa: BLE001 - a balance read must never stop the keeper
            log.warning("[keeper] balance read failed for %s: %s", self.balance_address, exc)
            return None
        self.last_balance = wei
        hype, floor = wei / WEI_PER_HYPE, self.min_balance_wei / WEI_PER_HYPE
        if wei < self.min_balance_wei:
            log.warning("[keeper] LOW BALANCE %s: %.6f HYPE < %.6f HYPE; trigger/expire txs may fail. "
                        "Top up with testnet HYPE.", self.balance_address, hype, floor)  # fmt: skip
        else:
            log.info("[keeper] balance %s: %.6f HYPE (warn below %.6f)", self.balance_address, hype, floor)
        return wei

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
        if self.watches:  # v2 alert state, same eth_call
            calls.append(mc.block_number("bn"))
            for w in self.watches.values():
                calls += w.calls()
        out = dict(zip((c.key for c in calls), mc.aggregate(self.rpc, calls), strict=True))
        if out["ts"] is None:
            raise RuntimeError("Multicall3.getCurrentBlockTimestamp() failed")
        self._block = out.get("bn")
        for w in self.watches.values():
            self.alerts += emit(w.update(out, int(out["ts"]), self._block))
        prices: dict[str, dict[int, int | None]] = {}
        for s, p in price_keys:
            prices.setdefault(s, {})[p] = out[("px", s, p)]
        missing: dict[int, list[int]] = {}
        for i, b in enumerate(self.books):
            covers = {k[2]: cover_from_tuple(k[2], v) for k, v in out.items()
                      if isinstance(k, tuple) and k[0] == "cover" and k[1] == i}  # fmt: skip
            self._alert_new_covers(b, covers)
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
                self._alert_new_covers(self.books[i], covers)
                self.books[i].apply(None, covers)
        # prices for perps first seen in the backfill
        new = [(s, p) for s, p in self._price_keys() if p not in prices.get(s, {})]
        if new:
            calls = [mc.oracle_px6(s, p, (s, p)) for s, p in new]
            for (s, p), v in zip(new, mc.aggregate(self.rpc, calls), strict=True):
                prices.setdefault(s, {})[p] = v

    def _alert_new_covers(self, b: PoolBook, covers: Mapping[int, Cover | None]) -> None:
        """Floor-priced sale alert for covers read for the first time (ids beyond ``b.known``)."""
        w = self.watches.get(b.pool)
        if w is None:
            return
        for cid, c in covers.items():
            if c is not None and cid > b.known:
                self.alerts += emit(w.check_cover(cid, c.payout, c.premium, c.status == Status.ACTIVE))

    def poll(self) -> list[tuple[str, Action, str]]:
        r0 = self.rpc.requests
        if self._balance_at is not None and self.clock() - self._balance_at >= self.balance_every_s:
            self.check_balance(self.clock())
        now, prices = self.read()
        t = self.clock()
        if self._block is not None and self.scanner.due(t):
            self.alerts += emit(self.scanner.scan(int(self._block), t))
        done = []
        todo: list[tuple[PoolBook, Action]] = []
        for b in self.books:
            sent, txs = self.sent[b.pool], self.txs[b.pool]
            for cid in [c for c in sent if c not in b.active]:
                del sent[cid]  # final now (or never was): forget
                txs.pop(cid, None)
            assert b.source is not None
            todo += [(b, a) for a in due(decide(b.active.values(), prices.get(b.source, {}), now), sent, t)]
        todo.sort(key=lambda ba: ba[1].kind != "trigger")  # stable: triggers (largest first) before expires
        if len(todo) > self.max_tx_per_poll:
            log.warning("[keeper] %d actions due, sending %d this poll (cap); the rest next poll", len(todo),
                        self.max_tx_per_poll)  # fmt: skip
        for b, a in todo[: self.max_tx_per_poll]:
            self.sent[b.pool][a.cover_id] = t
            if self.dry_run:
                log.info("[keeper] dry-run: would send %s(%s) on %s (%s)", a.kind, a.cover_id, b.label,
                         a.reason)  # fmt: skip
                done.append((b.label, a, "dry-run"))
                continue
            assert self.sender is not None
            prev = self.txs[b.pool].get(a.cover_id)
            try:
                tx = self.sender.send(b.pool, a, prev=prev)
            except GasCapError as exc:
                if prev is None:  # nothing went out: not "sent", so the next poll retries it
                    del self.sent[b.pool][a.cover_id]
                log.warning("[keeper] %s(%s) on %s held: %s", a.kind, a.cover_id, b.label, exc)
                continue
            except Exception as exc:  # noqa: BLE001 - e.g. reverted because the price moved back
                log.warning("[keeper] %s(%s) on %s failed: %s", a.kind, a.cover_id, b.label, exc)
                continue
            self.txs[b.pool][a.cover_id] = tx
            log.info("[keeper] %s(%s) on %s sent %s nonce=%d (%s)", a.kind, a.cover_id, b.label, tx.hash,
                     tx.nonce, a.reason)  # fmt: skip
            done.append((b.label, a, tx.hash))
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
    env = os.environ
    ap.add_argument("--max-fee-gwei", type=float,
                    default=float(env.get("NUMERA_KEEPER_MAX_FEE_GWEI", DEFAULT_MAX_FEE_GWEI)),
                    help=f"maxFeePerGas ceiling in gwei (default {DEFAULT_MAX_FEE_GWEI:g})")  # fmt: skip
    ap.add_argument("--max-tx-per-poll", type=int,
                    default=int(env.get("NUMERA_KEEPER_MAX_TX_PER_POLL", DEFAULT_MAX_TX_PER_POLL)),
                    help=f"txs sent per poll at most (default {DEFAULT_MAX_TX_PER_POLL})")  # fmt: skip
    ap.add_argument("--min-balance", type=float,
                    default=float(env.get("NUMERA_KEEPER_MIN_BALANCE_HYPE", DEFAULT_MIN_BALANCE_HYPE)),
                    help=f"warn below this HYPE balance (default {DEFAULT_MIN_BALANCE_HYPE:g})")  # fmt: skip
    ap.add_argument("--balance-every", type=float, default=DEFAULT_BALANCE_EVERY_S,
                    help=f"seconds between balance checks (default {DEFAULT_BALANCE_EVERY_S:g})")  # fmt: skip
    ap.add_argument("--alert-logs-every", type=float, default=DEFAULT_LOG_EVERY_S,
                    help="seconds between v2 alert log scans (eth_getLogs over v2 pools; 0 = off; "
                         f"default {DEFAULT_LOG_EVERY_S:g})")  # fmt: skip
    ap.add_argument("--alert-lookback-blocks", type=int, default=DEFAULT_LOOKBACK_BLOCKS,
                    help="blocks before startup that the first v2 alert scan covers "
                         f"(default {DEFAULT_LOOKBACK_BLOCKS})")  # fmt: skip
    ap.add_argument("--keeper-address", default=None,
                    help="address whose balance a --dry-run reports (default: KEEPER_KEY's, else the "
                         "deployments file `keeper`)")  # fmt: skip
    args = ap.parse_args(argv)
    if not args.max_fee_gwei > 0:  # also rejects NaN
        ap.error("--max-fee-gwei must be > 0")
    if args.max_tx_per_poll < 1:
        ap.error("--max-tx-per-poll must be >= 1")
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
    sender = None if args.dry_run else Sender(rpc, key, max_fee_wei=int(args.max_fee_gwei * GWEI))
    if sender is not None:
        balance_addr = sender.address
    elif key:
        from eth_account import Account

        balance_addr = Account.from_key(key).address
    else:
        balance_addr = args.keeper_address or (dep.keeper if dep else None)
    log.info("[keeper] limits: maxFeePerGas <= %g gwei, <= %d txs/poll, balance warn < %g HYPE every %gs",
             args.max_fee_gwei, args.max_tx_per_poll, args.min_balance, args.balance_every)  # fmt: skip
    keeper = Keeper(rpc, plans, watch_perps=dep.perps.values() if dep else (), sender=sender,
                    dry_run=args.dry_run, price_source_override=args.price_source,
                    max_tx_per_poll=args.max_tx_per_poll, balance_address=balance_addr,
                    min_balance_wei=int(args.min_balance * WEI_PER_HYPE),
                    balance_every_s=args.balance_every, alert_logs_every_s=args.alert_logs_every,
                    alert_lookback_blocks=args.alert_lookback_blocks)  # fmt: skip
    keeper.start()
    keeper.run(args.poll, args.duration)


if __name__ == "__main__":
    main()
