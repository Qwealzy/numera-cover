"""Precomputed premium grid for the hero estimator (build spec 2.7, option A).

Runs the repo's own pricing code once, so the browser never re-implements the formula:

    <repo>/engine/.venv/Scripts/python waitlist/scripts/gen-grid.py

Reads (never writes):
  ../engine/numera_engine            pricing.touch_prob_directional, premium, load_tail_table; poolv2 floors
  ../engine/reports/tail_multipliers.json
  ../deployments/testnet-v2.json     MOCK v2 pool limits (minPremiumBps, minLevelDistanceBps, maxSpotDeviationBps)
Writes only:
  waitlist/src/data/grid.json

Every cell mirrors the order of engine/numera_engine/quote_api.py `quote()`: level already breached ->
sigma-based level floor (3 sigma over the 30 s quote lifetime) -> v2 level floor (poolv2.level_distance_bps,
56 bps at the testnet limits) -> GBM touch probability -> tail table (k, q) -> premium (refuse
prob_too_high above pMax 0.5) -> v2 premium floor (poolv2.raise_to_floor, 0.20 % of the payout).

Liquidation helper (content brief §4b; app/src/lib/liq.ts; docs/research/hyperliquid.md): isolated position,
entry = spot, mm = 1 / (2 maxLeverage):
  long:  liq = entry (1 - (1/L - mm) / (1 - mm));   short: liq = entry (1 + (1/L - mm) / (1 + mm))
Default level (app/src/config.ts LEVEL_BUFFER 0.01): liq x 1.01 for a long, liq x 0.99 for a short.
"""

from __future__ import annotations

import hashlib
import json
import math
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
SITE = HERE.parent  # waitlist/
REPO = SITE.parent  # the worktree root
sys.path.insert(0, str(REPO / "engine"))

from numera_engine.pricing import (  # noqa: E402
    P_MAX,
    priced_prob,
    SECONDS_PER_YEAR,
    THETA,
    QuoteRefusedError,
    load_tail_table,
    premium,
    touch_prob_directional,
)
from numera_engine.poolv2 import Limits, level_distance_bps, level_too_close, raise_to_floor  # noqa: E402
from numera_engine.quote_api import DEFAULT_QUOTE_TTL_S, LEVEL_K_SIGMA  # noqa: E402

TAIL = REPO / "engine" / "reports" / "tail_multipliers.json"
TAIL_COPY = SITE / "src" / "data" / "tail_multipliers.json"
DEPLOY = REPO / "deployments" / "testnet-v2.json"
OUT = SITE / "src" / "data" / "grid.json"

PAYOUT = 100_000_000  # $100 in USDC base units (6 decimals)
SPOT6 = 100_000_000  # the grid is scale-free: premium depends only on level/spot, sigma and duration
LEVEL_BUFFER = 0.01  # app/src/config.ts
DURATIONS = [3600, 14400, 86400, 259200, 604800]  # app/src/config.ts DURATIONS (1h 4h 1d 3d 7d)
SIGMAS = [0.32, 0.40, 0.50]  # docs/pitch/business-plan.md volatility range: calm / normal / wild presets
MAX_LEVS = [40]  # P0: BTC only. 40x: docs/research/hyperliquid.md l.79 ("1.25% at 40x"), business-plan l.89
COIN = "BTC"
FEE = 0  # fee = 0 today (docs/how-it-works.md §7 step 6)

REFUSE_PROB = -1  # prob_too_high
REFUSE_LEVEL = -2  # level_too_close (or already breached)


def sig(x: float, n: int = 5) -> float:
    return float(f"{x:.{n}g}")


def liq_and_level(lev: int, max_lev: int, is_long: bool) -> tuple[float, float]:
    side = 1 if is_long else -1
    mm = 1 / (2 * max_lev)
    frac = (1 / lev - mm) / (1 - side * mm)
    liq = 1.0 - side * frac  # fraction of entry
    level = liq * (1 + LEVEL_BUFFER) if is_long else liq * (1 - LEVEL_BUFFER)
    return liq, level


def main() -> None:
    tail_bytes = TAIL.read_bytes()
    tail_sha = hashlib.sha256(tail_bytes).hexdigest()
    if not TAIL_COPY.exists() or hashlib.sha256(TAIL_COPY.read_bytes()).hexdigest() != tail_sha:
        sys.exit(f"copy {TAIL} to {TAIL_COPY} first (the copy must be byte-identical)")
    table = load_tail_table(TAIL)

    dep = json.loads(DEPLOY.read_text(encoding="utf-8"))
    assert dep["chainId"] == 998, "testnet-v2.json must be chain 998"
    raw_limits = dep["pools"]["mock"]["config"]["limits"]
    limits = Limits(**{k: int(v) for k, v in raw_limits.items()})
    bps = level_distance_bps(limits)  # 56 at the testnet limits (25 + 30 + 1)

    perps: dict[str, dict] = {}
    for max_lev in MAX_LEVS:
        sides = {}
        for is_long in (True, False):
            levs = list(range(2, max_lev + 1))
            liqs, lvls, prem, prob, floor, priced, qset = [], [], [], [], [], [], []
            for lev in levs:
                liq, level = liq_and_level(lev, max_lev, is_long)
                liqs.append(sig(abs(liq - 1), 6))
                lvls.append(sig(abs(level - 1), 6))
                level6 = int(round(level * SPOT6))
                S, H = SPOT6 / 1e6, level6 / 1e6
                for dur in DURATIONS:
                    T = dur / SECONDS_PER_YEAR
                    for sigma in SIGMAS:
                        breached = (is_long and SPOT6 <= level6) or (not is_long and SPOT6 >= level6)
                        min_dist = LEVEL_K_SIGMA * sigma * math.sqrt(DEFAULT_QUOTE_TTL_S / SECONDS_PER_YEAR)
                        if breached or abs(math.log(H / S)) < min_dist or level_too_close(SPOT6, level6, bps):
                            prem.append(REFUSE_LEVEL)
                            prob.append(0)
                            floor.append(0)
                            priced.append(0)
                            qset.append(0)
                            continue
                        p = touch_prob_directional(S, H, sigma, T, is_long)
                        adj = table.adjust(COIN, is_long, dur, S, H, sigma)
                        # the probability the premium is priced on: max(p*k, q) (pricing.priced_prob);
                        # qset = 1 when the empirical tail floor q, not the multiplied model, sets it
                        pp = priced_prob(p, adj.k, adj.q)
                        priced.append(sig(pp, 4))
                        qset.append(1 if adj.q >= p * adj.k else 0)
                        try:
                            pr = premium(PAYOUT, p, adj.k, THETA, P_MAX, FEE, adj.q)
                        except QuoteRefusedError as exc:
                            assert exc.code == "prob_too_high"
                            prem.append(REFUSE_PROB)
                            prob.append(sig(p, 4))
                            floor.append(0)
                            continue
                        pr, applied = raise_to_floor(pr, PAYOUT, limits.minPremiumBps)
                        prem.append(pr)
                        prob.append(sig(p, 4))
                        floor.append(1 if applied else 0)
            sides["long" if is_long else "short"] = {
                "lev": [levs[0], levs[-1]],
                "liq": liqs,
                "lvl": lvls,
                "prem": prem,
                "p": prob,
                "floor": floor,
                "pp": priced,
                "ppq": qset,
            }
        perps[str(max_lev)] = sides

    engine_commit = subprocess.run(
        ["git", "-C", str(REPO), "log", "-1", "--format=%H", "--", "engine/numera_engine", "engine/reports/tail_multipliers.json"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    blob = {
        "meta": {
            "what": "premium per $100 payout (USDC base units), BTC tail table, illustrative; not a quote",
            "generator": "waitlist/scripts/gen-grid.py",
            "engine_commit": engine_commit,
            "tail_sha256": tail_sha,
            "tail_schema": json.loads(tail_bytes)["schema"],
            "generated_at": generated_at,
            "theta": THETA,
            "p_max": P_MAX,
            "fee": FEE,
            "level_buffer": LEVEL_BUFFER,
            "level_distance_bps": bps,
            "min_premium_bps": limits.minPremiumBps,
            "level_k_sigma": LEVEL_K_SIGMA,
            "quote_ttl_s": DEFAULT_QUOTE_TTL_S,
            "index": "cell = ((levIdx * durations) + durIdx) * sigmas + sigmaIdx; prem -1 prob_too_high, -2 level_too_close",
            "pp": "priced probability max(p*k, q) (pricing.priced_prob); ppq 1 when the tail floor q sets it",
        },
        "payout": PAYOUT,
        "durations": DURATIONS,
        "sigmas": SIGMAS,
        "perps": perps,
    }
    OUT.write_text(json.dumps(blob, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes), tail sha256 {tail_sha[:12]}..., level floor {bps} bps")


if __name__ == "__main__":
    main()
