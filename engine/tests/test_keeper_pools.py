"""Keeper pool planning (D10): which pools, and from which block (never 0)."""

import pytest

from numera_engine.deployments import parse
from numera_engine.keeper import PoolPlan, plan_pools

DEP = parse(
    {
        "pools": {
            "hypercore": {"pool": "0xAAAA000000000000000000000000000000000001", "txs": {"pool": "0xtxA"}},
            "mock": {"pool": "0xbbbb000000000000000000000000000000000002", "txs": {"pool": "0xtxB"}},
        }
    }
)
BLOCKS = {"0xtxA": 1000, "0xtxB": 2000}


def receipts(tx):
    return BLOCKS[tx]


def test_all_pools_start_at_their_deploy_block():
    assert plan_pools(DEP, None, None, receipts) == [
        PoolPlan("0xaaaa000000000000000000000000000000000001", 1000, "hypercore"),
        PoolPlan("0xbbbb000000000000000000000000000000000002", 2000, "mock"),
    ]


def test_selected_pool_case_insensitive_and_override():
    plans = plan_pools(DEP, ["0xBBBB000000000000000000000000000000000002"], None, receipts)
    assert plans == [PoolPlan("0xbbbb000000000000000000000000000000000002", 2000, "mock")]
    plans = plan_pools(DEP, ["0xBBBB000000000000000000000000000000000002"], 5, receipts)
    assert plans[0].from_block == 5


def test_unknown_pool_without_start_block_is_an_error():
    with pytest.raises(ValueError):
        plan_pools(DEP, ["0x" + "cc" * 20], None, receipts)
    assert plan_pools(DEP, ["0x" + "cc" * 20], 7, receipts)[0].from_block == 7


def test_no_pools_at_all_is_an_error():
    with pytest.raises(ValueError):
        plan_pools(None, None, None, receipts)
