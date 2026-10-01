"""Backtest mechanics on synthetic candles (no network)."""

import math

import numpy as np
import pytest

from numera_engine.backtest import (
    HORIZONS,
    K_MAX,
    Series,
    aggregate,
    fit_tail,
    fit_z,
    observations,
    pava_nonincreasing,
    simulate_pool,
    v1_priced,
    v2_priced,
    wilson,
    z_table,
)
from numera_engine.pricing import touch_prob

H = 3_600_000


def synthetic(n=2000, sigma_h=0.01, seed=0, start_t=0):
    rng = np.random.default_rng(seed)
    r = rng.normal(0, sigma_h, n)
    c = 100 * np.exp(np.cumsum(r))
    o = np.concatenate([[100.0], c[:-1]])
    wig = np.abs(rng.normal(0, sigma_h / 2, n))
    return Series(
        t=start_t + np.arange(n, dtype=np.int64) * H,
        o=o,
        h=np.maximum(o, c) * np.exp(wig),
        low=np.minimum(o, c) * np.exp(-wig),
        c=c,
    )


def test_wilson_known_values():
    lo, hi = wilson(0, 100)
    assert lo == 0 and hi == pytest.approx(1.6449**2 / (100 + 1.6449**2), rel=1e-3)
    lo, hi = wilson(50, 100)
    assert lo < 0.5 < hi and hi - 0.5 == pytest.approx(0.5 - lo)


def test_fit_tail():
    assert fit_tail(5, 29, 0.1) is None
    k, q = fit_tail(0, 1000, 1e-9)
    assert k == 1.0 and q == pytest.approx(wilson(0, 1000)[1])  # zero touches: no k, but still a floor
    assert fit_tail(1, 1000, 1e-9)[0] == K_MAX  # one touch the model called impossible: capped k
    k, q = fit_tail(10, 1000, 0.5)
    assert k == 1.0  # model over-predicts: no multiplier
    k, q = fit_tail(30, 1000, 0.02)
    assert 1 < k < K_MAX and k == pytest.approx(q / 0.02)


def test_observations_windows_are_aligned_non_overlapping_and_causal():
    s = synthetic(n=24 * 60)
    hz = next(h for h in HORIZONS if h.name == "4h")
    ob = observations(s, hz)
    starts = np.unique(ob.start_ms)
    assert (starts % (4 * H) == 0).all()
    assert (np.diff(starts) >= 4 * H).all()
    assert starts[0] >= 720 * H  # 30-day sigma warm-up
    # first window: realized touch and p recomputed by hand
    i = int(starts[0] // H)
    lo = s.low[i : i + 4].min()
    m = (ob.start_ms == starts[0]) & (ob.direction == "down") & np.isclose(ob.distance, 0.01)
    assert ob.hit[m][0] == (lo <= s.o[i] * 0.99)
    assert ob.p[m][0] == pytest.approx(touch_prob(s.o[i], s.o[i] * 0.99, ob.sigma[m][0], 4 / (24 * 365)))
    # changing data inside/after a window must not change that window's sigma
    s2 = synthetic(n=24 * 60)
    s2.c[i:] *= 2
    ob2 = observations(s2, hz)
    m2 = (ob2.start_ms == starts[0]) & (ob2.direction == "down") & np.isclose(ob2.distance, 0.01)
    assert ob2.sigma[m2][0] == ob.sigma[m][0]


def test_gap_windows_are_skipped():
    s = synthetic(n=24 * 40)
    keep = np.ones(len(s.t), dtype=bool)
    keep[800] = False  # drop one candle
    s = Series(s.t[keep], s.o[keep], s.h[keep], s.low[keep], s.c[keep])
    ob = observations(s, next(h for h in HORIZONS if h.name == "4h"))
    assert not ((ob.start_ms <= 800 * H) & (ob.start_ms + 4 * H > 800 * H)).any()


def test_gbm_data_is_calibrated():
    """On data that *is* GBM (close-to-close), realized touch frequency must not exceed the model much.
    Candle h/l here add wiggle, so realized can sit a bit above p; check the ratio stays sane."""
    s = synthetic(n=24 * 200, seed=7)
    hz = next(h for h in HORIZONS if h.name == "1h")
    b = [
        x for x in aggregate("SYN", "1h", observations(s, hz)) if x.distance == 0.01 and x.direction == "down"
    ][0]
    assert b.n > 3000 and 0.3 < b.realized / b.mean_p < 3


def test_aggregate_passes_in_sample_and_uses_external_pricing():
    s = synthetic(n=24 * 100, sigma_h=0.012, seed=3)
    hz = next(h for h in HORIZONS if h.name == "1h")
    ob = observations(s, hz)
    bs = aggregate("SYN", "1h", ob)
    assert all(b.passes for b in bs if b.k is not None)
    fit = {(b.direction, b.distance): (1.0, 0.5) for b in bs}
    bs2 = aggregate("SYN", "1h", ob, priced=v1_priced(ob, fit))
    assert all(b.priced >= 0.5 - 1e-12 for b in bs2 if b.n)


def test_simulate_pool_accounting():
    s = synthetic(n=24 * 60, seed=11)
    hz = next(h for h in HORIZONS if h.name == "4h")
    ob = observations(s, hz)
    res = simulate_pool("t", hz, {"SYN": ob})
    assert res.sold + res.refused == 10 * res.steps  # 5 distances x 2 directions per window
    assert res.ret == pytest.approx(res.premium - res.paid)
    assert 0 <= res.max_dd < 1 and res.worst_step <= 0
    assert math.isfinite(res.loss_ratio)
    res2 = simulate_pool("t", hz, {"SYN": ob}, {"SYN": np.full(len(ob), 0.6)})  # > pMax: refuse all
    assert res2.sold == 0 and res2.ret == 0


def test_z_column_matches_definition():
    s = synthetic(n=24 * 60, seed=5)
    hz = next(h for h in HORIZONS if h.name == "4h")
    ob = observations(s, hz)
    T = 4 / (24 * 365)
    for i in (0, 7, 33):
        sign = -1 if ob.direction[i] == "down" else 1
        expected = math.log(1 + sign * ob.distance[i]) / (ob.sigma[i] * math.sqrt(T))
        assert ob.z[i] == pytest.approx(expected)
        assert (ob.z[i] < 0) == (ob.direction[i] == "down")


def test_pava_merges_violators_and_keeps_monotone_input():
    mono = [(50, 100), (20, 100), (5, 100), (0, 100)]
    assert pava_nonincreasing(mono) == mono
    # far bucket (1/100) more frequent than its nearer neighbour (0/100): pooled into one block
    assert pava_nonincreasing([(30, 100), (0, 100), (1, 100)]) == [(30, 100), (1, 200), (1, 200)]
    # empty bucket inherits the block before it
    assert pava_nonincreasing([(10, 100), (0, 0), (2, 100)]) == [(10, 100), (10, 100), (2, 100)]
    rates = [h / n for h, n in pava_nonincreasing([(5, 50), (9, 60), (1, 40), (3, 30), (0, 80)])]
    assert all(a >= b for a, b in zip(rates, rates[1:], strict=False))


def test_fit_z_pools_and_table_prices_like_lookup():
    parts = []
    for seed, n in ((1, 24 * 80), (2, 24 * 80)):
        ob = observations(synthetic(n=n, seed=seed), next(h for h in HORIZONS if h.name == "1h"))
        parts.append((ob, np.ones(len(ob), dtype=bool)))
    zbs = fit_z(parts)
    total = sum(len(o) for o, _ in parts)
    assert sum(b.n for b in zbs) == total  # every row lands in exactly one bucket
    assert sum(b.hits for b in zbs) == sum(int(o.hit.sum()) for o, _ in parts)
    table = z_table(zbs)
    ob = parts[0][0]
    pr = v2_priced(ob, table)
    for i in (0, 5, 100):
        a = table.kq(ob.direction[i] == "down", abs(ob.z[i]))
        assert pr[i] == pytest.approx(max(ob.p[i] * a.k, a.q))
