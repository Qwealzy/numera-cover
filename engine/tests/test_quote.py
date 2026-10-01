"""EIP-712 Quote signing (ARCHITECTURE §4) and the shared test vector for the contracts worker (F7)."""

import json
from pathlib import Path

import pytest
from eth_account import Account
from eth_account.messages import encode_typed_data

from numera_engine.quote import (
    QUOTE_TYPE_STRING,
    ChainNotAllowedError,
    Quote,
    digest,
    domain_separator,
    recover_signer,
    sign_quote,
    struct_hash,
    type_hash,
    typed_data,
)

VECTOR_PATH = Path(__file__).parent / "vectors" / "quote_vector.json"
ANVIL_KEY0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"  # public anvil test key
ANVIL_ADDR0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
CHAIN_ID = 31337
POOL = "0x5FbDB2315678afecb367f032d93F642f64180aa3"

VECTOR_QUOTE = Quote(
    buyer="0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    perpIndex=3,
    isLong=True,
    level=80000000000,
    payout=100000000,
    premium=2500000,
    expiry=1790900000,
    spotRef=84000000000,
    deadline=1790890000,
    nonce=1,
)


def compute_vector() -> dict:
    return {
        "domain": {"name": "Numera", "version": "1", "chainId": CHAIN_ID, "verifyingContract": POOL},
        "quote": VECTOR_QUOTE.to_dict(),
        "signer": ANVIL_ADDR0,
        "typeString": QUOTE_TYPE_STRING,
        "typeHash": "0x" + type_hash().hex(),
        "structHash": "0x" + struct_hash(VECTOR_QUOTE).hex(),
        "domainSeparator": "0x" + domain_separator(CHAIN_ID, POOL).hex(),
        "digest": "0x" + digest(VECTOR_QUOTE, CHAIN_ID, POOL).hex(),
        "signature": sign_quote(VECTOR_QUOTE, CHAIN_ID, POOL, ANVIL_KEY0),
    }


def test_type_string_is_the_frozen_one():
    assert QUOTE_TYPE_STRING == (
        "Quote(address buyer,uint32 perpIndex,bool isLong,uint64 level,uint256 payout,uint256 premium,"
        "uint64 expiry,uint64 spotRef,uint64 deadline,uint256 nonce)"
    )


def test_manual_hashes_match_eth_account():
    msg = encode_typed_data(full_message=typed_data(VECTOR_QUOTE, CHAIN_ID, POOL))
    assert bytes(msg.header) == domain_separator(CHAIN_ID, POOL)
    assert bytes(msg.body) == struct_hash(VECTOR_QUOTE)


def test_vector_signature_recovers_anvil0():
    sig = sign_quote(VECTOR_QUOTE, CHAIN_ID, POOL, ANVIL_KEY0)
    assert len(bytes.fromhex(sig[2:])) == 65
    assert recover_signer(VECTOR_QUOTE, CHAIN_ID, POOL, sig) == ANVIL_ADDR0
    # also via the raw digest, as ecrecover in Solidity sees it
    assert Account._recover_hash(digest(VECTOR_QUOTE, CHAIN_ID, POOL), signature=bytes.fromhex(sig[2:])) == (
        ANVIL_ADDR0
    )


def test_vector_file_matches_code():
    """tests/vectors/quote_vector.json is the shared artefact; regenerate with
    `python -c "import json,tests.test_quote as t; print(json.dumps(t.compute_vector(), indent=1))"`."""
    assert json.loads(VECTOR_PATH.read_text()) == compute_vector()


def test_signature_is_deterministic_and_v_is_27_or_28():
    a = sign_quote(VECTOR_QUOTE, CHAIN_ID, POOL, ANVIL_KEY0)
    b = sign_quote(VECTOR_QUOTE, CHAIN_ID, POOL, ANVIL_KEY0)
    assert a == b  # RFC 6979
    assert bytes.fromhex(a[2:])[64] in (27, 28)


def test_any_field_change_changes_digest():
    base = digest(VECTOR_QUOTE, CHAIN_ID, POOL)
    d = VECTOR_QUOTE.to_dict()
    for name, val in d.items():
        if name == "buyer":
            new = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
        elif name == "isLong":
            new = not val
        else:
            new = val + 1
        assert digest(Quote(**{**d, name: new}), CHAIN_ID, POOL) != base, name
    assert digest(VECTOR_QUOTE, 998, POOL) != base
    assert digest(VECTOR_QUOTE, CHAIN_ID, "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512") != base


def test_refuses_mainnet_chain():
    with pytest.raises(ChainNotAllowedError):
        sign_quote(VECTOR_QUOTE, 999, POOL, ANVIL_KEY0)


@pytest.mark.parametrize(
    "field,value",
    [
        ("perpIndex", 2**32),
        ("level", 2**64),
        ("expiry", -1),
        ("nonce", 2**256),
        ("payout", 1.5),
        ("level", True),
    ],
)
def test_quote_field_ranges(field, value):
    with pytest.raises(ValueError):
        Quote(**{**VECTOR_QUOTE.to_dict(), field: value})


def test_buyer_is_checksummed():
    q = Quote(**{**VECTOR_QUOTE.to_dict(), "buyer": VECTOR_QUOTE.buyer.lower()})
    assert q.buyer == "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
