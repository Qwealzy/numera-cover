"""Keeper poll loop against a fake chain behind Multicall3 (D18): state discovery, one request per poll."""

import pytest
from eth_abi import decode, encode

from numera_engine import multicall as mc
from numera_engine.keeper import Keeper, PoolPlan, Status
from numera_engine.rpc import FailoverRpc

POOL_A = "0x" + "a1" * 20
POOL_B = "0x" + "b2" * 20
SRC_A = "0x" + "5a" * 20
SRC_B = "0x" + "5b" * 20
T0 = 1_790_000_000
SEL = {mc.selector(s): s for s in ("coverCount()", "getCover(uint256)", "oraclePx6(uint32)", "priceSource()",
                                    "getCurrentBlockTimestamp()")}  # fmt: skip


class FakeChain:
    def __init__(self):
        self.ts = T0
        self.sources = {POOL_A: SRC_A, POOL_B: SRC_B}
        self.covers = {POOL_A: {}, POOL_B: {}}  # id -> tuple
        self.px = {SRC_A: {3: 80_000_000_000}, SRC_B: {3: 80_000_000_000, 4: 3_000_000_000}}
        self.methods = []

    def buy(self, pool, is_long=True, level=79_000_000_000, perp=3, expiry=None):
        cid = len(self.covers[pool]) + 1
        self.covers[pool][cid] = ["0x" + "cc" * 20, perp, is_long, level, 10 * cid, 1, self.ts,
                                  expiry or self.ts + 3600, int(Status.ACTIVE)]  # fmt: skip
        return cid

    def sub(self, target, data):
        sig, args = SEL[data[:4]], data[4:]
        t = target.lower()
        if sig == "getCurrentBlockTimestamp()":
            return True, encode(["uint256"], [self.ts])
        if sig == "coverCount()":
            return True, encode(["uint256"], [len(self.covers[t])])
        if sig == "priceSource()":
            return True, encode(["address"], [self.sources[t]])
        if sig == "getCover(uint256)":
            (cid,) = decode(["uint256"], args)
            c = self.covers[t].get(cid, ["0x" + "00" * 20, 0, False, 0, 0, 0, 0, 0, 0])
            return True, encode([mc.COVER_TUPLE], [tuple(c)])
        (perp,) = decode(["uint32"], args)
        px = self.px[t].get(perp)
        return (True, encode(["uint64"], [px])) if px else (False, b"")  # PriceNotSet reverts

    def __call__(self, url, payload, timeout):
        self.methods.append(payload["method"])
        if payload["method"] == "eth_chainId":
            return 200, {"result": "0x3e6"}
        assert payload["method"] == "eth_call" and payload["params"][0]["to"] == mc.MULTICALL3
        data = bytes.fromhex(payload["params"][0]["data"][2:])
        (calls,) = decode(["(address,bool,bytes)[]"], data[4:])
        res = [self.sub(t, d) for t, _, d in calls]
        return 200, {"result": "0x" + encode(["(bool,bytes)[]"], [res]).hex()}


@pytest.fixture
def setup():
    chain = FakeChain()
    rpc = FailoverRpc(["https://fake/evm"], post=chain, clock=lambda: 0.0)
    k = Keeper(rpc, [PoolPlan(POOL_A, "hypercore"), PoolPlan(POOL_B, "mock")], watch_perps=[3, 4, 135],
               dry_run=True, clock=lambda: 0.0)  # fmt: skip
    k.start()
    return chain, rpc, k


def test_startup_reads_chain_id_and_all_price_sources_in_two_requests(setup):
    chain, rpc, k = setup
    assert chain.methods == ["eth_chainId", "eth_call"] and rpc.requests == 2
    assert [b.source for b in k.books] == [SRC_A, SRC_B]


def test_idle_poll_is_one_request_and_breach_is_found_in_the_same_call(setup):
    chain, rpc, k = setup
    r = rpc.requests
    assert k.poll() == [] and rpc.requests == r + 1
    chain.buy(POOL_B, level=79_000_000_000)  # not breached (px 80k)
    assert k.poll() == [] and rpc.requests == r + 2 and len(k.books[1].active) == 1
    chain.px[SRC_B][3] = 78_900_000_000
    done = k.poll()
    assert [(lbl, a.kind, a.cover_id) for lbl, a, _ in done] == [("mock", "trigger", 1)]
    assert rpc.requests == r + 3
    assert k.poll() == []  # already sent: not repeated while the tx is pending
    chain.covers[POOL_B][1][8] = int(Status.PAID)
    k.poll()
    assert k.books[1].active == {} and k.sent[POOL_B] == {}  # final -> dropped, never read again
    assert all(m in ("eth_chainId", "eth_call") for m in chain.methods)  # no eth_getLogs at all


def test_new_cover_bought_and_breached_between_polls_triggers_next_poll(setup):
    chain, rpc, k = setup
    k.poll()
    chain.buy(POOL_A, is_long=False, level=79_000_000_000)  # short cover, already breached (80k >= 79k)
    done = k.poll()
    assert [(a.kind, a.cover_id) for _, a, _ in done] == [("trigger", 1)]


def test_burst_of_purchases_is_backfilled_within_the_poll(setup):
    chain, rpc, k = setup
    for _ in range(7):
        chain.buy(POOL_A)
    chain.buy(POOL_A, perp=7, level=10**12)  # perp 7 is not watched: its price is read after the backfill
    chain.px[SRC_A][7] = 50_000_000
    r = rpc.requests
    done = k.poll()
    assert len(k.books[0].active) == 8 and k.books[0].known == 8
    assert rpc.requests == r + 3  # main call + one backfill (ids 3..8) + the new perp's price
    assert [(a.kind, a.cover_id) for _, a, _ in done] == [("trigger", 8)]


def test_expiry_uses_block_time(setup):
    chain, rpc, k = setup
    chain.buy(POOL_A, expiry=T0 + 10)
    k.poll()
    chain.ts = T0 + 11
    assert [(a.kind, a.cover_id) for _, a, _ in k.poll()] == [("expire", 1)]


def test_live_mode_requires_a_sender():
    with pytest.raises(ValueError):
        Keeper(FailoverRpc(["https://x"], post=lambda *a: (200, {"result": "0x"})), [PoolPlan(POOL_A, "a")])
