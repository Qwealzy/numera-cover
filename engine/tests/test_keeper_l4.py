"""Keeper tx hygiene (audit L4): fee ceiling, replace-by-fee, txs-per-poll cap, low-balance warning."""

import logging

import pytest
from eth_account.typed_transactions import TypedTransaction
from hexbytes import HexBytes
from test_keeper_poll import POOL_A, POOL_B, FakeChain

from numera_engine.keeper import (
    GWEI,
    RESEND_AFTER_S,
    WEI_PER_HYPE,
    GasCapError,
    Keeper,
    PoolPlan,
    Sender,
    SentTx,
    bump,
    choose_fees,
    choose_nonce,
)
from numera_engine.rpc import FailoverRpc

KEEPER = "0x9a809EF608F5AE30Ddd26708cC6794bD7dad7a1B"
ANVIL_KEY1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"  # public anvil key #1
BASE = GWEI // 10  # testnet base fee 0.1 gwei
CAP = 10 * GWEI


# -- pure fee / nonce rules ------------------------------------------------------------------------------


def test_fresh_tx_fees_are_two_base_plus_tip_and_clipped_to_the_cap():
    assert choose_fees(BASE, 0, CAP) == (2 * BASE, 0)
    assert choose_fees(6 * GWEI, GWEI, CAP) == (CAP, GWEI)  # 13 gwei wanted, clipped to 10
    with pytest.raises(GasCapError):
        choose_fees(CAP + 1, 0, CAP)  # base fee itself above the ceiling: wait, do not send


def test_replacement_bumps_both_fees_by_more_than_ten_percent():
    prev = SentTx("0xaa", 7, 2 * BASE, 0)
    max_fee, tip = choose_fees(BASE, 0, CAP, prev)
    assert max_fee >= prev.max_fee * 1.1 and tip >= 1 and tip > prev.tip
    assert bump(0) == 1 and bump(800) == 901
    with pytest.raises(GasCapError):
        choose_fees(BASE, 0, CAP, SentTx("0xaa", 7, CAP, 0))  # a valid replacement would exceed the cap


def test_nonce_after_a_dropped_lower_nonce_is_not_reused():
    # triggers went out at nonces 5 and 6; tx 5 was dropped (A no longer due), so 6 can never be mined
    assert choose_nonce(5, 5, SentTx("0xb", 6, 2 * BASE, 0)) == 5


def test_nonce_rbf_reuses_a_tx_that_is_really_pending():
    assert choose_nonce(5, 7, SentTx("0xb", 6, 2 * BASE, 0)) == 6  # latest <= 6 < pending
    assert choose_nonce(5, 6, SentTx("0xb", 6, 2 * BASE, 0)) == 6  # not in the pool any more: 6 again, fresh


def test_nonce_reuses_a_still_pending_tx_and_moves_on_after_it_is_mined():
    prev = SentTx("0xaa", 7, 2 * BASE, 0)
    assert choose_nonce(latest=7, pending=9, prev=prev) == 7  # unmined: replace it, do not queue behind
    assert choose_nonce(latest=8, pending=8, prev=prev) == 8  # mined (reverted): fresh nonce
    assert choose_nonce(latest=7, pending=9, prev=None) == 9


# -- Sender: real signing against a fake node ----------------------------------------------------------


class FakeNode:
    def __init__(self, latest=7, pending=7, base=BASE, batches=True):
        self.latest, self.pending, self.base, self.raw = latest, pending, base, []
        self.batches, self.posts, self.methods = batches, 0, []

    def __call__(self, url, payload, timeout):
        self.posts += 1
        if isinstance(payload, list):
            if not self.batches:
                return 200, {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "no batch"}}
            return 200, [self.one(p) for p in payload]
        return 200, self.one(payload)

    def one(self, payload):
        m, p = payload["method"], payload["params"]
        self.methods.append(m)
        res = {
            "eth_chainId": "0x3e6",
            "eth_getBlockByNumber": {"baseFeePerGas": hex(self.base), "timestamp": "0x1", "number": "0x1"},
            "eth_maxPriorityFeePerGas": "0x0",
            "eth_estimateGas": hex(60_000),
        }.get(m)
        if m == "eth_getTransactionCount":
            res = hex(self.latest if p[1] == "latest" else self.pending)
        if m == "eth_sendRawTransaction":
            self.raw.append(p[0])
            res = "0x" + f"{len(self.raw):064x}"
        assert res is not None, m
        return {"jsonrpc": "2.0", "id": payload["id"], "result": res}


def decode(raw_hex):
    tx = TypedTransaction.from_bytes(HexBytes(raw_hex)).as_dict()
    return tx["nonce"], tx["maxFeePerGas"], tx["maxPriorityFeePerGas"]


def test_sender_caps_fees_and_replaces_a_pending_tx_on_the_same_nonce():
    from numera_engine.keeper import Action

    node = FakeNode(latest=7, pending=7)
    clk = Clock()
    s = Sender(FailoverRpc(["https://fake/evm"], post=node), ANVIL_KEY1, max_fee_wei=CAP, clock=clk)
    a = Action("trigger", 1, "test")
    first = s.send(POOL_A, a)
    assert decode(node.raw[0]) == (7, 2 * BASE, 0) == (first.nonce, first.max_fee, first.tip)
    node.pending = 8  # our tx is pending, still unmined (latest 7): resend must replace it
    second = s.send(POOL_A, a, prev=first)
    nonce, max_fee, tip = decode(node.raw[1])
    assert nonce == 7 and max_fee >= first.max_fee * 1.1 and tip > first.tip and max_fee <= CAP
    node.latest = node.pending = 8  # mined (e.g. reverted): next nonce, fresh fees
    third = s.send(POOL_A, a, prev=second)
    assert decode(node.raw[2]) == (8, 2 * BASE, 0) and third.nonce == 8
    node.base = CAP + 1
    clk.t += 2  # a later poll: the base fee cached by the sends above (BASE_FEE_TTL_S) is re-read
    with pytest.raises(GasCapError):
        s.send(POOL_A, a)
    assert len(node.raw) == 3  # nothing sent above the ceiling


def test_sender_fresh_trigger_is_two_round_trips_with_the_polled_base_fee():
    from numera_engine.keeper import Action, calldata

    node = FakeNode(latest=7, pending=9)
    rpc = FailoverRpc(["https://fake/evm"], post=node)
    s = Sender(rpc, ANVIL_KEY1, max_fee_wei=CAP)  # eth_chainId once, cached
    node.posts, node.methods = 0, []
    tx = s.send(POOL_A, Action("trigger", 3, "t"), base_fee=BASE)
    assert node.posts == 2 and s.last_requests == 2  # one batch + eth_sendRawTransaction
    assert node.methods == ["eth_getTransactionCount", "eth_estimateGas", "eth_maxPriorityFeePerGas",
                            "eth_sendRawTransaction"]  # fmt: skip
    assert decode(node.raw[0]) == (9, 2 * BASE, 0) and tx.gas == 72_000  # 60k estimate + 20 %
    raw = TypedTransaction.from_bytes(HexBytes(node.raw[0])).as_dict()
    assert "0x" + bytes(raw["data"]).hex() == calldata(Action("trigger", 3, "t")) and raw["chainId"] == 998
    node.posts, node.methods = 0, []
    s.send(POOL_A, Action("trigger", 4, "t"))  # no base fee given: read in the same batch; tip cached
    assert node.posts == 2 and node.methods == ["eth_getTransactionCount", "eth_estimateGas",
                                                "eth_getBlockByNumber", "eth_sendRawTransaction"]  # fmt: skip
    node.posts, node.methods = 0, []
    s.clock = lambda: s._base_at + 0.5  # another send in the same poll reuses that base fee
    s.send(POOL_A, Action("trigger", 5, "t"))
    assert "eth_getBlockByNumber" not in node.methods and node.posts == 2
    s.clock = lambda: s._base_at + 1.0  # next poll: read again
    node.methods = []
    s.send(POOL_A, Action("trigger", 6, "t"))
    assert "eth_getBlockByNumber" in node.methods


def test_sender_works_on_a_node_without_batches_and_never_sends_a_reverting_trigger():
    from numera_engine.keeper import Action

    node = FakeNode(latest=7, pending=7, batches=False)
    s = Sender(FailoverRpc(["https://fake/evm"], post=node), ANVIL_KEY1, max_fee_wei=CAP)
    s.send(POOL_A, Action("trigger", 1, "t"), base_fee=BASE)
    assert decode(node.raw[0]) == (7, 2 * BASE, 0)

    class Reverting(FakeNode):
        def one(self, payload):
            if payload["method"] == "eth_estimateGas":
                err = {"code": 3, "message": "execution reverted: NotBreached"}
                return {"jsonrpc": "2.0", "id": payload["id"], "error": err}
            return super().one(payload)

    node = Reverting()
    s = Sender(FailoverRpc(["https://fake/evm"], post=node), ANVIL_KEY1, max_fee_wei=CAP)
    with pytest.raises(RuntimeError, match="would revert"):
        s.send(POOL_A, Action("trigger", 1, "t"), base_fee=BASE)
    assert node.raw == []


def test_sender_refuses_mainnet():
    def post(url, payload, timeout):
        return 200, {"jsonrpc": "2.0", "id": 1, "result": "0x3e7"}

    with pytest.raises(RuntimeError, match="999"):
        Sender(FailoverRpc(["https://fake/evm"], post=post), ANVIL_KEY1)


# -- Keeper: per-poll cap, resend with prev, balance warning ---------------------------------------------


class ChainWithBalance(FakeChain):
    def __init__(self, balance=0):
        super().__init__()
        self.balance = balance

    def __call__(self, url, payload, timeout):
        if payload["method"] == "eth_getBalance":
            self.methods.append("eth_getBalance")
            return 200, {"result": hex(self.balance)}
        if payload["method"] == "eth_getTransactionReceipt":  # the keeper's timing log after a cover is final
            self.methods.append("eth_getTransactionReceipt")
            return 200, {"result": {"blockNumber": "0x10", "status": "0x1"}}
        return super().__call__(url, payload, timeout)


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


class FakeSender:
    def __init__(self):
        self.calls = []

    def send(self, pool, action, prev=None, base_fee=None, ep=None):
        self.calls.append((pool, action.cover_id, prev))
        return SentTx(f"0x{len(self.calls):064x}", 100 + action.cover_id, 2 * BASE, 0)


def make(chain, clock, **kw):
    rpc = FailoverRpc(["https://fake/evm"], post=chain, clock=lambda: 0.0)
    plans = [PoolPlan(POOL_A, "hypercore"), PoolPlan(POOL_B, "mock")]
    k = Keeper(rpc, plans, watch_perps=[3], clock=clock, **kw)
    k.start()
    return k


def test_txs_per_poll_are_capped_and_the_rest_go_next_poll():
    chain, clk = ChainWithBalance(), Clock()
    for _ in range(4):
        chain.buy(POOL_A, is_long=False, level=79_000_000_000)  # short, already breached
    for _ in range(3):
        chain.buy(POOL_B, is_long=False, level=79_000_000_000)
    k = make(chain, clk, dry_run=True, max_tx_per_poll=3)
    assert len(k.poll()) == 3 and len(k.poll()) == 3 and len(k.poll()) == 1 and k.poll() == []
    with pytest.raises(ValueError):
        Keeper(k.rpc, [PoolPlan(POOL_A, "a")], dry_run=True, max_tx_per_poll=0)


def test_triggers_go_before_expiries_across_pools():
    chain, clk = ChainWithBalance(), Clock()
    chain.buy(POOL_A, expiry=chain.ts - 1)  # expired
    chain.buy(POOL_B, is_long=False, level=79_000_000_000)  # breached
    k = make(chain, clk, dry_run=True, max_tx_per_poll=1)
    assert [(a.kind, lbl) for lbl, a, _ in k.poll()] == [("trigger", "mock")]
    assert [(a.kind, lbl) for lbl, a, _ in k.poll()] == [("expire", "hypercore")]


def test_resend_after_30s_passes_the_previous_tx_for_replace_by_fee():
    chain, clk = ChainWithBalance(), Clock()
    chain.buy(POOL_A, is_long=False, level=79_000_000_000)
    sender = FakeSender()
    k = make(chain, clk, sender=sender)
    k.poll()
    clk.t = RESEND_AFTER_S - 1
    k.poll()
    assert len(sender.calls) == 1 and sender.calls[0][2] is None
    clk.t = RESEND_AFTER_S + 1
    k.poll()
    assert len(sender.calls) == 2 and sender.calls[1][2] == SentTx(f"0x{1:064x}", 101, 2 * BASE, 0)
    chain.covers[POOL_A][1][8] = 2  # Paid
    k.poll()
    assert k.txs[POOL_A] == {}
    assert chain.methods.count("eth_getTransactionReceipt") == 1  # timing log: where our tx landed, once


class CappedSender(FakeSender):
    def __init__(self):
        super().__init__()
        self.capped = True

    def send(self, pool, action, prev=None, base_fee=None, ep=None):
        if self.capped:
            self.calls.append((pool, action.cover_id, prev))
            raise GasCapError("base fee above the cap")
        return super().send(pool, action, prev)


def test_fresh_tx_over_the_gas_cap_is_not_marked_sent_and_retries_next_poll():
    chain, clk = ChainWithBalance(), Clock()
    chain.buy(POOL_A, is_long=False, level=79_000_000_000)
    sender = CappedSender()
    k = make(chain, clk, sender=sender)
    assert k.poll() == [] and k.sent[POOL_A] == {} and k.txs[POOL_A] == {}
    sender.capped = False
    clk.t = 3.0  # next poll, well inside RESEND_AFTER_S
    assert [(a.kind, a.cover_id) for _, a, _ in k.poll()] == [("trigger", 1)]
    assert len(sender.calls) == 2 and sender.calls[-1][2] is None  # poll 1 held at the cap, poll 2 sent fresh


def test_max_fee_must_be_positive():
    def post(url, payload, timeout):
        return 200, {"jsonrpc": "2.0", "id": 1, "result": "0x3e6"}

    with pytest.raises(ValueError):
        Sender(FailoverRpc(["https://fake/evm"], post=post), ANVIL_KEY1, max_fee_wei=0)
    from numera_engine.keeper import main

    for bad in ("0", "-1", "nan"):
        with pytest.raises(SystemExit):
            main(["--dry-run", "--max-fee-gwei", bad])


def test_low_balance_warns_at_startup_and_is_rechecked_every_n_seconds(caplog):
    chain, clk = ChainWithBalance(balance=WEI_PER_HYPE // 1000), Clock()  # 0.001 HYPE
    with caplog.at_level(logging.INFO, logger="numera.keeper"):
        k = make(chain, clk, dry_run=True, balance_address=KEEPER, balance_every_s=600)
    warn = [r for r in caplog.records if r.levelno == logging.WARNING and "LOW BALANCE" in r.getMessage()]
    assert len(warn) == 1 and KEEPER in warn[0].getMessage() and k.last_balance == WEI_PER_HYPE // 1000
    chain.balance = WEI_PER_HYPE
    caplog.clear()
    k.poll()
    assert chain.methods.count("eth_getBalance") == 1  # not yet due
    clk.t = 600
    with caplog.at_level(logging.INFO, logger="numera.keeper"):
        k.poll()
    assert chain.methods.count("eth_getBalance") == 2
    assert any("balance" in r.getMessage() and "1.000000 HYPE" in r.getMessage() for r in caplog.records)
    assert not any("LOW BALANCE" in r.getMessage() for r in caplog.records)


def test_no_balance_address_means_no_balance_reads():
    chain = ChainWithBalance()
    k = make(chain, Clock(), dry_run=True)
    k.poll()
    assert "eth_getBalance" not in chain.methods and k.last_balance is None
