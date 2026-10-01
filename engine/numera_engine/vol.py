"""Volatility estimators (ARCHITECTURE §7.1). Pure functions on numpy arrays.

sigma = max(EWMA sigma (lambda = 0.94, zero-mean RiskMetrics), 30-day realized sigma), annualized.
Returns are close-to-close log returns. Annualization: sqrt(periods per year), 24*365 for 1 h bars.
"""

from __future__ import annotations

import numpy as np
from scipy.signal import lfilter

LAMBDA = 0.94
HOURS_PER_YEAR = 24 * 365
DAYS_PER_YEAR = 365
FLOOR_DAYS = 30
EWMA_SEED = 24  # returns used to seed the EWMA variance


def log_returns(closes: np.ndarray) -> np.ndarray:
    c = np.asarray(closes, dtype=float)
    if c.ndim != 1 or len(c) < 2:
        raise ValueError("need at least 2 closes")
    if np.any(c <= 0):
        raise ValueError("closes must be positive")
    return np.diff(np.log(c))


def ewma_variance_series(returns: np.ndarray, lam: float = LAMBDA, seed: int = EWMA_SEED) -> np.ndarray:
    """v[t] = lam * v[t-1] + (1 - lam) * r[t]^2, per-period variance after observing r[t].

    Seeded with the mean square of the first ``seed`` returns (only those returns inform v before
    index ``seed``; callers needing strict no-look-ahead must skip the first ``seed`` points).
    """
    r2 = np.asarray(returns, dtype=float) ** 2
    if len(r2) == 0:
        raise ValueError("no returns")
    if not 0 < lam < 1:
        raise ValueError("lambda must be in (0, 1)")
    v0 = float(np.mean(r2[: max(1, min(seed, len(r2)))]))
    out, _ = lfilter([1 - lam], [1, -lam], r2, zi=[lam * v0])
    return out


def ewma_sigma(returns: np.ndarray, periods_per_year: float = HOURS_PER_YEAR, lam: float = LAMBDA) -> float:
    return float(np.sqrt(ewma_variance_series(returns, lam)[-1] * periods_per_year))


def realized_sigma(returns: np.ndarray, periods_per_year: float = HOURS_PER_YEAR) -> float:
    r = np.asarray(returns, dtype=float)
    if len(r) == 0:
        raise ValueError("no returns")
    return float(np.sqrt(np.mean(r**2) * periods_per_year))


def sigma_estimate(
    closes: np.ndarray,
    periods_per_year: float = HOURS_PER_YEAR,
    floor_periods: int | None = None,
    lam: float = LAMBDA,
) -> float:
    """Annualized sigma from closes: max(EWMA, realized over the last ``floor_periods`` returns).

    ``floor_periods`` defaults to 30 days of bars at the given frequency.
    """
    r = log_returns(closes)
    if floor_periods is None:
        floor_periods = int(round(FLOOR_DAYS * periods_per_year / DAYS_PER_YEAR))
    return max(ewma_sigma(r, periods_per_year, lam), realized_sigma(r[-floor_periods:], periods_per_year))


def sigma_series(
    closes: np.ndarray,
    periods_per_year: float = HOURS_PER_YEAR,
    floor_periods: int | None = None,
    lam: float = LAMBDA,
) -> np.ndarray:
    """s[i] = sigma estimate using closes[0..i] only (NaN until a full floor window exists).

    Vectorized equivalent of ``sigma_estimate(closes[: i + 1])`` for the backtest (no look-ahead:
    index i only uses returns ending at close i).
    """
    c = np.asarray(closes, dtype=float)
    if floor_periods is None:
        floor_periods = int(round(FLOOR_DAYS * periods_per_year / DAYS_PER_YEAR))
    r = log_returns(c)
    ew = np.sqrt(ewma_variance_series(r, lam) * periods_per_year)
    csum = np.concatenate([[0.0], np.cumsum(r**2)])
    out = np.full(len(c), np.nan)
    # close index i  <->  returns r[0..i-1]; need i >= floor_periods and i > EWMA_SEED
    for i in range(max(floor_periods, EWMA_SEED + 1), len(c)):
        floor = np.sqrt((csum[i] - csum[i - floor_periods]) / floor_periods * periods_per_year)
        out[i] = max(ew[i - 1], floor)
    return out
