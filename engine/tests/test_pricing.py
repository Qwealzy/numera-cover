"""One-touch closed form vs Monte Carlo (F5), premium and tail-table tests.

Monte Carlo design: simulate X = ln(S_t/S_0) exactly on a grid (Brownian motion with drift
nu = -sigma^2/2, N steps). A grid-only check misses barrier crossings *between* grid points, so a naive
discrete MC is biased low (shown in test_naive_discrete_mc_underestimates). We remove that bias with the
Brownian-bridge correction: given X at both ends of a step, both on the safe side of barrier b, the
probability the path crossed b inside the step is exp(-2 (x0 - b)(x1 - b) / (sigma^2 dt)), independent of
the drift. Each path's touch probability is 1 - prod(1 - p_step) (or 1 if a grid point is beyond b), and
the estimate is its mean over paths: unbiased for continuous monitoring with lower variance than drawing
the crossings.
"""

import json
import math
from pathlib import Path

import numpy as np
import pytest
from scipy.special import ndtr

from numera_engine.pricing import (
    HorizonZTable,
    QuoteRefusedError,
    TailAdj,
    TailTable,
    ZTailTable,
    load_tail_table,
    premium,
    priced_prob,
    touch_prob,
    touch_prob_directional,
    z_score,
)

DAY = 1 / 365
HOUR = DAY / 24
N_PATHS = 200_000
N_STEPS = 64
SEED = 20261012


def mc_touch(S, H, sigma, T, n_paths=N_PATHS, n_steps=N_STEPS, seed=SEED, bridge=True, chunk=50_000):
    rng = np.random.default_rng(seed)
    b = math.log(H / S)
    down = H < S
    dt = T / n_steps
    nu = -0.5 * sigma**2
    total = 0.0
    done = 0
    while done < n_paths:
        m = min(chunk, n_paths - done)
        inc = nu * dt + sigma * math.sqrt(dt) * rng.standard_normal((m, n_steps))
        x = np.concatenate([np.zeros((m, 1)), np.cumsum(inc, axis=1)], axis=1)
        d = (x - b) if down else (b - x)  # distance to barrier on the safe side (> 0 = not touched)
        hit_grid = (d[:, 1:] <= 0).any(axis=1)
        if bridge:
            d0, d1 = np.maximum(d[:, :-1], 0), np.maximum(d[:, 1:], 0)
            p_step = np.exp(-2 * d0 * d1 / (sigma**2 * dt))
            p_path = 1 - np.exp(np.sum(np.log1p(-np.minimum(p_step, 1 - 1e-16)), axis=1))
            p_path = np.where(hit_grid, 1.0, p_path)
            total += float(p_path.sum())
        else:
            total += float(hit_grid.sum())
        done += m
    return total / n_paths


# (label, S, H, sigma, T)
F5_CASES = [
    ("down 5% / 1d / sigma 80%", 100.0, 95.0, 0.80, DAY),
    ("down 1% / 1h / sigma 60%", 100.0, 99.0, 0.60, HOUR),
    ("down 10% / 7d / sigma 100%", 100.0, 90.0, 1.00, 7 * DAY),
    ("up 5% / 1d / sigma 80%", 100.0, 105.0, 0.80, DAY),
    ("up 2% / 4h / sigma 70%", 100.0, 102.0, 0.70, 4 * HOUR),
    ("up 20% / 7d / sigma 120%", 100.0, 120.0, 1.20, 7 * DAY),
    ("down 30% / 30d / sigma 300% (drift matters)", 100.0, 70.0, 3.00, 30 * DAY),
    ("up 40% / 30d / sigma 300% (drift matters)", 100.0, 140.0, 3.00, 30 * DAY),
]


@pytest.mark.parametrize("label,S,H,sigma,T", F5_CASES, ids=[c[0] for c in F5_CASES])
def test_f5_closed_form_matches_monte_carlo(label, S, H, sigma, T):
    cf = touch_prob(S, H, sigma, T)
    mc = mc_touch(S, H, sigma, T)
    assert abs(cf - mc) < 0.005, f"{label}: closed form {cf:.5f} vs MC {mc:.5f}"


def test_naive_discrete_mc_underestimates():
    """Why the bridge correction is needed: grid-only monitoring misses crossings between steps."""
    S, H, sigma, T = 100.0, 95.0, 0.80, DAY
    cf = touch_prob(S, H, sigma, T)
    naive = mc_touch(S, H, sigma, T, n_paths=50_000, bridge=False)
    assert naive < cf - 0.01


def _general_touch(S, H, sigma, T, nu):
    """Textbook first-passage probability of BM with drift nu (independent re-derivation for the mirror)."""
    b = math.log(H / S)
    s = sigma * math.sqrt(T)
    if b < 0:
        return ndtr((b - nu * T) / s) + math.exp(2 * nu * b / sigma**2) * ndtr((b + nu * T) / s)
    return ndtr((-b + nu * T) / s) + math.exp(2 * nu * b / sigma**2) * ndtr((-b - nu * T) / s)


@pytest.mark.parametrize("H", [50.0, 80.0, 97.0, 99.9, 100.1, 103.0, 125.0, 200.0])
def test_matches_general_drift_formula(H):
    for sigma, T in [(0.5, DAY), (1.5, 30 * DAY)]:
        expected = _general_touch(100.0, H, sigma, T, -(sigma**2) / 2)
        assert touch_prob(100.0, H, sigma, T) == pytest.approx(expected)


def test_architecture_down_formula_literal():
    """ARCHITECTURE §7.2 exactly as written."""
    S, H, sigma, T = 84_000.0, 80_000.0, 0.55, 3 * DAY
    b = math.log(H / S)
    s = sigma * math.sqrt(T)
    doc = ndtr((b + sigma**2 * T / 2) / s) + (S / H) * ndtr((b - sigma**2 * T / 2) / s)
    assert touch_prob(S, H, sigma, T) == pytest.approx(doc, rel=1e-12)


def test_limits_and_monotonicity():
    assert touch_prob(100, 100, 0.5, DAY) == 1.0
    assert touch_prob(100, 90, 0.0, DAY) == 0.0
    assert touch_prob(100, 90, 0.5, 0.0) == 0.0
    ps = [touch_prob(100, 100 * (1 - d), 0.8, DAY) for d in (0.01, 0.02, 0.05, 0.1)]
    assert all(a > b for a, b in zip(ps, ps[1:], strict=False))
    ps = [touch_prob(100, 95, s, DAY) for s in (0.3, 0.6, 1.2)]
    assert all(a < b for a, b in zip(ps, ps[1:], strict=False))
    ps = [touch_prob(100, 105, 0.8, t) for t in (HOUR, DAY, 7 * DAY)]
    assert all(a < b for a, b in zip(ps, ps[1:], strict=False))
    # long horizon: driftless GBM price is a martingale, so P(touch 2x) <= 1/2 (optional stopping)
    assert touch_prob(100, 200, 2.0, 10.0) <= 0.5 + 1e-9


def test_down_vs_up_asymmetry():
    """Negative log drift: equal log-distance down is likelier than up; +x% is a smaller log move than -x%."""
    S, sigma, T = 100.0, 1.0, 7 * DAY
    assert touch_prob(S, S * math.exp(-0.1), sigma, T) > touch_prob(S, S * math.exp(0.1), sigma, T)
    assert touch_prob(S, 110.0, sigma, T) != pytest.approx(touch_prob(S, 90.0, sigma, T))


def test_directional_breached_is_certain():
    assert touch_prob_directional(100, 100, 0.5, DAY, is_long=True) == 1.0
    assert touch_prob_directional(99, 100, 0.5, DAY, is_long=True) == 1.0
    assert touch_prob_directional(101, 100, 0.5, DAY, is_long=False) == 1.0
    assert touch_prob_directional(100, 95, 0.5, DAY, is_long=True) == touch_prob(100, 95, 0.5, DAY)


# -- premium ----------------------------------------------------------------------------------------


def test_premium_formula_and_rounding():
    # 100 USDC payout, p = 0.02, k = 1.5, theta 0.2: 100e6 * 0.03 * 1.2 = 3.6e6
    assert premium(100_000_000, 0.02, 1.5) == 3_600_000
    assert premium(100_000_000, 0.02, 1.5, fee=10_000) == 3_610_000
    assert premium(1, 0.001) == 1  # rounds up, never 0 for a positive price
    assert premium(100_000_000, 0.0) == 0


def test_premium_floor_q():
    assert priced_prob(0.001, 2.0, 0.01) == 0.01
    assert premium(100_000_000, 0.001, 2.0, q_floor=0.01) == 1_200_000
    assert premium(100_000_000, 0.02, 2.0, q_floor=0.01) == 4_800_000


def test_premium_refuses_above_pmax():
    with pytest.raises(QuoteRefusedError) as e:
        premium(100_000_000, 0.3, 2.0)
    assert e.value.code == "prob_too_high"
    with pytest.raises(QuoteRefusedError):
        premium(100_000_000, 0.01, 1.0, q_floor=0.6)
    assert premium(100_000_000, 0.25, 2.0) == 60_000_000  # exactly pMax is allowed


@pytest.mark.parametrize("kw", [{"payout": 0}, {"p": 1.5}, {"k": 0.9}, {"q_floor": -0.1}])
def test_premium_rejects_bad_inputs(kw):
    args = {"payout": 100, "p": 0.1, "k": 1.0, "q_floor": 0.0} | kw
    with pytest.raises(ValueError):
        premium(args["payout"], args["p"], args["k"], q_floor=args["q_floor"])


# -- tail table -------------------------------------------------------------------------------------


def _table():
    cells = {
        "3600": {"0.050": {"k": 2.0, "q": 0.004}, "0.075": {"k": 5.0, "q": 0.001}},
        "86400": {"0.050": {"k": 1.2, "q": 0.03}, "0.075": None},
    }
    return TailTable(
        coins={"BTC": {"down": cells, "up": {}}, "SOL": {"down": {"3600": {"0.050": {"k": 3.0, "q": 0.01}}}}},
        horizons_s=(3600, 86400),
        distances=(0.05, 0.075),
        default=TailAdj(4.0, 0.02),
    )


def test_tail_lookup_grid_point_and_interpolation():
    t = _table()
    assert t.lookup("BTC", True, 3600, 0.05) == TailAdj(2.0, 0.004)
    mid = t.lookup("BTC", True, 3600, 0.0625)
    assert mid.k == 5.0  # max of bracketing buckets
    assert mid.q == pytest.approx(math.sqrt(0.004 * 0.001))  # log-linear midpoint
    assert t.lookup("BTC", True, 3600, 0.20) == TailAdj(5.0, 0.001)  # clamped to the far end
    assert t.lookup("BTC", True, 3600, 0.01) == TailAdj(2.0, 0.004)  # clamped to the near end


def test_tail_lookup_horizon_rounds_up_and_missing_cells():
    t = _table()
    assert t.lookup("BTC", True, 1800, 0.05) == TailAdj(2.0, 0.004)
    assert t.lookup("BTC", True, 7200, 0.05) == TailAdj(1.2, 0.03)  # 2h -> 1d bucket
    assert t.lookup("BTC", True, 86400, 0.07) == TailAdj(1.2, 0.03)  # one bracket null: use the other
    assert t.lookup("BTC", True, 86400, 0.075) == TailAdj(4.0, 0.02)  # null cell on the grid: default
    assert t.lookup("BTC", False, 3600, 0.05) == TailAdj(4.0, 0.02)  # no data at all: default


def test_tail_lookup_unknown_coin_takes_max_over_coins():
    t = _table()
    assert t.lookup("DOGE", True, 3600, 0.05) == TailAdj(3.0, 0.01)


def test_v1_table_still_loads(tmp_path):
    blob = {
        "horizons_s": [3600],
        "distances": [0.05],
        "default": {"k": 1.0, "q": 0.0},
        "coins": {"BTC": {"down": {"3600": {"0.050": {"k": 2.0, "q": 0.01}}}}},
    }
    p = tmp_path / "t.json"
    p.write_text(json.dumps(blob))
    t = load_tail_table(p)
    assert isinstance(t, TailTable)
    assert t.adjust("BTC", True, 3600, 100.0, 95.0, 0.5) == TailAdj(2.0, 0.01)


# -- v2 pooled z table ------------------------------------------------------------------------------


def _ztable():
    edges = (0.0, 1.0, 2.0, 3.0, math.inf)
    cells = {
        "down": [
            {"k": 1.0, "q": 0.20},
            {"k": 1.5, "q": 0.02},
            None,  # < 30 windows: borrows the nearer-the-money neighbour
            {"k": 10.0, "q": 0.03},  # above the previous bucket: q is made non-increasing in |z|
        ],
        "up": [None, None, None, None],
    }
    return ZTailTable(edges, cells, TailAdj(2.0, 0.05))


def test_z_score_sign_and_scale():
    assert z_score(100, 90, 0.5, DAY) == pytest.approx(math.log(0.9) / (0.5 * math.sqrt(DAY)))
    assert z_score(100, 110, 0.5, DAY) > 0 > z_score(100, 90, 0.5, DAY)


def test_ztable_k_step_and_q_monotone_interpolated():
    t = _ztable()
    assert t.kq(True, 0.2) == TailAdj(1.0, pytest.approx(0.20))  # below the first mid-point: clamp
    assert t.kq(True, 1.5) == TailAdj(1.5, pytest.approx(0.03))  # q of bucket 1 lifted to 0.03 (monotone)
    assert t.kq(True, 2.5).k == 1.5  # empty bucket borrows its nearer-the-money neighbour
    assert t.kq(True, 50.0) == TailAdj(10.0, pytest.approx(0.03))  # beyond the grid: clamp
    assert t.kq(True, 1.0).q == pytest.approx(math.sqrt(0.20 * 0.03))  # log-linear between mids 0.5, 1.5
    qs = [t.kq(True, z).q for z in np.linspace(0, 6, 61)]
    assert all(a >= b - 1e-15 for a, b in zip(qs, qs[1:], strict=False))  # never rises with distance
    assert t.kq(False, 1.0) == TailAdj(2.0, 0.05)  # no data for that direction: default


def test_ztable_vectorized_lookup_matches_scalar():
    t = _ztable()
    zs = np.concatenate([np.linspace(0, 8, 161), [0.5, 1.5, 2.0, 2.5, 50.0]])
    for is_long in (True, False):
        k, q = t.kq_many(is_long, zs)
        for z, kk, qq in zip(zs, k, q, strict=True):
            a = t.kq(is_long, float(z))
            assert kk == a.k and qq == pytest.approx(a.q, rel=1e-12)


def test_ztable_adjust_uses_z_of_the_quote():
    t = _ztable()
    S, H, sigma, dur = 100.0, 97.0, 0.6, 3600
    z = abs(z_score(S, H, sigma, dur / (365 * 24 * 3600)))
    assert t.adjust("ANY", True, dur, S, H, sigma) == t.kq(True, z)


def test_published_table_loads_and_is_sane():
    t = load_tail_table(Path(__file__).parent.parent / "reports" / "tail_multipliers.json")
    assert isinstance(t, HorizonZTable)
    assert t.horizons_s == (3600, 4 * 3600, 86400, 7 * 86400)
    for table in t.tables.values():
        for is_long in (True, False):
            prev = 1.0
            for z in (0.1, 1.0, 2.0, 3.0, 4.0, 6.0, 10.0, 40.0):
                a = table.kq(is_long, z)
                assert 1.0 <= a.k <= 10.0 and 0 < a.q <= prev + 1e-15
                prev = a.q


def test_horizon_table_picks_smallest_horizon_at_or_above_duration():
    t1 = ZTailTable((0.0, math.inf), {"down": [{"k": 1.0, "q": 0.01}], "up": [None]})
    t2 = ZTailTable((0.0, math.inf), {"down": [{"k": 2.0, "q": 0.02}], "up": [None]})
    h = HorizonZTable((3600, 86400), {3600: t1, 86400: t2})
    assert h.adjust("BTC", True, 1800, 100.0, 95.0, 0.5) == TailAdj(1.0, pytest.approx(0.01))
    assert h.adjust("BTC", True, 3600, 100.0, 95.0, 0.5) == TailAdj(1.0, pytest.approx(0.01))
    assert h.adjust("BTC", True, 7200, 100.0, 95.0, 0.5) == TailAdj(2.0, pytest.approx(0.02))
    assert h.adjust("BTC", True, 10 * 86400, 100.0, 95.0, 0.5) == TailAdj(2.0, pytest.approx(0.02))
