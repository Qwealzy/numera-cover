"""Keeper pool selection and RPC list resolution."""

import pytest

from numera_engine.deployments import parse
from numera_engine.keeper import PoolPlan, plan_pools, resolve_rpcs
from numera_engine.rpc import CHAINLINK_TESTNET_RPC, OFFICIAL_TESTNET_RPC

DEP = parse(
    {
        "rpc": OFFICIAL_TESTNET_RPC,
        "pools": {
            "hypercore": {"pool": "0xAAAA000000000000000000000000000000000001", "priceSource": "0xS1"},
            "mock": {"pool": "0xbbbb000000000000000000000000000000000002"},
        },
    }
)


def test_all_pools_from_the_deployment():
    assert plan_pools(DEP, None) == [
        PoolPlan("0xaaaa000000000000000000000000000000000001", "hypercore", "0xs1"),
        PoolPlan("0xbbbb000000000000000000000000000000000002", "mock", None),
    ]


def test_selected_pool_case_insensitive_and_unknown_pool():
    assert plan_pools(DEP, ["0xBBBB000000000000000000000000000000000002"]) == [
        PoolPlan("0xbbbb000000000000000000000000000000000002", "mock", None)
    ]
    assert plan_pools(DEP, ["0x" + "CC" * 20]) == [PoolPlan("0x" + "cc" * 20, "0x" + "cc" * 20, None)]


def test_no_pools_at_all_is_an_error():
    with pytest.raises(ValueError):
        plan_pools(None, None)


def test_rpc_list_precedence_cli_then_env_then_default():
    assert resolve_rpcs(["https://x", "https://y"], "https://e", None) == ["https://x", "https://y"]
    assert resolve_rpcs(None, " https://e1 , https://e2,", None) == ["https://e1", "https://e2"]
    assert resolve_rpcs(None, "", DEP.rpc) == [OFFICIAL_TESTNET_RPC, CHAINLINK_TESTNET_RPC]
    assert resolve_rpcs(None, None, "https://own") == [
        "https://own",
        OFFICIAL_TESTNET_RPC,
        CHAINLINK_TESTNET_RPC,
    ]
