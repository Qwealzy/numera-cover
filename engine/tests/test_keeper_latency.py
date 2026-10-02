"""Keeper latency (F9: trigger within 5 s of a breach): adaptive polling, request budget per mode, hot-path
order, and decision reads that avoid a lagging RPC. Fake chain and fake time throughout."""

from eth_abi import encode
from test_keeper_alerts import V2Chain
from test_keeper_l4 import FakeSender
from test_keeper_poll import POOL_A, POOL_B, SRC_A, T0, FakeChain

from numera_engine import multicall as mc
from numera_engine.keeper import Keeper, PoolPlan
from numera_engine.rpc import FailoverRpc

LEVEL = 79_000_000_000  # long cover level, px6
NEAR = 79_500_000_000  # 0.63 % above the level: inside the 1 % band
FAR = 85_000_000_000  # 7 % above: outside
BREACH = 78_900_000_000
A, B = "https://a.example/evm", "https://b.example/evm"


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.t += s


class TimedChain(FakeChain):
    """FakeChain whose answers reflect the state at request time; each request then takes ``latency`` s.
    ``schedule``: [(t, px)] -- SRC_A perp 3 price from time t on. Answers getBlockNumber / eth_blockNumber
    from ``head`` (+1 a second)."""

    def __init__(self, clock, schedule, latency=0.0, head=1000):
        super().__init__()
        self.clock, self.schedule, self.latency, self.head0 = clock, schedule, latency, head
        self.slow = {}  # poll index -> latency override
        self.calls = 0

    def head(self):
        return self.head0 + int(self.clock.t)

    def sub(self, target, data):
        if data[:4] == mc.selector("getBlockNumber()"):  # eth_call at latest runs in head + 1 (HyperEVM)
            return True, encode(["uint256"], [self.head() + 1])
        return super().sub(target, data)

    def __call__(self, url, payload, timeout):
        for t, px in self.schedule:
            if self.clock.t >= t:
                self.px[SRC_A][3] = px
        self.ts = T0 + int(self.clock.t)
        if payload["method"] == "eth_blockNumber":
            self.methods.append("eth_blockNumber")
            res = 200, {"result": hex(self.head())}
        else:
            res = super().__call__(url, payload, timeout)
        if payload["method"] == "eth_call":
            self.calls += 1
            self.clock.t += self.slow.get(self.calls, self.latency)
        return res


class TimedSender(FakeSender):
    def __init__(self, clock):
        super().__init__()
        self.clock, self.at = clock, []

    def send(self, pool, action, prev=None, base_fee=None):
        self.at.append(self.clock.t)
        return super().send(pool, action, prev, base_fee)


def make(schedule, urls=("https://fake/evm",), post=None, latency=0.0, **kw):
    clock = Clock()
    chain = TimedChain(clock, schedule, latency)
    rpc = FailoverRpc(list(urls), post=post or chain, clock=clock, sleep=clock.sleep)
    sender = TimedSender(clock)
    k = Keeper(rpc, [PoolPlan(POOL_A, "a")], watch_perps=[3], sender=sender, clock=clock,
               wall=lambda: T0 + clock.t, **kw)  # fmt: skip
    k.start()
    chain.buy(POOL_A, level=LEVEL)
    return k, chain, rpc, clock, sender


# -- a breach just after a slow poll ----------------------------------------------------------------------


def _breach_delay(near_pct):
    # the poll at t=3 is slow (0.9 s); the breach lands 10 ms after that poll read the chain
    k, chain, rpc, clock, sender = make([(0, NEAR), (3.01, BREACH)], latency=0.3, near_pct=near_pct)
    chain.calls, clock.t = 0, 0.0  # the startup read took 0.3 s: polls start at t=0
    chain.slow = {4: 0.9}  # 4th poll eth_call (starts at t=3 in fast mode)
    k.run(poll_s=3.0, duration_s=12, sleep=clock.sleep)
    assert len(sender.at) == 1
    return sender.at[0] - 3.01


def test_breach_just_after_a_slow_poll_is_sent_within_the_fast_poll_bound():
    fast = _breach_delay(near_pct=1.0)
    assert fast <= 1.0 + 0.3 + 1e-9  # next poll starts <= --fast-poll after the slow one, + one read
    slow = _breach_delay(near_pct=0)  # fast mode off: the same breach waits for the 3 s poll
    assert slow > 1.3 and fast < slow


# -- request budget per mode ------------------------------------------------------------------------------


def test_normal_mode_is_one_request_per_poll():
    k, chain, rpc, clock, _ = make([(0, FAR)])
    r = rpc.requests
    k.run(poll_s=3.0, duration_s=60, sleep=clock.sleep)
    assert rpc.requests - r == 20 and not k.fast  # 60 s / 3 s, eth_call only
    assert set(chain.methods[2:]) == {"eth_call"}


def test_fast_mode_budget_with_one_and_two_rpcs():
    k, chain, rpc, clock, _ = make([(0, NEAR)])
    r = rpc.requests
    k.run(poll_s=3.0, duration_s=60, sleep=clock.sleep)
    assert k.fast and rpc.requests - r == 1 + 59  # first poll at normal pace decides; then 1 s polls
    assert rpc.per_minute() <= 60

    clock2 = Clock()
    chain2 = TimedChain(clock2, [(0, NEAR)])
    rpc2 = FailoverRpc([A, B], post=chain2, clock=clock2, sleep=clock2.sleep)
    k2 = Keeper(rpc2, [PoolPlan(POOL_A, "a")], watch_perps=[3], dry_run=True, clock=clock2)
    k2.start()
    chain2.buy(POOL_A, level=LEVEL)
    r = rpc2.requests
    k2.run(poll_s=3.0, duration_s=60, sleep=clock2.sleep)
    calls, probes = chain2.methods.count("eth_call") - 1, chain2.methods.count("eth_blockNumber")
    assert calls == 60 and probes == 12  # head probe of the other RPC every 5 s
    assert rpc2.requests - r == calls + probes <= 72


def test_fast_mode_is_capped_per_approach_and_rearms_after_the_price_leaves():
    k, chain, rpc, clock, _ = make([(0, NEAR), (100, FAR), (110, NEAR)], fast_max_s=30)
    r = rpc.requests
    k.run(poll_s=3.0, duration_s=90, sleep=clock.sleep)
    assert not k.fast  # capped after 30 s although still near
    n = rpc.requests - r
    assert 30 + 20 - 2 <= n <= 30 + 20 + 2  # ~30 fast polls, then ~20 at 3 s
    k.run(poll_s=3.0, duration_s=20, sleep=clock.sleep)  # t 90 -> 110: price left the band at 100
    assert not k.fast and k._near_since == {}
    k.run(poll_s=3.0, duration_s=5, sleep=clock.sleep)  # back near at 110: a new approach, fast again
    assert k.fast


def test_fast_mode_turns_off_when_the_price_moves_away():
    k, chain, rpc, clock, _ = make([(0, NEAR), (2.5, FAR)])
    k.poll()
    assert k.fast
    clock.t = 3.0
    k.poll()
    assert not k.fast and k._near_since == {}


def test_breached_cover_counts_as_near_and_breach_is_logged_once(caplog):
    import logging

    k, chain, rpc, clock, sender = make([(0, BREACH)])
    with caplog.at_level(logging.INFO, logger="numera.keeper"):
        k.poll()
        clock.t = 1.0
        k.poll()
    assert k.fast and len(sender.at) == 1
    seen = [r.getMessage() for r in caplog.records if "breach seen" in r.getMessage()]
    assert len(seen) == 1 and "cover 1" in seen[0] and "block 1000" in seen[0]
    assert any("sent" in r.getMessage() and "nonce=" in r.getMessage() for r in caplog.records)


# -- hot path order ---------------------------------------------------------------------------------------


def test_send_goes_out_before_the_log_scan_and_backfill():
    chain = V2Chain()
    clock = [0.0]
    rpc = FailoverRpc(["https://fake/evm"], post=chain, clock=lambda: clock[0])
    at_send = []

    class Rec(FakeSender):
        def send(self, pool, action, prev=None, base_fee=None):
            at_send.append(list(chain.methods))
            return super().send(pool, action, prev, base_fee)

    k = Keeper(rpc, [PoolPlan(POOL_A, "hypercore"), PoolPlan(POOL_B, "mock-v2")], watch_perps=[3],
               sender=Rec(), clock=lambda: clock[0], alert_head_lag_blocks=0)  # fmt: skip
    k.start()
    chain.buy(POOL_B, is_long=False, level=LEVEL)  # breached (80k >= 79k)
    for _ in range(5):
        chain.buy(POOL_A)  # beyond the lookahead: needs a backfill call
    k.poll()
    assert at_send == [["eth_chainId", "eth_call", "eth_call"]]  # startup + the decision read only
    assert "eth_getLogs" in chain.methods and chain.methods.count("eth_call") >= 3  # then scan + backfill


# -- decision reads avoid a lagging RPC -------------------------------------------------------------------


def test_call_block_maps_to_the_head_it_read():
    from numera_engine.keeper import state_block

    assert state_block(65837373) == 65837372 and state_block(None) is None and state_block(0) == 0


class SplitNet:
    """A lags B by ``lag`` blocks: its head and its state are older (price not yet breached)."""

    def __init__(self, clock, lag=5):
        self.a = TimedChain(clock, [(0, NEAR)], head=1000 - lag)
        self.b = TimedChain(clock, [(0, NEAR), (0.5, BREACH)], head=1000)
        self.log = []

    def __call__(self, url, payload, timeout):
        self.log.append((url, payload["method"]))
        return (self.a if url == A else self.b)(url, payload, timeout)

    def buy(self):
        self.a.buy(POOL_A, level=LEVEL)
        self.b.buy(POOL_A, level=LEVEL)


def test_fast_decision_read_skips_an_rpc_lagging_more_than_two_blocks():
    clock = Clock()
    net = SplitNet(clock)
    rpc = FailoverRpc([A, B], post=net, clock=clock, sleep=clock.sleep)
    sender = TimedSender(clock)
    k = Keeper(rpc, [PoolPlan(POOL_A, "a")], watch_perps=[3], sender=sender, clock=clock)
    k.start()
    net.buy()
    k.poll()  # t=0: A (priority) answers; cover near -> fast; probe B's head: A is 5 blocks behind
    assert k.fast and rpc.endpoints[1].head == 1000 and rpc.lagging(rpc.endpoints[0])
    clock.t = 1.0
    k.poll()  # fresh read goes straight to B, which already has the breach
    assert [u for u, m in net.log if m == "eth_call"][-2:] == [A, B]  # t=0 from A, t=1 from B (no A read)
    assert len(sender.at) == 1


def test_lagging_rpc_is_still_used_when_the_other_is_not_healthy():
    clock = Clock()
    net = SplitNet(clock)
    rpc = FailoverRpc([A, B], post=net, clock=clock, sleep=clock.sleep)
    k = Keeper(rpc, [PoolPlan(POOL_A, "a")], watch_perps=[3], dry_run=True, clock=clock)
    k.start()
    net.buy()
    k.poll()
    assert rpc.lagging(rpc.endpoints[0])
    rpc.endpoints[1].cool_until = clock.t + 30  # B rate-limited
    clock.t = 1.0
    k.poll()
    assert [u for u, m in net.log if m == "eth_call"][-1] == A  # better a lagging read than none


def test_a_read_found_lagging_is_redone_on_the_fresher_rpc_in_the_same_poll():
    clock = Clock()
    net = SplitNet(clock)
    rpc = FailoverRpc([A, B], post=net, clock=clock, sleep=clock.sleep)
    sender = TimedSender(clock)
    k = Keeper(rpc, [PoolPlan(POOL_A, "a")], watch_perps=[3], sender=sender, clock=clock)
    k.start()
    net.buy()
    k.fast = True  # already in fast mode; B's head known from a probe, A's not yet
    rpc.note_head(1000, rpc.endpoints[1])
    clock.t = 1.0
    k.poll()
    reads = [u for u, m in net.log if m == "eth_call"][1:]  # after the startup read
    assert reads == [A, B] and len(sender.at) == 1  # A answered 5 behind -> re-read from B -> trigger
