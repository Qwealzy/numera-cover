"""Quote API (docs/how-it-works.md §6) with a stubbed market data layer: no network."""

import pytest
from fastapi.testclient import TestClient

from numera_engine.data import InfoApiError
from numera_engine.pricing import (
    SECONDS_PER_YEAR,
    TailAdj,
    TailTable,
    premium,
    touch_prob,
)
from numera_engine.quote import Quote, recover_signer
from numera_engine.quote_api import Settings, UnknownPerpError, create_app

KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"  # public anvil key #0
SIGNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
POOL = "0x5FbDB2315678afecb367f032d93F642f64180aa3"
BUYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
NOW = 1_790_000_000


class StubMarket:
    def __init__(self, px6=84_000_000_000, sigma=0.5, fail=None):
        self.px6, self.sig, self.fail = px6, sigma, fail

    def oracle(self, perp_index):
        if self.fail == "oracle":
            raise InfoApiError("down")
        if perp_index != 3:
            raise UnknownPerpError(perp_index)
        return "BTC", self.px6

    def sigma(self, coin):
        if self.fail == "sigma":
            raise InfoApiError("down")
        return self.sig


def make_client(market=None, tail=None, **settings):
    s = Settings(**{"env": "local", "chain_id": 31337, "pool": POOL, "signer_key": KEY} | settings)
    tail = tail or TailTable(coins={})
    app = create_app(s, market or StubMarket(), tail, clock=lambda: NOW, nonce_fn=lambda: 42)
    return TestClient(app)


def body(**kw):
    return {"buyer": BUYER, "perpIndex": 3, "isLong": True, "level": 80_000_000_000, "payout": 100_000_000,
            "durationSec": 86400} | kw  # fmt: skip


def test_health():
    r = make_client().get("/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "env": "local", "signer": SIGNER, "chainId": 31337, "pool": POOL,
                        "pools": [POOL.lower()]}  # fmt: skip


def test_health_without_signer_is_not_ok():
    r = make_client(signer_key=None).get("/health")
    assert r.json()["ok"] is False and r.json()["signer"] is None


def test_quote_happy_path_signs_a_valid_quote():
    r = make_client().post("/quote", json=body())
    assert r.status_code == 200, r.text
    j = r.json()
    q = j["quote"]
    p = touch_prob(84_000.0, 80_000.0, 0.5, 86400 / SECONDS_PER_YEAR)
    assert q == {
        "buyer": BUYER, "perpIndex": 3, "isLong": True, "level": 80_000_000_000, "payout": 100_000_000,
        "premium": premium(100_000_000, p), "expiry": NOW + 86400, "spotRef": 84_000_000_000,
        "deadline": NOW + 60, "nonce": 42,
    }  # fmt: skip
    assert recover_signer(Quote(**q), 31337, POOL, j["signature"]) == SIGNER
    b = j["breakdown"]
    assert b["model"] == "gbm-touch-v1" and b["loading"] == 0.2 and b["sigma"] == 0.5
    assert b["touchProb"] == pytest.approx(p) and b["premium"] == q["premium"]
    assert b["tailMultiplier"] == 1.0 and b["tailFloor"] == 0.0


def test_short_cover_and_tail_table_are_used():
    tail = TailTable(coins={}, default=TailAdj(2.0, 0.05))
    r = make_client(tail=tail).post("/quote", json=body(isLong=False, level=86_000_000_000, durationSec=3600))
    assert r.status_code == 200, r.text
    p = touch_prob(84_000.0, 86_000.0, 0.5, 3600 / SECONDS_PER_YEAR)
    assert r.json()["quote"]["premium"] == premium(100_000_000, p, 2.0, q_floor=0.05)
    assert r.json()["breakdown"]["pricedProb"] == pytest.approx(max(2 * p, 0.05))


@pytest.mark.parametrize(
    "kw,code",
    [
        ({"level": 84_000_000_000}, "level_already_breached"),  # long: oracle <= level
        ({"level": 85_000_000_000}, "level_already_breached"),
        ({"isLong": False, "level": 83_000_000_000}, "level_already_breached"),  # short: oracle >= level
        ({"level": 83_900_000_000, "durationSec": 7 * 86400}, "prob_too_high"),
        ({"durationSec": 30}, "duration_out_of_range"),
        ({"durationSec": 8 * 86400}, "duration_out_of_range"),
        ({"payout": 10**12}, "capacity"),
        ({"perpIndex": 9}, "unknown_perp"),
    ],
)
def test_refusals(kw, code):
    r = make_client().post("/quote", json=body(**kw))
    assert r.status_code in (400, 422), r.text
    assert r.json()["error"] == code and r.json()["reason"]


@pytest.mark.parametrize(
    "payload",
    [
        body(buyer="0x123"),
        body(level=-1),
        body(payout=0),
        body(extra=1),
        {k: v for k, v in body().items() if k != "payout"},
        body(isLong="maybe"),
    ],
)
def test_invalid_requests_use_error_shape(payload):
    r = make_client().post("/quote", json=payload)
    assert r.status_code == 400
    assert r.json()["error"] == "invalid_request" and set(r.json()) == {"error", "reason"}


def test_market_data_failures_are_503():
    for fail in ("oracle", "sigma"):
        r = make_client(market=StubMarket(fail=fail)).post("/quote", json=body())
        assert r.status_code == 503 and r.json()["error"] == "market_data_unavailable"


def test_no_signer_is_503():
    r = make_client(signer_key=None).post("/quote", json=body())
    assert r.status_code == 503 and r.json()["error"] == "signer_unavailable"


def test_never_signs_for_mainnet():
    c = make_client(chain_id=999)
    r = c.post("/quote", json=body())
    assert r.status_code == 403 and r.json()["error"] == "chain_not_allowed"
    assert c.get("/health").json()["ok"] is False


def test_unknown_route_uses_error_shape():
    r = make_client().get("/nope")
    assert r.status_code == 404 and set(r.json()) == {"error", "reason"}
