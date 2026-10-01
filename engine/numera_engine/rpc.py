"""JSON-RPC client with an endpoint list, rate-limit backoff and failover.

Endpoints are tried in priority order. When one answers ``-32005`` (or HTTP 429) it cools down for an
exponential, jittered 2 -> 60 s and the request moves to the next endpoint that is not cooling; once the
cooldown is over the higher-priority endpoint is used again. Transport errors (timeout, refused, HTTP 5xx)
cool an endpoint the same way. Every HTTP request is counted so callers can report requests/min.

``FailoverProvider`` lets web3 (used only to build and send the rare keeper transactions) go through the
same client, so sends are counted and fail over too.
"""

from __future__ import annotations

import logging
import random
import time
from collections import deque
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

log = logging.getLogger("numera.keeper")

OFFICIAL_TESTNET_RPC = "https://rpc.hyperliquid-testnet.xyz/evm"
CHAINLINK_TESTNET_RPC = "https://rpcs.chain.link/hyperevm/testnet"
DEFAULT_TESTNET_RPCS = (OFFICIAL_TESTNET_RPC, CHAINLINK_TESTNET_RPC)

RATE_LIMIT_CODE = -32005
BACKOFF_BASE_S = 2.0
BACKOFF_MAX_S = 60.0
JITTER = 0.2  # +/- 20 %

# post(url, payload, timeout_s) -> (http_status, parsed_json_or_None); raises on transport failure
Post = Callable[[str, dict[str, Any], float], tuple[int, Any]]


class RpcError(Exception):
    """A JSON-RPC error answer that is not a rate limit (e.g. execution reverted). Not retried."""

    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(f"rpc error {code}: {message}")
        self.code = code
        self.message = message
        self.data = data


class RpcUnavailableError(Exception):
    """Every endpoint kept failing for longer than ``max_wait_s``."""


def host(url: str) -> str:
    return urlparse(url).netloc or url


def backoff_s(fails: int, rand: float) -> float:
    """Cooldown after ``fails`` consecutive failures: 2, 4, 8, ... capped at 60 s, jittered +/-20 %.

    ``rand`` is uniform in [0, 1). The cap holds after jitter, so the result never exceeds 60 s.
    """
    base = min(BACKOFF_MAX_S, BACKOFF_BASE_S * 2 ** max(0, fails - 1))
    return min(BACKOFF_MAX_S, base * (1 + JITTER * (2 * rand - 1)))


def is_rate_limit(status: int, body: Any) -> bool:
    if status == 429:
        return True
    err = body.get("error") if isinstance(body, dict) else None
    if not isinstance(err, dict):
        return False
    return err.get("code") == RATE_LIMIT_CODE or "rate limit" in str(err.get("message", "")).lower()


def _requests_post() -> Post:
    import requests

    session = requests.Session()

    def post(url: str, payload: dict[str, Any], timeout: float) -> tuple[int, Any]:
        r = session.post(url, json=payload, timeout=timeout)
        try:
            body = r.json()
        except ValueError:
            body = None
        return r.status_code, body

    return post


@dataclass
class Endpoint:
    url: str
    fails: int = 0  # consecutive failures (reset on success)
    cool_until: float = 0.0
    requests: int = 0
    rate_limits: int = 0
    errors: int = 0


class FailoverRpc:
    def __init__(
        self,
        urls: Sequence[str],
        post: Post | None = None,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        rand: Callable[[], float] = random.random,
        timeout_s: float = 10.0,
        max_wait_s: float = 120.0,
    ) -> None:
        urls = list(dict.fromkeys(u.strip() for u in urls if u and u.strip()))
        if not urls:
            raise ValueError("no RPC endpoints")
        self.endpoints = [Endpoint(u) for u in urls]
        self.post = post or _requests_post()
        self.clock = clock
        self.sleep = sleep
        self.rand = rand
        self.timeout_s = timeout_s
        self.max_wait_s = max_wait_s
        self.requests = 0
        self.rate_limits = 0
        self.current: Endpoint | None = None
        self._recent: deque[float] = deque()
        self._id = 0

    # -- stats ----------------------------------------------------------------------------------------

    def per_minute(self) -> int:
        """HTTP requests sent in the last 60 s."""
        self._trim(self.clock())
        return len(self._recent)

    def _trim(self, now: float) -> None:
        while self._recent and self._recent[0] <= now - 60.0:
            self._recent.popleft()

    # -- endpoint choice ------------------------------------------------------------------------------

    def _pick(self, now: float) -> Endpoint | None:
        return next((e for e in self.endpoints if e.cool_until <= now), None)

    def _cool(self, ep: Endpoint, now: float, why: str) -> None:
        ep.fails += 1
        wait = backoff_s(ep.fails, self.rand())
        ep.cool_until = now + wait
        if why == "rate":
            ep.rate_limits += 1
            self.rate_limits += 1
            log.warning("[keeper] rate limited, backing off %.1fs (rpc=%s)", wait, host(ep.url))
        else:
            ep.errors += 1
            log.warning("[keeper] rpc error (%s), backing off %.1fs (rpc=%s)", why, wait, host(ep.url))

    def _use(self, ep: Endpoint) -> None:
        if self.current is not ep:
            if self.current is not None:
                log.info("[keeper] switched rpc %s -> %s", host(self.current.url), host(ep.url))
            self.current = ep

    # -- call -----------------------------------------------------------------------------------------

    def call(self, method: str, params: list[Any] | None = None) -> Any:
        """One JSON-RPC call; fails over and backs off on rate limits and transport errors."""
        waited = 0.0
        while True:
            now = self.clock()
            ep = self._pick(now)
            if ep is None:
                wait = max(0.0, min(e.cool_until for e in self.endpoints) - now)
                if waited + wait > self.max_wait_s:
                    raise RpcUnavailableError(f"all RPC endpoints failing for {waited:.0f}s ({method})")
                self.sleep(wait)
                waited += wait
                continue
            self._id += 1
            payload = {"jsonrpc": "2.0", "id": self._id, "method": method, "params": params or []}
            self.requests += 1
            ep.requests += 1
            self._recent.append(now)
            self._trim(now)
            try:
                status, body = self.post(ep.url, payload, self.timeout_s)
            except Exception as exc:  # noqa: BLE001 - transport failure: cool this endpoint, try the next
                self._cool(ep, now, type(exc).__name__)
                continue
            if is_rate_limit(status, body):
                self._cool(ep, now, "rate")
                continue
            if status >= 500 or not isinstance(body, dict) or ("result" not in body and "error" not in body):
                self._cool(ep, now, f"http {status}")
                continue
            ep.fails = 0
            self._use(ep)
            if "error" in body:
                err = body["error"] or {}
                raise RpcError(int(err.get("code", 0)), str(err.get("message", "")), err.get("data"))
            return body["result"]


def failover_provider(rpc: FailoverRpc) -> Any:
    """A web3 provider that sends every request through ``rpc`` (built lazily: web3 import is heavy)."""
    from web3.providers.base import JSONBaseProvider

    class FailoverProvider(JSONBaseProvider):
        def make_request(self, method: Any, params: Any) -> Any:
            try:
                return {"jsonrpc": "2.0", "id": 0, "result": rpc.call(str(method), list(params or []))}
            except RpcError as e:
                err: dict[str, Any] = {"code": e.code, "message": e.message}
                if e.data is not None:
                    err["data"] = e.data
                return {"jsonrpc": "2.0", "id": 0, "error": err}

        def is_connected(self, show_traceback: bool = False) -> bool:
            return True

    return FailoverProvider()
