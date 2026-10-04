"""Quote API (docs/how-it-works.md §6): FastAPI service that prices and signs §4 Quotes.

    uvicorn numera_engine.quote_api:app --port 8000      (configuration from environment, see Settings)

POST /quote  {buyer, perpIndex, isLong, level, payout, durationSec}
  -> 200 {quote: {...§4 fields}, signature, breakdown: {sigma, touchProb, loading, premium, model, ...}}
  -> 4xx/5xx {error: <code>, reason: <human text>}
GET /health -> {ok, env, signer, chainId, pool}

Live data: the spot price S and spotRef come from the target pool's own price source
(`priceSource().oraclePx6(perpIndex)` via eth_call), i.e. exactly what buyCover checks: the HyperCore
precompile oracle for the real pool, the mock price for the MOCK pool. If that read fails, the Info API
oracle price is used (`breakdown.spotSource` says which). sigma comes from recent mainnet 1h candles
(read-only; testnet books are thin). k and q come from reports/tail_multipliers.json.
The request may name a `pool`; it must be in the allowlist (configured pool + deployments/<env>.json).
"""

from __future__ import annotations

import ipaddress
import logging
import math
import os
import re
import secrets
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

import numpy as np
from eth_abi import decode as abi_decode
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import MODEL_NAME
from . import multicall as mc
from .data import (
    INTERVAL_MS,
    MAINNET_INFO_URL,
    TESTNET_INFO_URL,
    InfoApiError,
    InfoClient,
    px6_from_decimal_str,
)
from .deployments import Deployment, default_path
from .deployments import load as load_deployment
from .poolv2 import (
    DEFAULT_STATE_CACHE_S,
    V2ReadError,
    V2State,
    V2StateReader,
    capacity_refusal,
    level_distance_bps,
    level_too_close,
    raise_to_floor,
)
from .pricing import (
    P_MAX,
    SECONDS_PER_YEAR,
    THETA,
    HorizonZTable,
    QuoteRefusedError,
    TailTable,
    ZTailTable,
    load_tail_table,
    premium,
    priced_prob,
    touch_prob,
    z_score,
)
from .quote import MAINNET_CHAIN_ID, ChainNotAllowedError, Quote, sign_quote
from .rpc import DEFAULT_TESTNET_RPCS, FailoverRpc, host
from .vol import sigma_estimate

DEFAULT_TAIL_PATH = Path(__file__).resolve().parent.parent / "reports" / "tail_multipliers.json"
JS_SAFE_INT = 2**53 - 1
ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
DEFAULT_POOL_NAME = "hypercore"  # deployments/<env>.json pool used when no pool is configured
PROXY_MODES = ("", "direct", "proxy")
TESTNET_CHAIN_ID = 998
_ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
DEFAULT_CORS_ORIGINS = ("http://localhost:5173", "http://127.0.0.1:5173")  # Vite dev server (app/)
DEFAULT_QUOTE_TTL_S = 30  # deadline - issue time (audit M1: was 60 s)
# Level-distance floor (audit M1, stale-quote free option): a signed quote can be held for the TTL and used
# only if the price has moved toward the level meanwhile. Refuse levels with |ln(level/spot)| < k sigma
# sqrt(TTL). Under the pricing model (driftless GBM) the chance of touching a level k sigma sqrt(TTL) away
# within the TTL is 2 Phi(-k): 4.6 % at k = 2, 0.27 % at k = 3, 0.006 % at k = 4. k = 3 keeps that option
# well under 1 % of the payout even with crypto's fat 1-minute tails (several times the normal tail), while
# for BTC (sigma ~ 0.5, TTL 30 s) it refuses only levels within ~0.15 % of spot, which no real liquidation
# cover sits that close to; k = 4 would refuse more for a negligible gain.
LEVEL_K_SIGMA = 3.0
DEFAULT_RATE_PER_MIN = 10.0  # POST /quote per client IP (audit M4): token bucket refill rate
DEFAULT_RATE_BURST = 5  # bucket size: a few quick re-quotes are fine, a flood is not
DEFAULT_SPOT_CACHE_S = 2.0  # pool spot per (pool, perp) reused this long (audit M4)
ENGINE_RPC_MAX_WAIT_S = 3.0  # a quote request never waits long on the RPC: it falls back to the Info API
log = logging.getLogger("numera.engine")


# -- configuration ---------------------------------------------------------------------------------


@dataclass
class Settings:
    env: str = "local"
    chain_id: int = 31337
    pool: str = ZERO_ADDRESS  # "" = not configured: deployment's HyperCore pool (resolve_default_pool)
    # Constructor input only: __post_init__ turns it into `signer` (an eth_account LocalAccount) and clears
    # it, so no Settings field keeps the raw key; repr=False on both keeps them out of any repr/log line.
    signer_key: str | None = field(default=None, repr=False, compare=False)
    signer: Any = field(default=None, repr=False, compare=False)
    info_url: str = TESTNET_INFO_URL  # live oracle prices
    history_info_url: str = MAINNET_INFO_URL  # candles for sigma (read-only)
    tail_path: Path = DEFAULT_TAIL_PATH
    theta: float = THETA
    p_max: float = P_MAX
    fee: int = 0  # USDC base units added to every premium
    quote_ttl_s: int = DEFAULT_QUOTE_TTL_S
    level_k_sigma: float = LEVEL_K_SIGMA
    min_duration_s: int = 600
    max_duration_s: int = 7 * 86400
    max_payout: int = 100_000 * 10**6  # engine-side sanity cap; real capacity is enforced on-chain
    cors_origins: tuple[str, ...] = DEFAULT_CORS_ORIGINS
    rpc_url: str | None = None  # EVM RPC for pool price reads, first in the failover list
    rpc_urls: tuple[str, ...] = ()  # NUMERA_RPCS failover list; empty = rpc_url, deployments rpc, defaults
    deployments_path: Path | None = None  # pool + perp allowlists, price sources
    rate_per_min: float = DEFAULT_RATE_PER_MIN  # POST /quote per client IP; 0 disables the limit
    rate_burst: int = DEFAULT_RATE_BURST
    trusted_proxies: tuple[str, ...] = ()  # NUMERA_TRUSTED_PROXIES: peers whose X-Forwarded-For is believed
    # NUMERA_BIND_HOST: the address uvicorn binds (--host); it must match, the engine cannot see it.
    # Default is uvicorn's own default. NUMERA_PROXY_MODE: "direct" = clients reach the engine without a
    # proxy (opt-out of the start-up guard, audit M1), "proxy" = a reverse proxy sits in front (needs
    # NUMERA_TRUSTED_PROXIES), "" = unset.
    bind_host: str = "127.0.0.1"
    proxy_mode: str = ""
    # NUMERA_CLIENT_IP_HEADER: header a trusted proxy sets to the real client address (Cloudflare Tunnel:
    # "CF-Connecting-IP"). Believed only when the direct peer is in trusted_proxies, and needs them.
    client_ip_header: str = ""
    # NUMERA_POOLS: explicit pool allowlist (addresses); when set it replaces the deployments file's pools.
    # Unset on chain 998 = only pools the deployments file marks v2 (audit L5: v1 pools are not signed for).
    pools: tuple[str, ...] = ()
    spot_cache_s: float = DEFAULT_SPOT_CACHE_S  # pool spot reused per (pool, perp) for this long
    v2_cache_s: float = DEFAULT_STATE_CACHE_S  # v2 pool state reused per (pool, perp, buyer) for this long

    def __post_init__(self) -> None:
        if self.proxy_mode not in PROXY_MODES:
            modes = sorted(m for m in PROXY_MODES if m)
            raise ValueError(f"NUMERA_PROXY_MODE must be one of {modes} or unset")
        self.client_ip_header = self.client_ip_header.strip()
        if self.client_ip_header and not re.fullmatch(r"[A-Za-z0-9-]+", self.client_ip_header):
            raise ValueError("NUMERA_CLIENT_IP_HEADER must be a plain header name such as CF-Connecting-IP")
        if self.signer_key:
            from eth_account import Account

            self.signer = Account.from_key(self.signer_key)
        self.signer_key = None

    @property
    def signer_address(self) -> str | None:
        return self.signer.address if self.signer is not None else None

    @staticmethod
    def from_env() -> Settings:
        e = os.environ
        return Settings(
            env=e.get("NUMERA_ENV", "local"),
            chain_id=int(e.get("NUMERA_CHAIN_ID", "31337")),
            pool=(e.get("NUMERA_POOL") or "").strip() or (e.get("POOL_ADDRESS") or "").strip(),
            signer_key=(e.get("QUOTE_SIGNER_KEY") or "").strip() or None,
            info_url=e.get("NUMERA_INFO_URL", TESTNET_INFO_URL),
            history_info_url=e.get("NUMERA_HISTORY_INFO_URL", MAINNET_INFO_URL),
            tail_path=Path(e.get("NUMERA_TAIL_PATH", str(DEFAULT_TAIL_PATH))),
            theta=float(e.get("NUMERA_THETA", str(THETA))),
            p_max=float(e.get("NUMERA_P_MAX", str(P_MAX))),
            fee=int(e.get("NUMERA_FEE", "0")),
            quote_ttl_s=int(e.get("NUMERA_QUOTE_TTL_S", str(DEFAULT_QUOTE_TTL_S))),
            max_payout=int(e.get("NUMERA_MAX_PAYOUT", str(100_000 * 10**6))),
            cors_origins=tuple(
                x.strip()
                for x in e.get("NUMERA_CORS_ORIGINS", ",".join(DEFAULT_CORS_ORIGINS)).split(",")
                if x.strip()
            ),
            rpc_url=e.get("NUMERA_RPC_URL") or None,
            rpc_urls=tuple(u.strip() for u in (e.get("NUMERA_RPCS") or "").split(",") if u.strip()),
            deployments_path=Path(e["NUMERA_DEPLOYMENTS"])
            if e.get("NUMERA_DEPLOYMENTS")
            else default_path(e.get("NUMERA_ENV", "local")),
            rate_per_min=float(e.get("NUMERA_RATE_PER_MIN", str(DEFAULT_RATE_PER_MIN))),
            rate_burst=int(e.get("NUMERA_RATE_BURST", str(DEFAULT_RATE_BURST))),
            trusted_proxies=tuple(
                x.strip() for x in (e.get("NUMERA_TRUSTED_PROXIES") or "").split(",") if x.strip()
            ),
            bind_host=(e.get("NUMERA_BIND_HOST") or "127.0.0.1").strip(),
            proxy_mode=(e.get("NUMERA_PROXY_MODE") or "").strip().lower(),
            client_ip_header=(e.get("NUMERA_CLIENT_IP_HEADER") or "").strip(),
            pools=tuple(x.strip() for x in (e.get("NUMERA_POOLS") or "").split(",") if x.strip()),
            spot_cache_s=float(e.get("NUMERA_SPOT_CACHE_S", str(DEFAULT_SPOT_CACHE_S))),
            v2_cache_s=float(e.get("NUMERA_V2_CACHE_S", str(DEFAULT_STATE_CACHE_S))),
        )


def resolve_default_pool(configured: str | None, deployment: Deployment | None, v2_only: bool = False) -> str:
    """Pool a request without `pool` is signed for. A configured address (NUMERA_POOL, else POOL_ADDRESS)
    wins; if it is empty/unset or not an address, the deployment's HyperCore pool (`pools.hypercore`, else the
    first listed pool); the zero address only when there is no deployment file at all (local dev).
    ``v2_only`` (chain 998, audit L5): only v2 pools are candidates, preferring ``hypercore-v2``; when
    there is none the default is the zero address, which is never in the allowlist. Never ""."""
    c = (configured or "").strip()
    if _ADDRESS_RE.match(c):
        return c
    pools = tuple(p for p in (deployment.pools if deployment else ()) if p.version == "v2" or not v2_only)
    if pools:
        named = next((p for p in pools if p.name in (DEFAULT_POOL_NAME, f"{DEFAULT_POOL_NAME}-v2")), pools[0])
        return named.pool
    return ZERO_ADDRESS


# -- market data -----------------------------------------------------------------------------------


class MarketData(Protocol):
    def oracle(self, perp_index: int) -> tuple[str, int]:
        """(coin name, oracle price px6) for a perp index on the quoting network."""

    def sigma(self, coin: str) -> float:
        """Annualized sigma for the coin (EWMA 0.94 with 30-day floor, §7 step 2)."""


class UnknownPerpError(KeyError):
    pass


@dataclass
class LiveMarketData:
    live: InfoClient
    history: InfoClient
    ctx_ttl_s: float = 2.0
    sigma_ttl_s: float = 300.0
    clock: Callable[[], float] = time.time
    _ctx: tuple[float, list, list] | None = None
    _sig: dict[str, tuple[float, float]] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def oracle(self, perp_index: int) -> tuple[str, int]:
        with self._lock:
            now = self.clock()
            if self._ctx is None or now - self._ctx[0] > self.ctx_ttl_s:
                universe, ctxs = self.live.meta_and_ctxs()
                self._ctx = (now, universe, ctxs)
            _, universe, ctxs = self._ctx
        if not 0 <= perp_index < len(universe):
            raise UnknownPerpError(perp_index)
        px = ctxs[perp_index].get("oraclePx")
        if px is None:
            raise InfoApiError(f"no oraclePx for perp {perp_index}")
        return universe[perp_index]["name"], px6_from_decimal_str(px)

    def sigma(self, coin: str) -> float:
        now = self.clock()
        hit = self._sig.get(coin)
        if hit and now - hit[0] < self.sigma_ttl_s:
            return hit[1]
        h = INTERVAL_MS["1h"]
        end = int(now * 1000) // h * h - h
        start = end - 40 * 24 * h
        cs = self.history.candles(coin, "1h", start, end, ttl_s=self.sigma_ttl_s)
        if len(cs) < 30 * 24:  # coin missing on history network: fall back to the live network
            cs = self.live.candles(coin, "1h", start, end, ttl_s=self.sigma_ttl_s)
        if len(cs) < 30 * 24 + 1:
            raise InfoApiError(f"not enough 1h candles for {coin}: {len(cs)}")
        s = sigma_estimate(np.array([c.c for c in cs]))
        self._sig[coin] = (now, s)
        return s


class SpotReader(Protocol):
    def px6(self, pool: str, perp_index: int) -> int:
        """Oracle price px6 as the pool's own price source reports it (raises on failure)."""


class PoolSpotReader:
    """Raw ``eth_call`` reads of pool.priceSource().oraclePx6(perp) through ``rpc.FailoverRpc`` (the keeper's
    client: endpoint list, -32005 backoff, failover; one HTTP request per read, no web3 round trips). The
    price source address comes from the deployments file when listed there, else from the pool's
    `priceSource()` getter, and is cached. Also reads the latest block timestamp (the engine's `now`, audit
    L6). Calls are serialized: FailoverRpc keeps per-endpoint state."""

    def __init__(self, rpc: FailoverRpc, deployment: Deployment | None = None) -> None:
        self.rpc = rpc
        self.deployment = deployment
        self._sources: dict[str, str] = {}
        self._lock = threading.Lock()

    def _eth_call(self, c: mc.Call) -> Any:
        raw = self.rpc.call("eth_call", [{"to": c.target, "data": "0x" + c.data.hex()}, "latest"])
        out = abi_decode(list(c.out), bytes.fromhex(str(raw).removeprefix("0x")))
        return out[0]

    def _source(self, pool: str) -> str:
        key = pool.lower()
        if key not in self._sources:
            info = self.deployment.find(key) if self.deployment else None
            addr = info.price_source if info and info.price_source else None
            self._sources[key] = addr or str(self._eth_call(mc.price_source(pool)))
        return self._sources[key]

    def px6(self, pool: str, perp_index: int) -> int:
        with self._lock:
            return int(self._eth_call(mc.oracle_px6(self._source(pool), perp_index)))

    def block_timestamp(self) -> int:
        with self._lock:
            blk = self.rpc.call("eth_getBlockByNumber", ["latest", False])
        return int(blk["timestamp"], 16)


LOCAL_CHAIN_ID = 31337


class AllowlistMissingError(RuntimeError):
    """The engine would quote any pool/perp: refuse to start (audit review L-2)."""


def check_allowlists(chain_id: int, deployment: Deployment | None) -> None:
    """Fail closed. Outside local dev (31337) the deployments file must exist, be for this chain and list
    pools and perps; otherwise the perp allowlist would silently be open. Mainnet (999) is exempt only
    because the engine never signs for it (every /quote answers 403)."""
    if chain_id in (LOCAL_CHAIN_ID, MAINNET_CHAIN_ID):
        return
    if deployment is None:
        raise AllowlistMissingError(
            f"chain {chain_id}: no deployments file (NUMERA_DEPLOYMENTS or deployments/<env>.json); "
            "refusing to quote without a pool/perp allowlist"
        )
    if deployment.chain_id is not None and deployment.chain_id != chain_id:
        raise AllowlistMissingError(
            f"deployments file is for chain {deployment.chain_id}, the engine for {chain_id}"
        )
    if not deployment.pools or not deployment.perps:
        missing = "pools" if not deployment.pools else "perps"
        raise AllowlistMissingError(f"chain {chain_id}: deployments file lists no {missing}; not starting")


class RateLimitProxyError(RuntimeError):
    """The rate limiter would key every client on the proxy's address (audit M1): refuse to start."""


def is_loopback_host(host_: str) -> bool:
    """True when a bind address is reachable from this machine only (127.0.0.0/8, ::1, localhost)."""
    h = host_.strip().strip("[]").lower()
    if h == "localhost":
        return True
    try:
        return ipaddress.ip_address(h).is_loopback
    except ValueError:
        return False  # "", 0.0.0.0, ::, a hostname or interface name: assume reachable from outside


def check_rate_limit_proxy(settings: Settings) -> None:
    """Fail closed (audit M1). With the rate limiter on and no NUMERA_TRUSTED_PROXIES, the limiter keys on the
    direct peer. Bound beyond loopback that is only right when clients connect directly; behind a reverse
    proxy every client shares the proxy's bucket (or, with a spoofable header, none does). So refuse to start
    unless the operator says which: trusted proxies, or NUMERA_PROXY_MODE=direct."""
    if settings.rate_per_min <= 0:
        return
    if settings.client_ip_header and not settings.trusted_proxies:
        raise RateLimitProxyError(
            "NUMERA_CLIENT_IP_HEADER needs NUMERA_TRUSTED_PROXIES (the proxy that sets it, e.g. 127.0.0.1 "
            "for cloudflared on this host); refusing to start"
        )
    if settings.proxy_mode == "proxy" and not settings.trusted_proxies:
        raise RateLimitProxyError(
            "NUMERA_PROXY_MODE=proxy needs NUMERA_TRUSTED_PROXIES (the proxy's address) so the rate "
            "limiter can tell clients apart; refusing to start"
        )
    if settings.trusted_proxies or settings.proxy_mode == "direct" or is_loopback_host(settings.bind_host):
        return
    raise RateLimitProxyError(
        f"rate limiting is on and the engine is bound to {settings.bind_host!r} (not loopback-only) with no "
        "NUMERA_TRUSTED_PROXIES: behind a reverse proxy every client would share the proxy's rate-limit "
        "bucket. Set NUMERA_TRUSTED_PROXIES to the proxy's address, or NUMERA_PROXY_MODE=direct if clients "
        "connect to the engine directly (NUMERA_BIND_HOST must match uvicorn's --host); refusing to start"
    )


class PoolNotAllowedError(RuntimeError):
    """A configured pool the engine would refuse to sign for (audit L5)."""


class ChainIdMismatchError(RuntimeError):
    """NUMERA_CHAIN_ID differs from the RPC's eth_chainId (audit info b)."""


def build_pool_allowlist(
    settings: Settings, deployment: Deployment | None, default_pool: str
) -> tuple[set[str], str]:
    """(allowlist, default pool). NUMERA_POOLS, when set, is the whole allowlist (any chain). Otherwise the
    configured/default pool plus every pool in the deployments file, except on chain 998 (audit L5), where
    v1 pools in deployments/testnet.json have no on-chain floors and are not signed for: only v2 count."""
    explicit = [a for a in settings.pools if _ADDRESS_RE.match(a)]
    if settings.pools and len(explicit) != len(settings.pools):
        raise PoolNotAllowedError("NUMERA_POOLS must be a comma-separated list of 0x addresses")
    if explicit:
        allow = {a.lower() for a in explicit}
        return allow, (default_pool if default_pool.lower() in allow else explicit[0])
    listed = deployment.pools if deployment else ()
    on_998 = settings.chain_id == TESTNET_CHAIN_ID
    if on_998:
        listed = tuple(p for p in listed if p.version == "v2")
        configured = _ADDRESS_RE.match(default_pool or "") and default_pool != ZERO_ADDRESS
        if configured and default_pool.lower() not in {p.pool for p in listed}:
            raise PoolNotAllowedError(
                f"pool {default_pool} is not a v2 pool of the deployments file; on chain 998 the engine "
                "refuses v1 pools (list it in NUMERA_POOLS to override)"
            )
    allow = {a.lower() for a in (default_pool, *(p.pool for p in listed)) if _ADDRESS_RE.match(a or "")}
    if on_998:
        allow.discard(ZERO_ADDRESS)
    return allow, default_pool


def verify_rpc_chain(rpc: FailoverRpc, chain_id: int) -> None:
    """Refuse to start when an RPC answers another chain than NUMERA_CHAIN_ID (audit info b). An RPC that does
    not answer at all only logs a WARNING: quotes degrade to the Info API as before."""
    try:
        rpc.verify_chain({chain_id}, attempts=1)
    except RuntimeError as exc:
        if str(exc).startswith("no RPC endpoint answered"):
            log.warning("[engine] chain id of the RPC not verified: %s", exc)
            return
        raise ChainIdMismatchError(f"NUMERA_CHAIN_ID is {chain_id} but {exc}") from exc


class XffWatch:
    """Counts distinct X-Forwarded-For values per untrusted peer in a sliding window (audit M1). A peer
    that is not a trusted proxy has no business sending many different values: it is either spoofing the
    header to dodge the limiter (ignored, the limiter keys on the peer) or it is a proxy missing from
    NUMERA_TRUSTED_PROXIES (then every client shares its bucket). Either way the operator should know."""

    def __init__(self, threshold: int = 10, window_s: float = 60.0, max_peers: int = 1_000,
                 clock: Callable[[], float] = time.monotonic) -> None:  # fmt: skip
        self.threshold, self.window_s, self.max_peers, self.clock = threshold, window_s, max_peers, clock
        self._seen: OrderedDict[str, dict[str, float]] = OrderedDict()
        self._lock = threading.Lock()

    def note(self, peer: str, xff: str | None) -> int:
        """Record one request; returns the distinct values seen from ``peer`` inside the window."""
        if not xff:
            return 0
        now = self.clock()
        with self._lock:
            vals = self._seen.pop(peer, {})
            vals = {v: t for v, t in vals.items() if now - t <= self.window_s}
            vals[xff.strip()[:256]] = now
            while len(vals) > 4 * self.threshold:
                vals.pop(min(vals, key=vals.__getitem__))
            self._seen[peer] = vals
            while len(self._seen) > self.max_peers:
                self._seen.popitem(last=False)
            return len(vals)


def engine_rpc_urls(settings: Settings, deployment: Deployment | None) -> list[str]:
    """Engine RPC failover list: NUMERA_RPCS, else NUMERA_RPC_URL + the deployments rpc (+ the public
    testnet endpoints for chain 998). Its own FailoverRpc: an RPC budget separate from the keeper."""
    if settings.rpc_urls:
        urls = list(settings.rpc_urls)
    else:
        urls = [u for u in (settings.rpc_url, deployment.rpc if deployment else None) if u]
        if urls and settings.chain_id == 998:
            urls += list(DEFAULT_TESTNET_RPCS)
    return list(dict.fromkeys(u.strip() for u in urls if u and u.strip()))


class CachedSpotReader:
    """Reuses a pool spot per (pool, perp) for ``ttl_s`` (audit M4: a quote flood costs one eth_call per
    pair per window, not one per request). Failures are not cached."""

    def __init__(self, inner: SpotReader, ttl_s: float, clock: Callable[[], float] = time.monotonic) -> None:
        self.inner, self.ttl_s, self.clock = inner, ttl_s, clock
        self._hits: dict[tuple[str, int], tuple[float, int]] = {}
        self._lock = threading.Lock()

    def px6(self, pool: str, perp_index: int) -> int:
        key = (pool.lower(), perp_index)
        now = self.clock()
        with self._lock:
            hit = self._hits.get(key)
            if hit and now - hit[0] < self.ttl_s:
                return hit[1]
        px = int(self.inner.px6(pool, perp_index))
        with self._lock:
            self._hits[key] = (now, px)
        return px

    def block_timestamp(self) -> int:
        return int(self.inner.block_timestamp())  # type: ignore[attr-defined]


class BlockClock:
    """`now` for deadline/expiry from the chain (audit L6): the latest block timestamp, re-read every
    ``ttl_s`` and advanced by the local monotonic clock in between. Raises when the chain cannot be read."""

    def __init__(self, fetch: Callable[[], int], ttl_s: float = 2.0,
                 mono: Callable[[], float] = time.monotonic) -> None:  # fmt: skip
        self.fetch, self.ttl_s, self.mono = fetch, ttl_s, mono
        self._last: tuple[float, int] | None = None
        self._lock = threading.Lock()

    def __call__(self) -> int:
        t = self.mono()
        with self._lock:
            if self._last and t - self._last[0] < self.ttl_s:
                return self._last[1] + int(t - self._last[0])
        ts = int(self.fetch())
        with self._lock:
            self._last = (t, ts)
        return ts


class ThrottledWarning:
    """log.warning at most once per ``every_s`` per key (a persistent condition must not log per request)."""

    def __init__(self, every_s: float = 60.0, mono: Callable[[], float] = time.monotonic) -> None:
        self.every_s, self.mono = every_s, mono
        self._at: dict[str, float] = {}
        self._lock = threading.Lock()

    def __call__(self, key: str, msg: str, *args: Any) -> bool:
        t = self.mono()
        with self._lock:
            if key in self._at and t - self._at[key] < self.every_s:
                return False
            self._at[key] = t
        log.warning(msg, *args)
        return True


def _norm_ip(s: str) -> str:
    """Canonical text of an IP address (so ::1 and 0:0::1 match); anything else as given, stripped."""
    s = s.strip()
    try:
        return str(ipaddress.ip_address(s))
    except ValueError:
        return s


def client_ip(peer: str, xff: str | None, trusted: frozenset[str] | set[str],
              real_ip: str | None = None) -> str:
    """Rate-limit key for a request. The direct peer, unless the peer is a trusted proxy (e.g. Caddy on the
    same host): then the right-most X-Forwarded-For entry that is not itself a trusted proxy, i.e. the
    address the first trusted hop actually saw. Entries left of it are client-supplied and can be spoofed,
    so they are never used. Explicit on purpose: no reliance on uvicorn's --proxy-headers.
    ``real_ip`` is the value of NUMERA_CLIENT_IP_HEADER (e.g. Cloudflare's CF-Connecting-IP). From a trusted
    peer a valid IP there wins over X-Forwarded-For; from any other peer it is ignored (client-supplied)."""
    peer = _norm_ip(peer)
    if peer not in trusted:
        return peer
    if real_ip:
        try:
            return str(ipaddress.ip_address(real_ip.strip()))
        except ValueError:
            pass  # not an address: fall back to X-Forwarded-For
    if not xff:
        return peer
    hops = [_norm_ip(h) for h in xff.split(",") if h.strip()]
    for hop in reversed(hops):
        if hop not in trusted:
            return hop
    return peer  # every hop is a trusted proxy: the request came from the proxies themselves


def rate_key(ip: str) -> str:
    """Bucket key for a client address: IPv4 as is (IPv4-mapped IPv6 too), IPv6 by its /64, since one
    subscriber usually holds a whole /64 and could otherwise rotate addresses to get fresh buckets."""
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return ip
    if isinstance(a, ipaddress.IPv6Address):
        if a.ipv4_mapped is not None:
            return str(a.ipv4_mapped)
        return str(ipaddress.IPv6Network((a, 64), strict=False))
    return str(a)


class RateLimiter:
    """Per-key token bucket (audit M4): ``burst`` requests at once, refilled at ``per_min`` per minute.
    ``take(key)`` returns 0.0 when allowed, else the seconds until the next token.

    Memory is bounded by ``max_keys``: buckets are kept in least-recently-used order and the oldest are
    evicted as soon as the table is over the bound (an evicted client simply starts with a full bucket)."""

    def __init__(self, per_min: float, burst: int, clock: Callable[[], float] = time.monotonic,
                 max_keys: int = 10_000) -> None:  # fmt: skip
        if per_min <= 0 or burst < 1 or max_keys < 1:
            raise ValueError("rate limit needs per_min > 0, burst >= 1 and max_keys >= 1")
        self.rate, self.burst, self.clock, self.max_keys = per_min / 60.0, float(burst), clock, max_keys
        self._b: OrderedDict[str, tuple[float, float]] = OrderedDict()  # key -> (tokens, last refill time)
        self._lock = threading.Lock()

    def take(self, key: str) -> float:
        now = self.clock()
        with self._lock:
            tokens, last = self._b.pop(key, (self.burst, now))
            tokens = min(self.burst, tokens + (now - last) * self.rate)
            ok = tokens >= 1.0
            self._b[key] = (tokens - 1.0 if ok else tokens, now)  # (re)inserted last = most recent
            while len(self._b) > self.max_keys:
                self._b.popitem(last=False)  # evict the least recently used
            return 0.0 if ok else (1.0 - tokens) / self.rate


# -- API -------------------------------------------------------------------------------------------


class QuoteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    buyer: str = Field(pattern=r"^0x[0-9a-fA-F]{40}$")
    perpIndex: int = Field(ge=0, lt=2**32)  # noqa: N815 - §6 field names
    isLong: bool  # noqa: N815
    level: int = Field(gt=0, lt=2**64)
    payout: int = Field(gt=0, le=JS_SAFE_INT)
    durationSec: int = Field(gt=0)  # noqa: N815
    pool: str | None = Field(default=None, pattern=r"^0x[0-9a-fA-F]{40}$")  # default: configured pool


class ApiError(Exception):
    def __init__(self, status: int, code: str, reason: str) -> None:
        super().__init__(code)
        self.status, self.code, self.reason = status, code, reason


def _err(status: int, code: str, reason: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": code, "reason": reason})


def read_v2_state(reader: V2StateReader | None, pool: str, req: QuoteRequest, listed_v2: bool,
                  warn: Callable[..., Any]) -> V2State | None:  # fmt: skip
    """The pool's v2 state, or None for a v1 pool. Refuses (503) a pool known to be v2 whose state cannot
    be read: signing blind could miss the floor or the caps. An unknown pool whose probe fails is quoted as
    v1 (the contract still enforces its own checks). 400 ``perp_not_allowed`` when ``perpAllowed`` is
    false."""
    v2 = None
    if reader is not None:
        try:
            v2 = reader.read(pool, req.perpIndex, req.buyer)
        except V2ReadError as exc:
            if listed_v2 or reader.version(pool) == "v2":
                raise ApiError(503, "market_data_unavailable", f"v2 pool state unavailable: {exc}") from None
            warn(f"v2:{pool.lower()}", "[engine] pool %s: v2 probe failed (%s); quoting it as v1", pool, exc)
    elif listed_v2:
        raise ApiError(503, "market_data_unavailable", f"pool {pool} is v2; no RPC is configured to read it")
    if v2 is not None:
        check_pool_gate(pool, req, v2.paused, v2.limits.minPayout, v2.perp_allowed)
    elif reader is not None and reader.version(pool) == "v1":
        try:
            gate = reader.read_v1(pool)
        except V2ReadError as exc:  # the contract still enforces both; do not fail the quote on it
            warn(f"v1:{pool.lower()}", "[engine] pool %s: paused/minPayout read failed (%s)", pool, exc)
            gate = None
        if gate is not None:
            check_pool_gate(pool, req, gate.paused, gate.min_payout, True)
    return v2


def check_pool_gate(pool: str, req: QuoteRequest, paused: bool, min_payout: int, perp_allowed: bool) -> None:
    """What buyCover rejects before pricing, in the contract's order: ``whenNotPaused`` (503
    ``pool_paused``), then check 2's ``perpAllowed`` (400 ``perp_not_allowed``, v2 only) and ``minPayout``
    (422 ``payout_too_small``)."""
    if paused:
        raise ApiError(503, "pool_paused", f"pool {pool} is paused: buyCover is disabled until the owner "
                       "unpauses it")  # fmt: skip
    if not perp_allowed:
        reason = f"perpIndex {req.perpIndex} is not allowed on pool {pool} (perpAllowed is false on chain)"
        raise ApiError(400, "perp_not_allowed", reason)
    if req.payout < min_payout:
        raise ApiError(422, "payout_too_small", f"payout {req.payout} is below the pool's minPayout "
                       f"{min_payout} (USDC 6 dec)")  # fmt: skip


def check_v2_sale(v2: V2State, spot6: int, req: QuoteRequest, now: int, deadline: int | None = None) -> None:
    """Refuse what buyCover would reject on the v2 level floor (check 3) or capacity (checks 5, 6), at any
    block time from ``now`` to the quote's ``deadline`` (a sale window that ends inside the quote lifetime
    must allow the sale both open and reset)."""
    lim = v2.limits
    bps = level_distance_bps(lim)
    if level_too_close(spot6, req.level, bps):
        raise ApiError(
            422,
            "level_too_close",
            f"level {req.level} is within {bps} bps of spot {spot6}: the pool requires "
            f"{lim.minLevelDistanceBps} bps from the oracle at purchase (minLevelDistanceBps) and the oracle "
            f"may move {lim.maxSpotDeviationBps} bps from the quoted spot (maxSpotDeviationBps)",
        )
    refusal = capacity_refusal(v2, req.payout, now, deadline)
    if refusal is not None:
        raise ApiError(422, "capacity", refusal.reason)


def create_app(
    settings: Settings | None = None,
    market: MarketData | None = None,
    tail: TailTable | ZTailTable | HorizonZTable | None = None,
    clock: Callable[[], float] = time.time,
    nonce_fn: Callable[[], int] | None = None,
    spot_reader: SpotReader | None = None,
    deployment: Deployment | None = None,
    block_time: Callable[[], int] | None = None,
    rate_limiter: RateLimiter | None = None,
    v2_reader: V2StateReader | None = None,
) -> FastAPI:
    """``clock`` is the wall-clock fallback for `now`; ``block_time`` (latest block timestamp) is preferred
    and is built from the RPC when the pool reader is (tests pass their own or none). ``v2_reader`` reads a
    CoverPool v2's floors, allowlist and capacity state (§6 v2 follow-up); built from the same RPC when the
    pool reader is. Without it every pool is quoted as v1, except a pool the deployments file lists as v2,
    which is refused (503) rather than quoted blind."""
    settings = settings or Settings.from_env()
    if market is None:
        market = LiveMarketData(
            InfoClient(settings.info_url, cache_dir=None), InfoClient(settings.history_info_url)
        )
    if tail is None:
        tail = load_tail_table(settings.tail_path) if settings.tail_path.exists() else TailTable(coins={})
    nonce_fn = nonce_fn or (lambda: secrets.randbelow(JS_SAFE_INT) + 1)  # JSON-number safe for JS clients
    if deployment is None and settings.deployments_path is not None:
        deployment = load_deployment(settings.deployments_path)
    check_allowlists(settings.chain_id, deployment)
    check_rate_limit_proxy(settings)  # audit M1: fail closed behind an unconfigured proxy
    v2_only = settings.chain_id == TESTNET_CHAIN_ID and not settings.pools
    default_pool = resolve_default_pool(settings.pool, deployment, v2_only=v2_only)
    allowlist, default_pool = build_pool_allowlist(settings, deployment, default_pool)
    # Perps the engine quotes (audit M2): those cached for the pools in deployments/<env>.json `perps`. Only
    # local dev (31337) may run without one (check_allowlists fails closed elsewhere); the universe check
    # applies either way.
    allowed_perps = set(deployment.perps.values()) if deployment and deployment.perps else None
    perps_desc = dict(sorted(deployment.perps.items())) if allowed_perps is not None else "any (local dev)"
    log.info("[engine] chain %d allowlist: pools %s, perps %s", settings.chain_id, sorted(allowlist),
             perps_desc)  # fmt: skip
    if spot_reader is None:
        urls = engine_rpc_urls(settings, deployment)
        if urls:
            rpc = FailoverRpc(urls, timeout_s=5.0, max_wait_s=ENGINE_RPC_MAX_WAIT_S, label="engine")
            verify_rpc_chain(rpc, settings.chain_id)  # audit info b
            live = PoolSpotReader(rpc, deployment)
            spot_reader = live
            if v2_reader is None:
                known = {p.pool: p.version for p in deployment.pools if p.version} if deployment else {}
                v2_reader = V2StateReader(rpc, known, ttl_s=settings.v2_cache_s)
            if block_time is None:
                block_time = BlockClock(live.block_timestamp)
            log.info("[engine] rpcs: %s", " > ".join(host(u) for u in urls))
    if spot_reader is not None and settings.spot_cache_s > 0:
        spot_reader = CachedSpotReader(spot_reader, settings.spot_cache_s)
    if rate_limiter is None and settings.rate_per_min > 0:
        rate_limiter = RateLimiter(settings.rate_per_min, settings.rate_burst)
    signer_addr = settings.signer_address
    warn_once = ThrottledWarning(60.0)
    trusted = frozenset(_norm_ip(p) for p in settings.trusted_proxies)
    xff_watch = XffWatch()

    def now_s() -> int:
        """Latest block timestamp; the wall clock when the chain cannot be read, or when the latest block
        lags the wall clock by more than the quote TTL (a stalled chain/RPC: deadlines from it would be
        dead on arrival). Both fallbacks log a WARNING at most once a minute."""
        wall = int(clock())
        if block_time is None:
            return wall
        try:
            ts = int(block_time())
        except Exception as exc:  # noqa: BLE001 - any RPC failure: fall back, quote stays usable
            warn_once("rpc", "[engine] block timestamp unavailable (%s); using the wall clock", exc)
            return wall
        if wall - ts > settings.quote_ttl_s:
            warn_once("lag", "[engine] latest block %d lags the wall clock %d by %d s (> TTL %d s); using "
                      "the wall clock", ts, wall, wall - ts, settings.quote_ttl_s)  # fmt: skip
            return wall
        return ts

    app = FastAPI(title="Numera Quote API", version="1")

    @app.middleware("http")
    async def _rate_limit(request: Request, call_next):  # added before CORS: CORS wraps it (429 readable)
        if rate_limiter is not None and request.method == "POST" and request.url.path == "/quote":
            peer = request.client.host if request.client else "unknown"
            xff = request.headers.get("x-forwarded-for")
            real = request.headers.get(settings.client_ip_header) if settings.client_ip_header else None
            ip = client_ip(peer, xff, trusted, real)
            if xff and _norm_ip(peer) not in trusted:
                n = xff_watch.note(_norm_ip(peer), xff)
                if n >= xff_watch.threshold:
                    warn_once(
                        f"xff:{peer}",
                        "[engine] %d distinct X-Forwarded-For values from %s, which is not in "
                        "NUMERA_TRUSTED_PROXIES: header spoofing, or an unlisted proxy (all its clients "
                        "share one rate-limit bucket)", n, peer,
                    )  # fmt: skip
            wait = rate_limiter.take(rate_key(ip))
            if wait > 0:
                retry = max(1, math.ceil(wait))
                resp = _err(429, "rate_limited", f"too many quote requests; retry in {retry} s")
                resp.headers["Retry-After"] = str(retry)
                return resp
        try:
            return await call_next(request)
        except Exception as exc:  # inside CORS: the 500 keeps its Access-Control-Allow-Origin header
            return _internal_error(request, exc)

    def _internal_error(request: Request, exc: Exception) -> JSONResponse:
        log.error("[engine] unhandled %s on %s %s", type(exc).__name__, request.method, request.url.path,
                  exc_info=(type(exc), exc, exc.__traceback__))  # traceback server-side only
        resp = _err(500, "internal", "internal error; see the engine log")  # never the exception text
        origin = request.headers.get("origin")
        if origin and origin in settings.cors_origins:  # fallback for errors raised outside the CORS layer
            resp.headers["Access-Control-Allow-Origin"] = origin
            resp.headers["Vary"] = "Origin"
        return resp

    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )

    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return _err(exc.status, exc.code, exc.reason)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0] if exc.errors() else {}
        loc = ".".join(str(x) for x in first.get("loc", ()) if x != "body")
        return _err(400, "invalid_request", f"{loc}: {first.get('msg', 'invalid body')}")

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        return _internal_error(request, exc)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        return _err(exc.status_code, "http_error", str(exc.detail))

    @app.get("/health")
    def health() -> dict[str, Any]:
        ok = signer_addr is not None and settings.chain_id != MAINNET_CHAIN_ID
        return {
            "ok": ok,
            "env": settings.env,
            "signer": signer_addr,
            "chainId": settings.chain_id,
            "pool": default_pool,
            "pools": sorted(allowlist),
        }

    @app.post("/quote")
    def quote(req: QuoteRequest) -> dict[str, Any]:
        if settings.chain_id == MAINNET_CHAIN_ID:
            raise ApiError(403, "chain_not_allowed", "engine never signs for chainId 999")
        if settings.signer is None:
            raise ApiError(503, "signer_unavailable", "QUOTE_SIGNER_KEY is not set")
        if not settings.min_duration_s <= req.durationSec <= settings.max_duration_s:
            raise ApiError(
                400,
                "duration_out_of_range",
                f"durationSec must be in [{settings.min_duration_s}, {settings.max_duration_s}]",
            )
        if req.payout > settings.max_payout:
            raise ApiError(422, "capacity", f"payout exceeds engine cap {settings.max_payout}")
        pool = req.pool or default_pool
        if pool.lower() not in allowlist:
            raise ApiError(400, "unknown_pool", f"pool {pool} is not in the allowlist")
        if allowed_perps is not None and req.perpIndex not in allowed_perps:
            raise ApiError(
                400,
                "perp_not_allowed",
                f"perpIndex {req.perpIndex} is not one of the perps this deployment quotes "
                f"({', '.join(f'{c}={i}' for c, i in sorted(deployment.perps.items()))})",
            )
        listed_v2 = bool(deployment and deployment.version_of(pool) == "v2")
        v2 = read_v2_state(v2_reader, pool, req, listed_v2, warn_once)
        spot6, spot_source = None, "info_api"
        if spot_reader is not None:
            try:
                px = int(spot_reader.px6(pool, req.perpIndex))
                if 0 < px < 2**64:
                    spot6, spot_source = px, "pool"
            except Exception:  # noqa: BLE001 - any RPC/revert failure falls back to the Info API
                spot6 = None
        try:
            coin, info_px6 = market.oracle(req.perpIndex)
        except (UnknownPerpError, KeyError, IndexError):
            coin = deployment.coin_of(req.perpIndex) if (deployment and spot6 is not None) else None
            if coin is None:
                raise ApiError(400, "unknown_perp", f"perpIndex {req.perpIndex} not listed") from None
            info_px6 = None
        except (InfoApiError, ValueError) as exc:
            coin = deployment.coin_of(req.perpIndex) if (deployment and spot6 is not None) else None
            if coin is None:
                raise ApiError(503, "market_data_unavailable", str(exc)) from None
            info_px6 = None
        if spot6 is None:
            spot6 = info_px6
        assert spot6 is not None
        if (req.isLong and spot6 <= req.level) or (not req.isLong and spot6 >= req.level):
            raise ApiError(
                422,
                "level_already_breached",
                f"oracle {spot6} already {'<=' if req.isLong else '>='} level {req.level}",
            )
        try:
            sigma = market.sigma(coin)
        except (InfoApiError, ValueError) as exc:
            raise ApiError(503, "market_data_unavailable", str(exc)) from None
        if not (math.isfinite(sigma) and sigma > 0):
            raise ApiError(503, "market_data_unavailable", f"bad sigma {sigma}")

        S, H = spot6 / 1e6, req.level / 1e6
        min_dist = settings.level_k_sigma * sigma * math.sqrt(settings.quote_ttl_s / SECONDS_PER_YEAR)
        if abs(math.log(H / S)) < min_dist:
            raise ApiError(
                422,
                "level_too_close",
                f"level {req.level} is within {min_dist:.4%} of spot {spot6} "
                f"({settings.level_k_sigma:g} sigma over the {settings.quote_ttl_s} s quote lifetime)",
            )
        now = now_s()
        deadline = now + settings.quote_ttl_s
        if v2 is not None:
            check_v2_sale(v2, spot6, req, now, deadline)
        T = req.durationSec / SECONDS_PER_YEAR
        p = touch_prob(S, H, sigma, T)
        adj = tail.adjust(coin, req.isLong, req.durationSec, S, H, sigma)
        try:
            prem = premium(req.payout, p, adj.k, settings.theta, settings.p_max, settings.fee, adj.q)
        except QuoteRefusedError as exc:
            raise ApiError(422, exc.code, exc.reason) from None
        floor_applied = False
        if v2 is not None:  # §6 v2: raise the model premium to the on-chain floor
            prem, floor_applied = raise_to_floor(prem, req.payout, v2.limits.minPremiumBps)
        q = Quote(
            buyer=req.buyer,
            perpIndex=req.perpIndex,
            isLong=req.isLong,
            level=req.level,
            payout=req.payout,
            premium=prem,
            expiry=now + req.durationSec,
            spotRef=spot6,
            deadline=deadline,
            nonce=nonce_fn(),
        )
        try:
            sig = sign_quote(q, settings.chain_id, pool, settings.signer)
        except ChainNotAllowedError as exc:
            raise ApiError(403, "chain_not_allowed", str(exc)) from None
        extra = {"floorApplied": floor_applied} if v2 is not None else {}
        return {
            "quote": q.to_dict(),
            "signature": sig,
            "breakdown": extra | {
                "sigma": sigma,
                "touchProb": p,
                "loading": settings.theta,
                "premium": prem,
                "model": MODEL_NAME,
                # additive fields (not in §6, informational):
                "tailMultiplier": adj.k,
                "tailFloor": adj.q,
                "pricedProb": priced_prob(p, adj.k, adj.q),
                "fee": settings.fee,
                "coin": coin,
                "z": z_score(S, H, sigma, T),
                "spotSource": spot_source,
                "pool": pool,
            },
        }

    return app


_APP: FastAPI | None = None


def _lazy_app() -> FastAPI:
    """Built once: uvicorn reads the `app` attribute more than once (seen: twice), which used to build two
    apps (two RPC clients, two rate-limit tables)."""
    global _APP
    if _APP is None:
        if not logging.getLogger().handlers:  # under uvicorn: show numera.* INFO lines (allowlist, rpcs)
            logging.basicConfig(level=logging.INFO, format="%(levelname)s:     %(message)s")
        _APP = create_app()
    return _APP


def __getattr__(name: str) -> Any:  # `uvicorn numera_engine.quote_api:app` builds from env on first use
    if name == "app":
        return _lazy_app()
    raise AttributeError(name)
