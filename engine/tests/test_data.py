"""Info API client: px6 conversion, pagination, cache. No network: the HTTP session is faked."""

import json

import pytest

from numera_engine.data import (
    InfoApiError,
    InfoClient,
    perp_index_of,
    px6_from_decimal_str,
    px6_from_precompile,
)

H = 3_600_000


def test_px6_from_info_api_string():
    assert px6_from_decimal_str("84245.6") == 84_245_600_000
    assert px6_from_decimal_str("0.000123") == 123
    assert px6_from_decimal_str("90.926") == 90_926_000
    with pytest.raises(ValueError):
        px6_from_decimal_str("1.0000001")  # more than 6 decimals cannot be px6
    with pytest.raises(ValueError):
        px6_from_decimal_str("0")


def test_px6_from_precompile_matches_research_example():
    # Info API snapshot: testnet BTC (szDecimals 5) oraclePx raw 842456 -> 84245.6 USD
    assert px6_from_precompile(842456, 5) == 84_245_600_000 == px6_from_decimal_str("84245.6")
    assert px6_from_precompile(909_260, 2) == px6_from_decimal_str("90.926")  # HYPE-like, szDecimals 2
    with pytest.raises(ValueError):
        px6_from_precompile(1, 7)


def test_perp_index_of():
    uni = [{"name": "SOL"}, {"name": "BTC"}]
    assert perp_index_of(uni, "BTC") == 1
    with pytest.raises(KeyError):
        perp_index_of(uni, "ETH")


class FakeResp:
    def __init__(self, status, payload):
        self.status_code = status
        self._payload = payload
        self.text = json.dumps(payload)

    def json(self):
        return self._payload


class FakeSession:
    """Serves candles 0..n-1 (hourly), at most ``cap`` per response, optional leading 429."""

    def __init__(self, n=1200, cap=500, fail_first=0):
        self.n, self.cap, self.fail_first, self.calls = n, cap, fail_first, []

    def post(self, url, json, timeout):  # noqa: A002 - mirrors requests API
        self.calls.append(json)
        if self.fail_first:
            self.fail_first -= 1
            return FakeResp(429, {})
        if json["type"] == "metaAndAssetCtxs":
            return FakeResp(200, [{"universe": [{"name": "BTC"}]}, [{"oraclePx": "1.5"}]])
        req = json["req"]
        rows = [
            {"t": i * H, "T": i * H + H - 1, "s": req["coin"], "i": "1h", "o": "1", "c": "1", "h": "1",
             "l": "1", "v": "1", "n": 1}
            for i in range(self.n)
            if req["startTime"] <= i * H <= req["endTime"]
        ][: self.cap]  # fmt: skip
        return FakeResp(200, rows)


def _client(session, tmp_path=None):
    c = InfoClient("http://fake/info", cache_dir=tmp_path, session=session)
    c._next_ok = 0.0
    return c


def test_candles_paginate_past_response_cap(monkeypatch):
    monkeypatch.setattr("numera_engine.data.time.sleep", lambda s: None)
    sess = FakeSession(n=1200, cap=500)
    cs = _client(sess).candles("BTC", "1h", 0, 1199 * H)
    assert [c.t for c in cs] == [i * H for i in range(1200)]
    assert len(sess.calls) == 3  # 500 + 500 + 200, then the cursor passes end_ms


def test_candles_respect_range(monkeypatch):
    monkeypatch.setattr("numera_engine.data.time.sleep", lambda s: None)
    cs = _client(FakeSession(n=100)).candles("BTC", "1h", 10 * H, 19 * H)
    assert [c.t // H for c in cs] == list(range(10, 20))


def test_retry_on_429(monkeypatch):
    monkeypatch.setattr("numera_engine.data.time.sleep", lambda s: None)
    sess = FakeSession(n=5, fail_first=2)
    assert len(_client(sess).candles("BTC", "1h", 0, 4 * H)) == 5


def test_gives_up_after_retries(monkeypatch):
    monkeypatch.setattr("numera_engine.data.time.sleep", lambda s: None)
    with pytest.raises(InfoApiError):
        _client(FakeSession(fail_first=100)).candles("BTC", "1h", 0, H)


def test_closed_window_is_served_from_cache(monkeypatch, tmp_path):
    monkeypatch.setattr("numera_engine.data.time.sleep", lambda s: None)
    sess = FakeSession(n=50)
    c = _client(sess, tmp_path)
    a = c.candles("BTC", "1h", 0, 49 * H)
    n_calls = len(sess.calls)
    b = c.candles("BTC", "1h", 0, 49 * H)
    assert a == b and len(sess.calls) == n_calls


def test_meta_and_ctxs(monkeypatch):
    monkeypatch.setattr("numera_engine.data.time.sleep", lambda s: None)
    uni, ctxs = _client(FakeSession()).meta_and_ctxs()
    assert uni[0]["name"] == "BTC" and ctxs[0]["oraclePx"] == "1.5"
