"""CoverPool v2 replicas (ARCHITECTURE §5.3, §6 v2 follow-up): premium floor, level distance, checks 5/6.

The capacity/window replica is property-tested against ``ContractModel``, a direct transcription of the
contract's buyCover checks 5 and 6 and their effects (§5.3 step 7), plus trigger/expire/deposit/request
moves of the capacity base. The model is written from the spec text, not from poolv2.py."""

import random

import pytest
from eth_abi import encode

from numera_engine import multicall as mc
from numera_engine.poolv2 import (
    LIMITS_TUPLE,
    Limits,
    V2ReadError,
    V2State,
    V2StateReader,
    capacity_refusal,
    contract_level_ok,
    decode_state,
    level_distance_bps,
    level_too_close,
    premium_floor,
    raise_to_floor,
    sale_window,
    state_calls,
)

TESTNET = Limits(8000, 5000, 604_800, 30, 1_000_000, 20, 25, 3600, 2500, 2500, 1500)  # §5.2 testnet column
POOL = "0x1b1bfb83f2100c95a7460ed1a746170cbdeccbae"
BUYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"


# -- premium floor -------------------------------------------------------------------------------------


def test_premium_floor_is_ceil_div():
    assert premium_floor(100_000_000, 20) == 200_000  # 0.2 % of 100 USDC
    assert premium_floor(1_000_001, 20) == 2001  # 2000.002 -> 2001
    assert premium_floor(5_000, 20) == 10
    assert premium_floor(4_999, 20) == 10  # 9.998 -> 10
    for payout in range(1, 3000):
        f = premium_floor(payout, 20)
        assert f * 10_000 >= payout * 20 > (f - 1) * 10_000  # least premium the contract accepts


def test_raise_to_floor_only_raises():
    assert raise_to_floor(150_000, 100_000_000, 20) == (200_000, True)
    assert raise_to_floor(200_000, 100_000_000, 20) == (200_000, False)  # exactly at the floor: not raised
    assert raise_to_floor(7_000_000, 100_000_000, 20) == (7_000_000, False)


# -- level distance ------------------------------------------------------------------------------------


def test_level_distance_is_min_distance_plus_spot_deviation_plus_cross_term():
    assert level_distance_bps(TESTNET) == 25 + 30 + 1  # ceil(25 x 30 / 10000) = 1
    assert level_distance_bps(Limits(*[0] * 3, 100, 0, 0, 2000, *[0] * 4)) == 2000 + 100 + 20
    s = 84_000_000_000
    assert level_too_close(s, s - s * 55 // 10_000, 56)
    assert not level_too_close(s, s - s * 56 // 10_000, 56)
    assert level_too_close(s, s + s * 55 // 10_000, 56)  # short cover: level above spot


def test_min_plus_deviation_alone_is_not_enough_for_a_short_cover():
    """The reviewer's m + d: a short-cover level exactly m + d above S fails the contract when the oracle
    rose by d (the case the cross term covers)."""
    s, m, d = 1_000_000_000_000, 2000, 500
    level = s + s * (m + d) // 10_000
    px = s + s * d // 10_000
    assert not contract_level_ok(px, level, m)
    lim = Limits(8000, 5000, 604_800, d, 1, 20, m, 3600, 2500, 2500, 1500)
    assert level_too_close(s, level, level_distance_bps(lim))


def test_engine_level_floor_implies_contract_floor_anywhere_in_the_deviation_band():
    """Property: a level the engine accepts against spotRef S passes the contract's check 3 floor for
    every oracle px the contract still accepts (|px - S| <= S x maxSpotDeviationBps)."""
    rng = random.Random(7)
    for _ in range(20_000):
        dev, mld = rng.randint(1, 500), rng.randint(1, 2000)
        lim = Limits(8000, 5000, 604_800, dev, 1, 20, mld, 3600, 2500, 2500, 1500)
        s = rng.randint(10_000, 10**12)
        bps = level_distance_bps(lim)
        dist = rng.randint(s * bps // 10_000, s * bps // 10_000 + max(1, s // 50))
        is_long = rng.random() < 0.5
        level = s - dist if is_long else s + dist
        if level <= 0 or level_too_close(s, level, bps):
            continue
        max_dev = s * lim.maxSpotDeviationBps // 10_000
        for px in (s - max_dev, s + max_dev, s + rng.randint(-max_dev, max_dev)):
            assert abs(px - s) * 10_000 <= s * lim.maxSpotDeviationBps
            breached = px <= level if is_long else px >= level
            assert not breached
            assert contract_level_ok(px, level, lim.minLevelDistanceBps), (s, px, level, lim)


# -- checks 5 and 6: Python model of the contract ------------------------------------------------------


class ContractModel:
    """CoverPool v2 sale-side state, transcribed from ARCHITECTURE §5.3 (checks 5, 6 and effects)."""

    def __init__(self, limits, assets):
        self.l = limits
        self.assets = assets  # totalAssets
        self.escrowed = 0  # assets of escrowed shares
        self.locked = 0
        self.locked_by_perp = {}
        self.window_start = 0
        self.window_assets = 0
        self.sold_in_window = 0
        self.buyer_window = {}  # buyer -> (start, sold)
        self.covers = []  # (perp, payout, active)

    @property
    def b(self):
        return max(0, self.assets - self.escrowed)

    def buy(self, buyer, perp, payout, now):
        """True when checks 5 and 6 pass (and apply the effects), else the failing check name."""
        b, lim = self.b, self.l
        if self.locked + payout > b * lim.maxUtilizationBps // 10000:
            return "utilization"
        if self.locked_by_perp.get(perp, 0) + payout > b * lim.perPerpCapBps // 10000:
            return "perp_cap"
        reset = now >= self.window_start + lim.saleWindow
        w = b if reset else self.window_assets
        sold = 0 if reset else self.sold_in_window
        cap = w * lim.maxSoldPerWindowBps // 10000
        if sold + payout > cap:
            return "sale_window"
        bw_start, bw_sold = self.buyer_window.get(buyer, (0, 0))
        b_sold = 0 if (reset or bw_start != self.window_start) else bw_sold
        if b_sold + payout > cap * lim.maxBuyerWindowShareBps // 10000:
            return "buyer_window"
        # effects (step 7)
        self.locked += payout
        self.locked_by_perp[perp] = self.locked_by_perp.get(perp, 0) + payout
        if reset:
            self.window_start, self.window_assets, self.sold_in_window = now, b, 0
        self.sold_in_window += payout
        self.buyer_window[buyer] = (self.window_start, b_sold + payout)
        self.covers.append([perp, payout, True])
        return True

    def settle(self, i, paid):
        perp, payout, active = self.covers[i]
        if not active:
            return
        self.covers[i][2] = False
        self.locked -= payout
        self.locked_by_perp[perp] -= payout
        if paid:
            self.assets -= payout

    def state(self, buyer, perp, now):
        start, sold = self.buyer_window.get(buyer, (0, 0))
        return V2State(self.l, True, self.b, self.locked, self.locked_by_perp.get(perp, 0), self.window_start,
                       self.window_assets, self.sold_in_window, start, sold, False, now)  # fmt: skip


def test_capacity_replica_matches_the_contract_model():
    """Property: before every simulated sale, the engine's verdict (refusal check or None) equals what the
    contract model does with the same sale, across random deposits, requests, triggers, expiries, buyers,
    perps and time steps that cross window boundaries."""
    rng = random.Random(20261002)
    checked = {"ok": 0, "utilization": 0, "perp_cap": 0, "sale_window": 0, "buyer_window": 0}
    for _ in range(300):
        util = rng.choice([8000, 9000, 3000])
        perp_cap, sold = min(rng.choice([5000, 2000, 8000]), util), min(rng.choice([2500, 1000, 100]), util)
        window, share = rng.choice([60, 3600]), rng.choice([2500, 10_000, 500])
        lim = Limits(util, perp_cap, 604_800, 30, 1, 20, 25, window, sold, share, 100)
        m = ContractModel(lim, rng.randint(1_000, 50_000) * 10**6)
        now = 1_790_000_000
        buyers = [f"0x{i:040x}" for i in range(1, 4)]
        for _ in range(60):
            op = rng.random()
            if op < 0.6:
                buyer, perp = rng.choice(buyers), rng.choice([3, 4, 135])
                payout = rng.choice([1, rng.randint(1, 10**6), rng.randint(10**6, 3 * 10**9)])
                verdict = capacity_refusal(m.state(buyer, perp, now), payout, now)
                got = m.buy(buyer, perp, payout, now)
                if got is True:
                    assert verdict is None, (verdict, payout)
                    checked["ok"] += 1
                else:
                    assert verdict is not None and verdict.check == got, (verdict, got)
                    checked[got] += 1
            elif op < 0.7:
                m.assets += rng.randint(0, 5_000) * 10**6  # deposit (B grows; the window snapshot does not)
            elif op < 0.75:
                m.escrowed = rng.randint(0, m.assets)  # requestRedeem / claim / cancel move B
            elif op < 0.85 and m.covers:
                m.settle(rng.randrange(len(m.covers)), paid=rng.random() < 0.3)
            else:
                now += rng.choice([1, 30, lim.saleWindow - 1, lim.saleWindow, lim.saleWindow + 1, 7200])
    assert all(v > 20 for v in checked.values()), checked  # every branch exercised


def test_sale_window_reset_and_buyer_window():
    s = V2State(TESTNET, True, 10_000 * 10**6, 0, 0, window_start=1000, window_assets=8_000 * 10**6,
                sold_in_window=1_500 * 10**6, buyer_start=1000, buyer_sold=400 * 10**6, paused=False,
                block_ts=1000)  # fmt: skip
    w = sale_window(s, 1000 + 3599)
    assert (w.reset, w.cap, w.sold, w.buyer_cap, w.buyer_sold) == (False, 2_000 * 10**6, 1_500 * 10**6,
                                                                   500 * 10**6, 400 * 10**6)  # fmt: skip
    assert w.ends_at == 4600
    w = sale_window(s, 1000 + 3600)  # window over: fresh cap on B, nothing sold, buyer reset
    assert (w.reset, w.cap, w.sold, w.buyer_sold, w.ends_at) == (True, 2_500 * 10**6, 0, 0, None)
    assert capacity_refusal(s, 101 * 10**6, 2000).check == "buyer_window"
    assert capacity_refusal(s, 100 * 10**6, 2000) is None
    old = V2State(**(vars(s) | {"buyer_start": 999}))  # the buyer's sales belong to an older window
    assert sale_window(old, 2000).buyer_sold == 0


# -- reads and version detection -----------------------------------------------------------------------


def _encode_state(limits=TESTNET, probe_ok=True, fail=()):
    vals = {
        "probe": (["uint16"], [limits.minPremiumBps]),
        "limits": ([LIMITS_TUPLE], [tuple(vars(limits).values())]),
        "perpAllowed": (["bool"], [True]),
        "capacityBase": (["uint256"], [10_000 * 10**6]),
        "locked": (["uint256"], [0]),
        "lockedByPerp": (["uint256"], [0]),
        "windowStart": (["uint64"], [0]),
        "windowAssets": (["uint256"], [0]),
        "soldInWindow": (["uint256"], [0]),
        "buyerWindow": (["uint64", "uint192"], [0, 0]),
        "paused": (["bool"], [False]),
        "ts": (["uint256"], [1_790_000_000]),
    }
    items = []
    for c in state_calls(POOL, 3, BUYER):
        ok = c.key not in fail and (probe_ok or c.key in ("ts",))
        items.append((ok, encode(*vals[c.key]) if ok else b""))
    return "0x" + encode(["(bool,bytes)[]"], [items]).hex()


class FakeRpc:
    def __init__(self, answers):
        self.answers, self.calls = list(answers), 0

    def call(self, method, params):
        assert method == "eth_call" and params[0]["to"] == mc.MULTICALL3
        self.calls += 1
        a = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(a, Exception):
            raise a
        return a


def test_state_calls_selectors():
    sel = {c.key: c.data[:4].hex() for c in state_calls(POOL, 3, BUYER)}
    assert sel["probe"] == "d8fcb368"  # minPremiumBps(), forge inspect
    assert sel["limits"] == "860aefcf"
    assert sel["capacityBase"] == "c838a7af"
    assert sel["perpAllowed"] == "8f739c59"
    assert sel["windowStart"] == "b0c2783a" and sel["windowAssets"] == "71c51473"
    assert sel["soldInWindow"] == "d81354b0" and sel["buyerWindow"] == "7d1296fc"


def test_version_detection_probe_and_cache():
    clock = [0.0]
    v1 = V2StateReader(FakeRpc([_encode_state(probe_ok=False)]), clock=lambda: clock[0])
    assert v1.read(POOL, 3, BUYER) is None and v1.version(POOL) == "v1"
    assert v1.read(POOL, 3, BUYER) is None and v1.rpc.calls == 1  # v1 is cached: no more reads

    v2 = V2StateReader(FakeRpc([_encode_state()]), clock=lambda: clock[0], ttl_s=2.0)
    st = v2.read(POOL, 3, BUYER)
    assert v2.version(POOL) == "v2" and st.limits == TESTNET and st.capacity_base == 10_000 * 10**6
    v2.read(POOL, 3, BUYER)
    assert v2.rpc.calls == 1  # cached within the TTL
    clock[0] = 2.5
    v2.read(POOL, 3, BUYER)
    assert v2.rpc.calls == 2


def test_rpc_failure_caches_nothing_and_listed_v2_with_failed_probe_raises():
    r = V2StateReader(FakeRpc([RuntimeError("rpc down"), _encode_state()]))
    with pytest.raises(V2ReadError):
        r.read(POOL, 3, BUYER)
    assert r.version(POOL) is None
    assert r.read(POOL, 3, BUYER) is not None  # next try reads again
    listed = V2StateReader(FakeRpc([_encode_state(probe_ok=False)]), known={POOL: "v2"})
    with pytest.raises(V2ReadError, match="listed as v2"):
        listed.read(POOL, 3, BUYER)
    partial = V2StateReader(FakeRpc([_encode_state(fail=("capacityBase",))]))
    with pytest.raises(V2ReadError, match="capacityBase"):
        partial.read(POOL, 3, BUYER)


def test_decode_state_v1_is_none():
    assert decode_state({"probe": None, "ts": 1}) is None
