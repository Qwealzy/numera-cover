// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ICoverPool} from "../src/interfaces/ICoverPool.sol";
import {BaseTest} from "./Base.t.sol";

/// @notice buyCover enforces every docs/how-it-works.md §5 check, in order, with a named error.
contract BuyCoverTest is BaseTest {
    // ================================================================ happy path (check 6)

    function test_buyCover_happyPath_emitsAndLocks() public {
        ICoverPool.Quote memory q = _quote();
        bytes memory sig = _sign(q, signerKey);
        uint256 poolBefore = usdc.balanceOf(address(pool));
        uint256 buyerBefore = usdc.balanceOf(buyer);

        vm.expectEmit(true, true, true, true, address(pool));
        emit ICoverPool.CoverPurchased(1, buyer, BTC, true, q.level, q.payout, q.premium, q.expiry);
        vm.prank(buyer);
        uint256 id = pool.buyCover(q, sig);

        assertEq(id, 1);
        assertEq(pool.coverCount(), 1);
        assertEq(pool.lockedAssets(), q.payout);
        assertEq(pool.lockedByPerp(BTC), q.payout);
        assertTrue(pool.nonceUsed(q.nonce));
        assertEq(usdc.balanceOf(address(pool)), poolBefore + q.premium, "premium pulled");
        assertEq(usdc.balanceOf(buyer), buyerBefore - q.premium);

        ICoverPool.Cover memory c = pool.getCover(id);
        assertEq(c.buyer, buyer);
        assertEq(c.perpIndex, BTC);
        assertTrue(c.isLong);
        assertEq(c.level, q.level);
        assertEq(c.payout, q.payout);
        assertEq(c.premium, q.premium);
        assertEq(c.start, block.timestamp);
        assertEq(c.expiry, q.expiry);
        assertEq(uint8(c.status), uint8(ICoverPool.Status.Active));
    }

    function test_buyCover_shortHappyPath() public {
        _setPosition(buyer, ETH, -10e4, 30_000e6, 10); // 10 ETH short, cap 3,000
        ICoverPool.Quote memory q = _quote();
        q.perpIndex = ETH;
        q.isLong = false;
        q.level = 3_200e6;
        q.spotRef = ETH_PX;
        uint256 id = _buy(q);
        assertFalse(pool.getCover(id).isLong);
    }

    // ================================================================ check 1: signature, buyer, deadline, nonce

    function test_revert_check1_InvalidSignature_wrongKey() public {
        ICoverPool.Quote memory q = _quote();
        bytes memory sig = _sign(q, 0xBAD);
        vm.prank(buyer);
        vm.expectRevert(ICoverPool.InvalidSignature.selector);
        pool.buyCover(q, sig);
    }

    function test_revert_check1_InvalidSignature_tamperedField() public {
        ICoverPool.Quote memory q = _quote();
        bytes memory sig = _sign(q, signerKey);
        q.payout += 1; // buyer edits the signed quote
        vm.prank(buyer);
        vm.expectRevert(ICoverPool.InvalidSignature.selector);
        pool.buyCover(q, sig);
    }

    function test_revert_check1_InvalidSignature_malformed() public {
        ICoverPool.Quote memory q = _quote();
        vm.prank(buyer);
        vm.expectRevert(ICoverPool.InvalidSignature.selector);
        pool.buyCover(q, hex"1234");
    }

    function test_revert_check1_InvalidSignature_afterSignerRotation() public {
        ICoverPool.Quote memory q = _quote();
        bytes memory sig = _sign(q, signerKey);
        vm.prank(owner);
        pool.setQuoteSigner(vm.addr(0xB0B));
        vm.prank(buyer);
        vm.expectRevert(ICoverPool.InvalidSignature.selector);
        pool.buyCover(q, sig);
    }

    function test_revert_check1_BuyerMismatch() public {
        ICoverPool.Quote memory q = _quote();
        bytes memory sig = _sign(q, signerKey);
        address thief = makeAddr("thief");
        vm.prank(thief);
        vm.expectRevert(abi.encodeWithSelector(ICoverPool.BuyerMismatch.selector, buyer, thief));
        pool.buyCover(q, sig);
    }

    function test_revert_check1_QuoteDeadlinePassed() public {
        ICoverPool.Quote memory q = _quote();
        vm.warp(q.deadline + 1);
        _expectBuyRevert(
            q, abi.encodeWithSelector(ICoverPool.QuoteDeadlinePassed.selector, q.deadline, block.timestamp)
        );
    }

    function test_buyCover_atDeadline_ok() public {
        ICoverPool.Quote memory q = _quote();
        vm.warp(q.deadline);
        _buy(q);
    }

    function test_revert_check1_NonceAlreadyUsed() public {
        ICoverPool.Quote memory q = _quote();
        _buy(q);
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.NonceAlreadyUsed.selector, q.nonce));
    }

    // ================================================================ check 2: expiry window, min payout

    function test_revert_check2_ExpiryNotInFuture() public {
        ICoverPool.Quote memory q = _quote();
        q.expiry = uint64(block.timestamp);
        _expectBuyRevert(
            q, abi.encodeWithSelector(ICoverPool.ExpiryNotInFuture.selector, q.expiry, block.timestamp)
        );
    }

    function test_revert_check2_DurationTooLong() public {
        ICoverPool.Quote memory q = _quote();
        q.expiry = uint64(block.timestamp + 7 days + 1);
        _expectBuyRevert(
            q, abi.encodeWithSelector(ICoverPool.DurationTooLong.selector, q.expiry, block.timestamp + 7 days)
        );
    }

    function test_buyCover_atMaxDuration_ok() public {
        ICoverPool.Quote memory q = _quote();
        q.expiry = uint64(block.timestamp + 7 days);
        _buy(q);
    }

    function test_revert_check2_PayoutTooSmall() public {
        ICoverPool.Quote memory q = _quote();
        q.payout = 1e6 - 1;
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.PayoutTooSmall.selector, q.payout, 1e6));
    }

    // ================================================================ check 3: spot deviation, already breached

    function test_revert_check3_SpotDeviationTooHigh_above() public {
        _setPrice(BTC, 84_841e6); // +1.0012 % vs spotRef 84,000
        ICoverPool.Quote memory q = _quote();
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.SpotDeviationTooHigh.selector, 84_841e6, BTC_PX));
    }

    function test_revert_check3_SpotDeviationTooHigh_below() public {
        _setPrice(BTC, 83_159e6); // -1.0012 %
        ICoverPool.Quote memory q = _quote();
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.SpotDeviationTooHigh.selector, 83_159e6, BTC_PX));
    }

    function test_buyCover_spotDeviationAtLimit_ok() public {
        _setPrice(BTC, 84_840e6); // exactly +1 %
        _buy(_quote());
    }

    function test_revert_check3_LevelAlreadyBreached_long() public {
        ICoverPool.Quote memory q = _quote();
        q.level = BTC_PX; // long breaches at px <= level, equality counts
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.LevelAlreadyBreached.selector, BTC_PX, q.level));
    }

    function test_revert_check3_LevelAlreadyBreached_short() public {
        _setPosition(buyer, BTC, -1e5, 84_000e6, 20);
        ICoverPool.Quote memory q = _quote();
        q.isLong = false;
        q.level = BTC_PX - 1; // short breaches at px >= level
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.LevelAlreadyBreached.selector, BTC_PX, q.level));
    }

    // ================================================================ check 4: insurable interest

    function test_revert_check4_NoPosition() public {
        _setPosition(buyer, BTC, 0, 0, 0);
        _expectBuyRevert(_quote(), abi.encodeWithSelector(ICoverPool.NoPosition.selector, buyer, BTC));
    }

    function test_revert_check4_PositionSideMismatch_shortHolderBuysLong() public {
        _setPosition(buyer, BTC, -1e5, 84_000e6, 20);
        _expectBuyRevert(_quote(), abi.encodeWithSelector(ICoverPool.PositionSideMismatch.selector, int64(-1e5), true));
    }

    function test_revert_check4_PositionSideMismatch_longHolderBuysShort() public {
        ICoverPool.Quote memory q = _quote();
        q.isLong = false;
        q.level = 88_000e6;
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.PositionSideMismatch.selector, int64(1e5), false));
    }

    function test_revert_check4_PayoutExceedsMarginCap() public {
        ICoverPool.Quote memory q = _quote();
        q.payout = 4_200e6 + 1; // cap = 84,000 / 20
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.PayoutExceedsMarginCap.selector, q.payout, 4_200e6));
    }

    function test_buyCover_payoutAtMarginCap_ok() public {
        ICoverPool.Quote memory q = _quote();
        q.payout = 4_200e6;
        _buy(q);
    }

    function test_revert_check4_zeroLeverageMeansZeroCap() public {
        _setPosition(buyer, BTC, 1e5, 84_000e6, 0);
        ICoverPool.Quote memory q = _quote();
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.PayoutExceedsMarginCap.selector, q.payout, 0));
    }

    // ================================================================ check 5: capacity

    function _bigPositions() internal {
        _setPosition(buyer, BTC, 1e5, 10_000_000e6, 10); // cap 1,000,000
        _setPosition(buyer, ETH, 1e4, 10_000_000e6, 10);
        _setPosition(buyer, SOL, 1e2, 10_000_000e6, 10);
    }

    function _quoteOn(uint32 perp, uint64 px, uint256 payout) internal returns (ICoverPool.Quote memory q) {
        q = _quote();
        q.perpIndex = perp;
        q.spotRef = px;
        q.level = px / 2;
        q.payout = payout;
        q.premium = 0;
    }

    function test_revert_check5_UtilizationExceeded() public {
        _bigPositions();
        _buy(_quoteOn(BTC, BTC_PX, 45_000e6));
        _buy(_quoteOn(ETH, ETH_PX, 30_000e6)); // locked 75k of max 80k
        ICoverPool.Quote memory q = _quoteOn(SOL, SOL_PX, 5_001e6); // SOL alone is far below its 50k cap
        _expectBuyRevert(
            q, abi.encodeWithSelector(ICoverPool.UtilizationExceeded.selector, 80_001e6, 80_000e6)
        );
        _buy(_quoteOn(SOL, SOL_PX, 5_000e6)); // exactly at the limit is fine
    }

    function test_revert_check5_PerPerpCapExceeded() public {
        _bigPositions();
        _buy(_quoteOn(BTC, BTC_PX, 45_000e6));
        ICoverPool.Quote memory q = _quoteOn(BTC, BTC_PX, 5_001e6); // pool total 50k is well under 80k
        _expectBuyRevert(
            q, abi.encodeWithSelector(ICoverPool.PerPerpCapExceeded.selector, BTC, 50_001e6, 50_000e6)
        );
    }

    // ================================================================ ordering and pause

    /// @dev A quote that fails several checks reports the earliest one in §5 order.
    function test_checkOrder_signatureBeforeEverythingElse() public {
        _setPosition(buyer, BTC, 0, 0, 0);
        _setPrice(BTC, 1e6);
        ICoverPool.Quote memory q = _quote();
        q.payout = 1;
        bytes memory sig = _sign(q, 0xBAD);
        vm.warp(q.deadline + 1);
        vm.prank(makeAddr("other"));
        vm.expectRevert(ICoverPool.InvalidSignature.selector);
        pool.buyCover(q, sig);
    }

    function test_checkOrder_expiryBeforePrice_priceBeforePosition_positionBeforeCapacity() public {
        _setPosition(buyer, BTC, 0, 0, 0);
        _setPrice(BTC, 1e6); // deviates and breaches
        ICoverPool.Quote memory q = _quote();
        q.payout = 1_000_000e6; // exceeds capacity too
        q.expiry = uint64(block.timestamp + 8 days);
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.DurationTooLong.selector, q.expiry, block.timestamp + 7 days));

        q = _quote();
        q.payout = 1_000_000e6;
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.SpotDeviationTooHigh.selector, 1e6, BTC_PX));

        _setPrice(BTC, BTC_PX);
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.NoPosition.selector, buyer, BTC));
    }

    function test_revert_paused() public {
        vm.prank(owner);
        pool.setPaused(true);
        ICoverPool.Quote memory q = _quote();
        _expectBuyRevert(q, abi.encodeWithSelector(Pausable.EnforcedPause.selector));
        vm.prank(owner);
        pool.setPaused(false);
        _buy(q);
    }

    function test_revert_premiumNotApproved() public {
        vm.prank(buyer);
        usdc.approve(address(pool), 0);
        ICoverPool.Quote memory q = _quote();
        bytes memory sig = _sign(q, signerKey);
        vm.prank(buyer);
        vm.expectRevert(); // ERC20InsufficientAllowance from the token
        pool.buyCover(q, sig);
        assertEq(pool.lockedAssets(), 0);
        assertFalse(pool.nonceUsed(q.nonce));
    }
}
