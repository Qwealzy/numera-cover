"""Multicall3 encoding/decoding: one eth_call per poll, failed sub-calls become None."""

import pytest
from eth_abi import decode, encode

from numera_engine import multicall as mc

POOL = "0x1b1bfb83f2100c95a7460ed1a746170cbdeccbae"
SRC = "0x08d24f21bcd9fdf690499456e90b9712b31bbc13"
BUYER = "0x2ba514ca28fc6f34072f2cbb7467d0849cff52a9"
COVER = (BUYER, 3, True, 83_117_000_000, 20_000_000, 6_845_262, 1_790_882_277, 1_790_968_677, 1)


def test_known_selectors():
    assert mc.AGGREGATE3.hex() == "82ad56cb"
    assert mc.selector("getCurrentBlockTimestamp()").hex() == "0f28c97d"
    assert mc.cover_count(POOL).data.hex() == "feb0b8f5"  # cast sig "coverCount()"
    assert mc.oracle_px6(SRC, 3).data[:4].hex() == "b1d42205"
    assert mc.get_cover(POOL, 1).data[:4].hex() == "fd7b68a2"


def test_aggregate3_calldata_round_trips_with_allow_failure():
    calls = [mc.block_timestamp(), mc.cover_count(POOL), mc.get_cover(POOL, 7), mc.oracle_px6(SRC, 135)]
    data = bytes.fromhex(mc.encode_aggregate3(calls)[2:])
    assert data[:4] == mc.AGGREGATE3
    (decoded,) = decode(["(address,bool,bytes)[]"], data[4:])
    assert [(t.lower(), ok) for t, ok, _ in decoded] == [
        (mc.MULTICALL3.lower(), True), (POOL, True), (POOL, True), (SRC, True)]  # fmt: skip
    assert decoded[2][2] == mc.selector("getCover(uint256)") + encode(["uint256"], [7])
    assert decoded[3][2] == mc.selector("oraclePx6(uint32)") + encode(["uint32"], [135])


def result_hex(items):
    return "0x" + encode(["(bool,bytes)[]"], [items]).hex()


def test_decode_results_failures_and_garbage_are_none():
    calls = [mc.block_timestamp(), mc.cover_count(POOL), mc.get_cover(POOL, 1), mc.oracle_px6(SRC, 4),
             mc.oracle_px6(SRC, 3)]  # fmt: skip
    res = result_hex([
        (True, encode(["uint256"], [1_790_900_000])),
        (True, encode(["uint256"], [5])),
        (True, encode([mc.COVER_TUPLE], [COVER])),
        (False, bytes.fromhex("deadbeef")),  # reverted (e.g. PriceNotSet)
        (True, b"\x01"),  # too short to decode
    ])  # fmt: skip
    ts, count, cover, px4, px3 = mc.decode_aggregate3(calls, res)
    assert (ts, count, px4, px3) == (1_790_900_000, 5, None, None)
    assert cover[0].lower() == BUYER and tuple(cover[1:]) == COVER[1:]


def test_decode_rejects_length_mismatch():
    with pytest.raises(ValueError):
        mc.decode_aggregate3([mc.block_timestamp()], result_hex([]))


class OneCall:
    def __init__(self, answer):
        self.answer, self.seen = answer, []

    def call(self, method, params):
        self.seen.append((method, params))
        return self.answer


def test_aggregate_is_a_single_eth_call_and_empty_is_free():
    rpc = OneCall(result_hex([(True, encode(["uint256"], [9]))]))
    assert mc.aggregate(rpc, [mc.cover_count(POOL)]) == [9]
    assert rpc.seen[0][0] == "eth_call" and rpc.seen[0][1][0]["to"] == mc.MULTICALL3
    assert len(rpc.seen) == 1
    assert mc.aggregate(rpc, []) == [] and len(rpc.seen) == 1
    with pytest.raises(RuntimeError):
        mc.aggregate(OneCall("0x"), [mc.cover_count(POOL)])
