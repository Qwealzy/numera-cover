"""Quote API (ARCHITECTURE §6): FastAPI service that prices and signs §4 Quotes.

    uvicorn numera_engine.quote_api:app --port 8000      (configuration from environment, see Settings)

POST /quote  {buyer, perpIndex, isLong, level, payout, durationSec}
  -> 200 {quote: {...§4 fields}, signature, breakdown: {sigma, touchProb, loading, premium, model, ...}}
  -> 4xx/5xx {error: <code>, reason: <human text>}
GET /health -> {ok, env, signer, chainId, pool}

Live data: oracle price from the network's Info API asset ctxs (testnet by default), converted to px6
(§3); sigma from recent 1h candles (mainnet Info API by default, read-only: testnet books are thin and
their trade candles are not representative); tail multiplier k from reports/tail_multipliers.json.
"""

from __future__ import annotations

import math
import os
import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

import numpy as np
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import MODEL_NAME
from .data import (
    INTERVAL_MS,
    MAINNET_INFO_URL,
    TESTNET_INFO_URL,
    InfoApiError,
    InfoClient,
    px6_from_decimal_str,
)
from .pricing import (
    P_MAX,
    SECONDS_PER_YEAR,
    THETA,
    QuoteRefusedError,
    TailTable,
    premium,
    priced_prob,
    touch_prob,
)
from .quote import MAINNET_CHAIN_ID, ChainNotAllowedError, Quote, sign_quote
from .vol import sigma_estimate

DEFAULT_TAIL_PATH = Path(__file__).resolve().parent.parent / "reports" / "tail_multipliers.json"
JS_SAFE_INT = 2**53 - 1


# -- configuration ---------------------------------------------------------------------------------


@dataclass
class Settings:
    env: str = "local"
    chain_id: int = 31337
    pool: str = "0x0000000000000000000000000000000000000000"
    signer_key: str | None = None
    info_url: str = TESTNET_INFO_URL  # live oracle prices
    history_info_url: str = MAINNET_INFO_URL  # candles for sigma (read-only)
    tail_path: Path = DEFAULT_TAIL_PATH
    theta: float = THETA
    p_max: float = P_MAX
    fee: int = 0  # USDC base units added to every premium
    quote_ttl_s: int = 60
    min_duration_s: int = 600
    max_duration_s: int = 7 * 86400
    max_payout: int = 100_000 * 10**6  # engine-side sanity cap; real capacity is enforced on-chain

    @staticmethod
    def from_env() -> Settings:
        e = os.environ
        return Settings(
            env=e.get("NUMERA_ENV", "local"),
            chain_id=int(e.get("NUMERA_CHAIN_ID", "31337")),
            pool=e.get("NUMERA_POOL", "0x0000000000000000000000000000000000000000"),
            signer_key=(e.get("QUOTE_SIGNER_KEY") or "").strip() or None,
            info_url=e.get("NUMERA_INFO_URL", TESTNET_INFO_URL),
            history_info_url=e.get("NUMERA_HISTORY_INFO_URL", MAINNET_INFO_URL),
            tail_path=Path(e.get("NUMERA_TAIL_PATH", str(DEFAULT_TAIL_PATH))),
            theta=float(e.get("NUMERA_THETA", str(THETA))),
            p_max=float(e.get("NUMERA_P_MAX", str(P_MAX))),
            fee=int(e.get("NUMERA_FEE", "0")),
            quote_ttl_s=int(e.get("NUMERA_QUOTE_TTL_S", "60")),
            max_payout=int(e.get("NUMERA_MAX_PAYOUT", str(100_000 * 10**6))),
        )


# -- market data -----------------------------------------------------------------------------------


class MarketData(Protocol):
    def oracle(self, perp_index: int) -> tuple[str, int]:
        """(coin name, oracle price px6) for a perp index on the quoting network."""

    def sigma(self, coin: str) -> float:
        """Annualized sigma for the coin (EWMA 0.94 with 30-day floor, §7.1)."""


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


# -- API -------------------------------------------------------------------------------------------


class QuoteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    buyer: str = Field(pattern=r"^0x[0-9a-fA-F]{40}$")
    perpIndex: int = Field(ge=0, lt=2**32)  # noqa: N815 - §6 field names
    isLong: bool  # noqa: N815
    level: int = Field(gt=0, lt=2**64)
    payout: int = Field(gt=0, le=JS_SAFE_INT)
    durationSec: int = Field(gt=0)  # noqa: N815


class ApiError(Exception):
    def __init__(self, status: int, code: str, reason: str) -> None:
        super().__init__(code)
        self.status, self.code, self.reason = status, code, reason


def _err(status: int, code: str, reason: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": code, "reason": reason})


def create_app(
    settings: Settings | None = None,
    market: MarketData | None = None,
    tail: TailTable | None = None,
    clock: Callable[[], float] = time.time,
    nonce_fn: Callable[[], int] | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    if market is None:
        market = LiveMarketData(
            InfoClient(settings.info_url, cache_dir=None), InfoClient(settings.history_info_url)
        )
    if tail is None:
        tail = TailTable.load(settings.tail_path) if settings.tail_path.exists() else TailTable(coins={})
    nonce_fn = nonce_fn or (lambda: secrets.randbelow(JS_SAFE_INT) + 1)  # JSON-number safe for JS clients
    signer_addr = None
    if settings.signer_key:
        from eth_account import Account

        signer_addr = Account.from_key(settings.signer_key).address

    app = FastAPI(title="Numera Quote API", version="1")

    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return _err(exc.status, exc.code, exc.reason)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0] if exc.errors() else {}
        loc = ".".join(str(x) for x in first.get("loc", ()) if x != "body")
        return _err(400, "invalid_request", f"{loc}: {first.get('msg', 'invalid body')}")

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
            "pool": settings.pool,
        }

    @app.post("/quote")
    def quote(req: QuoteRequest) -> dict[str, Any]:
        if settings.chain_id == MAINNET_CHAIN_ID:
            raise ApiError(403, "chain_not_allowed", "engine never signs for chainId 999")
        if not settings.signer_key:
            raise ApiError(503, "signer_unavailable", "QUOTE_SIGNER_KEY is not set")
        if not settings.min_duration_s <= req.durationSec <= settings.max_duration_s:
            raise ApiError(
                400,
                "duration_out_of_range",
                f"durationSec must be in [{settings.min_duration_s}, {settings.max_duration_s}]",
            )
        if req.payout > settings.max_payout:
            raise ApiError(422, "capacity", f"payout exceeds engine cap {settings.max_payout}")
        try:
            coin, spot6 = market.oracle(req.perpIndex)
        except (UnknownPerpError, KeyError, IndexError):
            raise ApiError(400, "unknown_perp", f"perpIndex {req.perpIndex} not listed") from None
        except (InfoApiError, ValueError) as exc:
            raise ApiError(503, "market_data_unavailable", str(exc)) from None
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
        T = req.durationSec / SECONDS_PER_YEAR
        p = touch_prob(S, H, sigma, T)
        adj = tail.lookup(coin, req.isLong, req.durationSec, abs(H / S - 1))
        try:
            prem = premium(req.payout, p, adj.k, settings.theta, settings.p_max, settings.fee, adj.q)
        except QuoteRefusedError as exc:
            raise ApiError(422, exc.code, exc.reason) from None
        now = int(clock())
        q = Quote(
            buyer=req.buyer,
            perpIndex=req.perpIndex,
            isLong=req.isLong,
            level=req.level,
            payout=req.payout,
            premium=prem,
            expiry=now + req.durationSec,
            spotRef=spot6,
            deadline=now + settings.quote_ttl_s,
            nonce=nonce_fn(),
        )
        try:
            sig = sign_quote(q, settings.chain_id, settings.pool, settings.signer_key)
        except ChainNotAllowedError as exc:
            raise ApiError(403, "chain_not_allowed", str(exc)) from None
        return {
            "quote": q.to_dict(),
            "signature": sig,
            "breakdown": {
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
            },
        }

    return app


def _lazy_app() -> FastAPI:
    return create_app()


def __getattr__(name: str) -> Any:  # `uvicorn numera_engine.quote_api:app` builds from env on first use
    if name == "app":
        return _lazy_app()
    raise AttributeError(name)
