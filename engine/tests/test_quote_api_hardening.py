"""Quote API hardening from the 2026-10-02 security audit: M1 (TTL, level floor), M2 (perp allowlist),
M4 (rate limit, spot cache, RPC failover), L5 (no key in repr), L6 (block-time now). No network."""

import logging
import math

import pytest
from eth_abi import encode
from fastapi.testclient import TestClient

from numera_engine.deployments import default_path, parse
from numera_engine.deployments import load as load_deployment
from numera_engine.pricing import SECONDS_PER_YEAR, TailTable
from numera_engine.quote import Quote, recover_signer
from numera_engine.quote_api import (
    LEVEL_K_SIGMA,
    AllowlistMissingError,
    BlockClock,
    CachedSpotReader,
    PoolSpotReader,
    RateLimiter,
    Settings,
    ThrottledWarning,
    client_ip,
    create_app,
    engine_rpc_urls,
    rate_key,
)
from numera_engine.rpc import FailoverRpc

KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"  # public anvil key #0
SIGNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
POOL = "0xda611e1a07260005ea5641e9fe633cd4d10c341e"
SRC = "0xf8323c267ef0516651c1cc2f94f984d50f597f44"
BUYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
NOW = 1_790_000_000
SPOT = 84_000_000_000
DEPLOYMENT = parse({
    "chainId": 998, "rpc": "http://unused",
    "pools": {"hypercore": {"pool": POOL, "priceSource": SRC}},
    "perps": {"BTC": 3, "ETH": 4},
})  # fmt: skip


class StubMarket:
    def oracle(self, perp_index):
        return ("BTC" if perp_index == 3 else "ETH"), SPOT  # any index is "in the universe"

    def sigma(self, coin):
        return 0.5


class StubReader:
    def __init__(self, px=SPOT, fail=False):
        self.px, self.fail, self.calls = px, fail, []

    def px6(self, pool, perp_index):
        self.calls.append((pool, perp_index))
        if self.fail:
            raise RuntimeError("rpc down")
        return self.px


class Clock:
    def __init__(self, t=0.0):
        self.t = t

    def __call__(self):
        return self.t


def client(reader=None, deployment=DEPLOYMENT, block_time=None, rate_limiter=None, **kw):
    base = {"env": "testnet", "chain_id": 998, "pool": POOL, "signer_key": KEY, "rate_per_min": 0}
    s = Settings(**base | kw)
    app = create_app(s, StubMarket(), TailTable(coins={}), clock=lambda: NOW, nonce_fn=lambda: 7,
                     spot_reader=reader or StubReader(), deployment=deployment, block_time=block_time,
                     rate_limiter=rate_limiter)  # fmt: skip
    return TestClient(app)


def body(**kw):
    return {"buyer": BUYER, "perpIndex": 3, "isLong": True, "level": 80_000_000_000, "payout": 100_000_000,
            "durationSec": 86400} | kw  # fmt: skip


# -- M1: TTL 30 s and the level-distance floor ---------------------------------------------------------


def test_quote_ttl_is_30_seconds_by_default(monkeypatch):
    monkeypatch.delenv("NUMERA_QUOTE_TTL_S", raising=False)
    assert Settings().quote_ttl_s == 30 and Settings.from_env().quote_ttl_s == 30
    q = client().post("/quote", json=body()).json()["quote"]
    assert q["deadline"] == NOW + 30


def test_level_floor_is_k_sigma_sqrt_ttl():
    assert LEVEL_K_SIGMA == 3.0
    d = 3.0 * 0.5 * math.sqrt(30 / SECONDS_PER_YEAR)  # ~0.146 % for sigma 0.5
    inside = round(SPOT * math.exp(-d * 0.99))
    outside = round(SPOT * math.exp(-d * 1.01))
    c = client()
    r = c.post("/quote", json=body(level=inside, durationSec=3600))
    assert r.status_code == 422 and r.json()["error"] == "level_too_close", r.text
    assert "0.14" in r.json()["reason"]
    r = c.post("/quote", json=body(level=outside, durationSec=3600))
    assert r.json().get("error") != "level_too_close", r.text
    up_inside = round(SPOT * math.exp(d * 0.99))
    r = c.post("/quote", json=body(isLong=False, level=up_inside, durationSec=3600))
    assert r.status_code == 422 and r.json()["error"] == "level_too_close"


def test_level_floor_scales_with_the_ttl():
    level = round(SPOT * math.exp(-0.001))  # 0.1 % away: refused at 30 s, fine at 10 s
    r = client().post("/quote", json=body(level=level, durationSec=600))
    assert r.json()["error"] == "level_too_close"
    r = client(quote_ttl_s=10).post("/quote", json=body(level=level, durationSec=600))
    assert r.json().get("error") != "level_too_close"


# -- M2: perps from deployments/<env>.json only --------------------------------------------------------


def test_perp_not_in_deployment_is_refused_before_any_rpc_read():
    reader = StubReader()
    r = client(reader).post("/quote", json=body(perpIndex=60000))
    assert r.status_code == 400 and r.json()["error"] == "perp_not_allowed"
    assert "BTC=3" in r.json()["reason"] and reader.calls == []
    assert client().post("/quote", json=body(perpIndex=4)).status_code == 200


def test_real_testnet_deployment_lists_the_cached_perps():
    dep = load_deployment(default_path("testnet"))
    allowed = set(dep.perps.values())
    assert allowed and all(isinstance(i, int) for i in allowed)
    c = client(deployment=dep)
    bad = max(allowed) + 1
    assert c.post("/quote", json=body(perpIndex=bad)).json()["error"] == "perp_not_allowed"


def test_no_deployment_means_no_perp_allowlist_only_on_local():
    r = client(deployment=None, pool=POOL, chain_id=31337).post("/quote", json=body(perpIndex=60000))
    assert r.json().get("error") != "perp_not_allowed"


@pytest.mark.parametrize(
    "deployment,match",
    [
        (None, "no deployments file"),
        (parse({"chainId": 998, "pools": {"hypercore": {"pool": POOL}}}), "lists no perps"),
        (parse({"chainId": 998, "perps": {"BTC": 3}}), "lists no pools"),
        (parse({"chainId": 31337, "pools": {"h": {"pool": POOL}}, "perps": {"BTC": 3}}), "for chain 31337"),
    ],
)
def test_testnet_engine_refuses_to_start_without_allowlists(deployment, match):
    with pytest.raises(AllowlistMissingError, match=match):
        client(deployment=deployment)


def test_allowlist_is_logged_at_startup(caplog):
    with caplog.at_level(logging.INFO, logger="numera.engine"):
        client()
    msg = next(r.getMessage() for r in caplog.records if "allowlist" in r.getMessage())
    assert "chain 998" in msg and POOL in msg and "'BTC': 3" in msg and "'ETH': 4" in msg


# -- M4: rate limit, spot cache, RPC failover ----------------------------------------------------------


def test_rate_limiter_burst_then_refill():
    clk = Clock()
    rl = RateLimiter(per_min=10, burst=5, clock=clk)
    assert [rl.take("a") for _ in range(5)] == [0.0] * 5
    wait = rl.take("a")
    assert wait == pytest.approx(6.0)  # 10/min = one token per 6 s
    assert rl.take("b") == 0.0  # per key
    clk.t = 6.0
    assert rl.take("a") == 0.0 and rl.take("a") > 0
    clk.t = 1000.0
    assert [rl.take("a") for _ in range(5)] == [0.0] * 5  # bucket never exceeds the burst
    assert rl.take("a") > 0


def test_rate_limiter_memory_is_bounded_by_lru_eviction():
    clk = Clock()
    rl = RateLimiter(per_min=10, burst=1, clock=clk, max_keys=1000)
    rl.take("keep")
    for i in range(5000):  # buckets still drained (no refill time): the old prune kept all of them
        rl.take(f"ip{i}")
        if i % 500 == 0:
            rl.take("keep")  # recently used: survives
        assert len(rl._b) <= 1000
    assert len(rl._b) == 1000 and "keep" in rl._b and "ip0" not in rl._b and "ip4999" in rl._b
    assert rl.take("keep") > 0  # its drained bucket was kept, not reset


def test_ipv6_clients_share_a_bucket_per_64():
    assert rate_key("2001:db8:1:2:aaaa::1") == rate_key("2001:db8:1:2:ffff::9") == "2001:db8:1:2::/64"
    assert rate_key("2001:db8:1:3::1") != rate_key("2001:db8:1:2::1")
    assert rate_key("::ffff:1.2.3.4") == "1.2.3.4" and rate_key("1.2.3.4") == "1.2.3.4"
    assert rate_key("testclient") == "testclient"
    c = proxied_client("127.0.0.1", trusted=("127.0.0.1",))
    assert codes(c, ["2001:db8::1", "2001:db8::2", "2001:db8::3"]) == [200, 200, 429]  # same /64
    assert codes(c, ["2001:db8:0:1::1"]) == [200]  # next /64


def test_quote_endpoint_answers_429_after_the_burst_with_cors_and_retry_after():
    clk = Clock()
    c = client(rate_limiter=RateLimiter(per_min=10, burst=3, clock=clk))
    origin = {"Origin": "http://localhost:5173"}
    codes = [c.post("/quote", json=body(), headers=origin).status_code for _ in range(3)]
    assert codes == [200, 200, 200]
    r = c.post("/quote", json=body(), headers=origin)
    assert r.status_code == 429 and r.json()["error"] == "rate_limited"
    assert set(r.json()) == {"error", "reason"}
    assert r.headers["retry-after"] == "6" and r.headers["access-control-allow-origin"] == origin["Origin"]
    assert c.post("/quote", json={"bad": 1}).status_code == 429  # invalid bodies count too
    assert c.get("/health").status_code == 200  # only POST /quote is limited
    clk.t = 6.0
    assert c.post("/quote", json=body()).status_code == 200


def proxied_client(peer, trusted=(), burst=2):
    s = Settings(env="testnet", chain_id=998, pool=POOL, signer_key=KEY, trusted_proxies=trusted)
    app = create_app(s, StubMarket(), TailTable(coins={}), clock=lambda: NOW, nonce_fn=lambda: 7,
                     spot_reader=StubReader(), deployment=DEPLOYMENT,
                     rate_limiter=RateLimiter(per_min=10, burst=burst, clock=Clock()))  # fmt: skip
    return TestClient(app, client=(peer, 50000))


def codes(c, xffs):
    return [c.post("/quote", json=body(), headers={"X-Forwarded-For": x}).status_code for x in xffs]


def test_client_ip_rules():
    trusted = frozenset({"127.0.0.1", "::1"})
    assert client_ip("203.0.113.9", "1.2.3.4", frozenset()) == "203.0.113.9"  # no trusted proxy: XFF ignored
    assert client_ip("127.0.0.1", "1.2.3.4", trusted) == "1.2.3.4"
    assert client_ip("127.0.0.1", "6.6.6.6, 1.2.3.4", trusted) == "1.2.3.4"  # spoofed left entry not used
    assert client_ip("127.0.0.1", "1.2.3.4, 127.0.0.1", trusted) == "1.2.3.4"  # trusted hops skipped
    assert client_ip("127.0.0.1", None, trusted) == "127.0.0.1"
    assert client_ip("127.0.0.1", "127.0.0.1", trusted) == "127.0.0.1"
    assert client_ip("0:0::1", "1.2.3.4", trusted) == "1.2.3.4"  # addresses compared canonically


def test_xff_is_ignored_without_a_trusted_proxy():
    c = proxied_client("127.0.0.1", trusted=())
    assert codes(c, ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) == [200, 200, 429]  # one bucket: the peer's


def test_trusted_proxy_gives_each_forwarded_client_its_own_bucket():
    c = proxied_client("127.0.0.1", trusted=("127.0.0.1",))
    assert codes(c, ["1.1.1.1", "1.1.1.1", "1.1.1.1"]) == [200, 200, 429]
    assert codes(c, ["2.2.2.2", "2.2.2.2"]) == [200, 200]  # a different client is not throttled
    assert codes(c, ["9.9.9.9, 1.1.1.1"]) == [429]  # client-prepended entry cannot dodge the bucket


def test_spoofed_xff_from_an_untrusted_peer_is_ignored():
    c = proxied_client("203.0.113.9", trusted=("127.0.0.1",))
    assert codes(c, ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) == [200, 200, 429]


def test_trusted_proxies_from_env(monkeypatch):
    monkeypatch.setenv("NUMERA_TRUSTED_PROXIES", " 127.0.0.1, ::1 ,")
    assert Settings.from_env().trusted_proxies == ("127.0.0.1", "::1")
    monkeypatch.delenv("NUMERA_TRUSTED_PROXIES")
    assert Settings.from_env().trusted_proxies == ()


def test_rate_limit_is_on_by_default():
    s = Settings()
    assert s.rate_per_min == 10 and s.rate_burst == 5


def test_spot_cache_per_pool_and_perp():
    clk = Clock()
    inner = StubReader()
    cr = CachedSpotReader(inner, 2.0, clk)
    cr.px6(POOL, 3)
    cr.px6(POOL.upper().replace("0X", "0x"), 3)
    cr.px6(POOL, 4)
    assert len(inner.calls) == 2
    clk.t = 2.0
    cr.px6(POOL, 3)
    assert len(inner.calls) == 3


def test_spot_cache_does_not_cache_failures():
    inner = StubReader(fail=True)
    cr = CachedSpotReader(inner, 2.0, Clock())
    for _ in range(2):
        with pytest.raises(RuntimeError):
            cr.px6(POOL, 3)
    assert len(inner.calls) == 2


def test_app_reads_the_pool_once_for_a_burst_of_quotes():
    reader = StubReader()
    c = client(reader)
    for _ in range(3):
        assert c.post("/quote", json=body()).status_code == 200
    assert len(reader.calls) == 1


class FakeEvm:
    """JSON-RPC endpoint stub: `limited` URLs answer -32005, the others serve oraclePx6 and the block."""

    def __init__(self, limited=()):
        self.limited, self.log = set(limited), []

    def __call__(self, url, payload, timeout):
        self.log.append((url, payload["method"]))
        if url in self.limited:
            err = {"code": -32005, "message": "rate limited"}
            return 200, {"jsonrpc": "2.0", "id": payload["id"], "error": err}
        m = payload["method"]
        if m == "eth_chainId":
            res = "0x3e6"
        elif m == "eth_call":
            assert payload["params"][0]["to"].lower() == SRC
            res = "0x" + encode(["uint64"], [SPOT]).hex()
        elif m == "eth_getBlockByNumber":
            res = {"timestamp": hex(NOW + 3), "number": "0x1"}
        else:
            raise AssertionError(m)
        return 200, {"jsonrpc": "2.0", "id": payload["id"], "result": res}


def test_pool_spot_reader_fails_over_through_the_keeper_rpc_client():
    net = FakeEvm(limited={"https://a/evm"})
    rpc = FailoverRpc(["https://a/evm", "https://b/evm"], post=net, sleep=lambda s: None, label="engine")
    reader = PoolSpotReader(rpc, DEPLOYMENT)
    assert reader.px6(POOL, 3) == SPOT
    assert reader.block_timestamp() == NOW + 3
    assert net.log == [("https://a/evm", "eth_call"), ("https://b/evm", "eth_call"),
                       ("https://b/evm", "eth_getBlockByNumber")]  # one request per read, failed over
    assert rpc.rate_limits == 1


def test_engine_rpc_list():
    s = Settings(chain_id=998, rpc_url="https://mine/evm")
    urls = engine_rpc_urls(s, DEPLOYMENT)
    assert urls[:2] == ["https://mine/evm", "http://unused"] and len(urls) == 4  # + official + chain.link
    assert engine_rpc_urls(Settings(chain_id=998, rpc_urls=("https://x",)), DEPLOYMENT) == ["https://x"]
    assert engine_rpc_urls(Settings(chain_id=31337, rpc_url="http://127.0.0.1:8545"), None) == [
        "http://127.0.0.1:8545"
    ]  # local: no public testnet endpoints
    assert engine_rpc_urls(Settings(chain_id=31337), None) == []


# -- L5: the signer key never appears in a repr ----------------------------------------------------------


def _no_key(text):
    k = KEY[2:].lower()
    return k not in text.lower() and k[:16] not in text.lower()


def test_settings_repr_has_no_key_material(monkeypatch):
    s = Settings(signer_key=KEY)
    assert _no_key(repr(s)) and _no_key(str(s)) and _no_key(repr(s.signer))
    assert s.signer_key is None and s.signer_address == SIGNER
    monkeypatch.setenv("QUOTE_SIGNER_KEY", KEY)
    e = Settings.from_env()
    assert _no_key(repr(e)) and e.signer_address == SIGNER
    assert "signer" not in repr(e)


def test_quotes_are_signed_with_the_account_object():
    j = client().post("/quote", json=body()).json()
    assert recover_signer(Quote(**j["quote"]), 998, POOL, j["signature"]) == SIGNER


# -- L6: now from the latest block ----------------------------------------------------------------------


def test_now_comes_from_the_block_timestamp():
    q = client(block_time=lambda: NOW + 500).post("/quote", json=body()).json()["quote"]
    assert q["deadline"] == NOW + 500 + 30 and q["expiry"] == NOW + 500 + 86400


def test_now_falls_back_to_the_wall_clock_with_a_warning(caplog):
    def broken():
        raise RuntimeError("rpc down")

    with caplog.at_level(logging.WARNING, logger="numera.engine"):
        q = client(block_time=broken).post("/quote", json=body()).json()["quote"]
    assert q["deadline"] == NOW + 30
    assert any("wall clock" in r.getMessage() for r in caplog.records)


def test_rpc_failure_warning_is_logged_once_a_minute_not_per_request(caplog):
    def broken():
        raise RuntimeError("rpc down")

    c = client(block_time=broken)
    with caplog.at_level(logging.WARNING, logger="numera.engine"):
        for _ in range(4):
            assert c.post("/quote", json=body()).json()["quote"]["deadline"] == NOW + 30
    assert sum("block timestamp unavailable" in r.getMessage() for r in caplog.records) == 1


def test_lagging_block_time_falls_back_to_the_wall_clock(caplog):
    with caplog.at_level(logging.WARNING, logger="numera.engine"):
        q = client(block_time=lambda: NOW - 31).post("/quote", json=body()).json()["quote"]
    assert q["deadline"] == NOW + 30  # 31 s behind > TTL 30 s: wall clock
    assert any("lags the wall clock" in r.getMessage() for r in caplog.records)
    q = client(block_time=lambda: NOW - 30).post("/quote", json=body()).json()["quote"]
    assert q["deadline"] == NOW  # within the TTL: block time is kept


def test_module_app_is_built_once(monkeypatch):
    import numera_engine.quote_api as qa

    built = []
    monkeypatch.setattr(qa, "_APP", None)
    monkeypatch.setattr(qa, "create_app", lambda: built.append(1) or object())
    assert qa.app is qa.app and len(built) == 1


def test_throttled_warning():
    mono = Clock()
    w = ThrottledWarning(60.0, mono)
    assert w("k", "x") and not w("k", "x") and w("other", "y")
    mono.t = 60.0
    assert w("k", "x")


def test_block_clock_caches_and_advances_with_the_local_clock():
    mono, calls = Clock(100.0), []

    def fetch():
        calls.append(1)
        return NOW

    bc = BlockClock(fetch, ttl_s=2.0, mono=mono)
    assert bc() == NOW
    mono.t = 101.5
    assert bc() == NOW + 1 and len(calls) == 1
    mono.t = 102.0
    assert bc() == NOW and len(calls) == 2  # re-read from the chain
