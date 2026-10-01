"""Multicall3 batching for the keeper's state reads: one ``eth_call`` per poll.

Multicall3 is the canonical deployment at ``0xcA11bde05977b3631167028862bE2a173976CA11`` (present on
HyperEVM testnet, chain 998). Every sub-call uses ``allowFailure = true``: a reverting read (e.g. an unset
mock price) comes back as ``None`` instead of failing the whole batch.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from eth_abi import decode, encode
from eth_utils import function_signature_to_4byte_selector, to_checksum_address

MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"

COVER_TUPLE = "(address,uint32,bool,uint64,uint256,uint256,uint64,uint64,uint8)"  # ICoverPool.Cover


def selector(signature: str) -> bytes:
    return function_signature_to_4byte_selector(signature)


@dataclass(frozen=True)
class Call:
    target: str
    data: bytes
    out: tuple[str, ...]  # ABI output types, decoded into a tuple (single value unwrapped)
    key: Any = None  # caller's tag for the result


def call(target: str, signature: str, in_types: Sequence[str], args: Sequence[Any],
         out: Sequence[str], key: Any = None) -> Call:  # fmt: skip
    data = selector(signature) + (encode(list(in_types), list(args)) if in_types else b"")
    return Call(to_checksum_address(target), data, tuple(out), key)


def cover_count(pool: str, key: Any = None) -> Call:
    return call(pool, "coverCount()", [], [], ["uint256"], key)


def get_cover(pool: str, cover_id: int, key: Any = None) -> Call:
    return call(pool, "getCover(uint256)", ["uint256"], [cover_id], [COVER_TUPLE], key)


def oracle_px6(source: str, perp: int, key: Any = None) -> Call:
    return call(source, "oraclePx6(uint32)", ["uint32"], [perp], ["uint64"], key)


def price_source(pool: str, key: Any = None) -> Call:
    return call(pool, "priceSource()", [], [], ["address"], key)


def block_timestamp(key: Any = None) -> Call:
    return call(MULTICALL3, "getCurrentBlockTimestamp()", [], [], ["uint256"], key)


def block_number(key: Any = None) -> Call:
    return call(MULTICALL3, "getBlockNumber()", [], [], ["uint256"], key)


AGGREGATE3 = selector("aggregate3((address,bool,bytes)[])")


def encode_aggregate3(calls: Sequence[Call]) -> str:
    """Calldata (0x-hex) for ``Multicall3.aggregate3`` with allowFailure on every call."""
    body = encode(["(address,bool,bytes)[]"], [[(c.target, True, c.data) for c in calls]])
    return "0x" + (AGGREGATE3 + body).hex()


def decode_aggregate3(calls: Sequence[Call], result_hex: str) -> list[Any]:
    """Decode ``aggregate3`` return data; a failed or undecodable sub-call yields ``None``."""
    raw = bytes.fromhex(result_hex[2:] if result_hex.startswith("0x") else result_hex)
    (results,) = decode(["(bool,bytes)[]"], raw)
    if len(results) != len(calls):
        raise ValueError(f"multicall returned {len(results)} results for {len(calls)} calls")
    out: list[Any] = []
    for c, (ok, data) in zip(calls, results, strict=True):
        if not ok:
            out.append(None)
            continue
        try:
            vals = decode(list(c.out), data)
        except Exception:  # noqa: BLE001 - short/garbled return data counts as a failed read
            out.append(None)
            continue
        out.append(vals[0] if len(vals) == 1 else vals)
    return out


def aggregate(rpc: Any, calls: Sequence[Call], block: str = "latest") -> list[Any]:
    """Run ``calls`` as one ``eth_call`` to Multicall3 through ``rpc`` (anything with ``.call``)."""
    if not calls:
        return []
    res = rpc.call("eth_call", [{"to": MULTICALL3, "data": encode_aggregate3(calls)}, block])
    if not isinstance(res, str) or res in ("0x", ""):
        raise RuntimeError(f"Multicall3 returned no data (is it deployed at {MULTICALL3}?)")
    return decode_aggregate3(calls, res)
