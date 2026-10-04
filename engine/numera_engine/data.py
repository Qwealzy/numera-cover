"""Hyperliquid Info API client (read-only): candles with pagination + on-disk cache, asset contexts.

Facts used (Hyperliquid Info API):
- POST JSON to /info. ``candleSnapshot`` returns trade-price candles ``t,T,s,i,o,c,h,l,v,n`` (strings for
  prices). Only the ~5000 most recent candles per interval exist; a time-range response may be capped,
  so we paginate from the last returned open time until ``end_ms`` or no progress.
- Rate limit 1200 weight/min/IP; candleSnapshot weight = 20 + 1 per 60 items. We pace requests by their
  estimated weight and back off exponentially on 429/5xx.
- Mainnet is used for history only (read-only). Testnet is used for live oracle prices.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any

import requests

MAINNET_INFO_URL = "https://api.hyperliquid.xyz/info"
TESTNET_INFO_URL = "https://api.hyperliquid-testnet.xyz/info"

log = logging.getLogger("numera.engine")

DEFAULT_CACHE_DIR = Path(__file__).resolve().parent.parent / ".cache"  # local dev: engine/.cache
CACHE_DIR_ENV = "NUMERA_CACHE_DIR"
_UNSET: Any = object()


def default_cache_dir() -> Path:
    """``NUMERA_CACHE_DIR`` when set (the VPS units point it at /var/cache/numera), else engine/.cache."""
    env = os.environ.get(CACHE_DIR_ENV, "").strip()
    return Path(env) if env else DEFAULT_CACHE_DIR

INTERVAL_MS = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
    "1d": 86_400_000,
}

WEIGHT_PER_MIN = 1200


class InfoApiError(RuntimeError):
    pass


@dataclass(frozen=True)
class Candle:
    t: int  # open time, ms
    T: int  # close time, ms
    o: float
    h: float
    low: float
    c: float
    v: float
    n: int

    @staticmethod
    def from_api(row: dict[str, Any]) -> Candle:
        return Candle(
            t=int(row["t"]),
            T=int(row["T"]),
            o=float(row["o"]),
            h=float(row["h"]),
            low=float(row["l"]),
            c=float(row["c"]),
            v=float(row["v"]),
            n=int(row.get("n", 0)),
        )


class InfoClient:
    """Minimal POST-JSON client with pacing, retry/backoff and an optional disk cache."""

    def __init__(
        self,
        base_url: str = MAINNET_INFO_URL,
        cache_dir: Path | None = _UNSET,
        timeout_s: float = 30.0,
        max_retries: int = 5,
        session: requests.Session | None = None,
    ) -> None:
        self.base_url = base_url
        if cache_dir is _UNSET:
            cache_dir = default_cache_dir()
        self.cache_dir = Path(cache_dir) if cache_dir else None
        self._cache_warned = False
        self.timeout_s = timeout_s
        self.max_retries = max_retries
        self.session = session or requests.Session()
        self._next_ok = 0.0  # monotonic time before which we should not send

    # -- transport ---------------------------------------------------------------------------------
    def post(self, body: dict[str, Any], weight: int = 20) -> Any:
        delay = 1.0
        for attempt in range(self.max_retries + 1):
            wait = self._next_ok - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            try:
                resp = self.session.post(self.base_url, json=body, timeout=self.timeout_s)
            except requests.RequestException as exc:  # network blip: retry
                if attempt == self.max_retries:
                    raise InfoApiError(f"request failed: {exc}") from exc
                time.sleep(delay)
                delay *= 2
                continue
            # pace the next request by the weight this one consumed
            self._next_ok = time.monotonic() + weight * 60.0 / WEIGHT_PER_MIN
            if resp.status_code == 429 or resp.status_code >= 500:
                if attempt == self.max_retries:
                    raise InfoApiError(f"HTTP {resp.status_code} after {attempt + 1} attempts")
                time.sleep(delay)
                delay *= 2
                continue
            if resp.status_code != 200:
                raise InfoApiError(f"HTTP {resp.status_code}: {resp.text[:200]}")
            return resp.json()
        raise InfoApiError("unreachable")

    # -- cache -------------------------------------------------------------------------------------
    def _cache_path(self, body: dict[str, Any]) -> Path | None:
        if self.cache_dir is None:
            return None
        key = hashlib.sha1((self.base_url + json.dumps(body, sort_keys=True)).encode()).hexdigest()[:20]
        return self.cache_dir / f"{key}.json"

    def _cache_get(self, path: Path | None, closed_before_ms: int, ttl_s: float) -> Any | None:
        if path is None or not path.exists():
            return None
        try:
            blob = json.loads(path.read_text())
        except (OSError, ValueError):
            return None
        fetched = int(blob["fetched_at_ms"])
        # A window that had fully closed when fetched never changes; otherwise honour the TTL.
        if closed_before_ms <= fetched or (time.time() * 1000 - fetched) < ttl_s * 1000:
            return blob["data"]
        return None

    def _cache_put(self, path: Path | None, data: Any) -> None:
        if path is None:
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"fetched_at_ms": int(time.time() * 1000), "data": data}))
        except OSError as exc:  # read-only fs, disk full, permissions: cache is optional
            if not self._cache_warned:
                self._cache_warned = True
                log.warning("[engine] candle cache disabled, cannot write %s (%s); continuing without it. "
                            "Set %s to a writable directory.", path.parent, exc, CACHE_DIR_ENV)

    # -- endpoints ---------------------------------------------------------------------------------
    def candles(
        self, coin: str, interval: str, start_ms: int, end_ms: int, ttl_s: float = 300.0
    ) -> list[Candle]:
        """Candles with open time in [start_ms, end_ms], ascending, de-duplicated."""
        if interval not in INTERVAL_MS:
            raise ValueError(f"unsupported interval {interval}")
        step = INTERVAL_MS[interval]
        body = {
            "type": "candleSnapshot",
            "req": {"coin": coin, "interval": interval, "startTime": start_ms, "endTime": end_ms},
        }
        path = self._cache_path(body)
        cached = self._cache_get(path, end_ms + step, ttl_s)
        if cached is None:
            rows = self._paginate(coin, interval, start_ms, end_ms)
            self._cache_put(path, rows)
        else:
            rows = cached
        return [Candle.from_api(r) for r in rows]

    def _paginate(self, coin: str, interval: str, start_ms: int, end_ms: int) -> list[dict[str, Any]]:
        step = INTERVAL_MS[interval]
        by_t: dict[int, dict[str, Any]] = {}
        cursor = start_ms
        while cursor <= end_ms:
            body = {
                "type": "candleSnapshot",
                "req": {"coin": coin, "interval": interval, "startTime": cursor, "endTime": end_ms},
            }
            est_items = min(5000, (end_ms - cursor) // step + 1)
            page = self.post(body, weight=20 + est_items // 60)
            if not isinstance(page, list):
                raise InfoApiError(f"unexpected candleSnapshot response: {str(page)[:200]}")
            fresh = [r for r in page if start_ms <= int(r["t"]) <= end_ms and int(r["t"]) not in by_t]
            if not fresh:
                break
            for r in fresh:
                by_t[int(r["t"])] = r
            last_t = max(int(r["t"]) for r in fresh)
            cursor = last_t + step
        return [by_t[t] for t in sorted(by_t)]

    def meta_and_ctxs(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """(universe, asset_ctxs) for the perp dex. Not cached: used for live prices."""
        res = self.post({"type": "metaAndAssetCtxs"}, weight=20)
        if not (isinstance(res, list) and len(res) == 2):
            raise InfoApiError(f"unexpected metaAndAssetCtxs response: {str(res)[:200]}")
        return res[0]["universe"], res[1]


def px6_from_decimal_str(px: str) -> int:
    """Info API price string (USD, e.g. "84245.6") -> px6 (USD x 1e6), exact decimal arithmetic."""
    d = Decimal(px)
    if d <= 0:
        raise ValueError(f"non-positive price {px!r}")
    scaled = d * 1_000_000
    if scaled != scaled.to_integral_value():
        raise ValueError(f"price {px!r} has more than 6 decimals")
    return int(scaled)


def px6_from_precompile(raw: int, sz_decimals: int) -> int:
    """Precompile oraclePx raw value -> px6. docs/how-it-works.md §3: px6 = raw * 10^szDecimals."""
    if not 0 <= sz_decimals <= 6:
        raise ValueError("szDecimals out of range")
    return int(raw) * 10**sz_decimals


def perp_index_of(universe: list[dict[str, Any]], coin: str) -> int:
    for i, a in enumerate(universe):
        if a.get("name") == coin:
            return i
    raise KeyError(coin)
