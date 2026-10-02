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
                   "paidWindowStart": 0, "paidWindowAssets": 0, "paidInWindow": 0, "owedAssets": 0,
                   "configDelay": 600, "CONFIG_GRACE": al.CONFIG_GRACE_S}  # fmt: skip
        self.eta = {}
        self.block = 5_000
        self.logs = []
        self.log_queries = []
        self.log_topics = []
        self.receipts = {}
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
        typ = {"paused": "bool", "configDelay": "uint64", "CONFIG_GRACE": "uint64"}.get(name, "uint256")
        return True, encode([typ], [self.v2[name]])

    def __call__(self, url, payload, timeout):
        if payload["method"] == "eth_getLogs":
            self.methods.append("eth_getLogs")
            q = payload["params"][0]
            self.log_queries.append((int(q["fromBlock"], 16), int(q["toBlock"], 16), q["address"]))
            self.log_topics.append(q["topics"][0])
            lo, hi = int(q["fromBlock"], 16), int(q["toBlock"], 16)
            want = set(q["topics"][0])
            return 200, {"result": [lg for lg in self.logs
                                    if lo <= int(lg["blockNumber"], 16) <= hi and lg["topics"][0] in want]}
        if payload["method"] == "eth_getTransactionReceipt":
            self.methods.append("eth_getTransactionReceipt")
            return 200, {"result": self.receipts.get(payload["params"][0])}
        return super().__call__(url, payload, timeout)

    def log(self, t0, topics, data, block=None, tx=None):
        self.logs.append({"address": POOL_B, "topics": [t0, *topics], "data": "0x" + data.hex(),
                          "blockNumber": hex(block or self.block),
                          "transactionHash": tx or "0x" + f"{len(self.logs) + 1:064x}"})  # fmt: skip


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
    k.poll()  # first poll: one eth_call + the first log scan + the startup catch-up
    assert chain.log_queries[0] == (5_000 - 1000 + 1, 5_000, [POOL_B])  # lookback 1000 blocks, v2 pools only
    assert chain.log_topics[0] == al.ALERT_TOPICS
    # catch-up: configDelay 600 + CONFIG_GRACE 3 d (read in the poll's eth_call) reaches block 0 here,
    # newest first, ConfigQueued only, 1000 blocks a request
    assert [q[:2] for q in chain.log_queries[1:]] == [(3001, 4000), (2001, 3000), (1001, 2000), (1, 1000),
                                                      (0, 0)]  # fmt: skip
    assert all(t == [al.T_QUEUED] for t in chain.log_topics[1:])
    assert rpc.requests == r + 2 + 5 and k.scanner.catchup_requests == 5
    for _ in range(5):
        clock[0] += 3
        k.poll()
    assert rpc.requests == r + 7 + 5  # steady state: one eth_call a poll, no log scan inside 60 s
    clock[0] = 61
    chain.block = 5_060
    k.poll()
    assert chain.log_queries[-1][:2] == (5_001, 5_060)  # resumes after the last scanned block
    assert rpc.requests == r + 7 + 5 + 2
    assert k.alerts == []


def _queue_log(chain, op, eta, block, kind=1):
    chain.log(al.T_QUEUED, [op], encode(["uint8", "bytes", "uint64"], [kind, b"", eta]), block=block)


def test_restart_catch_up_finds_ops_queued_before_the_lookback(setup):
    """Review 2026-10-02: an op queued before the 1000-block lookback got no op_ready/op_stale after a
    restart. The catch-up seeds it; the next poll's queuedEta read decides, without a config_queued replay
    for ops that were executed meanwhile."""
    chain, rpc, k, clock = setup
    ready, pending, done, stale = ("0x" + c * 32 for c in ("a1", "b2", "c3", "d4"))
    _queue_log(chain, ready, T0 - 100, block=2_500)  # executable since 100 s, within the grace
    _queue_log(chain, pending, T0 + 300, block=3_900)
    _queue_log(chain, done, T0 - 50, block=1_200)
    _queue_log(chain, stale, T0 - al.CONFIG_GRACE_S - 1, block=10)
    chain.eta = {ready: T0 - 100, pending: T0 + 300, stale: T0 - al.CONFIG_GRACE_S - 1}  # `done` executed: 0
    k.poll()
    assert kinds(k) == []  # seeded silently
    assert set(k.watches[POOL_B].ops) == {ready, pending, done, stale}
    k.poll()
    assert sorted(kinds(k)) == ["config_queued", "op_ready", "op_stale"]
    assert "startup catch-up" in next(a.message for a in k.alerts if a.kind == "config_queued")
    assert set(k.watches[POOL_B].ops) == {ready, pending, stale}  # executed op dropped, no alert
    k.poll()
    assert len(k.alerts) == 3  # once each
    chain.ts = T0 + 300
    k.poll()
    assert kinds(k)[-1] == "op_ready"


def test_catch_up_is_bounded_by_the_deploy_block_and_the_cap():
    chain = V2Chain()
    tx = "0x" + "de" * 32
    chain.receipts[tx] = {"blockNumber": hex(3_500), "contractAddress": POOL_B}
    rpc = FailoverRpc(["https://fake/evm"], post=chain, clock=lambda: 0.0)
    k = Keeper(rpc, [PoolPlan(POOL_B, "mock-v2", deploy_tx=tx)], dry_run=True, clock=lambda: 0.0)
    k.start()
    assert k.watches[POOL_B].deploy_block == 3_500
    k.poll()
    assert [q[:2] for q in chain.log_queries] == [(4001, 5000), (3500, 4000)]  # nothing before the deploy

    chain = V2Chain()
    chain.block = 2_000_000
    clock = [0.0]
    rpc = FailoverRpc(["https://fake/evm"], post=chain, clock=lambda: clock[0])
    k = Keeper(rpc, [PoolPlan(POOL_B, "mock-v2")], dry_run=True, clock=lambda: clock[0])
    k.scanner.catchup_cap, k.scanner.catchup_per_scan = 7, 3
    k.start()
    per_poll = []
    for _ in range(5):
        n = len(chain.log_queries)
        k.poll()
        per_poll.append(len(chain.log_queries) - n)
        clock[0] += 3
    assert per_poll == [1 + 3, 3, 1, 0, 0]  # paced per poll, stops at the cap of 7
    oldest, newest = k.scanner.catchup_range
    assert newest == 2_000_000 - 1000 and oldest == 2_000_000 - (600 + al.CONFIG_GRACE_S) + 1
    assert chain.log_queries[-1][:2] == (newest - 7000 + 1, newest - 6000)


def test_catch_up_failure_is_retried_from_the_same_block(setup):
    chain, rpc, k, clock = setup
    w = k.watches[POOL_B]
    calls = []

    class Flaky:
        def call(self, method, params):
            calls.append((int(params[0]["fromBlock"], 16), int(params[0]["toBlock"], 16)))
            if len(calls) == 2:
                raise RuntimeError("rate limited")
            return []

    s = al.LogScanner(Flaky(), {POOL_B: w}, every_s=60, lookback=1000, catchup_per_scan=10)
    s.scan(5_000, 0.0)
    assert calls == [(4001, 5000), (3001, 4000)] and s.catchup_requests == 1
    assert s.due(3.0)  # the catch-up continues next poll, before the 60 s interval
    s.scan(5_000, 3.0)
    assert calls[2:] == [(3001, 4000), (2001, 3000), (1001, 2000), (1, 1000), (0, 0)]
    assert not s.due(6.0)


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
    chain.v2["owedAssets"] = 20_000_000  # trigger's transfer failed: state and a PayoutDeferred log
    buyer = "0x" + "00" * 12 + "cc" * 20
    chain.block = 5_010
    chain.log(al.T_DEFERRED, [hex(1), buyer], encode(["uint256"], [20_000_000]))
    k.poll()
    assert kinds(k) == ["floor_sale"]  # the owedAssets rise alone is an INFO line
    clock[0] = 61
    k.poll()
    assert kinds(k) == ["floor_sale", "payout_deferred"] and "cover 1" in k.alerts[1].message
    clock[0] = 122
    chain.block = 5_100
    k.poll()
    assert kinds(k) == ["floor_sale", "payout_deferred"]  # review 2026-10-02: once, not state + log


def test_payout_deferred_once_per_cover_and_startup_owed():
    w = al.PoolWatch(POOL_B, "mock-v2")
    buyer = "0x" + "00" * 12 + "cc" * 20
    one = w.on_log(al.T_DEFERRED, [al.T_DEFERRED, hex(7), buyer], encode(["uint256"], [5]), 10, "0x01")
    again = w.on_log(al.T_DEFERRED, [al.T_DEFERRED, hex(7), buyer], encode(["uint256"], [5]), 11, "0x02")
    assert [a.kind for a in one] == ["payout_deferred"] and again == []
    w.owed = 5
    assert w.startup_owed() == []  # explained by the log
    fresh = al.PoolWatch(POOL_B, "mock-v2", owed=9_000_000)
    assert [a.kind for a in fresh.startup_owed()] == ["payout_deferred"]  # older than the scanned blocks
    off = al.PoolWatch(POOL_B, "mock-v2", logs_on=False)  # no log scan: the state rise is the alert
    k = ("v2", POOL_B, "owedAssets")
    assert [a.kind for a in off.update({k: 3}, T0)] == ["payout_deferred"]  # > 0 at startup
    assert off.update({k: 3}, T0) == [] and [a.kind for a in off.update({k: 4}, T0)] == ["payout_deferred"]


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
    chain.v2["paused"] = True  # tripped (state read failed to show the breaker condition: the log tells)
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

    s = al.LogScanner(Boom(), {POOL_B: w}, every_s=60, lookback=10, catchup_cap=0)
    assert s.scan(100, 0.0) == [] and s.next_block == 91
    s.rpc = rpc
    s.scan(100, 60.0)
    assert s.next_block == 101 and chain.log_queries[-1][:2] == (91, 100)


def test_breaker_log_after_an_unpause_inside_the_scan_interval_is_history(setup):
    """Review 2026-10-02: trip, owner unpause, then the 60 s scan brings the LossBreakerTripped log; it was
    reported as a current trip. The breaker only trips an unpaused pool, so a log at or before a block where
    the pool was seen unpaused has been followed by an unpause."""
    chain, rpc, k, clock = setup
    k.poll()
    chain.block = 5_010
    chain.log(al.T_BREAKER, [], encode(["uint256", "uint256"], [1_600 * 10**6, 1_500 * 10**6]))
    chain.v2 |= {"paused": True, "paidWindowStart": T0, "paidWindowAssets": 10_000 * 10**6,
                 "paidInWindow": 1_600 * 10**6}  # fmt: skip
    k.poll()
    assert kinds(k) == ["breaker"]  # from the state, at once
    chain.block = 5_020
    chain.v2 |= {"paused": False, "paidWindowStart": 0, "paidInWindow": 0}  # owner unpauses
    k.poll()
    clock[0] = 61
    chain.block = 5_030
    k.poll()  # the scan now returns the trip at 5,010
    assert chain.log_queries[-1][:2] == (5_001, 5_030)
    assert kinds(k) == ["breaker"]


def test_breaker_log_is_deduplicated_by_tx_hash():
    w = al.PoolWatch(POOL_B, "mock-v2")
    data = encode(["uint256", "uint256"], [1_600 * 10**6, 1_500 * 10**6])
    assert [a.kind for a in w.on_log(al.T_BREAKER, [al.T_BREAKER], data, 10, "0xAB")] == ["breaker"]
    w._breaker_alerted = False  # e.g. an unpause seen without a block number
    assert w.on_log(al.T_BREAKER, [al.T_BREAKER], data, 10, "0xab") == []  # same tx: once
    assert [a.kind for a in w.on_log(al.T_BREAKER, [al.T_BREAKER], data, 12, "0xcd")] == ["breaker"]


def test_cli_has_alert_flags():
    from numera_engine import keeper

    with pytest.raises(SystemExit):
        keeper.main(["--help"])
