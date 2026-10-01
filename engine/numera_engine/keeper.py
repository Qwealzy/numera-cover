"""Keeper: watch CoverPool covers; trigger(id) on breach, expire(id) after expiry (ARCHITECTURE §5, §8).

    KEEPER_KEY=0x... python -m numera_engine.keeper                        # all pools in deployments file
    KEEPER_KEY=0x... python -m numera_engine.keeper --pool 0xA --pool 0xB  # chosen pools

Design: the decision is a pure function (``decide``) over a cover book rebuilt from events; the chain I/O
around it (``Keeper``) is thin. Prices come from the pool's own IPriceSource (``pool.priceSource()`` then
``oraclePx6(uint32)``: what ``trigger`` itself checks, so a decision cannot disagree with the contract); only
if that getter cannot be read does it fall back to the Info API oracle price. Event scanning starts at the
pool's deploy block, taken from the receipt of the deploy tx listed in deployments/<env>.json (decision
D10), never at block 0. Several pools can be watched by one process (``MultiKeeper``).
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
    {"type": "function", "name": "priceSource", "stateMutability": "view", "inputs": [],
     "outputs": [{"name": "", "type": "address"}]},
]  # fmt: skip
PRICE_SOURCE_ABI: list[dict[str, Any]] = [
    {"type": "function", "name": "oraclePx6", "stateMutability": "view",
     "inputs": [{"name": "perpIndex", "type": "uint32"}], "outputs": [{"name": "", "type": "uint64"}]},
]  # fmt: skip
EVENTS = ("CoverPurchased", "CoverTriggered", "CoverExpired")


@dataclass(frozen=True)
class PoolPlan:
    pool: str
    from_block: int
    label: str


def plan_pools(
    deployment: Any,
    pools: list[str] | None,
    from_block: int | None,
    receipt_block: Callable[[str], int],
) -> list[PoolPlan]:
    """Which pools to watch and from which block (pure; ``receipt_block(tx_hash)`` is injected).

    pools None -> every pool in the deployment. Start block: explicit ``from_block`` if given, else the
    block of the pool's deploy tx receipt. A pool with neither is an error (never scan from 0).
    """
    if pools is None:
        if deployment is None or not deployment.pools:
            raise ValueError("no --pool given and no pools in the deployments file")
        pools = [p.pool for p in deployment.pools]
    out = []
    for addr in pools:
        info = deployment.find(addr) if deployment is not None else None
        label = info.name if info else addr
        if from_block is not None:
            start = from_block
        elif info is not None and info.deploy_tx:
            start = int(receipt_block(info.deploy_tx))
        else:
            raise ValueError(f"pool {addr}: not in the deployments file and no --from-block given")
        out.append(PoolPlan(addr.lower(), start, label))
    return out


class Keeper:
    def __init__(
        self,
        rpc_url: str,
        pool: str,
        private_key: str,
        from_block: int,
        price_source: str | None = None,
        info_url: str | None = None,
        log_chunk: int = 1000,
        w3: Any = None,
        label: str | None = None,
    ) -> None:
        from eth_account import Account
        from web3 import Web3

        self.w3 = w3 or Web3(Web3.HTTPProvider(rpc_url))
        self.chain_id = int(self.w3.eth.chain_id)
        if self.chain_id == MAINNET_CHAIN_ID:
            raise RuntimeError("keeper refuses to run on chainId 999 (mainnet)")
        self.label = label or pool
        self.account = Account.from_key(private_key)
        self.pool = self.w3.eth.contract(address=Web3.to_checksum_address(pool), abi=POOL_ABI)
        if price_source is None:
            try:
                price_source = self.pool.functions.priceSource().call()
            except Exception as exc:  # noqa: BLE001 - fall back to the Info API below
                log.warning("[%s] cannot read pool.priceSource(): %s; using Info API prices", self.label, exc)
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
        self.next_block = int(from_block)
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
                    log.warning("[%s] price read failed for perp %s: %s", self.label, i, exc)
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
                log.warning("[%s] %s(%s) failed: %s", self.label, a.kind, a.cover_id, exc)
                continue
            self.sent[a.cover_id] = txh
            log.info("[%s] %s(%s) sent %s (%s)", self.label, a.kind, a.cover_id, txh, a.reason)
            done.append((a, txh))
        return done


class MultiKeeper:
    """Steps several pool keepers in turn (one process, one key)."""

    def __init__(self, keepers: list[Keeper]) -> None:
        self.keepers = keepers

    def step(self) -> list[tuple[str, Action, str]]:
        out = []
        for k in self.keepers:
            try:
                out += [(k.label, a, h) for a, h in k.step()]
            except Exception as exc:  # noqa: BLE001 - one pool's RPC hiccup must not stop the others
                log.warning("[%s] step failed: %s", k.label, exc)
        return out

    def run(self, poll_s: float = 1.0, stop: Callable[[], bool] = lambda: False) -> None:
        while not stop():
            self.step()
            time.sleep(poll_s)


def main(argv: list[str] | None = None) -> None:
    from .deployments import default_path
    from .deployments import load as load_deployment

    ap = argparse.ArgumentParser(description="Numera keeper")
    ap.add_argument("--deployments", default=str(default_path("testnet")), help="deployments/<env>.json")
    ap.add_argument("--rpc", default=None, help="EVM RPC (default: `rpc` in the deployments file)")
    ap.add_argument("--pool", action="append", default=None, help="pool address (repeatable; default: all)")
    ap.add_argument("--from-block", type=int, default=None, help="override the deploy-block start")
    ap.add_argument("--price-source", default=None, help="override pool.priceSource() (single pool only)")
    ap.add_argument("--info-url", default=None)
    ap.add_argument("--poll", type=float, default=1.0)
    args = ap.parse_args(argv)
    key = os.environ.get("KEEPER_KEY", "").strip()
    if not key:
        raise SystemExit("set KEEPER_KEY")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    dep = load_deployment(args.deployments)
    rpc = args.rpc or (dep.rpc if dep else None)
    if not rpc:
        raise SystemExit("no --rpc and no rpc in the deployments file")
    if args.price_source and (args.pool is None or len(args.pool) != 1):
        raise SystemExit("--price-source needs exactly one --pool")
    from web3 import Web3

    w3 = Web3(Web3.HTTPProvider(rpc))
    plans = plan_pools(dep, args.pool, args.from_block,
                       lambda tx: w3.eth.get_transaction_receipt(tx)["blockNumber"])  # fmt: skip
    keepers = []
    for plan in plans:
        log.info("watching %s (%s) from block %s", plan.label, plan.pool, plan.from_block)
        keepers.append(Keeper(rpc, plan.pool, key, plan.from_block, args.price_source, args.info_url,
                              w3=w3, label=plan.label))  # fmt: skip
    MultiKeeper(keepers).run(args.poll)


if __name__ == "__main__":
    main()
