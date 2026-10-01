"""FailoverRpc (D18): -32005 backoff 2 -> 60 s with jitter, rotation, return to primary (fake transport)."""

import pytest

from numera_engine.rpc import (
    FailoverRpc,
    RpcError,
    RpcUnavailableError,
    backoff_s,
    failover_provider,
    is_rate_limit,
)

A, B = "https://a.example/evm", "https://b.example/evm"
RL = (200, {"jsonrpc": "2.0", "id": 1, "error": {"code": -32005, "message": "rate limited"}})


def ok(result="0x1"):
    return (200, {"jsonrpc": "2.0", "id": 1, "result": result})


class Clock:
    def __init__(self):
        self.t = 1000.0
        self.slept = []

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.slept.append(s)
        self.t += s


class FakeNet:
    """Per-URL scripted answers; a callable answer is evaluated (may raise), the last one repeats."""

    def __init__(self, script):
        self.script = {u: list(v) for u, v in script.items()}
        self.log = []

    def __call__(self, url, payload, timeout):
        self.log.append((url, payload["method"]))
        q = self.script[url]
        ans = q.pop(0) if len(q) > 1 else q[0]
        return ans() if callable(ans) else ans


def make(script, rand=0.5, **kw):
    clock = Clock()
    net = FakeNet(script)
    rpc = FailoverRpc([A, B], post=net, clock=clock, sleep=clock.sleep, rand=lambda: rand, **kw)
    return rpc, net, clock


def test_backoff_doubles_from_2_to_60_with_bounded_jitter():
    assert [backoff_s(n, 0.5) for n in (1, 2, 3, 4, 5, 6, 7, 10)] == [2, 4, 8, 16, 32, 60, 60, 60]
    assert backoff_s(1, 0.0) == pytest.approx(1.6) and backoff_s(1, 0.999999) == pytest.approx(2.4, abs=1e-4)
    assert backoff_s(9, 0.999999) == 60  # cap holds after jitter


def test_rate_limit_detection():
    assert is_rate_limit(*RL) and is_rate_limit(429, None)
    assert is_rate_limit(200, {"error": {"code": -32000, "message": "Rate limit exceeded"}})
    assert not is_rate_limit(*ok()) and not is_rate_limit(200, {"error": {"code": 3, "message": "revert"}})


def test_rate_limited_primary_rotates_then_returns_after_cooldown(caplog):
    rpc, net, clock = make({A: [RL, ok("0xa")], B: [ok("0xb")]})
    caplog.set_level("INFO", logger="numera.keeper")
    assert rpc.call("eth_blockNumber") == "0xb"  # A limited -> same request answered by B, no sleep
    assert [u for u, _ in net.log] == [A, B] and clock.slept == []
    assert "rate limited, backing off 2.0s (rpc=a.example)" in caplog.text
    assert rpc.call("eth_blockNumber") == "0xb"  # A still cooling
    clock.t += 2.0
    assert rpc.call("eth_blockNumber") == "0xa"  # back to the primary
    assert rpc.requests == 4 and rpc.rate_limits == 1
    assert (rpc.endpoints[0].requests, rpc.endpoints[1].requests) == (2, 2)
    assert "switched rpc b.example -> a.example" in caplog.text


def test_consecutive_limits_grow_backoff_and_success_resets_it():
    rpc, net, clock = make({A: [RL, RL, RL, ok()], B: [ok()]})
    rpc.call("x")
    clock.t += 2
    rpc.call("x")  # A limited again: 4 s
    assert rpc.endpoints[0].cool_until == pytest.approx(clock.t + 4)
    clock.t += 4
    rpc.call("x")  # third: 8 s
    assert rpc.endpoints[0].cool_until == pytest.approx(clock.t + 8)
    clock.t += 8
    rpc.call("x")
    assert rpc.endpoints[0].fails == 0


def test_all_endpoints_limited_sleeps_until_the_first_cools_down():
    rpc, net, clock = make({A: [RL, ok("0xa")], B: [RL, ok("0xb")]})
    assert rpc.call("eth_call") == "0xa"
    assert clock.slept == [pytest.approx(2.0)]
    assert [u for u, _ in net.log] == [A, B, A]


def test_gives_up_after_max_wait():
    rpc, _, clock = make({A: [RL], B: [RL]}, max_wait_s=30)
    with pytest.raises(RpcUnavailableError):
        rpc.call("eth_call")
    assert sum(clock.slept) <= 30


def test_transport_errors_and_5xx_fail_over_but_rpc_errors_do_not():
    def boom():
        raise ConnectionError("refused")

    rpc, net, _ = make({A: [boom, (502, None), ok("0xa")], B: [ok("0xb")]})
    assert rpc.call("x") == "0xb" and rpc.endpoints[0].errors == 1
    rpc2, net2, _ = make({A: [(200, {"error": {"code": 3, "message": "execution reverted"}})], B: [ok()]})
    with pytest.raises(RpcError) as e:
        rpc2.call("eth_call")
    assert e.value.code == 3 and [u for u, _ in net2.log] == [A]  # deterministic error: no retry elsewhere


def test_requests_per_minute_window():
    rpc, _, clock = make({A: [ok()], B: [ok()]})
    for _ in range(5):
        rpc.call("x")
        clock.t += 15
    assert rpc.requests == 5 and rpc.per_minute() == 3  # sent at -75, -60, -45, -30, -15 s


def test_web3_provider_wraps_results_and_errors():
    rpc, _, _ = make({A: [ok("0x3e6"), (200, {"error": {"code": 3, "message": "reverted", "data": "0x12"}})],
                      B: [ok()]})  # fmt: skip
    p = failover_provider(rpc)
    assert p.make_request("eth_chainId", [])["result"] == "0x3e6"
    assert p.make_request("eth_call", [])["error"] == {"code": 3, "message": "reverted", "data": "0x12"}


def test_endpoint_list_is_deduplicated_and_required():
    assert [e.url for e in FailoverRpc([A, " " + A, B, ""], post=lambda *a: ok()).endpoints] == [A, B]
    with pytest.raises(ValueError):
        FailoverRpc([], post=lambda *a: ok())
