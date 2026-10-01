"""Keeper decision logic (pure; the RPC wrapper is exercised on testnet separately)."""

import pytest

from numera_engine.keeper import Action, Cover, Status, apply_event, decide, is_breached

T0 = 1_790_000_000


def cover(cid, is_long=True, level=80_000_000_000, expiry=T0 + 3600, perp=3, payout=100_000_000,
          status=Status.ACTIVE):  # fmt: skip
    return Cover(cid, "0xBuyer", perp, is_long, level, payout, expiry, status)


def test_breach_semantics_match_architecture_section3():
    assert is_breached(True, 100, 100) and is_breached(True, 100, 99) and not is_breached(True, 100, 101)
    assert is_breached(False, 100, 100) and is_breached(False, 100, 101) and not is_breached(False, 100, 99)


def test_triggers_long_and_short_on_breach():
    covers = [cover(1, True, 80_000_000_000), cover(2, False, 90_000_000_000), cover(3, True, 70_000_000_000)]
    acts = decide(covers, {3: 80_000_000_000}, T0)
    assert [(a.kind, a.cover_id) for a in acts] == [("trigger", 1)]
    acts = decide(covers, {3: 90_000_000_001}, T0)
    assert [(a.kind, a.cover_id) for a in acts] == [("trigger", 2)]


def test_expiry_boundaries():
    c = cover(1, expiry=T0)
    assert decide([c], {3: 79_000_000_000}, T0) == [
        Action("trigger", 1, "oracle 79000000000 <= level 80000000000")
    ]
    acts = decide([c], {3: 79_000_000_000}, T0 + 1)  # after expiry: cannot trigger, only expire
    assert [(a.kind, a.cover_id) for a in acts] == [("expire", 1)]
    assert decide([c], {3: 85_000_000_000}, T0) == []


def test_missing_or_bad_price_never_triggers():
    c = cover(1)
    assert decide([c], {}, T0) == []
    assert decide([c], {3: None}, T0) == []
    assert decide([c], {3: 0}, T0) == []
    # but expiry does not need a price
    assert [a.kind for a in decide([c], {}, T0 + 3601)] == ["expire"]


def test_inactive_covers_are_ignored():
    covers = [cover(1, status=Status.PAID), cover(2, status=Status.EXPIRED)]
    assert decide(covers, {3: 1}, T0 + 10**6) == []


def test_triggers_ordered_by_payout_then_expires():
    covers = [cover(1, payout=10), cover(2, payout=30), cover(3, perp=4, expiry=T0 - 1), cover(4, payout=30)]
    acts = decide(covers, {3: 1, 4: 1}, T0)
    assert [(a.kind, a.cover_id) for a in acts] == [
        ("trigger", 2),
        ("trigger", 4),
        ("trigger", 1),
        ("expire", 3),
    ]


def test_event_folding():
    book = {}
    apply_event(book, "CoverPurchased", {"coverId": 7, "buyer": "0xB", "perpIndex": 3, "isLong": False,
                                         "level": 5, "payout": 9, "premium": 1, "expiry": T0})  # fmt: skip
    assert book[7] == Cover(7, "0xB", 3, False, 5, 9, T0, Status.ACTIVE)
    apply_event(book, "CoverTriggered", {"coverId": 7, "oraclePx": 6, "caller": "0xK"})
    assert book[7].status == Status.PAID
    apply_event(book, "CoverPurchased", {"coverId": 8, "buyer": "0xB", "perpIndex": 3, "isLong": True,
                                         "level": 5, "payout": 9, "premium": 1, "expiry": T0})  # fmt: skip
    apply_event(book, "CoverExpired", {"coverId": 8})
    assert book[8].status == Status.EXPIRED
    apply_event(book, "CoverExpired", {"coverId": 99})  # unknown id (bought before from_block): ignored
    with pytest.raises(ValueError):
        apply_event(book, "Other", {"coverId": 1})
