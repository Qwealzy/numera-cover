"""Keeper pure logic: decisions, getCover decoding, active-set bookkeeping, resend guard."""

from numera_engine.keeper import Action, Cover, PoolBook, Status, cover_from_tuple, decide, due, is_breached

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


def test_cover_from_get_cover_tuple():
    t = ("0xB", 3, False, 5, 9, 1, T0 - 10, T0, 3)
    assert cover_from_tuple(7, t) == Cover(7, "0xB", 3, False, 5, 9, T0, Status.EXPIRED)
    assert cover_from_tuple(7, None) is None
    assert cover_from_tuple(7, ("0xB", 3, False, 5, 9, 1, 0, T0, 9)) is None  # unknown enum value


def test_book_reads_active_ids_plus_lookahead():
    b = PoolBook("0xp", "p")
    assert b.ids_to_read(2) == [1, 2]
    b.known, b.active = 5, {2: cover(2), 4: cover(4)}
    assert b.ids_to_read(2) == [2, 4, 6, 7]


def test_book_discovers_and_drops_final_covers():
    b = PoolBook("0xp", "p")
    assert b.apply(2, {1: cover(1), 2: cover(2, status=Status.PAID)}) == []
    assert (b.known, b.count, sorted(b.active)) == (2, 2, [1])
    # cover 1 expires; 3 is new; 4 not bought yet (getCover returns the zero struct -> status None)
    assert (
        b.apply(3, {1: cover(1, status=Status.EXPIRED), 3: cover(3), 4: cover(4, status=Status.NONE)}) == []
    )
    assert (b.known, sorted(b.active)) == (3, [3])
    assert b.ids_to_read(2) == [3, 4, 5]


def test_book_backfill_and_failed_reads():
    b = PoolBook("0xp", "p")
    # 7 covers exist but only the lookahead (1, 2) was read: 3..7 need a backfill
    assert b.apply(7, {1: cover(1), 2: cover(2)}) == [3, 4, 5, 6, 7]
    # a failed read keeps the id unread (known stops before it) and keeps an active cover's last state
    assert b.apply(None, {3: cover(3), 4: None, 5: cover(5), 1: None}) == [4, 5, 6, 7]
    assert b.count == 7 and sorted(b.active) == [1, 2, 3, 5]
    assert b.apply(7, {4: cover(4), 5: cover(5), 6: cover(6), 7: cover(7)}) == []
    assert b.known == 7 and len(b.active) == 7
    assert b.apply(3, {}) == [] and b.count == 7  # count never goes backwards


def test_due_skips_recent_sends_and_retries_stale_ones():
    acts = [Action("trigger", 1, ""), Action("trigger", 2, ""), Action("expire", 3, "")]
    assert due(acts, {}, 100.0) == acts
    assert [a.cover_id for a in due(acts, {1: 90.0, 2: 60.0}, 100.0, resend_after=30)] == [2, 3]
