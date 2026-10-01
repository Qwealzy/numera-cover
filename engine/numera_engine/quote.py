"""EIP-712 Quote (ARCHITECTURE §4): build, hash, sign, recover.

The hashes are computed twice: by hand (typeHash / structHash / domainSeparator / digest, as Solidity
does) and by eth_account's ``encode_typed_data``; tests assert they agree, and the shared test vector in
tests/vectors/quote_vector.json is what the contracts worker must reproduce.
"""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass
from typing import Any

from eth_abi import encode as abi_encode
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import keccak, to_checksum_address

DOMAIN_NAME = "Numera"
DOMAIN_VERSION = "1"
MAINNET_CHAIN_ID = 999  # never signed for (CLAUDE.md, ARCHITECTURE §6)

QUOTE_TYPE_STRING = (
    "Quote(address buyer,uint32 perpIndex,bool isLong,uint64 level,uint256 payout,uint256 premium,"
    "uint64 expiry,uint64 spotRef,uint64 deadline,uint256 nonce)"
)
DOMAIN_TYPE_STRING = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"

QUOTE_FIELDS: list[dict[str, str]] = [
    {"name": "buyer", "type": "address"},
    {"name": "perpIndex", "type": "uint32"},
    {"name": "isLong", "type": "bool"},
    {"name": "level", "type": "uint64"},
    {"name": "payout", "type": "uint256"},
    {"name": "premium", "type": "uint256"},
    {"name": "expiry", "type": "uint64"},
    {"name": "spotRef", "type": "uint64"},
    {"name": "deadline", "type": "uint64"},
    {"name": "nonce", "type": "uint256"},
]
DOMAIN_FIELDS: list[dict[str, str]] = [
    {"name": "name", "type": "string"},
    {"name": "version", "type": "string"},
    {"name": "chainId", "type": "uint256"},
    {"name": "verifyingContract", "type": "address"},
]

_BITS = {"uint32": 32, "uint64": 64, "uint256": 256}


class ChainNotAllowedError(ValueError):
    pass


@dataclass(frozen=True)
class Quote:
    buyer: str
    perpIndex: int  # noqa: N815 - field names mirror the Solidity struct
    isLong: bool  # noqa: N815
    level: int
    payout: int
    premium: int
    expiry: int
    spotRef: int  # noqa: N815
    deadline: int
    nonce: int

    def __post_init__(self) -> None:
        object.__setattr__(self, "buyer", to_checksum_address(self.buyer))
        for f in QUOTE_FIELDS:
            t = f["type"]
            if t in _BITS:
                v = getattr(self, f["name"])
                if isinstance(v, bool) or not isinstance(v, int) or not 0 <= v < 2 ** _BITS[t]:
                    raise ValueError(f"{f['name']} out of range for {t}: {v!r}")
        if not isinstance(self.isLong, bool):
            raise ValueError("isLong must be bool")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _check_chain(chain_id: int) -> None:
    if chain_id == MAINNET_CHAIN_ID:
        raise ChainNotAllowedError("refusing to sign for chainId 999 (mainnet)")


def domain(chain_id: int, verifying_contract: str) -> dict[str, Any]:
    return {
        "name": DOMAIN_NAME,
        "version": DOMAIN_VERSION,
        "chainId": int(chain_id),
        "verifyingContract": to_checksum_address(verifying_contract),
    }


def typed_data(q: Quote, chain_id: int, verifying_contract: str) -> dict[str, Any]:
    return {
        "types": {"EIP712Domain": DOMAIN_FIELDS, "Quote": QUOTE_FIELDS},
        "primaryType": "Quote",
        "domain": domain(chain_id, verifying_contract),
        "message": q.to_dict(),
    }


# -- manual hashing (mirrors Solidity) -------------------------------------------------------------


def type_hash() -> bytes:
    return keccak(text=QUOTE_TYPE_STRING)


def struct_hash(q: Quote) -> bytes:
    types = ["bytes32"] + [f["type"] for f in QUOTE_FIELDS]
    values = [type_hash()] + [getattr(q, f["name"]) for f in QUOTE_FIELDS]
    return keccak(abi_encode(types, values))


def domain_separator(chain_id: int, verifying_contract: str) -> bytes:
    return keccak(
        abi_encode(
            ["bytes32", "bytes32", "bytes32", "uint256", "address"],
            [
                keccak(text=DOMAIN_TYPE_STRING),
                keccak(text=DOMAIN_NAME),
                keccak(text=DOMAIN_VERSION),
                int(chain_id),
                to_checksum_address(verifying_contract),
            ],
        )
    )


def digest(q: Quote, chain_id: int, verifying_contract: str) -> bytes:
    return keccak(b"\x19\x01" + domain_separator(chain_id, verifying_contract) + struct_hash(q))


# -- sign / recover --------------------------------------------------------------------------------


def sign_quote(q: Quote, chain_id: int, verifying_contract: str, private_key: str | bytes) -> str:
    """65-byte signature r||s||v (v in {27, 28}) as 0x-hex, accepted by OpenZeppelin ECDSA.recover."""
    _check_chain(chain_id)
    msg = encode_typed_data(full_message=typed_data(q, chain_id, verifying_contract))
    signed = Account.sign_message(msg, private_key=private_key)
    sig = bytes(signed.signature)
    if len(sig) != 65:
        raise RuntimeError("unexpected signature length")
    return "0x" + sig.hex()


def recover_signer(q: Quote, chain_id: int, verifying_contract: str, signature: str | bytes) -> str:
    msg = encode_typed_data(full_message=typed_data(q, chain_id, verifying_contract))
    return Account.recover_message(msg, signature=signature)


def signer_from_env(var: str = "QUOTE_SIGNER_KEY") -> tuple[str, str] | None:
    """(private_key, address) from the environment, or None if unset."""
    key = os.environ.get(var, "").strip()
    if not key:
        return None
    return key, Account.from_key(key).address
