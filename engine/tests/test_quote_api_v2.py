"""Quote API additions: pooled z table, Vite CORS, pool price source and pool allowlist."""

import math

import pytest
from fastapi.testclient import TestClient

from numera_engine.deployments import default_path, parse
from numera_engine.deployments import load as load_deployment
from numera_engine.pricing import SECONDS_PER_YEAR, ZTailTable, premium, touch_prob, z_score
from numera_engine.quote import Quote, recover_signer
from numera_engine.quote_api import Settings, create_app, resolve_default_pool

KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"  # public anvil key #0
SIGNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
POOL_A = "0xd9e3b5fa578883f66438f3e3be05db420b94fd54"  # shapes of deployments/testnet.json
POOL_B = "0x7e5e234a3b7606a471eb97f5d64041309f457041"
BUYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
NOW = 1_790_000_000
DEPLOYMENT = parse(
    {
        "chainId": 998,
        "rpc": "http://unused",
        "pools": {
            "hypercore": {"pool": POOL_A, "priceSource": "0x67870faee9f561269e683e0a2c8524d65973451a"},
            "mock": {"pool": POOL_B, "priceSource": "0x13cef3f8571926fae6f13fbc46e16f0b56cceabf"},
        },
        "perps": {"BTC": 3},
    }
)


class StubMarket:
    def __init__(self, px6=84_000_000_000, fail=False):
        self.px6, self.fail = px6, fail

    def oracle(self, perp_index):
        if self.fail:
            from numera_engine.data import InfoApiError

            raise InfoApiError("info api down")
        return "BTC", self.px6

    def sigma(self, coin):
        return 0.5


class StubReader:
    def __init__(self, prices=None, fail=False):
        self.prices, self.fail, self.calls = prices or {}, fail, []

    def px6(self, pool, perp_index):
        self.calls.append((pool, perp_index))
        if self.fail:
            raise RuntimeError("execution reverted")
        return self.prices[pool.lower()]


def client(reader=None, market=None, tail=None, deployment=DEPLOYMENT):
    reader = reader or StubReader(fail=True)  # never the network: spot falls back to the stub Info API
    s = Settings(env="testnet", chain_id=998, pool=POOL_A, signer_key=KEY)
    app = create_app(
        s,
        market or StubMarket(),
        tail or ZTailTable((0.0, math.inf), {"down": [None], "up": [None]}),
        clock=lambda: NOW,
        nonce_fn=lambda: 7,
        spot_reader=reader,
        deployment=deployment,
    )
    return TestClient(app)


def body(**kw):
    return {
        "buyer": BUYER,
        "perpIndex": 3,
        "isLong": True,
        "level": 80_000_000_000,
        "payout": 100_000_000,
        "durationSec": 86400,
    } | kw


def test_pooled_z_table_prices_by_z():
    tail = ZTailTable(
        (0.0, 2.0, 4.0, math.inf),
        {"down": [{"k": 1.0, "q": 0.2}, {"k": 2.0, "q": 0.01}, {"k": 10.0, "q": 0.001}], "up": [None] * 3},
    )
    r = client(tail=tail).post("/quote", json=body())
    assert r.status_code == 200, r.text
    b = r.json()["breakdown"]
    T = 86400 / SECONDS_PER_YEAR
    z = z_score(84_000.0, 80_000.0, 0.5, T)
    a = tail.kq(True, abs(z))
    assert b["z"] == pytest.approx(z) and b["tailMultiplier"] == a.k and b["tailFloor"] == pytest.approx(a.q)
    assert r.json()["quote"]["premium"] == premium(
        100_000_000, touch_prob(84_000.0, 80_000.0, 0.5, T), a.k, q_floor=a.q
    )


@pytest.mark.parametrize("origin", ["http://localhost:5173", "http://127.0.0.1:5173"])
def test_cors_allows_vite_dev_server(origin):
    c = client()
    pre = c.options(
        "/quote",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert pre.status_code == 200 and pre.headers["access-control-allow-origin"] == origin
    r = c.post("/quote", json=body(), headers={"Origin": origin})
    assert r.headers["access-control-allow-origin"] == origin


def test_cors_rejects_other_origins():
    r = client().post("/quote", json=body(), headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in r.headers


def test_spot_comes_from_the_pool_price_source():
    reader = StubReader({POOL_A: 84_500_000_000, POOL_B: 83_000_000_000})
    r = client(reader).post("/quote", json=body())
    assert r.status_code == 200, r.text
    q, b = r.json()["quote"], r.json()["breakdown"]
    assert q["spotRef"] == 84_500_000_000 and b["spotSource"] == "pool" and b["pool"] == POOL_A
    assert reader.calls == [(POOL_A, 3)]


def test_request_can_target_the_other_allowlisted_pool_and_signature_binds_it():
    reader = StubReader({POOL_A: 84_500_000_000, POOL_B: 83_000_000_000})
    r = client(reader).post("/quote", json=body(pool=POOL_B))
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["quote"]["spotRef"] == 83_000_000_000 and j["breakdown"]["pool"] == POOL_B
    assert recover_signer(Quote(**j["quote"]), 998, POOL_B, j["signature"]) == SIGNER
    assert recover_signer(Quote(**j["quote"]), 998, POOL_A, j["signature"]) != SIGNER


def test_pool_not_in_allowlist_is_rejected():
    r = client(StubReader({})).post("/quote", json=body(pool="0x" + "11" * 20))
    assert r.status_code == 400 and r.json()["error"] == "unknown_pool"


def test_falls_back_to_info_api_when_pool_read_fails():
    r = client(StubReader(fail=True)).post("/quote", json=body())
    assert r.status_code == 200
    assert (
        r.json()["breakdown"]["spotSource"] == "info_api" and r.json()["quote"]["spotRef"] == 84_000_000_000
    )


def test_pool_price_is_enough_when_info_api_is_down():
    r = client(StubReader({POOL_A: 84_500_000_000}), market=StubMarket(fail=True)).post("/quote", json=body())
    assert r.status_code == 200 and r.json()["breakdown"]["coin"] == "BTC"  # coin from deployments perps


def test_breach_is_checked_against_the_pool_price():
    r = client(StubReader({POOL_A: 79_000_000_000})).post("/quote", json=body())
    assert r.status_code == 422 and r.json()["error"] == "level_already_breached"


def test_health_lists_allowlisted_pools():
    j = client().get("/health").json()
    assert j["pools"] == sorted([POOL_A, POOL_B]) and j["chainId"] == 998


@pytest.mark.parametrize("env_pool", [None, "", "   "])
def test_empty_pool_env_falls_back_to_the_hypercore_pool(monkeypatch, env_pool):
    """`.env` ships `POOL_ADDRESS=` empty: default pool = the deployment's HyperCore pool, never ""."""
    for var in ("NUMERA_POOL", "POOL_ADDRESS"):
        monkeypatch.delenv(var, raising=False)
        if env_pool is not None:
            monkeypatch.setenv(var, env_pool)
    monkeypatch.setenv("NUMERA_ENV", "testnet")
    monkeypatch.setenv("NUMERA_CHAIN_ID", "998")
    monkeypatch.setenv("QUOTE_SIGNER_KEY", KEY)
    s = Settings.from_env()
    deployment = load_deployment(default_path("testnet"))  # the real deployments/testnet.json
    hypercore = next(p.pool for p in deployment.pools if p.name == "hypercore")
    assert resolve_default_pool(s.pool, deployment) == hypercore
    reader = StubReader({p.pool: 84_500_000_000 for p in deployment.pools})
    tail = ZTailTable((0.0, math.inf), {"down": [None], "up": [None]})
    kw = {"clock": lambda: NOW, "nonce_fn": lambda: 7, "spot_reader": reader, "deployment": deployment}
    app = create_app(s, StubMarket(), tail, **kw)
    c = TestClient(app)
    h = c.get("/health").json()
    assert h["pool"] == hypercore and "" not in h["pools"] and all(len(p) == 42 for p in h["pools"])
    r = c.post("/quote", json=body())  # no `pool` in the request
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["breakdown"]["pool"] == hypercore and reader.calls == [(hypercore, 3)]
    assert recover_signer(Quote(**j["quote"]), 998, hypercore, j["signature"]) == SIGNER


def test_configured_pool_env_wins_and_bad_values_are_ignored(monkeypatch):
    monkeypatch.setenv("NUMERA_POOL", "")
    monkeypatch.setenv("POOL_ADDRESS", POOL_B)
    assert Settings.from_env().pool == POOL_B
    assert resolve_default_pool(POOL_B, DEPLOYMENT) == POOL_B
    assert resolve_default_pool("not-an-address", DEPLOYMENT) == POOL_A
    assert resolve_default_pool("", None) == "0x" + "00" * 20  # local dev without a deployments file
