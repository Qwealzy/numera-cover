// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ICoverPool} from "../src/interfaces/ICoverPool.sol";
import {BaseTest} from "./Base.t.sol";
import {BlocklistUSDC} from "./utils/BlocklistUSDC.sol";

/// @notice trigger pays exactly once on breach before expiry (or defers to claimPayout when the token refuses);
///         expire releases after expiry; both release the unearned premium; the payout breaker pauses sales.
contract TriggerExpireTest is BaseTest {
    address internal keeper = makeAddr("keeper");

    function _longCover() internal returns (uint256 id, ICoverPool.Quote memory q) {
        q = _quote(); // long BTC, level 80,000
        id = _buy(q);
    }

    function _shortCover() internal returns (uint256 id, ICoverPool.Quote memory q) {
        _setPosition(buyer, ETH, -10e4, 30_000e6, 10);
        q = _quote();
        q.perpIndex = ETH;
        q.isLong = false;
        q.level = 3_200e6;
        q.spotRef = ETH_PX;
        q.payout = 2_000e6;
        id = _buy(q);
    }

    // ================================================================ long

    function test_trigger_long_paysBuyerOnBreach() public {
        (uint256 id, ICoverPool.Quote memory q) = _longCover();
        _setPrice(BTC, 79_999e6);
        uint256 buyerBefore = usdc.balanceOf(buyer);
        uint256 poolBefore = usdc.balanceOf(address(pool));

        vm.expectEmit(true, false, false, true, address(pool));
        emit ICoverPool.CoverTriggered(id, 79_999e6, keeper);
        vm.prank(keeper); // permissionless: anyone may trigger, buyer gets paid
        pool.trigger(id);

        assertEq(usdc.balanceOf(buyer), buyerBefore + q.payout);
        assertEq(usdc.balanceOf(address(pool)), poolBefore - q.payout);
        assertEq(usdc.balanceOf(keeper), 0);
        assertEq(pool.lockedAssets(), 0);
        assertEq(pool.lockedByPerp(BTC), 0);
        assertEq(pool.unearnedPremium(), 0, "premium earned on settlement");
        assertEq(pool.owed(buyer), 0, "credit reversed after a successful transfer");
        assertEq(pool.owedAssets(), 0);
        assertEq(pool.totalAssets(), LP_DEPOSIT + q.premium - q.payout);
        assertEq(uint8(pool.getCover(id).status), uint8(ICoverPool.Status.Paid));
    }

    function test_trigger_long_atExactLevel() public {
        (uint256 id, ICoverPool.Quote memory q) = _longCover();
        _setPrice(BTC, q.level);
        pool.trigger(id);
        assertEq(uint8(pool.getCover(id).status), uint8(ICoverPool.Status.Paid));
    }

    function test_revert_trigger_long_notBreached() public {
        (uint256 id, ICoverPool.Quote memory q) = _longCover();
        _setPrice(BTC, q.level + 1);
        vm.expectRevert(abi.encodeWithSelector(ICoverPool.LevelNotBreached.selector, q.level + 1, q.level));
        pool.trigger(id);
    }

    function test_revert_trigger_long_priceAboveSpotDoesNotPay() public {
        (uint256 id, ICoverPool.Quote memory q) = _longCover();
        _setPrice(BTC, 200_000e6); // moving the wrong way never pays a long cover
        vm.expectRevert(abi.encodeWithSelector(ICoverPool.LevelNotBreached.selector, 200_000e6, q.level));
        pool.trigger(id);
    }

    // ================================================================ short

    function test_trigger_short_paysBuyerOnBreach() public {
        (uint256 id, ICoverPool.Quote memory q) = _shortCover();
        _setPrice(ETH, 3_250e6);
        uint256 buyerBefore = usdc.balanceOf(buyer);
        vm.expectEmit(true, false, false, true, address(pool));
        emit ICoverPool.CoverTriggered(id, 3_250e6, keeper);
        vm.prank(keeper);
        pool.trigger(id);
        assertEq(usdc.balanceOf(buyer), buyerBefore + q.payout);
        assertEq(pool.lockedAssets(), 0);
        assertEq(pool.lockedByPerp(ETH), 0);
    }

    function test_trigger_short_atExactLevel() public {
        (uint256 id, ICoverPool.Quote memory q) = _shortCover();
        _setPrice(ETH, q.level);
        pool.trigger(id);
        assertEq(uint8(pool.getCover(id).status), uint8(ICoverPool.Status.Paid));
    }

    function test_revert_trigger_short_notBreached() public {
        (uint256 id, ICoverPool.Quote memory q) = _shortCover();
        _setPrice(ETH, q.level - 1);
        vm.expectRevert(abi.encodeWithSelector(ICoverPool.LevelNotBreached.selector, q.level - 1, q.level));
        pool.trigger(id);
    }

    // ================================================================ exactly once, expiry boundary

    function test_revert_trigger_double() public {
        (uint256 id,) = _longCover();
        _setPrice(BTC, 70_000e6);
        pool.trigger(id);
        vm.expectRevert(abi.encodeWithSelector(ICoverPool.CoverNotActive.selector, id));
        pool.trigger(id);
    }

    function test_trigger_atExpiry_ok() public {
        (uint256 id, ICoverPool.Quote memory q) = _longCover();
        vm.warp(q.expiry);
        _setPrice(BTC, 70_000e6);
        pool.trigger(id);
    }

    function test_revert_trigger_afterExpiry() public {
        (uint256 id, ICoverPool.Quote memory q) = _longCover();
        vm.warp(q.expiry + 1);
        _setPrice(BTC, 70_000e6);
        vm.expectRevert(abi.encodeWithSelector(ICoverPool.CoverPastExpiry.selector, id, q.expiry));
        pool.trigger(id);
    }

    function test_revert_trigger_unknownCover() public {
        vm.expectRevert(abi.encodeWithSelector(ICoverPool.CoverNotActive.selector, 42));
        pool.trigger(42);
    }

    function test_trigger_worksWhilePaused() public {
        (uint256 id,) = _longCover();
        _pause();
        _setPrice(BTC, 70_000e6);
        pool.trigger(id);
    }

    // ================================================================ deferred payout (pull payment)

    function test_trigger_blocklistedBuyer_defersAndNeverReverts() public {
        (uint256 id, ICoverPool.Quote memory q) = _longCover();
        usdc.setBlocked(buyer, true);
        _setPrice(BTC, 70_000e6);
        uint256 poolBefore = usdc.balanceOf(address(pool));
        uint256 assetsBefore = pool.totalAssets();

        vm.expectEmit(address(pool));
        emit ICoverPool.CoverTriggered(id, 70_000e6, keeper);
        vm.expectEmit(address(pool));
        emit ICoverPool.PayoutDeferred(id, buyer, q.payout);
        vm.prank(keeper);
        pool.trigger(id);

        assertEq(uint8(pool.getCover(id).status), uint8(ICoverPool.Status.Paid), "Paid even when deferred");
        assertEq(usdc.balanceOf(address(pool)), poolBefore, "nothing left the pool");
        assertEq(pool.owed(buyer), q.payout);
        assertEq(pool.owedAssets(), q.payout);
        assertEq(pool.totalAssets(), assetsBefore + q.premium - q.payout, "owed payout is not pool money");

        // claim fails while still blocked and leaves the balance owed
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(BlocklistUSDC.Blocked.selector, buyer));
        pool.claimPayout();
        assertEq(pool.owed(buyer), q.payout);

        usdc.setBlocked(buyer, false);
        _pause(); // claims work while paused
        uint256 buyerBefore = usdc.balanceOf(buyer);
        vm.expectEmit(address(pool));
        emit ICoverPool.PayoutClaimed(buyer, q.payout);
        vm.prank(buyer);
        pool.claimPayout();
        assertEq(usdc.balanceOf(buyer), buyerBefore + q.payout);
        assertEq(pool.owed(buyer), 0);
        assertEq(pool.owedAssets(), 0);
    }

    function test_trigger_tokenReturnsFalse_defers() public {
        (uint256 id, ICoverPool.Quote memory q) = _longCover();
        usdc.setSilent(buyer, true);
        _setPrice(BTC, 70_000e6);
        vm.expectEmit(address(pool));
        emit ICoverPool.PayoutDeferred(id, buyer, q.payout);
        pool.trigger(id);
        assertEq(pool.owed(buyer), q.payout);
    }

    function test_revert_claimPayout_nothingOwed() public {
        vm.prank(buyer);
        vm.expectRevert(ICoverPool.NothingOwed.selector);
        pool.claimPayout();
    }

    /// @dev No redirect: only the buyer's own call pays, and only to the buyer.
    function test_claimPayout_onlyOwnBalance() public {
        (uint256 id,) = _longCover();
        usdc.setBlocked(buyer, true);
        _setPrice(BTC, 70_000e6);
        pool.trigger(id);
        vm.prank(keeper);
        vm.expectRevert(ICoverPool.NothingOwed.selector);
        pool.claimPayout();
    }

    /// @dev LP claims cannot take owed USDC: freeAssets excludes it.
    function test_owedPayout_notClaimableByLps() public {
        (uint256 id, ICoverPool.Quote memory q) = _longCover();
        usdc.setBlocked(buyer, true);
        _setPrice(BTC, 70_000e6);
        pool.trigger(id);
        _requestAllAndMature(lp);
        uint256 free = pool.freeAssets();
        assertEq(free, LP_DEPOSIT + q.premium - q.payout);
        vm.prank(lp);
        pool.withdraw(free, lp, lp);
        assertEq(usdc.balanceOf(address(pool)), q.payout, "only the owed payout remains");
        usdc.setBlocked(buyer, false);
        vm.prank(buyer);
        pool.claimPayout();
        assertEq(usdc.balanceOf(address(pool)), 0);
    }

    // ================================================================ payout breaker

    /// @dev Testnet: maxPaidPerWindowBps 15 % of B at the breaker window's start (100k) = 15,000.
    function test_breaker_tripsAbovePaidCap_pausesNeverReverts() public {
        address[] memory bs = new address[](3);
        uint256[] memory ids = new uint256[](3);
        for (uint256 i; i < 3; ++i) {
            bs[i] = makeAddr(string.concat("b", vm.toString(i)));
            _bigPosition(bs[i], BTC);
            _fund(bs[i]);
            ICoverPool.Quote memory q = _quote();
            q.buyer = bs[i];
            q.payout = i < 2 ? 6_250e6 : 2_500e6 + 1; // 6,250 + 6,250 + 2,500.000001 = 15,000.000001
            q.premium = 100e6;
            ids[i] = _buy(q);
        }
        _setPrice(BTC, 70_000e6);
        uint256 b = pool.capacityBase();
        pool.trigger(ids[0]);
        assertEq(pool.paidWindowStart(), vm.getBlockTimestamp());
        assertEq(pool.paidWindowAssets(), b, "B as read before the trigger's own accounting");
        pool.trigger(ids[1]);
        assertFalse(pool.paused());
        assertEq(pool.paidInWindow(), 12_500e6);

        uint256 cap = b * 1_500 / 10_000;
        vm.expectEmit(address(pool));
        emit Pausable.Paused(address(this));
        vm.expectEmit(address(pool));
        emit ICoverPool.LossBreakerTripped(15_000e6 + 1, cap);
        pool.trigger(ids[2]); // does not revert
        assertTrue(pool.paused());
        assertEq(uint8(pool.getCover(ids[2]).status), uint8(ICoverPool.Status.Paid));
        assertEq(usdc.balanceOf(bs[2]), 1_000_000e6 - 100e6 + 2_500e6 + 1, "still paid");

        // sales and deposits are now blocked until the owner unpauses
        _expectBuyRevert(_quote(), abi.encodeWithSelector(Pausable.EnforcedPause.selector));
        _unpause();
        _setPrice(BTC, BTC_PX);
        _buy(_quote());
    }

    /// @dev Three buyers whose payouts sum to `total`; returns the cover ids (all BTC long, level 80k).
    function _threeCovers(uint256 total) internal returns (uint256[] memory ids) {
        ids = new uint256[](3);
        for (uint256 i; i < 3; ++i) {
            address b = makeAddr(string.concat("c", vm.toString(i)));
            _bigPosition(b, BTC);
            _fund(b);
            ICoverPool.Quote memory q = _quote();
            q.buyer = b;
            q.payout = i < 2 ? 6_250e6 : total - 12_500e6;
            q.premium = 100e6;
            ids[i] = _buy(q);
        }
    }

    /// @dev Boundary: paidInWindow == cap (15,000 on 100k) does not trip; cap + 1 does (previous test).
    function test_breaker_exactlyAtCapDoesNotTrip() public {
        uint256[] memory ids = _threeCovers(15_000e6);
        _setPrice(BTC, 70_000e6);
        for (uint256 i; i < 3; ++i) {
            pool.trigger(ids[i]);
        }
        assertEq(pool.paidInWindow(), 15_000e6);
        assertEq(pool.paidWindowAssets() * 1_500 / 10_000, 15_000e6, "cap");
        assertFalse(pool.paused(), "15,000 == cap does not trip");
    }

    /// @dev L-2: an owner unpause resets the breaker window, so the next payout opens a fresh one instead of
    ///      re-tripping on the payouts that tripped it.
    function test_breaker_unpauseResetsWindow() public {
        uint256[] memory ids = _threeCovers(15_000e6 + 1);
        (uint256 later,) = _longCover(); // 1,000 more, triggered after the unpause
        _setPrice(BTC, 70_000e6);
        for (uint256 i; i < 3; ++i) {
            pool.trigger(ids[i]);
        }
        assertTrue(pool.paused(), "tripped");
        _unpause();
        assertEq(pool.paidWindowStart(), 0);
        assertEq(pool.paidInWindow(), 0);

        uint256 b = pool.capacityBase();
        pool.trigger(later); // same second as the trip: without the reset 16,000 > 15,000 would re-trip
        assertFalse(pool.paused(), "fresh window");
        assertEq(pool.paidWindowStart(), vm.getBlockTimestamp());
        assertEq(pool.paidWindowAssets(), b);
        assertEq(pool.paidInWindow(), 1_000e6);
    }

    /// @dev A pause (not an unpause) leaves the breaker window alone.
    function test_breaker_pauseDoesNotReset() public {
        (uint256 id,) = _longCover();
        _setPrice(BTC, 70_000e6);
        pool.trigger(id);
        uint64 start = pool.paidWindowStart();
        _pause();
        assertEq(pool.paidWindowStart(), start);
        assertEq(pool.paidInWindow(), 1_000e6);
    }

    function test_breaker_alreadyPaused_noEvent() public {
        (uint256 id,) = _longCover();
        ICoverPool.Limits memory l = pool.limits();
        l.maxPaidPerWindowBps = 1; // 0.01 % of 100k = 10 USDC
        _setLimits(l);
        _pause();
        _setPrice(BTC, 70_000e6);
        vm.recordLogs();
        pool.trigger(id);
        assertTrue(pool.paused());
        // CoverTriggered + the token's Transfer only: no Paused, no LossBreakerTripped
        assertEq(vm.getRecordedLogs().length, 2);
    }

    function test_breaker_windowResets() public {
        ICoverPool.Limits memory l = pool.limits();
        l.maxPaidPerWindowBps = 150; // 1.5 % of 100k = 1,500
        _setLimits(l);
        (uint256 id1,) = _longCover(); // 1,000
        (uint256 id2,) = _longCover(); // 1,000
        _setPrice(BTC, 70_000e6);
        pool.trigger(id1);
        uint64 start = pool.paidWindowStart();
        vm.warp(start + 3_600); // next breaker window
        pool.trigger(id2);
        assertEq(pool.paidWindowStart(), vm.getBlockTimestamp());
        assertEq(pool.paidInWindow(), 1_000e6, "reset, not 2,000");
        assertFalse(pool.paused());
    }

    function test_breaker_deferredPayoutCounts() public {
        ICoverPool.Limits memory l = pool.limits();
        l.maxPaidPerWindowBps = 50; // 500 USDC on 100k
        _setLimits(l);
        (uint256 id,) = _longCover(); // 1,000
        usdc.setBlocked(buyer, true);
        _setPrice(BTC, 70_000e6);
        pool.trigger(id);
        assertTrue(pool.paused(), "a deferred payout counts as paid");
    }

    // ================================================================ expire

    function test_expire_afterExpiry_releasesLockAndPremium() public {
        (uint256 id, ICoverPool.Quote memory q) = _longCover();
        uint256 poolBalance = usdc.balanceOf(address(pool));
        uint256 assetsBefore = pool.totalAssets();
        vm.warp(q.expiry + 1);
        vm.expectEmit(true, false, false, true, address(pool));
        emit ICoverPool.CoverExpired(id);
        vm.prank(keeper);
        pool.expire(id);
        assertEq(pool.lockedAssets(), 0);
        assertEq(pool.lockedByPerp(BTC), 0);
        assertEq(pool.unearnedPremium(), 0);
        assertEq(pool.totalAssets(), assetsBefore + q.premium, "LPs earn the premium on settlement");
        assertEq(usdc.balanceOf(address(pool)), poolBalance, "no transfer on expiry");
        assertEq(uint8(pool.getCover(id).status), uint8(ICoverPool.Status.Expired));
    }

    function test_expire_short() public {
        (uint256 id, ICoverPool.Quote memory q) = _shortCover();
        vm.warp(q.expiry + 1);
        pool.expire(id);
        assertEq(pool.lockedByPerp(ETH), 0);
    }

    function test_revert_expire_beforeOrAtExpiry() public {
        (uint256 id, ICoverPool.Quote memory q) = _longCover();
        vm.warp(q.expiry);
        vm.expectRevert(abi.encodeWithSelector(ICoverPool.CoverNotYetExpired.selector, id, q.expiry));
        pool.expire(id);
    }

    function test_revert_expire_twice() public {
        (uint256 id, ICoverPool.Quote memory q) = _longCover();
        vm.warp(q.expiry + 1);
        pool.expire(id);
        vm.expectRevert(abi.encodeWithSelector(ICoverPool.CoverNotActive.selector, id));
        pool.expire(id);
    }

    function test_revert_expire_afterTrigger() public {
        (uint256 id, ICoverPool.Quote memory q) = _longCover();
        _setPrice(BTC, 70_000e6);
        pool.trigger(id);
        vm.warp(q.expiry + 1);
        vm.expectRevert(abi.encodeWithSelector(ICoverPool.CoverNotActive.selector, id));
        pool.expire(id);
    }

    function test_revert_trigger_afterExpire() public {
        (uint256 id, ICoverPool.Quote memory q) = _longCover();
        vm.warp(q.expiry + 1);
        pool.expire(id);
        _setPrice(BTC, 70_000e6);
        vm.expectRevert(abi.encodeWithSelector(ICoverPool.CoverNotActive.selector, id));
        pool.trigger(id);
    }

    function test_expire_worksWhilePaused() public {
        (uint256 id, ICoverPool.Quote memory q) = _longCover();
        _pause();
        vm.warp(q.expiry + 1);
        pool.expire(id);
    }

    function test_perPerpLocks_independent() public {
        (uint256 longId,) = _longCover();
        (uint256 shortId,) = _shortCover();
        assertEq(pool.lockedAssets(), 3_000e6);
        _setPrice(BTC, 70_000e6);
        pool.trigger(longId);
        assertEq(pool.lockedByPerp(BTC), 0);
        assertEq(pool.lockedByPerp(ETH), 2_000e6);
        assertEq(pool.lockedAssets(), 2_000e6);
        assertEq(uint8(pool.getCover(shortId).status), uint8(ICoverPool.Status.Active));
    }
}
