"""Backtest mechanics on synthetic candles (no network)."""

import math

import numpy as np
import pytest

from numera_engine.backtest import (
    DATASETS,
    HORIZONS,
    K_MAX,
    LEGACY_1D,
    ROWS,
    Obs,
    Series,
    aggregate,
    evaluate,
    fit_tail,
    fit_z,
    isotonic_nonincreasing,
    merge_tail_inward,
    nearward_pool,
    observations,
    pava_nonincreasing,
    simulate_pool,
    v1_priced,
    v2_priced,
    wilson,
    write_markdown,
    write_tail_json,
    z_table,
)
from numera_engine.pricing import HorizonZTable, load_tail_table, touch_prob
from numera_engine.vol import sigma_series

H = 3_600_000
D = 24 * H


def synthetic(n=2000, sigma_h=0.01, seed=0, start_t=0, step=H):
    rng = np.random.default_rng(seed)
    r = rng.normal(0, sigma_h, n)
    c = 100 * np.exp(np.cumsum(r))
    o = np.concatenate([[100.0], c[:-1]])
    wig = np.abs(rng.normal(0, sigma_h / 2, n))
    return Series(
        t=start_t + np.arange(n, dtype=np.int64) * step,
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


def test_one_day_horizon_uses_daily_candles_and_exact_daily_touch():
    hz = next(h for h in HORIZONS if h.name == "1d")
    assert (hz.interval, hz.bars) == ("1d", 1)  # v4; the v3 set (24 x 1h) is kept only for comparison
    assert (LEGACY_1D.interval, LEGACY_1D.bars, LEGACY_1D.seconds) == ("1h", 24, 86400)
    s = synthetic(n=200, sigma_h=0.03, seed=4, step=D)
    ob = observations(s, hz)
    starts = np.unique(ob.start_ms)
    assert (starts % D == 0).all() and starts[0] >= 30 * D  # 30-day warm-up on daily bars
    i = int(starts[3] // D)
    m = (ob.start_ms == starts[3]) & (ob.direction == "down") & np.isclose(ob.distance, 0.02)
    assert ob.hit[m][0] == (s.low[i] <= s.o[i] * 0.98)  # the day's own low
    sig = sigma_series(s.c, 365, 30)[i - 1]  # daily sigma from closes before the window only
    assert ob.sigma[m][0] == pytest.approx(sig)
    assert ob.p[m][0] == pytest.approx(touch_prob(s.o[i], s.o[i] * 0.98, sig, 1 / 365))


def test_nearward_pool_borrows_only_nearer_buckets():
    counts = [(50, 1000), (5, 1000), (0, 150), (0, 150), (1, 110), (0, 400), (0, 0)]
    pooled = nearward_pool(counts, n_pool=300)
    assert pooled[:2] == counts[:2]  # data-rich buckets keep their own counts
    assert pooled[2] == (5, 1150)  # 0/150 borrows its nearer neighbour
    assert pooled[3] == (5, 1300)  # 0/300 with the next one has no touch yet: keep going
    assert pooled[4] == (1, 410)  # the thin far 1/110 is pooled with nearer 0-touch buckets
    assert pooled[5] == (1, 510) and pooled[6] == (0, 0)
    for i, (h, n) in enumerate(pooled):  # each pool is a contiguous run ending at the bucket itself
        if n:
            j = next(j for j in range(i, -1, -1) if sum(c[1] for c in counts[j : i + 1]) == n)
            assert sum(c[0] for c in counts[j : i + 1]) == h


def test_merge_and_isotonic_alternatives():
    counts = [(50, 1000), (5, 1000), (0, 150), (0, 150), (1, 110), (0, 400)]
    assert merge_tail_inward(counts, n_pool=300) == [(50, 1000)] + [(5, 1300)] * 3 + [(1, 510)] * 2
    assert merge_tail_inward([(1, 10), (0, 10)], n_pool=300) == [(1, 20), (1, 20)]  # one short block
    v = [0.5, 0.2, 0.3, 0.1]
    assert isotonic_nonincreasing(v, [1, 1, 1, 1]) == pytest.approx([0.5, 0.25, 0.25, 0.1])
    assert isotonic_nonincreasing(v, [1, 3, 1, 1]) == pytest.approx([0.5, 0.225, 0.225, 0.1])  # weighted


def _rows(spec, direction="down"):
    """Synthetic Obs with given (|z|, n, hits, p) per bucket."""
    z, p, hit = [], [], []
    for zabs, n, hits, pp in spec:
        z += [zabs] * n
        p += [pp] * n
        hit += [True] * hits + [False] * (n - hits)
    sgn = -1 if direction == "down" else 1
    n = len(z)
    return Obs(np.zeros(n, dtype=np.int64), np.array([direction] * n, dtype=object), np.full(n, 0.05),
               np.full(n, 0.5), np.array(p), np.array(hit), sgn * np.array(z))  # fmt: skip


def test_thin_far_bucket_no_longer_lifts_nearer_data_rich_buckets():
    """The v3 failure: a far bucket with 1 touch in 110 set the floor for every nearer bucket."""
    ob = _rows([(2.1, 2000, 60, 0.03), (3.1, 1500, 3, 1e-3), (3.3, 1500, 2, 5e-4), (3.9, 110, 1, 1e-4),
                (4.5, 3000, 2, 1e-5)])  # fmt: skip
    parts = [(ob, np.ones(len(ob), dtype=bool))]
    old, new = z_table(fit_z(parts, method="none")), z_table(fit_z(parts, method="nearward"))
    thin_bound = wilson(1, 110)[1]
    assert old.kq(True, 3.2).q == pytest.approx(thin_bound)  # lifted by the thin bucket (v3)
    assert new.kq(True, 3.2).q < 0.5 * thin_bound  # v4: set by its own 1500 windows and neighbours
    b39 = next(b for b in fit_z(parts, method="nearward") if b.direction == "down" and b.lo == 3.75)
    assert (b39.block_hits, b39.block_n) == (3, 1610)  # pooled with the nearer 3.25-3.5 bucket only
    assert new.kq(True, 3.875).q == pytest.approx(wilson(3, 1610)[1], rel=1e-6)  # at the bucket mid-point
    with pytest.raises(ValueError):
        fit_z(parts, method="nope")


def test_evaluate_and_reports_run_on_synthetic_data(tmp_path):
    coins = ["AAA", "BBB"]
    obs_all = {d.name: {} for d in DATASETS}
    ranges, windows = {}, {}
    for k, coin in enumerate(coins):
        hs = synthetic(n=24 * 120, seed=20 + k)
        ds_ = synthetic(n=400, sigma_h=0.03, seed=30 + k, step=D)
        for d in DATASETS:
            obs_all[d.name][coin] = observations(hs if d.interval == "1h" else ds_, d)
        ranges[coin] = {iv: {"first": "x", "last": "y", "count": 1} for iv in ("1h", "1d")}
        windows[coin] = {d.name: len(np.unique(obs_all[d.name][coin].start_ms)) for d in DATASETS}
    ctx = evaluate(obs_all, coins)
    ctx["meta"] = {"generated_at": "t", "coins": coins, "ranges": ranges, "windows": windows}
    for key, _, spec in ROWS:
        for d, pk in spec.values():
            assert (d, "raw") in ctx["sims"] and (d, pk) in ctx["sims"], key
    assert ctx["tables_tr"][("1d-1h", "v4@1d")] is ctx["tables_tr"][("1d", "v4")]
    write_markdown(tmp_path / "c.md", ctx)
    assert "old (v3, main) vs new (v4)" in (tmp_path / "c.md").read_text(encoding="utf-8")
    published = {h.name: ctx["zfull"][(h.name, "v4")] for h in HORIZONS}
    write_tail_json(tmp_path / "t.json", published, ctx["meta"])
    t = load_tail_table(tmp_path / "t.json")
    assert isinstance(t, HorizonZTable) and t.horizons_s == (3600, 4 * 3600, 86400, 7 * 86400)


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
