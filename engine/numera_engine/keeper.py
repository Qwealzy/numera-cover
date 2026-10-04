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
KEEPER_KEY through the same client, pinned to the endpoint that served the decision read (nonce, estimate and
send see the state the decision saw). Runs only on chainId 998 (testnet) or 31337 (local), checked on every
RPC at startup (``FailoverRpc.verify_chain``); never on 999 (mainnet).

Tx hygiene (audit L4): EIP-1559 fees under a maxFeePerGas ceiling (``--max-fee-gwei``), at most
``--max-tx-per-poll`` txs per poll (triggers first), a resend after 30 s replaces our still-pending tx on the
same nonce with bumped fees (RBF) instead of queueing behind it, and the keeper's HYPE balance is logged at
startup and every ``--balance-every`` seconds, with a WARNING below ``--min-balance``.

Latency (F9: trigger within 5 s of a breach). Polling is adaptive: every ``--poll`` s (3), and every
``--fast-poll`` s (1) while an active cover's oracle price is within ``--near-pct`` (1 %) of its level, for at
most ``--fast-max-min`` (10) minutes per approach. Request budget: normal mode is one ``eth_call`` a poll
(20/min at 3 s); fast mode is one a second (60/min) plus, with several RPCs, one ``eth_blockNumber`` per
other healthy RPC every 5 s (12/min each), which lets a decision read skip an RPC more than
``--max-head-lag`` (2) blocks behind. A poll reads, then sends at once; the backfill, receipts, log scan,
balance check and probes come after the sends. A send is two round-trips (Sender docstring). ``--timing``
logs every RPC's head next to the decision read's block each poll (debug; one request per RPC per poll).
Timing lines: ``breach seen`` (block, block ts, wall, lag), ``sent`` (wall, nonce, fees, send ms, seen->sent),
``final`` (receipt block, blocks after the breach was seen).

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

from eth_abi import encode

from . import multicall as mc
from .alerts import (
    DEFAULT_HEAD_LAG_BLOCKS,
    DEFAULT_LOG_EVERY_S,
    DEFAULT_LOOKBACK_BLOCKS,
    LogScanner,
    PoolWatch,
    emit,
)
from .rpc import (  # noqa: F401 - resolve_rpcs re-exported (tests, CLI)
    DEFAULT_MAX_HEAD_LAG,
    Endpoint,
    FailoverRpc,
    RpcError,
    host,
    resolve_rpcs,
)

log = logging.getLogger("numera.keeper")

MAINNET_CHAIN_ID = 999
ALLOWED_CHAIN_IDS = frozenset({998, 31337})  # testnet, local anvil: the keeper refuses anything else
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
TIP_TTL_S = 300.0  # eth_maxPriorityFeePerGas cached this long (HyperEVM answers 0)
BASE_FEE_TTL_S = 1.0  # a base fee read by one send serves the other sends of the same poll
# maxFeePerGas floor: a base fee read as 0 (a node answering 0, or getBasefee() inside eth_call) with a 0 tip
# must not sign maxFeePerGas = 0, which no block accepts. 0.1 gwei = the testnet base fee (2026-10-02); the
# floor is a ceiling, not a price (a 1559 tx pays base fee + tip), so it costs nothing when the fee is lower.
MIN_MAX_FEE_WEI = GWEI // 10
# Local nonce floor: after a send, the next fresh nonce is at least ours + 1 for this long, because a node's
# `pending` count may not include a tx it accepted a moment ago (two covers sent in one poll). Past it, or
# once the node's pending count reaches the floor, the node's count rules again (a dropped tx leaves no gap).
NONCE_FLOOR_TTL_S = 10.0
# Retry backoff per cover after an attempt that broadcast nothing (revert on estimate, an error answer to the
# send such as insufficient funds): next try after 1, 2, 4, ... s, at most RETRY_MAX_S, so a stuck cover does
# not cost ~3 requests every fast poll. The first retry is the next fast poll (RETRY_SLACK_S absorbs poll
# jitter). Reset by a success, or when the cover's decision changes (no longer due, or another action kind).
RETRY_BASE_S = 1.0
RETRY_MAX_S = 30.0
RETRY_SLACK_S = 0.25
GAS_HEADROOM_DIV = 5  # gas limit = estimate + estimate / 5 (the state can change between estimate and block)
# Adaptive polling (F9: trigger within 5 s of a breach). A cover whose oracle price is within NEAR_PCT of its
# level (or past it) switches polling to FAST_POLL_S; each approach may keep fast mode on for FAST_MAX_S at
# most (request budget), until the price leaves the band and comes back.
DEFAULT_POLL_S = 3.0
DEFAULT_FAST_POLL_S = 1.0
DEFAULT_NEAR_PCT = 1.0
DEFAULT_FAST_MAX_MIN = 10.0
HEAD_PROBE_EVERY_S = 5.0  # fast mode: eth_blockNumber of the other healthy endpoints this often (lag check)
PPM = 1_000_000


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


def state_block(call_block: Any) -> int | None:
    """Head block whose state an ``eth_call`` at ``latest`` read, from ``block.number`` inside the call.
    On HyperEVM testnet both RPCs run that call in block head + 1 (``--timing`` dry runs, 2026-10-02:
    multicall ``getBlockNumber()`` = ``eth_blockNumber`` + 1), so this subtracts 1 and the result compares
    like-for-like with ``eth_blockNumber`` probes. A node that runs it at the head itself reads 1 block
    behind here, well inside ``--max-head-lag``."""
    return None if call_block is None else max(0, int(call_block) - 1)


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
    gas: int = 0  # gas limit (0 when unknown)


class GasCapError(RuntimeError):
    """The fee needed now (or for a replacement) is above the configured maxFeePerGas ceiling."""


class SendError(RuntimeError):
    """``eth_sendRawTransaction`` failed. ``tx`` is set when the tx may have reached a node anyway (the
    request got no answer): the caller must treat it as sent (no fresh resend on another nonce)."""

    def __init__(self, msg: str, tx: SentTx | None = None) -> None:
        super().__init__(msg)
        self.tx = tx


ALREADY_KNOWN = ("already known", "known transaction", "already imported", "alreadyknown")


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

    Fresh tx: 2 x base fee + tip (headroom for base fee rises), at least ``MIN_MAX_FEE_WEI``, clipped to
    ``cap``. Replacement: at least
    ``bump`` of the previous fees. Raises GasCapError when the base fee itself, or a replacement's required
    bump, is above the cap: better to wait a poll than overpay or send an underpriced replacement."""
    if base_fee > cap:
        raise GasCapError(f"base fee {base_fee} wei above the cap {cap} wei")
    max_fee = max(2 * base_fee + tip, MIN_MAX_FEE_WEI)
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


def plan_pools(deployment: Any, pools: list[str] | None, version: str | None = None) -> list[PoolPlan]:
    """Which pools to watch: every pool in the deployment, or the given addresses (labelled if known).
    ``version`` ("v2") keeps only the deployment pools of that version when no address is given: addresses
    come from the deployments file at start-up, never from the command line or the source."""
    if pools is None:
        if deployment is None or not deployment.pools:
            raise ValueError("no --pool given and no pools in the deployments file")
        pools = [p.pool for p in deployment.pools if version is None or p.version == version]
        if not pools:
            raise ValueError(f"the deployments file lists no {version} pool")
    out = []
    for addr in pools:
        info = deployment.find(addr) if deployment is not None else None
        out.append(PoolPlan(addr.lower(), info.name if info else addr.lower(),
                            info.price_source if info else None, info.version if info else None,
                            info.deploy_tx if info else None))  # fmt: skip
    return out


# -- chain I/O (thin) ------------------------------------------------------------------------------


def calldata(action: Action) -> str:
    """``trigger(uint256)`` / ``expire(uint256)`` calldata (0x-hex)."""
    return "0x" + (mc.selector(f"{action.kind}(uint256)") + encode(["uint256"], [action.cover_id])).hex()


class Sender:
    """Builds, signs and sends trigger/expire from KEEPER_KEY through the failover RPC.

    Round-trips per send (latency, F9 "trigger within 5 s"): one JSON-RPC batch with the pending nonce,
    ``eth_estimateGas`` and the latest block's base fee (plus the latest nonce when replacing and the tip
    when its cache is stale), then ``eth_sendRawTransaction``: 2 round-trips (was 6 sequential calls).
    Cached: chainId (read once here), the tip (``TIP_TTL_S``; HyperEVM answers 0) and the base fee for
    ``BASE_FEE_TTL_S`` (later sends of the same poll). The base fee is not taken from the decision
    multicall: ``Multicall3.getBasefee()`` answers 0 inside ``eth_call`` on HyperEVM (testnet, 2026-10-02).
    The nonce is still read per send, so ``choose_nonce`` sees the node's real pending/latest counts
    (another tx from the same key, e.g. a guardian action, never collides), raised to a local floor (our last
    nonce + 1, ``NONCE_FLOOR_TTL_S``) for a node whose pending count lags our own sends.

    ``ep`` pins every request of a send to one endpoint (the decision read's); ``eth_sendRawTransaction``
    errors are classified: ``already known`` = sent; an error answer = nothing went out (``SendError``
    without tx); no answer at all = may have gone out (``SendError`` with the tx, so the caller keeps it)."""

    def __init__(self, rpc: FailoverRpc, private_key: str,
                 max_fee_wei: int = int(DEFAULT_MAX_FEE_GWEI * GWEI),
                 clock: Callable[[], float] = time.monotonic) -> None:  # fmt: skip
        from eth_account import Account

        chain_id = rpc.verify_chain(ALLOWED_CHAIN_IDS)  # every endpoint: 998 or 31337, all the same
        if max_fee_wei <= 0:
            raise ValueError("max_fee_wei must be > 0")
        self.rpc = rpc
        self.account = Account.from_key(private_key)
        self.chain_id = chain_id
        self.max_fee_wei = max_fee_wei
        self.clock = clock
        self._tip: int | None = None
        self._tip_at = 0.0
        self._base: int | None = None
        self._base_at = 0.0
        self.last_requests = 0  # HTTP requests the last send() made (timing log)
        self._floor: int | None = None  # lowest fresh nonce allowed (our last nonce + 1)
        self._floor_at = 0.0

    @property
    def address(self) -> str:
        return self.account.address

    def send(self, pool: str, action: Action, prev: SentTx | None = None,
             base_fee: int | None = None, ep: Endpoint | None = None) -> SentTx:  # fmt: skip
        """Sign and send ``action``. With ``prev`` (our earlier tx for the same cover) still pending, the
        same nonce is reused with bumped fees (replace-by-fee); fees never exceed ``max_fee_wei``.
        ``base_fee``: the latest block's base fee if the caller already has it from a block header.
        ``ep``: the endpoint every request of this send goes to while it is healthy (decision read's)."""
        from eth_utils import to_checksum_address

        r0 = self.rpc.requests
        if base_fee is None and self._base is not None and self.clock() - self._base_at < BASE_FEE_TTL_S:
            base_fee = self._base
        addr, to, data = self.account.address, to_checksum_address(pool), calldata(action)
        calls: dict[str, tuple[str, list[Any]]] = {
            "pending": ("eth_getTransactionCount", [addr, "pending"]),
            "gas": ("eth_estimateGas", [{"from": addr, "to": to, "data": data}]),
        }
        if prev is not None:
            calls["latest"] = ("eth_getTransactionCount", [addr, "latest"])
        if self._tip is None or self.clock() - self._tip_at >= TIP_TTL_S:
            calls["tip"] = ("eth_maxPriorityFeePerGas", [])
        if base_fee is None:
            calls["block"] = ("eth_getBlockByNumber", ["latest", False])
        res = dict(zip(calls, self.rpc.batch(list(calls.values()), ep=ep), strict=True))
        ep = self.rpc.last or ep  # the batch's endpoint (ep, or its fallback) also gets the send
        for k in ("pending", "latest", "block"):
            if isinstance(res.get(k), RpcError):
                raise res[k]
        if isinstance(res["gas"], RpcError):  # e.g. the price moved back: trigger would revert
            raise RuntimeError(f"{action.kind}({action.cover_id}) would revert: {res['gas']}")
        if "tip" in res:  # not every node serves it; HyperEVM answers 0
            self._tip = 0 if isinstance(res["tip"], RpcError) else int(res["tip"], 16)
            self._tip_at = self.clock()
        if base_fee is None:
            blk = res["block"] or {}
            base_fee = int(blk.get("baseFeePerGas") or self.rpc.call("eth_gasPrice", ep=ep), 16)
            self._base, self._base_at = base_fee, self.clock()
        pending = int(res["pending"], 16)
        # with no previous tx choose_nonce returns `pending` whatever `latest` is, so it is not read then
        latest = int(res["latest"], 16) if prev is not None else pending
        nonce = choose_nonce(latest, pending, prev)
        replacing = prev if prev is not None and nonce == prev.nonce else None
        if self._floor is not None and (pending >= self._floor
                                        or self.clock() - self._floor_at >= NONCE_FLOOR_TTL_S):  # fmt: skip
            self._floor = None  # the node caught up (or our tx was dropped): its count rules again
        if replacing is None and self._floor is not None:
            nonce = max(nonce, self._floor)
        assert self._tip is not None
        max_fee, tip = choose_fees(int(base_fee), self._tip, self.max_fee_wei, replacing)
        est = int(res["gas"], 16)
        tx = {"type": 2, "chainId": self.chain_id, "nonce": nonce, "to": to, "data": data, "value": 0,
              "gas": est + est // GAS_HEADROOM_DIV, "maxFeePerGas": max_fee,
              "maxPriorityFeePerGas": tip}  # fmt: skip
        signed = self.account.sign_transaction(tx)
        local = SentTx("0x" + bytes(signed.hash).hex(), nonce, max_fee, tip, int(tx["gas"]))
        errs0 = sum(e.errors for e in self.rpc.endpoints)
        try:
            h = self.rpc.call("eth_sendRawTransaction", ["0x" + bytes(signed.raw_transaction).hex()], ep=ep)
        except RpcError as e:
            msg = e.message.lower()
            if any(k in msg for k in ALREADY_KNOWN):
                h = local.hash  # the node already has this exact tx: it is out
            elif "nonce too low" in msg and sum(x.errors for x in self.rpc.endpoints) > errs0:
                # an endpoint timed out on this very send, then failover found the nonce used: most likely
                # by this tx, which the first endpoint took. Treat as sent (local hash, 30 s guard).
                log.warning("[keeper] %s(%s): nonce %d too low after a send timeout; assuming %s went out",
                            action.kind, action.cover_id, nonce, local.hash)  # fmt: skip
                h = local.hash
            else:
                raise SendError(f"{action.kind}({action.cover_id}) rejected: {e}") from e
        except Exception as e:  # noqa: BLE001 - no answer: the tx may be in a mempool
            self._note_nonce(nonce)
            raise SendError(f"{action.kind}({action.cover_id}) may have gone out (no answer): {e}",
                            local) from e  # fmt: skip
        finally:
            self.last_requests = self.rpc.requests - r0
        self._note_nonce(nonce)
        if replacing:
            log.info("[keeper] replacing %s (nonce %d) with maxFee %d wei", replacing.hash, nonce, max_fee)
        return SentTx("0x" + str(h).removeprefix("0x"), nonce, max_fee, tip, int(tx["gas"]))

    def _note_nonce(self, nonce: int) -> None:
        if self._floor is None or nonce + 1 > self._floor:
            self._floor = nonce + 1
        self._floor_at = self.clock()


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
        alert_head_lag_blocks: int = DEFAULT_HEAD_LAG_BLOCKS,
        fast_poll_s: float = DEFAULT_FAST_POLL_S,
        near_pct: float = DEFAULT_NEAR_PCT,
        fast_max_s: float = DEFAULT_FAST_MAX_MIN * 60,
        timing: bool = False,
        wall: Callable[[], float] = time.time,
        head_probe_every_s: float = HEAD_PROBE_EVERY_S,
    ) -> None:
        if sender is None and not dry_run:
            raise ValueError("a Sender is needed unless dry_run")
        if not fast_poll_s > 0 or not near_pct >= 0 or not fast_max_s >= 0:
            raise ValueError("fast_poll_s must be > 0, near_pct and fast_max_s >= 0")
        self.fast_poll_s = fast_poll_s
        self.near_ppm = round(near_pct * 10_000)  # 1 % = 10 000 ppm; integer compare, no float edge
        self.fast_max_s = fast_max_s
        self.timing = timing
        self.wall = wall
        self.head_probe_every_s = head_probe_every_s
        self.fast = False  # current polling mode (run() sleeps fast_poll_s when True)
        self._near_since: dict[tuple[str, int], float] = {}  # (pool, cover) -> start of its current approach
        self._capped: set[tuple[str, int]] = set()  # approaches past fast_max_s (logged once)
        self._retry: dict[tuple[str, int], tuple[int, float, str]] = {}  # (pool, cover) -> (failures in a
        # row, next try at, action kind) after attempts that broadcast nothing (RETRY_BASE_S backoff)
        self._seen: dict[tuple[str, int], tuple[int | None, int, float, float]] = {}  # breach first seen:
        # (block, block ts, wall, clock)
        self._probe_at: float | None = None
        self.head: int | None = None  # block number of the last decision read
        self.read_ep: Endpoint | None = None  # endpoint that served the last decision read (sends pin it)
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
        if alert_head_lag_blocks < 0:
            raise ValueError("alert_head_lag_blocks must be >= 0")
        self.scanner = LogScanner(rpc, self.watches, alert_logs_every_s, alert_lookback_blocks,
                                  head_lag=alert_head_lag_blocks)  # fmt: skip
        self.alerts: list[Any] = []  # every alert emitted (tests, summary)
        self._block: int | None = None  # latest block number of the last poll (v2 pools only)

    # -- startup --------------------------------------------------------------------------------------

    def start(self) -> None:
        """Chain id guard, then every pool's price source in one call."""
        self.chain_id = self.rpc.verify_chain(ALLOWED_CHAIN_IDS)  # every endpoint: 998 or 31337
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
        """Refresh every book (decision read, then backfill); returns (block timestamp, prices)."""
        out, price_keys = self._read_main()
        prices, missing = self._fold(out, price_keys)
        self._backfill(missing, prices)
        return int(out["ts"]), prices

    def _read_main(self) -> tuple[dict[Any, Any], list[tuple[str, int]]]:
        """The decision read: one Multicall3 ``eth_call`` (block number, timestamp, base fee, covers,
        prices, v2 state). In fast mode it avoids a lagging endpoint, and re-reads once from a fresher one
        when the answer turns out to be more than ``rpc.max_head_lag`` blocks behind (rpc.py docstring)."""
        calls = [mc.block_timestamp("ts"), mc.block_number("bn")]
        for i, b in enumerate(self.books):
            calls.append(mc.cover_count(b.pool, ("count", i)))
            calls += [mc.get_cover(b.pool, cid, ("cover", i, cid)) for cid in b.ids_to_read()]
        price_keys = self._price_keys()
        calls += [mc.oracle_px6(s, p, ("px", s, p)) for s, p in price_keys]
        for w in self.watches.values():  # v2 alert state, same eth_call
            calls += w.calls()
        keys = [c.key for c in calls]
        out = dict(zip(keys, mc.aggregate(self.rpc, calls, fresh=self.fast), strict=True))
        self.rpc.note_head(state_block(out.get("bn")))
        ep = self.rpc.last
        if self.fast and ep is not None and self.rpc.lagging(ep):
            log.info("[keeper] decision read at block %s from %s is %s blocks behind; re-reading from a "
                     "fresher rpc", state_block(out.get("bn")), host(ep.url), self.rpc.lag(ep))  # fmt: skip
            out = dict(zip(keys, mc.aggregate(self.rpc, calls, fresh=True), strict=True))
            self.rpc.note_head(state_block(out.get("bn")))
        if out["ts"] is None:
            raise RuntimeError("Multicall3.getCurrentBlockTimestamp() failed")
        self.head = state_block(out.get("bn"))
        self.read_ep = self.rpc.last
        return out, price_keys

    def _fold(self, out: Mapping[Any, Any], price_keys: list[tuple[str, int]],
              ) -> tuple[dict[str, dict[int, int | None]], dict[int, list[int]]]:  # fmt: skip
        """Pure: fold the decision read into the books; returns (prices, ids still to backfill)."""
        if self.watches:
            self._block = out.get("bn")  # the call's block.number, as before (alert scan ranges)
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
        return prices, missing

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
        """One poll. Hot path first: the decision read, then the sends. Everything else (backfill of new
        ids, settling final covers and their receipts, the v2 log scan, the balance check, the polling mode,
        head probes) runs after the sends, so a breach costs one read plus the send round-trips."""
        r0, c0 = self.rpc.requests, self.clock()
        out, price_keys = self._read_main()
        now = int(out["ts"])
        read_ms = (self.clock() - c0) * 1000
        prices, missing = self._fold(out, price_keys)
        t = self.clock()
        budget = [self.max_tx_per_poll]
        done = self._act(prices, now, t, budget)
        # -- after the sends --------------------------------------------------------------------------
        if any(missing.values()):
            self._backfill(missing, prices)
            done += self._act(prices, now, t, budget)  # covers first read by the backfill
        self._settle()
        if self._block is not None and self.scanner.due(t):
            self.alerts += emit(self.scanner.scan(int(self._block), t))
        if self._balance_at is not None and self.clock() - self._balance_at >= self.balance_every_s:
            self.check_balance(self.clock())
        self._update_mode(prices, t)
        heads = self._probe_heads(t)
        cur = self.rpc.last.url if self.rpc.last else "-"
        log.info("[keeper] poll ok mode=%s pools=%d active=%d block=%s ts=%d read=%.0fms reqs=%d rpm=%d "
                 "rpc=%s%s", "fast" if self.fast else "normal", len(self.books),
                 sum(len(b.active) for b in self.books), self.head, now, read_ms, self.rpc.requests - r0,
                 self.rpc.per_minute(), host(cur), heads)  # fmt: skip
        return done

    def _act(self, prices: Mapping[str, Mapping[int, int | None]], now: int, t: float,
             budget: list[int]) -> list[tuple[str, Action, str]]:  # fmt: skip
        """Decide and send; ``budget`` holds the txs this poll may still send (shared across calls)."""
        todo: list[tuple[PoolBook, Action]] = []
        for b in self.books:
            assert b.source is not None
            acts = decide(b.active.values(), prices.get(b.source, {}), now)
            for a in acts:
                if a.kind == "trigger" and (b.pool, a.cover_id) not in self._seen:
                    self._breach_seen(b, a, now)
            kinds = {a.cover_id: a.kind for a in acts}
            for k in [k for k in self._retry if k[0] == b.pool and kinds.get(k[1]) != self._retry[k][2]]:
                del self._retry[k]  # the decision changed: a new attempt starts without backoff
            todo += [(b, a) for a in due(acts, self.sent[b.pool], t)
                     if t >= self._retry.get((b.pool, a.cover_id), (0, 0.0, ""))[1] - RETRY_SLACK_S]
        todo.sort(key=lambda ba: ba[1].kind != "trigger")  # stable: triggers (largest first) before expires
        if len(todo) > budget[0]:
            log.warning("[keeper] %d actions due, sending %d this poll (cap); the rest next poll", len(todo),
                        budget[0])  # fmt: skip
        done = []
        for b, a in todo[: budget[0]]:
            budget[0] -= 1
            before = self.sent[b.pool].get(a.cover_id)  # our previous send time (only when resending)
            self.sent[b.pool][a.cover_id] = t
            if self.dry_run:
                log.info("[keeper] dry-run: would send %s(%s) on %s (%s)", a.kind, a.cover_id, b.label,
                         a.reason)  # fmt: skip
                done.append((b.label, a, "dry-run"))
                continue
            assert self.sender is not None
            prev = self.txs[b.pool].get(a.cover_id)
            c0 = self.clock()
            try:
                tx = self.sender.send(b.pool, a, prev=prev, ep=self.read_ep)
            except SendError as exc:
                if exc.tx is None:
                    self._unmark(b.pool, a, before, t, exc)
                else:  # may be pending: keep it (RESEND_AFTER_S guard, RBF on its nonce if still pending)
                    self._retry.pop((b.pool, a.cover_id), None)
                    self.txs[b.pool][a.cover_id] = exc.tx
                    log.warning("[keeper] %s(%s) on %s %s; next attempt after %.0fs replaces %s", a.kind,
                                a.cover_id, b.label, exc, RESEND_AFTER_S, exc.tx.hash)  # fmt: skip
                continue
            except Exception as exc:  # noqa: BLE001 - gas cap, or a revert because the price moved back
                self._unmark(b.pool, a, before, t, exc)  # raised before the send: nothing went out
                continue
            self._retry.pop((b.pool, a.cover_id), None)
            self.txs[b.pool][a.cover_id] = tx
            seen = self._seen.get((b.pool, a.cover_id))
            since = f" seen->sent={self.clock() - seen[3]:.2f}s" if seen else ""
            reqs = getattr(self.sender, "last_requests", -1)
            log.info("[keeper] %s(%s) on %s sent %s nonce=%d maxFee=%d tip=%d gas=%d wall=%.3f send=%.0fms "
                     "send_reqs=%d%s (%s)", a.kind, a.cover_id, b.label, tx.hash, tx.nonce, tx.max_fee,
                     tx.tip, tx.gas, self.wall(), (self.clock() - c0) * 1000, reqs, since,
                     a.reason)  # fmt: skip
            done.append((b.label, a, tx.hash))
        return done

    def _unmark(self, pool: str, a: Action, before: float | None, t: float, exc: Exception) -> None:
        """Nothing was broadcast by this attempt: drop the send mark (or restore the previous send's, which
        is already past ``RESEND_AFTER_S``) instead of waiting 30 s, and back off this cover's next try
        1, 2, 4, ... s up to ``RETRY_MAX_S`` (the first retry is the next fast poll)."""
        cid = a.cover_id
        if before is None:
            del self.sent[pool][cid]
        else:
            self.sent[pool][cid] = before
        fails = self._retry.get((pool, cid), (0, 0.0, a.kind))[0] + 1
        delay = min(RETRY_MAX_S, RETRY_BASE_S * 2 ** (fails - 1))
        self._retry[(pool, cid)] = (fails, t + delay, a.kind)
        what = "held" if isinstance(exc, GasCapError) else "failed"
        log.warning("[keeper] %s(%s) on %s %s (attempt %d), retry in %.0fs: %s", a.kind, cid,
                    self._label(pool), what, fails, delay, exc)  # fmt: skip

    def _breach_seen(self, b: PoolBook, a: Action, now: int) -> None:
        """First poll that sees cover ``a.cover_id`` breached: log block, wall time and block-to-seen lag."""
        wall = self.wall()
        self._seen[(b.pool, a.cover_id)] = (self.head, now, wall, self.clock())
        cur = self.rpc.last.url if self.rpc.last else "-"
        log.info("[keeper] breach seen: cover %d on %s at block %s (block ts %d) wall=%.3f block->seen=%.1fs "
                 "mode=%s rpc=%s (%s)", a.cover_id, b.label, self.head, now, wall, wall - now,
                 "fast" if self.fast else "normal", host(cur), a.reason)  # fmt: skip

    def _settle(self) -> None:
        """Forget covers that left the active set; for ours, log where the tx landed (one receipt read)."""
        for b in self.books:
            sent, txs = self.sent[b.pool], self.txs[b.pool]
            for cid in [c for c in sent if c not in b.active]:
                del sent[cid]  # final now (or never was): forget
                tx = txs.pop(cid, None)
                seen = self._seen.pop((b.pool, cid), None)
                if tx is not None:
                    self._log_receipt(b, cid, tx, seen)

    def _log_receipt(self, b: PoolBook, cid: int, tx: SentTx,
                     seen: tuple[int | None, int, float, float] | None) -> None:  # fmt: skip
        try:
            r = self.rpc.call("eth_getTransactionReceipt", [tx.hash])
        except Exception as exc:  # noqa: BLE001 - timing log only
            log.info("[keeper] cover %d on %s final; receipt of %s unreadable: %s", cid, b.label, tx.hash,
                     exc)  # fmt: skip
            return
        if not isinstance(r, dict) or not r.get("blockNumber"):
            log.info("[keeper] cover %d on %s final; our tx %s has no receipt (replaced, or another caller "
                     "settled it)", cid, b.label, tx.hash)  # fmt: skip
            return
        blk = int(str(r["blockNumber"]), 16)
        extra = ""
        if seen is not None:
            sb, sts, swall, sclk = seen
            gap = f"+{blk - sb} blocks" if sb is not None else "?"
            extra = (f" breach seen at block {sb} (ts {sts}): {gap}; seen->final-seen "
                     f"{self.clock() - sclk:.1f}s")  # fmt: skip
        log.info("[keeper] cover %d on %s final: tx %s mined in block %d status=%s wall=%.3f%s", cid, b.label,
                 tx.hash, blk, r.get("status"), self.wall(), extra)  # fmt: skip

    def _update_mode(self, prices: Mapping[str, Mapping[int, int | None]], t: float) -> None:
        """Fast mode while an active cover's oracle price is within ``near_ppm`` of its level (or past it),
        for at most ``fast_max_s`` per approach; an approach ends when the price leaves the band."""
        near: dict[tuple[str, int], tuple[str, float]] = {}
        for b in self.books:
            px_by_perp = prices.get(b.source or "", {})
            for c in b.active.values():
                px = px_by_perp.get(c.perp_index)
                if px is None or px <= 0:
                    continue
                gap = px - c.level if c.is_long else c.level - px  # <= 0: breached
                if gap > 0:
                    self._seen.pop((b.pool, c.id), None)  # not breached (any more): a new breach logs anew
                if self.near_ppm > 0 and gap * PPM <= self.near_ppm * px:
                    near[(b.pool, c.id)] = (b.label, gap * 10_000 / px)
        for k in [k for k in self._near_since if k not in near]:
            del self._near_since[k]
            log.info("[keeper] cover %d on %s left the %.2f%% band", k[1], self._label(k[0]),
                     self.near_ppm / 10_000)  # fmt: skip
        for k, (label, bps) in near.items():
            if k not in self._near_since:
                self._near_since[k] = t
                log.info("[keeper] cover %d on %s within %.2f%% of its level (gap %.1f bps)", k[1], label,
                         self.near_ppm / 10_000, bps)  # fmt: skip
        live = [k for k in near if t - self._near_since[k] < self.fast_max_s]
        for k in near:
            if k not in live and k not in self._capped:
                log.warning("[keeper] fast mode for cover %d on %s capped after %.0f min; polling every "
                            "--poll until it leaves the band and returns", k[1], near[k][0],
                            self.fast_max_s / 60)  # fmt: skip
        self._capped = {k for k in near if k not in live}
        fast = bool(live)
        if fast != self.fast:
            log.info("[keeper] mode %s (%d cover(s) near; rpm so far %d)", "fast" if fast else "normal",
                     len(live), self.rpc.per_minute())  # fmt: skip
        self.fast = fast

    def _label(self, pool: str) -> str:
        return next((b.label for b in self.books if b.pool == pool), pool)

    def _probe_heads(self, t: float) -> str:
        """``--timing``: every poll, eth_blockNumber on each healthy endpoint (logged next to the read's
        block). Fast mode with several endpoints: the other healthy ones every ``head_probe_every_s`` (lag
        check for the next decision read). Returns a log suffix."""
        if self.timing:
            eps = self.rpc.healthy()
        elif self.fast and len(self.rpc.endpoints) > 1 and (
                self._probe_at is None or t - self._probe_at >= self.head_probe_every_s):  # fmt: skip
            eps = [e for e in self.rpc.healthy() if e is not self.rpc.last]
        else:
            return ""
        self._probe_at = t
        last = self.rpc.last
        heads = {host(e.url): self.rpc.probe_head(e) for e in eps}
        self.rpc.last = last  # probes do not change which endpoint served the decision read
        return " heads=" + ",".join(f"{h}:{v}" for h, v in heads.items())

    def run(self, poll_s: float = DEFAULT_POLL_S, duration_s: float = 0.0,
            sleep: Callable[[float], None] = time.sleep,
            stop: Callable[[], bool] = lambda: False) -> None:  # fmt: skip
        """Poll every ``poll_s`` (``fast_poll_s`` while fast mode is on) until ``duration_s`` or ``stop``."""
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
                every = self.fast_poll_s if self.fast else poll_s
                sleep(max(0.0, every - (self.clock() - t)))
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
    pool_version = (os.environ.get("NUMERA_KEEPER_POOL_VERSION") or "").strip() or None
    ap.add_argument("--pool-version", default=pool_version,
                    choices=["v2"], help="with no --pool: watch only the deployments file's pools of this "
                    "version (env NUMERA_KEEPER_POOL_VERSION; default: all)")  # fmt: skip
    ap.add_argument("--price-source", default=None, help="override pool.priceSource() (single pool only)")
    ap.add_argument("--poll", type=float, default=DEFAULT_POLL_S,
                    help=f"seconds between polls (default {DEFAULT_POLL_S:g})")  # fmt: skip
    env = os.environ

    def env_num(name: str, default: float, cast: Callable[[str], Any] = float) -> Any:
        """``name`` from the environment, or ``default`` when unset or blank (a blank value never crashes)."""
        raw = env.get(name, "").strip()
        return cast(raw) if raw else default
    ap.add_argument("--fast-poll", type=float,
                    default=env_num("NUMERA_KEEPER_FAST_POLL", DEFAULT_FAST_POLL_S),
                    help="seconds between polls while a cover is near its level "
                         f"(env NUMERA_KEEPER_FAST_POLL; default {DEFAULT_FAST_POLL_S:g})")  # fmt: skip
    ap.add_argument("--near-pct", type=float,
                    default=env_num("NUMERA_KEEPER_NEAR_PCT", DEFAULT_NEAR_PCT),
                    help="fast mode when an active cover's oracle price is within this %% of its level (0 = "
                         f"never; env NUMERA_KEEPER_NEAR_PCT; default {DEFAULT_NEAR_PCT:g})")  # fmt: skip
    ap.add_argument("--fast-max-min", type=float,
                    default=env_num("NUMERA_KEEPER_FAST_MAX_MIN", DEFAULT_FAST_MAX_MIN),
                    help="fast mode lasts at most this many minutes per approach of a cover to its level "
                         f"(env NUMERA_KEEPER_FAST_MAX_MIN; default {DEFAULT_FAST_MAX_MIN:g})")  # fmt: skip
    ap.add_argument("--max-head-lag", type=int, default=DEFAULT_MAX_HEAD_LAG,
                    help="fast mode: a decision read avoids an RPC whose head is more than this many blocks "
                         f"behind a healthy one (default {DEFAULT_MAX_HEAD_LAG})")  # fmt: skip
    ap.add_argument("--timing", action="store_true",
                    help="latency debug: eth_blockNumber on every healthy RPC each poll, logged next to the "
                         "decision read's block (costs one request per RPC per poll)")  # fmt: skip
    ap.add_argument("--dry-run", action="store_true", help="read only: log the txs it would send")
    ap.add_argument("--duration", type=float, default=0.0, help="stop after this many seconds (0 = never)")
    ap.add_argument("--max-fee-gwei", type=float,
                    default=env_num("NUMERA_KEEPER_MAX_FEE_GWEI", DEFAULT_MAX_FEE_GWEI),
                    help=f"maxFeePerGas ceiling in gwei (default {DEFAULT_MAX_FEE_GWEI:g})")  # fmt: skip
    ap.add_argument("--max-tx-per-poll", type=int,
                    default=env_num("NUMERA_KEEPER_MAX_TX_PER_POLL", DEFAULT_MAX_TX_PER_POLL, int),
                    help=f"txs sent per poll at most (default {DEFAULT_MAX_TX_PER_POLL})")  # fmt: skip
    ap.add_argument("--min-balance", type=float,
                    default=env_num("NUMERA_KEEPER_MIN_BALANCE_HYPE", DEFAULT_MIN_BALANCE_HYPE),
                    help=f"warn below this HYPE balance (default {DEFAULT_MIN_BALANCE_HYPE:g})")  # fmt: skip
    ap.add_argument("--balance-every", type=float, default=DEFAULT_BALANCE_EVERY_S,
                    help=f"seconds between balance checks (default {DEFAULT_BALANCE_EVERY_S:g})")  # fmt: skip
    ap.add_argument("--alert-logs-every", type=float, default=DEFAULT_LOG_EVERY_S,
                    help="seconds between v2 alert log scans (eth_getLogs over v2 pools; 0 = off; "
                         f"default {DEFAULT_LOG_EVERY_S:g})")  # fmt: skip
    ap.add_argument("--alert-lookback-blocks", type=int, default=DEFAULT_LOOKBACK_BLOCKS,
                    help="blocks before startup that the first v2 alert scan covers "
                         f"(default {DEFAULT_LOOKBACK_BLOCKS})")  # fmt: skip
    ap.add_argument("--alert-head-lag-blocks", type=int, default=DEFAULT_HEAD_LAG_BLOCKS,
                    help="v2 alert log scans end this many blocks behind the head (the RPC's log node "
                         f"lags; default {DEFAULT_HEAD_LAG_BLOCKS})")  # fmt: skip
    ap.add_argument("--keeper-address", default=None,
                    help="address whose balance a --dry-run reports (default: KEEPER_KEY's, else the "
                         "deployments file `keeper`)")  # fmt: skip
    args = ap.parse_args(argv)
    if not args.max_fee_gwei > 0:  # also rejects NaN
        ap.error("--max-fee-gwei must be > 0")
    if args.max_tx_per_poll < 1:
        ap.error("--max-tx-per-poll must be >= 1")
    if args.alert_head_lag_blocks < 0:
        ap.error("--alert-head-lag-blocks must be >= 0")
    if not args.poll > 0 or not args.fast_poll > 0:
        ap.error("--poll and --fast-poll must be > 0")
    if not args.near_pct >= 0 or not args.fast_max_min >= 0 or args.max_head_lag < 0:
        ap.error("--near-pct, --fast-max-min and --max-head-lag must be >= 0")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    key = os.environ.get("KEEPER_KEY", "").strip()
    if not key and not args.dry_run:
        raise SystemExit("set KEEPER_KEY (or pass --dry-run)")
    dep = load_deployment(args.deployments)
    if args.price_source and (args.pool is None or len(args.pool) != 1):
        raise SystemExit("--price-source needs exactly one --pool")
    urls = resolve_rpcs(args.rpc, os.environ.get("NUMERA_RPCS"), dep.rpc if dep else None)
    rpc = FailoverRpc(urls, max_head_lag=args.max_head_lag)
    log.info("[keeper] rpcs: %s%s", " > ".join(host(u) for u in urls), " (dry run)" if args.dry_run else "")
    plans = plan_pools(dep, args.pool, args.pool_version)
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
    log.info("[keeper] polling: every %gs, every %gs while a cover is within %g%% of its level (at most %g "
             "min per approach); decision reads avoid an rpc > %d blocks behind%s", args.poll, args.fast_poll,
             args.near_pct, args.fast_max_min, args.max_head_lag,
             "; --timing on" if args.timing else "")  # fmt: skip
    keeper = Keeper(rpc, plans, watch_perps=dep.perps.values() if dep else (), sender=sender,
                    dry_run=args.dry_run, price_source_override=args.price_source,
                    max_tx_per_poll=args.max_tx_per_poll, balance_address=balance_addr,
                    min_balance_wei=int(args.min_balance * WEI_PER_HYPE),
                    balance_every_s=args.balance_every, alert_logs_every_s=args.alert_logs_every,
                    alert_lookback_blocks=args.alert_lookback_blocks,
                    alert_head_lag_blocks=args.alert_head_lag_blocks, fast_poll_s=args.fast_poll,
                    near_pct=args.near_pct, fast_max_s=args.fast_max_min * 60,
                    timing=args.timing)  # fmt: skip
    keeper.start()
    keeper.run(args.poll, args.duration)


if __name__ == "__main__":
    main()
