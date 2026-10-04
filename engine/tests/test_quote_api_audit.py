"""Security audit 2026-10-04: M1 (rate limiter behind a proxy), L5 (v1 pools on 998), info b (chain id)."""

import logging

import pytest
from fastapi.testclient import TestClient

from numera_engine.deployments import parse
from numera_engine.pricing import TailTable
from numera_engine.quote_api import (
    ChainIdMismatchError,
    PoolNotAllowedError,
    RateLimiter,
    RateLimitProxyError,
    Settings,
    XffWatch,
    create_app,
    is_loopback_host,
    resolve_default_pool,
    verify_rpc_chain,
)

KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"  # public anvil key #0
BUYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
POOL_V1 = "0xda611e1a07260005ea5641e9fe633cd4d10c341e"
POOL_V2 = "0x5fbdb2315678afecb367f032d93f642f64180aa3"
NOW = 1_790_000_000
SPOT = 84_000_000_000
DEP = parse({
    "chainId": 998, "rpc": "http://unused",
    "pools": {"hypercore": {"pool": POOL_V1}, "hypercore-v2": {"pool": POOL_V2, "version": "v2"}},
    "perps": {"BTC": 3},
})  # fmt: skip


class StubMarket:
    def oracle(self, perp_index):
        return "BTC", SPOT

    def sigma(self, coin):
        return 0.5


class StubReader:
    def px6(self, pool, perp_index):
        return SPOT


class Clock:
    def __call__(self):
        return 0.0


def make_app(deployment=DEP, rate_limiter=None, **kw):
    base = {"env": "testnet", "chain_id": 998, "pool": "", "signer_key": KEY, "rate_per_min": 0}
    s = Settings(**base | kw)
    return create_app(s, StubMarket(), TailTable(coins={}), clock=lambda: NOW, nonce_fn=lambda: 7,
                      spot_reader=StubReader(), deployment=deployment, rate_limiter=rate_limiter)  # fmt: skip


def body(**kw):
    return {"buyer": BUYER, "perpIndex": 3, "isLong": True, "level": 80_000_000_000, "payout": 100_000_000,
            "durationSec": 86400} | kw  # fmt: skip


# -- M1: fail closed behind an unconfigured proxy -------------------------------------------------------


def test_rate_limit_requires_trusted_proxy_behind_proxy():
    # rate limiting on (the default), bound beyond loopback, no trusted proxies: refuse to start
    for host in ("0.0.0.0", "::", "10.0.0.5", "engine.internal", ""):
        with pytest.raises(RateLimitProxyError) as e:
            make_app(rate_per_min=10, bind_host=host)
        assert "NUMERA_TRUSTED_PROXIES" in str(e.value) and "NUMERA_PROXY_MODE" in str(e.value)
    # the ways out: a trusted proxy, an explicit direct mode, a loopback-only bind, or no limiter at all
    make_app(rate_per_min=10, bind_host="0.0.0.0", trusted_proxies=("127.0.0.1",))
    make_app(rate_per_min=10, bind_host="0.0.0.0", proxy_mode="direct")
    make_app(rate_per_min=10, bind_host="127.0.0.1")
    make_app(rate_per_min=10, bind_host="::1")
    make_app(rate_per_min=10, bind_host="localhost")
    make_app(rate_per_min=0, bind_host="0.0.0.0")


def test_proxy_mode_proxy_needs_trusted_proxies():
    with pytest.raises(RateLimitProxyError, match="NUMERA_TRUSTED_PROXIES"):
        make_app(rate_per_min=10, proxy_mode="proxy")
    make_app(rate_per_min=10, proxy_mode="proxy", trusted_proxies=("10.0.0.1",))


def test_proxy_settings_from_env(monkeypatch):
    s = Settings.from_env()
    assert s.bind_host == "127.0.0.1" and s.proxy_mode == "" and s.pools == ()
    monkeypatch.setenv("NUMERA_BIND_HOST", " 0.0.0.0 ")
    monkeypatch.setenv("NUMERA_PROXY_MODE", " Direct ")
    monkeypatch.setenv("NUMERA_POOLS", f"{POOL_V1}, {POOL_V2},")
    s = Settings.from_env()
    assert (s.bind_host, s.proxy_mode, s.pools) == ("0.0.0.0", "direct", (POOL_V1, POOL_V2))
    monkeypatch.setenv("NUMERA_PROXY_MODE", "maybe")
    with pytest.raises(ValueError, match="NUMERA_PROXY_MODE"):
        Settings.from_env()


def test_is_loopback_host():
    loopback = ("127.0.0.1", "127.1.2.3", "::1", "[::1]", "localhost", "LOCALHOST")
    assert all(is_loopback_host(h) for h in loopback)
    assert not any(is_loopback_host(h) for h in ("0.0.0.0", "::", "192.168.1.2", "example.com", ""))


def test_many_xff_values_from_an_untrusted_peer_log_a_warning(caplog):
    s = Settings(env="testnet", chain_id=998, pool="", signer_key=KEY, pools=(POOL_V2,))
    app = create_app(s, StubMarket(), TailTable(coins={}), clock=lambda: NOW, nonce_fn=lambda: 7,
                     spot_reader=StubReader(), deployment=DEP,
                     rate_limiter=RateLimiter(per_min=10, burst=1_000, clock=Clock()))  # fmt: skip
    c = TestClient(app, client=("203.0.113.9", 50000))
    with caplog.at_level(logging.WARNING, logger="numera.engine"):
        for i in range(30):
            c.post("/quote", json=body(), headers={"X-Forwarded-For": f"198.51.100.{i}"})
    warns = [r for r in caplog.records if "X-Forwarded-For" in r.getMessage()]
    assert len(warns) == 1, "throttled to one warning per minute"  # one peer, one key
    assert "203.0.113.9" in warns[0].getMessage() and "NUMERA_TRUSTED_PROXIES" in warns[0].getMessage()


def test_few_xff_values_do_not_warn(caplog):
    s = Settings(env="testnet", chain_id=998, pool="", signer_key=KEY, pools=(POOL_V2,))
    app = create_app(s, StubMarket(), TailTable(coins={}), clock=lambda: NOW, nonce_fn=lambda: 7,
                     spot_reader=StubReader(), deployment=DEP,
                     rate_limiter=RateLimiter(per_min=10, burst=1_000, clock=Clock()))  # fmt: skip
    c = TestClient(app, client=("203.0.113.9", 50000))
    with caplog.at_level(logging.WARNING, logger="numera.engine"):
        for _ in range(30):
            c.post("/quote", json=body(), headers={"X-Forwarded-For": "198.51.100.1"})
    assert not [r for r in caplog.records if "X-Forwarded-For" in r.getMessage()]


def test_xff_watch_counts_distinct_values_in_the_window():
    t = [0.0]
    w = XffWatch(threshold=3, window_s=10.0, clock=lambda: t[0])
    assert w.note("p", None) == 0
    assert [w.note("p", f"1.1.1.{i}") for i in range(3)] == [1, 2, 3]
    assert w.note("p", "1.1.1.0") == 3  # a repeat is not new
    assert w.note("q", "9.9.9.9") == 1  # per peer
    t[0] = 20.0
    assert w.note("p", "2.2.2.2") == 1  # the old values aged out


# -- L5: v1 pools are not signed for on chain 998 -----------------------------------------------------


def test_quote_refuses_v1_pool_on_testnet():
    c = TestClient(make_app())
    r = c.post("/quote", json=body(pool=POOL_V1))
    assert r.status_code == 400 and r.json()["error"] == "unknown_pool", r.text
    h = c.get("/health").json()
    assert h["pools"] == [POOL_V2] and h["pool"] == POOL_V2, "default pool is the v2 pool, v1 is not listed"
    # the v2 pool passes the pool gate (then 503: no v2 state reader is wired in this test)
    assert c.post("/quote", json=body(pool=POOL_V2)).json()["error"] != "unknown_pool"
    # a request without a pool goes to the default pool: v2, never v1
    assert c.post("/quote", json=body()).json().get("error") != "unknown_pool"


def test_numera_pools_allowlists_a_v1_pool_explicitly():
    c = TestClient(make_app(pools=(POOL_V1,)))
    h = c.get("/health").json()
    assert h["pools"] == [POOL_V1]
    r = c.post("/quote", json=body(pool=POOL_V1))
    assert r.status_code == 200, r.text
    other = c.post("/quote", json=body(pool=POOL_V2)).json()
    assert other["error"] == "unknown_pool", "the list is the whole list"


def test_configured_v1_pool_on_testnet_is_refused_at_start():
    with pytest.raises(PoolNotAllowedError, match="NUMERA_POOLS"):
        make_app(pool=POOL_V1)
    make_app(pool=POOL_V2)
    make_app(pool=POOL_V1, pools=(POOL_V1,))


def test_numera_pools_must_be_addresses():
    with pytest.raises(PoolNotAllowedError, match="addresses"):
        make_app(pools=("not-an-address",))


def test_v1_pools_stay_quotable_on_local_dev():
    dep = parse({"chainId": 31337, "pools": {"hypercore": {"pool": POOL_V1}}, "perps": {"BTC": 3}})
    app = make_app(deployment=dep, env="local", chain_id=31337, pool=POOL_V1)
    r = TestClient(app).post("/quote", json=body(pool=POOL_V1))
    assert r.status_code == 200, r.text


def test_default_pool_prefers_the_v2_pool_on_testnet():
    assert resolve_default_pool(None, DEP) == POOL_V1  # unchanged outside 998
    assert resolve_default_pool(None, DEP, v2_only=True) == POOL_V2
    only_v1 = parse({"chainId": 998, "pools": {"hypercore": {"pool": POOL_V1}}, "perps": {"BTC": 3}})
    assert resolve_default_pool(None, only_v1, v2_only=True) == "0x" + "0" * 40
    assert resolve_default_pool(POOL_V1, DEP, v2_only=True) == POOL_V1  # configured wins (then refused)


# -- info b: NUMERA_CHAIN_ID against the RPC's eth_chainId ------------------------------------------------


class FakeRpc:
    def __init__(self, exc=None):
        self.exc, self.asked = exc, None

    def verify_chain(self, allowed, attempts=3):
        self.asked = (set(allowed), attempts)
        if self.exc:
            raise self.exc
        return 998


def test_chain_id_mismatch_refuses_to_start():
    rpc = FakeRpc(RuntimeError("rpc x is on chainId 999; allowed: [998]"))
    with pytest.raises(ChainIdMismatchError, match="NUMERA_CHAIN_ID is 998 but rpc x is on chainId 999"):
        verify_rpc_chain(rpc, 998)
    assert rpc.asked == ({998}, 1)
    with pytest.raises(ChainIdMismatchError, match="differ"):
        verify_rpc_chain(FakeRpc(RuntimeError("RPC endpoints differ in chainId: a=998, b=999")), 998)


def test_chain_id_match_and_unreachable_rpc_start(caplog):
    verify_rpc_chain(FakeRpc(), 998)
    with caplog.at_level(logging.WARNING, logger="numera.engine"):
        silent = FakeRpc(RuntimeError("no RPC endpoint answered eth_chainId; refusing to start"))
        verify_rpc_chain(silent, 998)
    assert any("not verified" in r.getMessage() for r in caplog.records)


def test_create_app_runs_the_chain_check(monkeypatch):
    import numera_engine.quote_api as qa

    class Fake(FakeRpc):
        def __init__(self, urls, **kw):
            super().__init__(RuntimeError("rpc h is on chainId 31337; allowed: [998]"))

    monkeypatch.setattr(qa, "FailoverRpc", Fake)
    s = Settings(env="testnet", chain_id=998, signer_key=KEY, rate_per_min=0, rpc_url="http://127.0.0.1:1")
    with pytest.raises(ChainIdMismatchError):
        create_app(s, StubMarket(), TailTable(coins={}), clock=lambda: NOW, deployment=DEP)
