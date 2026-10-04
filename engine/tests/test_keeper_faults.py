"""Keeper send path under faults (F18 review): a fault-injecting fake node per RPC endpoint with a real Sender
(real signing). Faults: a lagging endpoint, a send that is rejected or never answers, ``already known``, a
pending count that does not yet include our last tx, and a wrong chain id on one endpoint."""

import logging

import pytest
from eth_abi import encode
from eth_account.typed_transactions import TypedTransaction
from eth_utils import keccak
from hexbytes import HexBytes
from test_keeper_latency import BREACH, LEVEL, NEAR, Clock, TimedChain
from test_keeper_poll import POOL_A, SRC_A

from numera_engine import multicall as mc
from numera_engine.keeper import (
    GWEI,
    RESEND_AFTER_S,
    Action,
    Keeper,
    PoolPlan,
    Sender,
    choose_fees,
    main,
)
from numera_engine.rpc import FailoverRpc

ANVIL_KEY1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"  # public anvil key #1
CAP = 10 * GWEI
BASE = GWEI // 10
A, B = "https://a.example/evm", "https://b.example/evm"


def no_jitter():  # fixed backoff jitter (rand=0.5 -> factor 1.0): no real randomness in the RPC pool
    return 0.5


class FaultError(Exception):
    """Transport failure (connection reset) injected by the fake."""


class FaultNode(TimedChain):
    """One endpoint: TimedChain state (heads, prices, covers) plus the JSON-RPC methods a send uses.

    ``send_mode``: "ok" | "reject" (nonce too low) | "known" (already known: it is in the mempool) |
    "transport" (the node takes the tx, then the POST raises). ``hide_pending``: the pending count lags and
    leaves out our txs.
    estimateGas reverts unless this node's own state has SRC_A perp 3 at or below LEVEL (breached)."""

    def __init__(self, clock, schedule, head=1000, chain_id=998, nonce=7):
        super().__init__(clock, schedule, head=head)
        self.chain_id, self.latest, self.mempool = chain_id, nonce, []
        self.send_mode, self.hide_pending, self.log = "ok", False, []
        self.base = BASE

    def __call__(self, url, payload, timeout):
        if isinstance(payload, list):
            return 200, [self.one(url, p) for p in payload]
        if payload["method"] == "eth_sendRawTransaction" and self.send_mode == "transport":
            self.log.append("eth_sendRawTransaction!")
            if payload["params"][0] not in self.mempool:  # the node took it, the answer was lost
                self.mempool.append(payload["params"][0])
            raise FaultError("connection reset")
        if payload["method"] in ("eth_call", "eth_blockNumber"):
            self.log.append(payload["method"])
            return super().__call__(url, payload, timeout)
        return 200, self.one(url, payload)

    def one(self, url, p):
        m, params = p["method"], p["params"]
        self.log.append(m)

        def ok(res):
            return {"jsonrpc": "2.0", "id": p["id"], "result": res}

        def err(code, msg):
            return {"jsonrpc": "2.0", "id": p["id"], "error": {"code": code, "message": msg}}

        if m == "eth_chainId":
            return ok(hex(self.chain_id))
        if m == "eth_getTransactionCount":
            n = self.latest if params[1] == "latest" or self.hide_pending else self.latest + len(self.mempool)
            return ok(hex(n))
        if m == "eth_estimateGas":
            self.px[SRC_A][3] = [px for t, px in self.schedule if self.clock.t >= t][-1]
            if self.px[SRC_A][3] <= LEVEL:
                return ok(hex(60_000))
            return err(3, "execution reverted: NotBreached")
        if m == "eth_maxPriorityFeePerGas":
            return ok("0x0")
        if m == "eth_getBlockByNumber":
            return ok({"baseFeePerGas": hex(self.base), "number": hex(self.head())})
        if m == "eth_getTransactionReceipt":
            return ok(None)
        if m == "eth_sendRawTransaction":
            raw = params[0]
            if self.send_mode == "reject":
                return err(-32000, "nonce too low")
            self.mempool.append(raw)
            h = "0x" + keccak(HexBytes(raw)).hex()
            return err(-32000, "already known") if self.send_mode == "known" else ok(h)
        raise AssertionError(m)

    def nonces(self):
        return [TypedTransaction.from_bytes(HexBytes(r)).as_dict()["nonce"] for r in self.mempool]


class Net:
    def __init__(self, nodes):
        self.nodes = nodes  # url -> FaultNode

    def __call__(self, url, payload, timeout):
        return self.nodes[url](url, payload, timeout)


def one_node(schedule=((0, BREACH),), **kw):
    clock = Clock()
    node = FaultNode(clock, list(schedule), **kw)
    rpc = FailoverRpc([A], post=Net({A: node}), clock=clock, sleep=clock.sleep, rand=no_jitter)
    return clock, node, rpc


def keeper(rpc, clock, **kw):
    sender = Sender(rpc, ANVIL_KEY1, max_fee_wei=CAP, clock=clock)
    k = Keeper(rpc, [PoolPlan(POOL_A, "a")], watch_perps=[3], sender=sender, clock=clock, **kw)
    k.start()
    return k, sender


# -- 1. nonce / estimate / send go to the endpoint the decision read used --------------------------------


def test_send_uses_the_endpoint_of_the_decision_read_not_a_lagging_priority_one():
    clock = Clock()
    a = FaultNode(clock, [(0, NEAR)], head=995)  # 5 blocks behind, breach not there yet
    b = FaultNode(clock, [(0, NEAR), (0.5, BREACH)], head=1000)
    rpc = FailoverRpc([A, B], post=Net({A: a, B: b}), clock=clock, sleep=clock.sleep, rand=no_jitter)
    k, _ = keeper(rpc, clock)
    a.buy(POOL_A, level=LEVEL)
    b.buy(POOL_A, level=LEVEL)
    k.poll()  # t=0 from A; near -> fast; B's head probed: A lags
    assert k.fast and rpc.lagging(rpc.endpoints[0])
    clock.t = 1.0
    a.log, b.log = [], []
    done = k.poll()  # fresh read from B sees the breach; the send must stay on B
    assert [x[1].cover_id for x in done] == [1] and len(b.mempool) == 1 and a.mempool == []
    assert "eth_estimateGas" not in a.log and "eth_getTransactionCount" not in a.log


def test_pinned_call_falls_back_to_a_fresh_endpoint_when_the_pinned_one_is_cooling():
    clock = Clock()
    a, b = FaultNode(clock, [(0, NEAR)]), FaultNode(clock, [(0, NEAR)])
    rpc = FailoverRpc([A, B], post=Net({A: a, B: b}), clock=clock, sleep=clock.sleep, rand=no_jitter)
    assert rpc.call("eth_chainId", ep=rpc.endpoints[1]) == "0x3e6" and b.log == ["eth_chainId"]
    rpc.endpoints[1].cool_until = 30.0
    rpc.batch([("eth_chainId", [])], ep=rpc.endpoints[1])
    assert a.log == ["eth_chainId"]  # B cooling: the next healthy endpoint answers


# -- 2. a failed send that broadcast nothing is retried on the next poll ----------------------------------


def test_rejected_send_is_retried_next_fast_poll_not_after_30s():
    clock, node, rpc = one_node()
    k, _ = keeper(rpc, clock)
    node.buy(POOL_A, level=LEVEL)
    node.send_mode = "reject"
    assert k.poll() == [] and k.sent[POOL_A] == {} and k.fast
    node.send_mode = "ok"
    clock.t = 1.0
    assert [a.cover_id for _, a, _ in k.poll()] == [1] and len(node.mempool) == 1


def test_estimate_revert_on_one_poll_is_retried_next_poll():
    clock, node, rpc = one_node(schedule=[(0, BREACH)])
    k, _ = keeper(rpc, clock)
    node.buy(POOL_A, level=LEVEL)
    node.schedule = [(0, BREACH)]
    real = node.one
    calls = []

    def flaky(url, p):  # the first estimate answers from a state without the breach
        if p["method"] == "eth_estimateGas" and not calls:
            calls.append(1)
            return {"jsonrpc": "2.0", "id": p["id"], "error": {"code": 3, "message": "execution reverted"}}
        return real(url, p)

    node.one = flaky
    assert k.poll() == []
    clock.t = 1.0
    assert len(k.poll()) == 1 and len(node.mempool) == 1


def test_send_that_may_have_gone_out_keeps_the_30s_guard_and_its_nonce(caplog):
    clock, node, rpc = one_node()
    rpc.max_wait_s = 5.0
    k, _ = keeper(rpc, clock)
    node.buy(POOL_A, level=LEVEL)
    node.send_mode = "transport"  # the node takes the tx but the answer never arrives
    with caplog.at_level(logging.WARNING, logger="numera.keeper"):
        assert k.poll() == []
    assert 1 in k.sent[POOL_A] and k.txs[POOL_A][1].nonce == 7  # kept: do not double-broadcast
    assert any("may have" in r.getMessage() for r in caplog.records)
    t1 = clock.t
    node.send_mode = "ok"
    assert node.nonces() == [7]  # it did reach the mempool: pending is now 8
    clock.t = t1 + 1.0
    k.poll()
    assert node.nonces() == [7]  # inside RESEND_AFTER_S: nothing resent
    clock.t = t1 + RESEND_AFTER_S + 1
    k.poll()
    assert node.nonces() == [7, 7]  # the resend replaces nonce 7 (RBF), never queues a second tx at 8


def test_already_known_counts_as_sent():
    clock, node, rpc = one_node()
    k, _ = keeper(rpc, clock)
    node.buy(POOL_A, level=LEVEL)
    node.send_mode = "known"
    done = k.poll()
    assert [a.cover_id for _, a, _ in done] == [1] and 1 in k.sent[POOL_A]
    h = "0x" + keccak(HexBytes(node.mempool[0])).hex()
    assert k.txs[POOL_A][1].hash == h and k.txs[POOL_A][1].nonce == 7
    clock.t = 1.0
    assert k.poll() == [] and len(node.mempool) == 1  # not resent while pending


# -- 3. two sends in one poll never share a nonce ---------------------------------------------------------


def test_two_covers_in_one_poll_get_consecutive_nonces_while_pending_lags():
    clock, node, rpc = one_node()
    k, _ = keeper(rpc, clock)
    node.buy(POOL_A, level=LEVEL)
    node.buy(POOL_A, level=LEVEL)
    node.hide_pending = True  # the node's pending count does not include tx #1 yet
    assert len(k.poll()) == 2
    assert node.nonces() == [7, 8]


def test_nonce_floor_yields_to_the_node_and_expires_when_a_tx_was_dropped():
    clock, node, rpc = one_node()
    s = Sender(rpc, ANVIL_KEY1, max_fee_wei=CAP, clock=clock)
    node.hide_pending = True
    s.send(POOL_A, Action("trigger", 1, "t"))
    s.send(POOL_A, Action("trigger", 2, "t"))
    assert node.nonces() == [7, 8]
    node.hide_pending = False
    node.latest, node.mempool = 20, []  # the node overtook the floor (another tx of the key mined)
    s.send(POOL_A, Action("trigger", 3, "t"))
    assert node.nonces() == [20]
    node.hide_pending, node.latest, node.mempool = True, 7, []
    s._floor, s._floor_at = 9, clock.t  # we sent 7 and 8, both dropped: the node never sees them
    clock.t += 60
    s.send(POOL_A, Action("trigger", 4, "t"))
    assert node.nonces() == [7]  # the stale floor would leave a gap forever; the node's count wins


# -- 4. chain id: 998 / 31337 only, every endpoint checked ------------------------------------------------


@pytest.mark.parametrize("bad", [999, 1, 42161])
def test_keeper_refuses_to_start_if_any_endpoint_is_not_testnet_or_local(bad):
    clock = Clock()
    a, b = FaultNode(clock, [(0, NEAR)]), FaultNode(clock, [(0, NEAR)], chain_id=bad)
    rpc = FailoverRpc([A, B], post=Net({A: a, B: b}), clock=clock, sleep=clock.sleep, rand=no_jitter)
    k = Keeper(rpc, [PoolPlan(POOL_A, "a")], watch_perps=[3], dry_run=True, clock=clock)
    with pytest.raises(RuntimeError, match=str(bad)):
        k.start()
    with pytest.raises(RuntimeError, match=str(bad)):
        Sender(
            FailoverRpc([A, B], post=Net({A: a, B: b}), clock=clock, sleep=clock.sleep, rand=no_jitter),
            ANVIL_KEY1,
        )


def test_local_chain_is_allowed_and_endpoints_must_agree():
    clock = Clock()
    a, b = FaultNode(clock, [(0, NEAR)], chain_id=31337), FaultNode(clock, [(0, NEAR)], chain_id=31337)
    rpc = FailoverRpc([A, B], post=Net({A: a, B: b}), clock=clock, sleep=clock.sleep, rand=no_jitter)
    assert Sender(rpc, ANVIL_KEY1).chain_id == 31337
    b.chain_id = 998
    with pytest.raises(RuntimeError, match="differ"):
        FailoverRpc(
            [A, B], post=Net({A: a, B: b}), clock=clock, sleep=clock.sleep, rand=no_jitter
        ).verify_chain({998, 31337})


class Flaky:
    """Endpoint B in front of a FaultNode: ``mode`` "429" (rate limited), "down" (refused) or "ok"."""

    def __init__(self, a, b):
        self.a, self.b, self.mode, self.b_calls = a, b, "429", []

    def __call__(self, url, payload, timeout):
        if url == A:
            return self.a(url, payload, timeout)
        self.b_calls.append(payload["method"] if isinstance(payload, dict) else "batch")
        if self.mode == "429":
            return 429, None
        if self.mode == "down":
            raise FaultError("refused")
        return self.b(url, payload, timeout)


def flaky_pair(b_chain=998):
    clock = Clock()
    net = Flaky(FaultNode(clock, [(0, NEAR)]), FaultNode(clock, [(0, NEAR)], chain_id=b_chain))
    return clock, net, FailoverRpc([A, B], post=net, clock=clock, sleep=clock.sleep, rand=no_jitter)


@pytest.mark.parametrize("mode", ["429", "down"])
def test_endpoint_without_chain_id_at_startup_stays_unverified_then_is_admitted(mode):
    clock, net, rpc = flaky_pair()
    net.mode = mode
    assert rpc.verify_chain({998, 31337}) == 998
    a, b = rpc.endpoints
    assert [e.url for e in rpc.endpoints] == [A, B] and a.verified and not b.verified  # kept, not dropped
    rpc.note_head(1000, a)
    rpc.note_head(2000, b)
    assert rpc.lag(a) is None and rpc.healthy() == [a]  # not compared, not used
    a.cool_until = 1e9  # A rate-limited: B must not serve until it is verified
    net.b_calls.clear()
    clock.t = b.cool_until - 0.5  # B still cooling: no recheck yet (at most once per cooldown)
    rpc._recheck(clock.t)
    assert net.b_calls == []
    net.mode = "ok"
    clock.t = b.cool_until
    assert rpc.call("eth_chainId") == "0x3e6"  # recheck admits B, then B serves the call
    assert b.verified and net.b_calls == ["eth_chainId", "eth_chainId"]


def test_unverified_endpoint_answering_another_chain_later_is_dropped():
    clock, net, rpc = flaky_pair(b_chain=999)
    net.mode = "down"
    rpc.verify_chain({998, 31337})
    net.mode = "ok"
    clock.t = rpc.endpoints[1].cool_until
    rpc.call("eth_chainId")
    assert [e.url for e in rpc.endpoints] == [A]


def test_refuses_to_start_when_no_endpoint_answers_chain_id():
    clock = Clock()

    def post(url, payload, timeout):
        return 429, None

    with pytest.raises(RuntimeError, match="no RPC endpoint answered"):
        FailoverRpc([A, B], post=post, clock=clock, sleep=clock.sleep, rand=no_jitter).verify_chain(
            {998, 31337}
        )


# -- review follow-up M2: a cover whose attempts broadcast nothing backs off 1, 2, 4 ... 30 s ---------------


def test_failing_cover_backs_off_exponentially_and_first_retry_is_the_next_fast_poll():
    clock, node, rpc = one_node()
    k, _ = keeper(rpc, clock)
    node.buy(POOL_A, level=LEVEL)
    node.send_mode = "reject"  # e.g. insufficient funds: an error answer, nothing went out
    at = []
    real = node.one

    def rec(url, p):
        if p["method"] == "eth_sendRawTransaction":
            at.append(clock.t)
        return real(url, p)

    node.one = rec
    k.run(poll_s=3.0, duration_s=60, sleep=clock.sleep)
    assert k.fast and at[:2] == [0.0, 1.0]  # the first retry is the next 1 s poll (H2 latency kept)
    assert at == [0.0, 1.0, 3.0, 7.0, 15.0, 31.0]  # then 2, 4, 8, 16 s; 30 s cap (next at 61)
    node.send_mode = "ok"
    clock.t = 61.0
    assert len(k.poll()) == 1 and k._retry == {}  # success resets


def test_backoff_resets_when_the_decision_changes():
    clock, node, rpc = one_node(schedule=[(0, BREACH)])
    k, _ = keeper(rpc, clock)
    node.buy(POOL_A, level=LEVEL)
    node.send_mode = "reject"
    for t in (0.0, 1.0, 2.0, 3.0):
        clock.t = t
        k.poll()
    assert k._retry[(POOL_A, 1)][0] == 3  # attempts at 0, 1, 3; next at 7
    node.schedule = [(0, NEAR)]  # price leaves the level: no trigger decided
    clock.t = 4.0
    k.poll()
    assert k._retry == {}
    node.schedule, node.send_mode = [(0, BREACH)], "ok"
    clock.t = 5.0  # breached again before the old 7 s backoff: tried at once
    assert len(k.poll()) == 1


# -- review follow-up L1: timeout after the node took the tx, failover answers "nonce too low" -----------


def test_nonce_too_low_after_a_send_timeout_counts_as_sent():
    clock = Clock()
    a, b = FaultNode(clock, [(0, BREACH)]), FaultNode(clock, [(0, BREACH)])
    rpc = FailoverRpc([A, B], post=Net({A: a, B: b}), clock=clock, sleep=clock.sleep, rand=no_jitter)
    k, _ = keeper(rpc, clock)
    a.buy(POOL_A, level=LEVEL)
    b.buy(POOL_A, level=LEVEL)
    a.send_mode, b.send_mode = "transport", "reject"  # A takes the tx and times out; B: nonce too low
    done = k.poll()
    assert [x[1].cover_id for x in done] == [1] and len(a.mempool) == 1
    h = "0x" + keccak(HexBytes(a.mempool[0])).hex()
    assert k.txs[POOL_A][1].hash == h and 1 in k.sent[POOL_A]  # local hash kept, 30 s guard on
    clock.t = 1.0
    assert k.poll() == []  # not resent


# -- 5. empty env values and a zero fee ------------------------------------------------------------------


ENV_FLAGS = [
    "NUMERA_KEEPER_FAST_POLL",
    "NUMERA_KEEPER_NEAR_PCT",
    "NUMERA_KEEPER_FAST_MAX_MIN",
    "NUMERA_KEEPER_MAX_FEE_GWEI",
    "NUMERA_KEEPER_MAX_TX_PER_POLL",
    "NUMERA_KEEPER_MIN_BALANCE_HYPE",
]


@pytest.mark.parametrize("name", ENV_FLAGS)
def test_empty_env_flag_falls_back_to_the_default(monkeypatch, name):
    monkeypatch.setenv(name, "  ")
    with pytest.raises(SystemExit) as e:
        main(["--help"])
    assert e.value.code == 0


def test_zero_base_fee_and_zero_tip_still_give_a_positive_max_fee():
    max_fee, tip = choose_fees(0, 0, CAP)
    assert max_fee > 0 and tip == 0
    assert choose_fees(BASE, 0, CAP) == (2 * BASE, 0)  # the floor is below normal testnet fees


def test_sender_never_signs_a_zero_max_fee():
    clock, node, rpc = one_node()
    node.base = 0
    s = Sender(rpc, ANVIL_KEY1, max_fee_wei=CAP, clock=clock)
    s.send(POOL_A, Action("trigger", 1, "t"))
    assert TypedTransaction.from_bytes(HexBytes(node.mempool[0])).as_dict()["maxFeePerGas"] > 0


def test_fault_node_block_number_selector_is_answered():
    clock = Clock()
    node = FaultNode(clock, [(0, NEAR)])
    ok, data = node.sub(mc.MULTICALL3, mc.selector("getBlockNumber()"))
    assert ok and data == encode(["uint256"], [1001])
