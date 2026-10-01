import math

import numpy as np
import pytest

from numera_engine.vol import (
    EWMA_SEED,
    HOURS_PER_YEAR,
    ewma_sigma,
    ewma_variance_series,
    log_returns,
    realized_sigma,
    sigma_estimate,
    sigma_series,
)


def _closes(returns, start=100.0):
    return start * np.exp(np.concatenate([[0.0], np.cumsum(returns)]))


def test_ewma_matches_explicit_recursion():
    rng = np.random.default_rng(1)
    r = rng.normal(0, 0.01, 300)
    v = np.mean(r[:EWMA_SEED] ** 2)
    expected = []
    for x in r:
        v = 0.94 * v + 0.06 * x * x
        expected.append(v)
    assert np.allclose(ewma_variance_series(r), expected)


def test_constant_returns_annualize_exactly():
    r = np.full(1000, 0.002)
    assert ewma_sigma(r) == pytest.approx(0.002 * math.sqrt(HOURS_PER_YEAR))
    assert realized_sigma(r) == pytest.approx(0.002 * math.sqrt(HOURS_PER_YEAR))


def test_floor_applies_when_recent_returns_are_calm():
    rng = np.random.default_rng(2)
    r = np.concatenate([rng.normal(0, 0.02, 700), np.zeros(100)])  # calm last 100 hours
    c = _closes(r)
    ew = ewma_sigma(log_returns(c))
    floor = realized_sigma(log_returns(c)[-720:])
    assert ew < floor
    assert sigma_estimate(c) == pytest.approx(floor)


def test_ewma_wins_after_a_shock():
    rng = np.random.default_rng(3)
    r = np.concatenate([rng.normal(0, 0.005, 800), [0.08, -0.07, 0.06]])
    c = _closes(r)
    assert sigma_estimate(c) == pytest.approx(ewma_sigma(log_returns(c)))


def test_sigma_series_has_no_look_ahead():
    """s[i] must equal the estimate computed from closes[:i+1] alone."""
    rng = np.random.default_rng(4)
    c = _closes(rng.normal(0, 0.01, 1000))
    s = sigma_series(c)
    assert np.isnan(s[:720]).all()
    for i in (720, 721, 800, 999):
        assert s[i] == pytest.approx(sigma_estimate(c[: i + 1]))
    c2 = c.copy()
    c2[900:] *= 1.5  # changing the future must not change the past
    assert np.allclose(sigma_series(c2)[:900], s[:900], equal_nan=True)


def test_daily_frequency_floor_window():
    rng = np.random.default_rng(5)
    c = _closes(rng.normal(0, 0.03, 100))
    s = sigma_series(c, periods_per_year=365, floor_periods=30)
    assert np.isnan(s[:30]).all() and not np.isnan(s[30:]).any()
    assert s[50] == pytest.approx(sigma_estimate(c[:51], periods_per_year=365, floor_periods=30))


def test_bad_inputs():
    with pytest.raises(ValueError):
        log_returns(np.array([1.0]))
    with pytest.raises(ValueError):
        log_returns(np.array([1.0, -1.0]))
    with pytest.raises(ValueError):
        ewma_variance_series(np.array([0.1]), lam=1.0)
