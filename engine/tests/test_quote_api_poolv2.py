"""Quote API against CoverPool v2 pools (ARCHITECTURE §6 "v2 contract follow-up"): premium raised to the
on-chain floor (floorApplied), on-chain level distance, perpAllowed, capacity/window refusals, v1 pools
unchanged, deployments/<env>-v2.json merged. No network."""

import json
import math

from fastapi.testclient import TestClient

from numera_engine.deployments import load as load_deployment
from numera_engine.deployments import parse, v2_sibling
from numera_engine.poolv2 import Limits, V2ReadError, V2State, level_distance_bps, premium_floor
from numera_engine.pricing import TailTable
from numera_engine.quote_api import Settings, create_app

KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"  # public anvil key #0
POOL_V1 = "0xda611e1a07260005ea5641e9fe633cd4d10c341e"
POOL_V2 = "0x5fbdb2315678afecb367f032d93f642f64180aa3"
BUYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
NOW = 1_790_000_000
SPOT = 84_000_000_000
TESTNET = Limits(8000, 5000, 604_800, 30, 1_000_000, 20, 25, 3600, 2500, 2500, 1500)
DEP = parse({
    "chainId": 998, "rpc": "http://unused",
    "pools": {"hypercore": {"pool": POOL_V1}, "mock-v2": {"pool": POOL_V2, "version": "v2"}},
    "perps": {"BTC": 3, "ETH": 4},
})  # fmt: skip


class StubMarket:
    def oracle(self, perp_index):
        return ("BTC" if perp_index == 3 else "ETH"), SPOT

    def sigma(self, coin):
        return 0.5


class StubSpot:
    def px6(self, pool, perp):
        return SPOT


def state(**kw):
    base = dict(limits=TESTNET, perp_allowed=True, capacity_base=10_000 * 10**6, locked=0, locked_by_perp=0,
                window_start=0, window_assets=0, sold_in_window=0, buyer_start=0, buyer_sold=0, paused=False,
                block_ts=NOW)  # fmt: skip
    return V2State(**base | kw)


class StubV2:
    """V2StateReader stand-in: a state for v2 pools, None (v1) for others, or an error."""

    def __init__(self, st=None, fail=False, versions=None):
        self.st, self.fail, self.versions, self.calls = st or state(), fail, dict(versions or {}), []

    def version(self, pool):
        return self.versions.get(pool.lower())

    def read(self, pool, perp, buyer):
        self.calls.append((pool.lower(), perp, buyer))
        if self.fail:
            raise V2ReadError("rpc down")
        if pool.lower() == POOL_V2:
            self.versions[POOL_V2] = "v2"
            return self.st
        self.versions[pool.lower()] = "v1"
        return None


def client(v2=None, deployment=DEP, **kw):
    base = {"env": "testnet", "chain_id": 998, "pool": POOL_V1, "signer_key": KEY, "rate_per_min": 0}
    s = Settings(**base | kw)
    app = create_app(s, StubMarket(), TailTable(coins={}), clock=lambda: NOW, nonce_fn=lambda: 7,
                     spot_reader=StubSpot(), deployment=deployment, v2_reader=v2)  # fmt: skip
    return TestClient(app)


def body(**kw):
    return {"buyer": BUYER, "perpIndex": 3, "isLong": True, "level": 70_000_000_000, "payout": 100_000_000,
            "durationSec": 3600, "pool": POOL_V2} | kw  # fmt: skip


def test_far_level_premium_is_raised_to_the_floor():
    r = client(StubV2()).post("/quote", json=body(level=40_000_000_000))  # -52 % in 1 h: model ~0
    assert r.status_code == 200, r.text
    j = r.json()
    floor = premium_floor(100_000_000, TESTNET.minPremiumBps)
    assert j["quote"]["premium"] == floor == 200_000
    assert j["breakdown"]["premium"] == floor
    assert j["breakdown"]["floorApplied"] is True


def test_premium_above_the_floor_is_not_touched():
    r = client(StubV2()).post("/quote", json=body(level=81_000_000_000, durationSec=86400))
    j = r.json()
    assert r.status_code == 200, r.text
    assert j["breakdown"]["floorApplied"] is False
    assert j["quote"]["premium"] > premium_floor(100_000_000, 20)


def test_v1_pool_has_no_floor_field_and_is_not_floored():
    v2 = StubV2()
    r = client(v2).post("/quote", json=body(level=40_000_000_000, pool=POOL_V1))
    j = r.json()
    assert r.status_code == 200, r.text
    assert "floorApplied" not in j["breakdown"]
    assert j["quote"]["premium"] < premium_floor(100_000_000, 20)  # v1 behaviour: model premium as is
    assert v2.versions[POOL_V1] == "v1"


def test_on_chain_level_distance_refuses_with_margin_for_spot_deviation():
    bps = level_distance_bps(TESTNET)  # 56
    inside = SPOT - SPOT * (bps - 1) // 10_000  # passes 3 sigma sqrt(TTL) (~0.15 %), not the on-chain floor
    assert abs(math.log(inside / SPOT)) > 3 * 0.5 * math.sqrt(30 / (365 * 86400))
    r = client(StubV2()).post("/quote", json=body(level=inside))
    assert r.status_code == 422 and r.json()["error"] == "level_too_close", r.text
    assert "minLevelDistanceBps" in r.json()["reason"]
    outside = SPOT - SPOT * bps // 10_000
    r = client(StubV2()).post("/quote", json=body(level=outside))
    assert r.json().get("error") != "level_too_close", r.text
    r = client(StubV2()).post("/quote", json=body(level=inside, pool=POOL_V1))  # v1: only the sigma floor
    assert r.json().get("error") != "level_too_close", r.text


def test_sigma_floor_still_applies_when_larger():
    big = Limits(*[*vars(TESTNET).values()][:5], 20, 1, *[*vars(TESTNET).values()][7:])  # 1 bps on chain
    lim = Limits(**vars(big) | {"maxSpotDeviationBps": 1})
    level = SPOT - SPOT * 10 // 10_000  # 0.10 %: above 3 bps on chain, below 3 sigma sqrt(30 s) ~0.146 %
    r = client(StubV2(state(limits=lim))).post("/quote", json=body(level=level))
    assert r.status_code == 422 and r.json()["error"] == "level_too_close"
    assert "sigma" in r.json()["reason"]


def test_perp_not_allowed_on_chain():
    r = client(StubV2(state(perp_allowed=False))).post("/quote", json=body())
    assert r.status_code == 400 and r.json()["error"] == "perp_not_allowed"
    assert "perpAllowed" in r.json()["reason"]


def test_capacity_refusals_replicate_checks_5_and_6():
    c = client(StubV2(state(locked=7_950 * 10**6)))  # B 10k x 80 % = 8,000: room 50
    r = c.post("/quote", json=body())
    assert r.status_code == 422 and r.json()["error"] == "capacity" and "utilization" in r.json()["reason"]
    open_window = {"window_start": NOW - 10, "window_assets": 10_000 * 10**6}
    c = client(StubV2(state(**open_window, sold_in_window=2_450 * 10**6)))
    r = c.post("/quote", json=body())  # window cap 2,500, 2,450 sold
    assert r.status_code == 422 and "sale-window" in r.json()["reason"]
    ended = {"window_start": NOW - 3600, "window_assets": 10_000 * 10**6}
    c = client(StubV2(state(**ended, sold_in_window=2_450 * 10**6)))
    assert c.post("/quote", json=body()).status_code == 200  # the window has ended: reset
    c = client(StubV2(state(**open_window, sold_in_window=600 * 10**6, buyer_start=NOW - 10,
                            buyer_sold=600 * 10**6)))  # fmt: skip
    r = c.post("/quote", json=body())  # buyer cap 2,500 x 25 % = 625
    assert r.status_code == 422 and "buyer" in r.json()["reason"]


def test_known_v2_pool_state_unavailable_is_503_unknown_pool_falls_back_to_v1():
    r = client(StubV2(fail=True)).post("/quote", json=body())
    assert r.status_code == 503 and r.json()["error"] == "market_data_unavailable"
    r = client(StubV2(fail=True)).post("/quote", json=body(pool=POOL_V1))  # not listed as v2: quoted as v1
    assert r.status_code == 200 and "floorApplied" not in r.json()["breakdown"]
    r = client(None).post("/quote", json=body())  # listed v2 but no reader at all: never quoted blind
    assert r.status_code == 503


def test_probed_v2_pool_not_in_the_file_is_treated_as_v2():
    pools = {"x": {"pool": POOL_V2}, "y": {"pool": POOL_V1}}
    dep = parse({"chainId": 998, "pools": pools, "perps": {"BTC": 3}})
    r = client(StubV2(), deployment=dep).post("/quote", json=body(level=40_000_000_000))
    assert r.json()["breakdown"]["floorApplied"] is True


# -- deployments/<env>-v2.json ------------------------------------------------------------------------

V2_FILE = {  # shape written by scripts/deploy-v2.mjs (lib/deployv2.mjs mergeV2)
    "env": "testnet", "chainId": 998, "contract": "CoverPool v2",
    "pools": {
        "mock": {
            "chainId": 998, "mode": "mock", "pool": POOL_V2,
            "priceSource": "0xAAAA000000000000000000000000000000000001",
            "config": {"limits": {"minPremiumBps": "20"}, "perps": {"BTC": {"index": 3, "allowed": True}}},
            "txs": [{"name": "MockPriceSource", "function": "create", "hash": "0x01"},
                    {"name": "CoverPool", "function": "create", "hash": "0x02"}],
        },
        "hypercore": {"chainId": 31337, "pool": "0x" + "bb" * 20, "txs": []},
    },
}  # fmt: skip


def test_v2_sibling_is_merged_with_names_and_versions(tmp_path):
    main = tmp_path / "testnet.json"
    pools = {"hypercore": {"pool": POOL_V1}}
    main.write_text(json.dumps({"chainId": 998, "pools": pools, "perps": {"BTC": 3}}))
    assert load_deployment(main).pools[0].version is None  # no sibling yet
    v2_sibling(main).write_text(json.dumps(V2_FILE))
    d = load_deployment(main)
    names = {p.name: p for p in d.pools}
    assert set(names) == {"hypercore", "mock-v2"}  # the 31337 pool is skipped (other chain)
    assert names["mock-v2"].version == "v2" and names["mock-v2"].deploy_tx == "0x02"
    assert names["mock-v2"].price_source == "0xaaaa000000000000000000000000000000000001"
    assert d.version_of(POOL_V2) == "v2" and d.version_of(POOL_V1) is None
    assert d.perps == {"BTC": 3}


def test_v2_only_file_is_usable_on_its_own(tmp_path):
    f = tmp_path / "local-v2.json"
    f.write_text(json.dumps(V2_FILE | {"pools": {"mock": V2_FILE["pools"]["mock"]}}))
    d = load_deployment(f)
    assert d.chain_id == 998 and d.pools[0].version == "v2" and d.perps == {"BTC": 3}
