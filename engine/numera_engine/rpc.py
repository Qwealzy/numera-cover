"""JSON-RPC client with an endpoint list, rate-limit backoff and failover.

Endpoints are tried in priority order. When one answers ``-32005`` (or HTTP 429) it cools down for an
exponential, jittered 2 -> 60 s and the request moves to the next endpoint that is not cooling; once the
cooldown is over the higher-priority endpoint is used again. Transport errors (timeout, refused, HTTP 5xx)
cool an endpoint the same way. Every HTTP request is counted so callers can report requests/min.

Freshness (keeper fast mode): every endpoint remembers the last head block seen through it
(``note_head``). A ``fresh=True`` call skips a healthy endpoint whose head lags another healthy endpoint's
by more than ``max_head_lag`` blocks (heads are extrapolated at ``block_s`` per block and forgotten after
``HEAD_FRESH_S``), so a decision read never comes from a node that is seconds behind while a fresher one
answers. ``batch`` sends several calls in one HTTP request (one round-trip), falling back to one request per
call when a node does not accept JSON-RPC batches.

Pinning (keeper sends): ``call``/``batch`` take ``ep``, the endpoint to use (normally the one that served the
decision read), so the nonce, the gas estimate and ``eth_sendRawTransaction`` see the same state the decision
saw. A pinned endpoint that is cooling down is replaced by a ``fresh`` pick.

Chain guard: ``verify_chain`` asks every endpoint for ``eth_chainId`` (directly, no failover). Any endpoint
answering an id outside the allowed set, or endpoints disagreeing, is an error; an endpoint that cannot be
reached is dropped from the list (never used, never compared for lag). Callers that send run it first.

``FailoverProvider`` lets web3 (used only to build and send the rare keeper transactions) go through the
same client, so sends are counted and fail over too.
"""

from __future__ import annotations

import logging
import random
import time
from collections import deque
from collections.abc import Callable, Collection, Sequence
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
DEFAULT_MAX_HEAD_LAG = 2  # blocks a fresh read tolerates behind the freshest healthy endpoint
HEAD_FRESH_S = 30.0  # a head observation older than this is not used to compare endpoints
BLOCK_S = 1.0  # HyperEVM small blocks: one a second (testnet block timestamps, 2026-10-02)

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


def resolve_rpcs(cli: list[str] | None, env: str | None, deployment_rpc: str | None) -> list[str]:
    """``--rpc`` (repeated) > ``NUMERA_RPCS`` (comma-separated) > deployments rpc + official + chain.link."""
    if cli:
        urls = cli
    elif env and env.strip():
        urls = env.split(",")
    else:
        urls = ([deployment_rpc] if deployment_rpc else []) + list(DEFAULT_TESTNET_RPCS)
    return list(dict.fromkeys(u.strip() for u in urls if u and u.strip()))


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
    head: int | None = None  # last head block seen through this endpoint
    head_at: float = 0.0  # clock time of that observation


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
        label: str = "keeper",
        max_head_lag: int = DEFAULT_MAX_HEAD_LAG,
        block_s: float = BLOCK_S,
    ) -> None:
        urls = list(dict.fromkeys(u.strip() for u in urls if u and u.strip()))
        if not urls:
            raise ValueError("no RPC endpoints")
        self.endpoints = [Endpoint(u) for u in urls]
        self.label = label  # log prefix: "keeper" or "engine" (each process has its own client and budget)
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
        if max_head_lag < 0:
            raise ValueError("max_head_lag must be >= 0")
        self.max_head_lag = max_head_lag
        self.block_s = block_s
        self.last: Endpoint | None = None  # endpoint that answered the last call (result or RpcError)
        self.chain_id: int | None = None  # set by verify_chain (every endpoint answered this id)

    # -- stats ----------------------------------------------------------------------------------------

    def per_minute(self) -> int:
        """HTTP requests sent in the last 60 s."""
        self._trim(self.clock())
        return len(self._recent)

    def _trim(self, now: float) -> None:
        while self._recent and self._recent[0] <= now - 60.0:
            self._recent.popleft()

    # -- endpoint choice ------------------------------------------------------------------------------

    def healthy(self, now: float | None = None) -> list[Endpoint]:
        """Endpoints not cooling down, in priority order."""
        now = self.clock() if now is None else now
        return [e for e in self.endpoints if e.cool_until <= now]

    def note_head(self, block: int | None, ep: Endpoint | None = None) -> None:
        """Record ``block`` as the head seen through ``ep`` (default: the endpoint of the last call)."""
        ep = ep or self.last
        if ep is not None and block is not None:
            ep.head, ep.head_at = int(block), self.clock()

    def est_head(self, ep: Endpoint, now: float | None = None) -> int | None:
        """``ep``'s head now, extrapolated from its last observation; None when unknown or too old."""
        now = self.clock() if now is None else now
        if ep.head is None or now - ep.head_at > HEAD_FRESH_S:
            return None
        return ep.head + int(max(0.0, now - ep.head_at) / self.block_s)

    def lag(self, ep: Endpoint, now: float | None = None) -> int | None:
        """Blocks ``ep`` is behind the freshest *other* healthy endpoint (None when not comparable)."""
        now = self.clock() if now is None else now
        own = self.est_head(ep, now)
        others = [h for e in self.healthy(now) if e is not ep and (h := self.est_head(e, now)) is not None]
        if own is None or not others:
            return None
        return max(others) - own

    def lagging(self, ep: Endpoint, now: float | None = None) -> bool:
        lag = self.lag(ep, now)
        return lag is not None and lag > self.max_head_lag

    def _pick(self, now: float, fresh: bool = False, ep: Endpoint | None = None) -> Endpoint | None:
        healthy = self.healthy(now)
        if ep is not None:  # pinned: that endpoint while it is healthy, else the freshest healthy one
            if ep in healthy:
                return ep
            fresh = True
        if fresh and len(healthy) > 1:  # a lagging endpoint is used only when no healthy one keeps up
            healthy = [e for e in healthy if not self.lagging(e, now)] or healthy
        return healthy[0] if healthy else None

    def _cool(self, ep: Endpoint, now: float, why: str) -> None:
        ep.fails += 1
        wait = backoff_s(ep.fails, self.rand())
        ep.cool_until = now + wait
        if why == "rate":
            ep.rate_limits += 1
            self.rate_limits += 1
            log.warning("[%s] rate limited, backing off %.1fs (rpc=%s)", self.label, wait, host(ep.url))
        else:
            ep.errors += 1
            log.warning("[%s] rpc error (%s), backing off %.1fs (rpc=%s)", self.label, why, wait,
                        host(ep.url))

    def _use(self, ep: Endpoint) -> None:
        if self.current is not ep:
            if self.current is not None:
                log.info("[%s] switched rpc %s -> %s", self.label, host(self.current.url), host(ep.url))
            self.current = ep

    # -- call -----------------------------------------------------------------------------------------

    def call(self, method: str, params: list[Any] | None = None, fresh: bool = False,
             ep: Endpoint | None = None) -> Any:  # fmt: skip
        """One JSON-RPC call; fails over and backs off on rate limits and transport errors. ``fresh``: skip
        endpoints whose head lags a healthy one by more than ``max_head_lag`` blocks; ``ep``: use that
        endpoint while it is healthy (module docstring)."""
        body = self._roundtrip(method, lambda: self._payload(method, params), fresh, batch=False, ep=ep)
        if "error" in body:
            raise _rpc_error(body["error"])
        return body["result"]

    def batch(self, calls: Sequence[tuple[str, list[Any]]], ep: Endpoint | None = None) -> list[Any]:
        """Several calls in one HTTP request (one round-trip). Each item is its result or an ``RpcError``
        instance (returned, not raised). A node that refuses batches gets one request per call instead.
        ``ep``: pinned endpoint, as in ``call``."""
        if not calls:
            return []
        payloads: list[dict[str, Any]] = []

        def build() -> list[dict[str, Any]]:
            payloads[:] = [self._payload(m, p) for m, p in calls]
            return payloads

        body = self._roundtrip(f"batch[{len(calls)}]", build, False, batch=True, ep=ep)
        if not isinstance(body, list):  # batch refused (one error object): one call each
            log.info("[%s] batch refused by %s; sending %d calls one by one", self.label,
                     host(self.last.url) if self.last else "-", len(calls))  # fmt: skip
            out: list[Any] = []
            for m, p in calls:
                try:
                    out.append(self.call(m, p, ep=self.last if ep is not None else None))
                except RpcError as e:
                    out.append(e)
            return out
        by_id = {item.get("id"): item for item in body if isinstance(item, dict)}
        out = []
        for pl in payloads:
            item = by_id.get(pl["id"])
            if item is None:
                out.append(RpcError(0, "missing from the batch answer"))
            elif "error" in item:
                out.append(_rpc_error(item["error"]))
            else:
                out.append(item.get("result"))
        return out

    def _payload(self, method: str, params: list[Any] | None) -> dict[str, Any]:
        self._id += 1
        return {"jsonrpc": "2.0", "id": self._id, "method": method, "params": params or []}

    def _roundtrip(self, what: str, build: Callable[[], Any], fresh: bool, batch: bool,
                   ep: Endpoint | None = None) -> Any:  # fmt: skip
        """Post ``build()`` until an endpoint gives a usable answer; returns the parsed body."""
        waited = 0.0
        pin = ep
        while True:
            now = self.clock()
            ep = self._pick(now, fresh, pin)
            if ep is None:
                wait = max(0.0, min(e.cool_until for e in self.endpoints) - now)
                if waited + wait > self.max_wait_s:
                    raise RpcUnavailableError(f"all RPC endpoints failing for {waited:.0f}s ({what})")
                self.sleep(wait)
                waited += wait
                continue
            payload = build()
            self._count(ep, now)
            try:
                status, body = self.post(ep.url, payload, self.timeout_s)
            except Exception as exc:  # noqa: BLE001 - transport failure: cool this endpoint, try the next
                self._cool(ep, now, type(exc).__name__)
                continue
            items = body if isinstance(body, list) else [body]
            if is_rate_limit(status, body) or (batch and any(is_rate_limit(200, i) for i in items)):
                self._cool(ep, now, "rate")
                continue
            batch_ok = batch and status < 500 and (isinstance(body, list) or
                                                   (isinstance(body, dict) and "error" in body))  # fmt: skip
            if not batch_ok and (status >= 500 or not isinstance(body, dict)
                                 or ("result" not in body and "error" not in body)):  # fmt: skip
                self._cool(ep, now, f"http {status}")
                continue
            ep.fails = 0
            self._use(ep)
            self.last = ep
            return body

    def _count(self, ep: Endpoint, now: float) -> None:
        self.requests += 1
        ep.requests += 1
        self._recent.append(now)
        self._trim(now)

    def verify_chain(self, allowed: Collection[int], attempts: int = 3) -> int:
        """``eth_chainId`` on every endpoint (no failover; counted). Raises RuntimeError when an endpoint
        answers an id outside ``allowed`` or the endpoints disagree; drops an endpoint that gives no usable
        answer after ``attempts`` tries (logged), so it is never used nor compared for lag. Returns the id.
        Runs once per client: later calls only check the verified id against ``allowed``."""
        if self.chain_id is not None:
            if self.chain_id not in allowed:
                raise RuntimeError(f"chainId {self.chain_id} not allowed: {sorted(allowed)}")
            return self.chain_id
        ids: dict[str, int] = {}
        for ep in list(self.endpoints):
            got: int | None = None
            for i in range(attempts):
                now = self.clock()
                self._count(ep, now)
                try:
                    status, body = self.post(ep.url, self._payload("eth_chainId", []), self.timeout_s)
                    if status < 500 and isinstance(body, dict) and isinstance(body.get("result"), str):
                        got = int(body["result"], 16)
                        break
                except Exception:  # noqa: BLE001 - unreachable now: retried, then dropped
                    pass
                if i + 1 < attempts:
                    self.sleep(BACKOFF_BASE_S)
            if got is None:
                log.warning("[%s] rpc %s gave no chain id; not used", self.label, host(ep.url))
                self.endpoints.remove(ep)
                continue
            if got not in allowed:
                raise RuntimeError(f"rpc {host(ep.url)} is on chainId {got}; allowed: {sorted(allowed)}")
            ids[ep.url] = got
        if not ids:
            raise RuntimeError("no RPC endpoint answered eth_chainId")
        if len(set(ids.values())) > 1:
            seen = ", ".join(f"{host(u)}={c}" for u, c in ids.items())
            raise RuntimeError(f"RPC endpoints differ in chainId: {seen}")
        self.chain_id = next(iter(ids.values()))
        return self.chain_id

    def probe_head(self, ep: Endpoint) -> int | None:
        """``eth_blockNumber`` on ``ep`` alone (no failover; counted). Records and returns the head, or None
        on any failure (a rate limit or transport error also cools ``ep``)."""
        now = self.clock()
        self._count(ep, now)
        try:
            status, body = self.post(ep.url, self._payload("eth_blockNumber", []), self.timeout_s)
        except Exception as exc:  # noqa: BLE001 - a probe never stops the caller
            self._cool(ep, now, type(exc).__name__)
            return None
        if is_rate_limit(status, body):
            self._cool(ep, now, "rate")
            return None
        if status >= 500 or not isinstance(body, dict) or not isinstance(body.get("result"), str):
            return None
        head = int(body["result"], 16)
        self.note_head(head, ep)
        return head


def _rpc_error(err: Any) -> RpcError:
    err = err if isinstance(err, dict) else {}
    return RpcError(int(err.get("code", 0)), str(err.get("message", "")), err.get("data"))


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
