"""Keeper alerts for v2 pools (ARCHITECTURE §5.10): state reads ride in the poll's one eth_call; the timelock
and breaker events cost one eth_getLogs per interval. Fake chain, no network."""

import logging

import pytest
from eth_abi import decode, encode
from test_keeper_poll import POOL_A, POOL_B, T0, FakeChain

from numera_engine import alerts as al
from numera_engine import multicall as mc
from numera_engine.keeper import Keeper, PoolPlan
from numera_engine.poolv2 import LIMITS_TUPLE, Limits, premium_floor
from numera_engine.rpc import FailoverRpc

LIM = Limits(8000, 5000, 604_800, 30, 1_000_000, 20, 25, 3600, 2500, 2500, 1500)
OP = "0x" + "ab" * 32


class V2Chain(FakeChain):
    """POOL_B is a CoverPool v2 (answers the v2 getters); POOL_A stays v1 (reverts on them)."""

    def __init__(self):
        super().__init__()
        self.v2 = {"paused": False, "windowStart": 0, "windowAssets": 0, "soldInWindow": 0,
                   "paidWindowStart": 0, "paidWindowAssets": 0, "paidInWindow": 0, "owedAssets": 0}
        self.eta = {}
        self.block = 5_000
        self.logs = []
        self.log_queries = []
        self.getters = {mc.selector(f"{n}()"): n for n in self.v2} | {
            mc.selector("minPremiumBps()"): "minPremiumBps", mc.selector("limits()"): "limits",
            mc.selector("queuedEta(bytes32)"): "queuedEta", mc.selector("getBlockNumber()"): "bn"}

    def sub(self, target, data):
        name = self.getters.get(data[:4])
        if name is None:
            return super().sub(target, data)
        if name == "bn":
            return True, encode(["uint256"], [self.block])
        if target.lower() != POOL_B:
            return False, b""  # v1 pool: no such function
        if name == "minPremiumBps":
            return True, encode(["uint16"], [LIM.minPremiumBps])
        if name == "limits":
            return True, encode([LIMITS_TUPLE], [tuple(vars(LIM).values())])
        if name == "queuedEta":
            (op,) = decode(["bytes32"], data[4:])
            return True, encode(["uint64"], [self.eta.get("0x" + op.hex(), 0)])
        typ = "bool" if name == "paused" else "uint256"
        return True, encode([typ], [self.v2[name]])

    def __call__(self, url, payload, timeout):
        if payload["method"] == "eth_getLogs":
            self.methods.append("eth_getLogs")
            q = payload["params"][0]
            self.log_queries.append((int(q["fromBlock"], 16), int(q["toBlock"], 16), q["address"]))
            lo, hi = int(q["fromBlock"], 16), int(q["toBlock"], 16)
            return 200, {"result": [lg for lg in self.logs if lo <= int(lg["blockNumber"], 16) <= hi]}
        return super().__call__(url, payload, timeout)

    def log(self, t0, topics, data, block=None):
        self.logs.append({"address": POOL_B, "topics": [t0, *topics], "data": "0x" + data.hex(),
                          "blockNumber": hex(block or self.block)})  # fmt: skip


@pytest.fixture
def setup():
    chain = V2Chain()
    clock = [0.0]
    rpc = FailoverRpc(["https://fake/evm"], post=chain, clock=lambda: clock[0])
    k = Keeper(rpc, [PoolPlan(POOL_A, "hypercore"), PoolPlan(POOL_B, "mock-v2")], watch_perps=[3],
               dry_run=True, clock=lambda: clock[0])  # fmt: skip
    k.start()
    return chain, rpc, k, clock


def kinds(k):
    return [a.kind for a in k.alerts]


def test_topics_match_the_contract_events():
    assert al.T_QUEUED.startswith("0x56e3f757") and al.T_EXECUTED.startswith("0x432b05da")
    assert al.T_CANCELLED.startswith("0x23933b6e") and al.T_BREAKER.startswith("0x043ac3aa")
    assert al.T_DEFERRED.startswith("0x54ce20b0")


def test_version_probe_at_startup_and_request_budget(setup):
    chain, rpc, k, clock = setup
    assert set(k.watches) == {POOL_B}  # v2 found by the minPremiumBps() probe; v1 pool not watched
    assert chain.methods == ["eth_chainId", "eth_call"]  # the probe rode in the start multicall
    r = rpc.requests
    k.poll()  # first poll: one eth_call + the first log scan
    assert rpc.requests == r + 2 and chain.methods[-2:] == ["eth_call", "eth_getLogs"]
    assert chain.log_queries[0] == (5_000 - 1000 + 1, 5_000, [POOL_B])  # lookback 1000 blocks, v2 pools only
    for _ in range(5):
        clock[0] += 3
        k.poll()
    assert rpc.requests == r + 2 + 5  # no further log scan inside 60 s
    clock[0] = 61
    chain.block = 5_060
    k.poll()
    assert chain.log_queries[-1][:2] == (5_001, 5_060)  # resumes after the last scanned block
    assert k.alerts == []


def test_v1_only_keeper_never_scans_logs():
    chain = V2Chain()
    rpc = FailoverRpc(["https://fake/evm"], post=chain, clock=lambda: 0.0)
    k = Keeper(rpc, [PoolPlan(POOL_A, "hypercore")], dry_run=True, clock=lambda: 0.0)
    k.start()
    r = rpc.requests
    k.poll()
    assert rpc.requests == r + 1 and "eth_getLogs" not in chain.methods and k.watches == {}


def test_breaker_alert_from_state_once_per_pause(setup, caplog):
    chain, rpc, k, clock = setup
    k.poll()
    chain.v2 |= {"paused": True, "paidWindowStart": T0, "paidWindowAssets": 10_000 * 10**6,
                 "paidInWindow": 1_600 * 10**6}  # fmt: skip
    with caplog.at_level(logging.WARNING, logger="numera.keeper"):
        k.poll()
    assert kinds(k) == ["breaker"] and "ALERT breaker mock-v2" in caplog.text
    k.poll()
    assert kinds(k) == ["breaker"]  # not repeated while paused
    chain.v2 |= {"paused": False, "paidWindowStart": 0, "paidInWindow": 0}
    k.poll()
    chain.v2 |= {"paused": True}  # an owner/guardian pause: no breaker condition
    k.poll()
    assert kinds(k) == ["breaker"]


def test_sale_cap_alert_once_per_window(setup):
    chain, rpc, k, clock = setup
    chain.v2 |= {"windowStart": T0 - 10, "windowAssets": 10_000 * 10**6, "soldInWindow": 2_499_500_000}
    k.poll()
    k.poll()
    assert kinds(k) == ["sale_cap"]  # 2,499.5 sold of 2,500: less than minPayout (1) of room
    chain.v2 |= {"windowStart": T0 + 5}
    chain.ts = T0 + 6
    k.poll()
    assert kinds(k) == ["sale_cap", "sale_cap"]  # a new window that also hit its cap


def test_floor_priced_sale_and_deferred_payout(setup):
    chain, rpc, k, clock = setup
    k.poll()
    cid = chain.buy(POOL_B)
    chain.covers[POOL_B][cid][4] = 100_000_000
    chain.covers[POOL_B][cid][5] = premium_floor(100_000_000, LIM.minPremiumBps)
    chain.buy(POOL_B)
    chain.covers[POOL_B][2][4], chain.covers[POOL_B][2][5] = 10_000_000, 900_000  # well above the floor
    k.poll()
    assert kinds(k) == ["floor_sale"] and "cover 1" in k.alerts[0].message
    k.poll()
    assert kinds(k) == ["floor_sale"]
    chain.v2["owedAssets"] = 20_000_000
    k.poll()
    assert kinds(k) == ["floor_sale", "payout_deferred"]
    k.poll()
    assert kinds(k) == ["floor_sale", "payout_deferred"]


def test_config_queued_then_ready_then_executed(setup):
    chain, rpc, k, clock = setup
    eta = T0 + 600
    chain.log(al.T_QUEUED, [OP], encode(["uint8", "bytes", "uint64"], [1, b"\x01\x02", eta]))
    chain.eta[OP] = eta
    k.poll()
    assert kinds(k) == ["config_queued"] and "Limits" in k.alerts[0].message
    assert OP in k.watches[POOL_B].ops
    chain.ts = eta
    k.poll()
    assert kinds(k) == ["config_queued", "op_ready"]
    chain.ts = eta + 10
    k.poll()
    assert kinds(k) == ["config_queued", "op_ready"]  # once
    chain.eta[OP] = 0  # executed (ConfigExecuted log missed): queuedEta reads 0
    k.poll()
    assert k.watches[POOL_B].ops == {}


def test_stale_op_and_breaker_and_deferred_logs(setup):
    chain, rpc, k, clock = setup
    eta = T0 - al.CONFIG_GRACE_S - 1
    chain.log(al.T_QUEUED, [OP], encode(["uint8", "bytes", "uint64"], [0, b"", eta]))
    chain.eta[OP] = eta
    chain.log(al.T_BREAKER, [], encode(["uint256", "uint256"], [1_600 * 10**6, 1_500 * 10**6]))
    buyer = "0x" + "00" * 12 + "cc" * 20
    chain.log(al.T_DEFERRED, [hex(7), buyer], encode(["uint256"], [20_000_000]))
    k.poll()  # the scan runs after the poll's state read: the op is known from the next poll on
    assert kinds(k) == ["config_queued", "breaker", "payout_deferred"]
    assert "cover 7" in k.alerts[2].message and "0x" + "cc" * 20 in k.alerts[2].message
    k.poll()
    assert kinds(k)[-1] == "op_stale"


def test_log_scan_failure_is_retried_from_the_same_block(setup):
    chain, rpc, k, clock = setup
    w = k.watches[POOL_B]

    class Boom:
        def call(self, *a):
            raise RuntimeError("rate limited")

    s = al.LogScanner(Boom(), {POOL_B: w}, every_s=60, lookback=10)
    assert s.scan(100, 0.0) == [] and s.next_block == 91
    s.rpc = rpc
    s.scan(100, 60.0)
    assert s.next_block == 101 and chain.log_queries[-1][:2] == (91, 100)


def test_cli_has_alert_flags():
    from numera_engine import keeper

    with pytest.raises(SystemExit):
        keeper.main(["--help"])
