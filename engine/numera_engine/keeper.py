"""Keeper: watch CoverPool covers; trigger(id) on breach, expire(id) after expiry (ARCHITECTURE §5, §8).

    KEEPER_KEY=0x... python -m numera_engine.keeper --rpc URL --pool 0xPool [--price-source 0xSrc]

Design: the decision is a pure function (``decide``) over a cover book rebuilt from events; the chain I/O
around it (``Keeper``) is thin. Prices come from the pool's IPriceSource (``oraclePx6(uint32)``, what
``trigger`` itself checks, so a decision based on it cannot disagree with the contract) or, without a price
source address, from the network's Info API oracle price (px6).
Never sends transactions to chainId 999.
"""

from __future__ import annotations

import argparse
import logging
import os
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, replace
from enum import IntEnum
from typing import Any

log = logging.getLogger("numera.keeper")

MAINNET_CHAIN_ID = 999


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


def apply_event(book: dict[int, Cover], name: str, args: Mapping[str, Any]) -> None:
    """Fold one pool event into the book (events must be applied in chain order)."""
    cid = int(args["coverId"])
    if name == "CoverPurchased":
        book[cid] = Cover(
            id=cid,
            buyer=str(args["buyer"]),
            perp_index=int(args["perpIndex"]),
            is_long=bool(args["isLong"]),
            level=int(args["level"]),
            payout=int(args["payout"]),
            expiry=int(args["expiry"]),
        )
    elif name == "CoverTriggered":
        if cid in book:
            book[cid] = replace(book[cid], status=Status.PAID)
    elif name == "CoverExpired":
        if cid in book:
            book[cid] = replace(book[cid], status=Status.EXPIRED)
    else:
        raise ValueError(f"unknown event {name}")


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


# -- chain I/O (thin; exercised against testnet by the orchestrator) --------------------------------

POOL_ABI: list[dict[str, Any]] = [
    {"type": "event", "name": "CoverPurchased", "anonymous": False, "inputs": [
        {"name": "coverId", "type": "uint256", "indexed": True},
        {"name": "buyer", "type": "address", "indexed": True},
        {"name": "perpIndex", "type": "uint32", "indexed": True},
        {"name": "isLong", "type": "bool", "indexed": False},
        {"name": "level", "type": "uint64", "indexed": False},
        {"name": "payout", "type": "uint256", "indexed": False},
        {"name": "premium", "type": "uint256", "indexed": False},
        {"name": "expiry", "type": "uint64", "indexed": False}]},
    {"type": "event", "name": "CoverTriggered", "anonymous": False, "inputs": [
        {"name": "coverId", "type": "uint256", "indexed": True},
        {"name": "oraclePx", "type": "uint64", "indexed": False},
        {"name": "caller", "type": "address", "indexed": False}]},
    {"type": "event", "name": "CoverExpired", "anonymous": False, "inputs": [
        {"name": "coverId", "type": "uint256", "indexed": True}]},
    {"type": "function", "name": "trigger", "stateMutability": "nonpayable",
     "inputs": [{"name": "coverId", "type": "uint256"}], "outputs": []},
    {"type": "function", "name": "expire", "stateMutability": "nonpayable",
     "inputs": [{"name": "coverId", "type": "uint256"}], "outputs": []},
]  # fmt: skip
PRICE_SOURCE_ABI: list[dict[str, Any]] = [
    {"type": "function", "name": "oraclePx6", "stateMutability": "view",
     "inputs": [{"name": "perpIndex", "type": "uint32"}], "outputs": [{"name": "", "type": "uint64"}]},
]  # fmt: skip
EVENTS = ("CoverPurchased", "CoverTriggered", "CoverExpired")


class Keeper:
    def __init__(
        self,
        rpc_url: str,
        pool: str,
        private_key: str,
        price_source: str | None = None,
        info_url: str | None = None,
        from_block: int = 0,
        log_chunk: int = 1000,
    ) -> None:
        from eth_account import Account
        from web3 import Web3

        self.w3 = Web3(Web3.HTTPProvider(rpc_url))
        self.chain_id = int(self.w3.eth.chain_id)
        if self.chain_id == MAINNET_CHAIN_ID:
            raise RuntimeError("keeper refuses to run on chainId 999 (mainnet)")
        self.account = Account.from_key(private_key)
        self.pool = self.w3.eth.contract(address=Web3.to_checksum_address(pool), abi=POOL_ABI)
        self.source = (
            self.w3.eth.contract(address=Web3.to_checksum_address(price_source), abi=PRICE_SOURCE_ABI)
            if price_source
            else None
        )
        self.info = None
        if self.source is None:
            from .data import TESTNET_INFO_URL, InfoClient

            self.info = InfoClient(info_url or TESTNET_INFO_URL, cache_dir=None)
        self.book: dict[int, Cover] = {}
        self.next_block = from_block
        self.log_chunk = log_chunk
        self.sent: dict[int, str] = {}  # cover id -> tx hash (avoid resending while pending)

    def sync(self) -> int:
        head = int(self.w3.eth.block_number)
        logs: list[Any] = []
        start = self.next_block
        while start <= head:
            end = min(head, start + self.log_chunk - 1)
            for name in EVENTS:
                logs += list(getattr(self.pool.events, name).get_logs(from_block=start, to_block=end))
            start = end + 1
        for ev in sorted(logs, key=lambda e: (e["blockNumber"], e["logIndex"])):
            apply_event(self.book, ev["event"], ev["args"])
        self.next_block = head + 1
        return head

    def prices(self, perps: set[int]) -> dict[int, int | None]:
        out: dict[int, int | None] = {}
        if self.source is not None:
            for i in perps:
                try:
                    out[i] = int(self.source.functions.oraclePx6(i).call())
                except Exception as exc:  # noqa: BLE001 - a bad perp must not stop the loop
                    log.warning("price read failed for perp %s: %s", i, exc)
                    out[i] = None
            return out
        from .data import px6_from_decimal_str

        assert self.info is not None
        _, ctxs = self.info.meta_and_ctxs()
        for i in perps:
            out[i] = px6_from_decimal_str(ctxs[i]["oraclePx"]) if 0 <= i < len(ctxs) else None
        return out

    def send(self, action: Action) -> str:
        fn = getattr(self.pool.functions, action.kind)(action.cover_id)
        tx = fn.build_transaction({
            "from": self.account.address,
            "nonce": self.w3.eth.get_transaction_count(self.account.address, "pending"),
            "chainId": self.chain_id,
        })  # fmt: skip
        signed = self.account.sign_transaction(tx)
        h = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        return "0x" + bytes(h).hex()

    def step(self) -> list[tuple[Action, str]]:
        head = self.sync()
        now = int(self.w3.eth.get_block(head)["timestamp"])
        active = [c for c in self.book.values() if c.status == Status.ACTIVE]
        prices = self.prices({c.perp_index for c in active})
        done = []
        for a in decide(active, prices, now):
            if a.cover_id in self.sent:
                continue
            try:
                txh = self.send(a)
            except Exception as exc:  # noqa: BLE001 - e.g. reverted because price moved back
                log.warning("%s(%s) failed: %s", a.kind, a.cover_id, exc)
                continue
            self.sent[a.cover_id] = txh
            log.info("%s(%s) sent %s (%s)", a.kind, a.cover_id, txh, a.reason)
            done.append((a, txh))
        return done

    def run(self, poll_s: float = 1.0, stop: Callable[[], bool] = lambda: False) -> None:
        while not stop():
            try:
                self.step()
            except Exception as exc:  # noqa: BLE001 - keep the loop alive across RPC hiccups
                log.warning("step failed: %s", exc)
            time.sleep(poll_s)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Numera keeper")
    ap.add_argument("--rpc", required=True)
    ap.add_argument("--pool", required=True)
    ap.add_argument("--price-source", default=None, help="IPriceSource address (default: Info API oracle)")
    ap.add_argument("--info-url", default=None)
    ap.add_argument("--from-block", type=int, default=0)
    ap.add_argument("--poll", type=float, default=1.0)
    args = ap.parse_args(argv)
    key = os.environ.get("KEEPER_KEY", "").strip()
    if not key:
        raise SystemExit("set KEEPER_KEY")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    Keeper(args.rpc, args.pool, key, args.price_source, args.info_url, args.from_block).run(args.poll)


if __name__ == "__main__":
    main()
