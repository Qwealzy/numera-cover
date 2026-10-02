// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ICoverPool} from "../src/interfaces/ICoverPool.sol";
import {IPriceSource} from "../src/interfaces/IPriceSource.sol";
import {MockPriceSource} from "../src/mocks/MockPriceSource.sol";
import {BaseTest} from "./Base.t.sol";
import {PoolConfig} from "./utils/PoolConfig.sol";

/// @notice buyCover enforces every ARCHITECTURE §5.3 check, in order, with a named error, then books the cover.
contract BuyCoverTest is BaseTest {
    // ================================================================ happy path (step 7 effects)

    function test_buyCover_happyPath_emitsAndLocks() public {
        ICoverPool.Quote memory q = _quote();
        bytes memory sig = _sign(q, signerKey);
        uint256 poolBefore = usdc.balanceOf(address(pool));
        uint256 buyerBefore = usdc.balanceOf(buyer);
        uint256 assetsBefore = pool.totalAssets();

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
        assertEq(pool.unearnedPremium(), q.premium, "premium is unearned while the cover is active");
        assertEq(pool.totalAssets(), assetsBefore, "unearned premium does not raise the share price");

        // window accounting: first sale opens the window with B snapshotted before the premium arrived
        assertEq(pool.windowStart(), vm.getBlockTimestamp());
        assertEq(pool.windowAssets(), assetsBefore);
        assertEq(pool.soldInWindow(), q.payout);
        (uint64 bStart, uint192 bSold) = pool.buyerWindow(buyer);
        assertEq(bStart, vm.getBlockTimestamp());
        assertEq(bSold, q.payout);

        ICoverPool.Cover memory c = pool.getCover(id);
        assertEq(c.buyer, buyer);
        assertEq(c.perpIndex, BTC);
        assertTrue(c.isLong);
        assertEq(c.level, q.level);
        assertEq(c.payout, q.payout);
        assertEq(c.premium, q.premium);
        assertEq(c.start, vm.getBlockTimestamp());
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

    function test_buyCover_readsPriceOnce() public {
        ICoverPool.Quote memory q = _quote();
        bytes memory sig = _sign(q, signerKey);
        vm.expectCall(address(prices), abi.encodeCall(IPriceSource.oraclePx6, (BTC)), 1);
        vm.prank(buyer);
        pool.buyCover(q, sig);
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
        _setQuoteSigner(vm.addr(0xB0B));
        q.deadline = uint64(vm.getBlockTimestamp() + 30);
        sig = _sign(q, signerKey);
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
            q, abi.encodeWithSelector(ICoverPool.QuoteDeadlinePassed.selector, q.deadline, vm.getBlockTimestamp())
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

    // ================================================================ check 2: allowlist, expiry, payout, premium floor

    function test_revert_check2_PerpNotAllowed() public {
        _setPosition(buyer, HYPE, 1e5, 84_000e6, 20);
        ICoverPool.Quote memory q = _quote();
        q.perpIndex = HYPE; // priced by the source but never allowlisted
        q.spotRef = HYPE_PX;
        q.level = 30e6;
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.PerpNotAllowed.selector, HYPE));
    }

    function test_revert_check2_PerpNotAllowed_afterDisallow_existingCoverStillSettles() public {
        uint256 id = _buy(_quote());
        _setPerpAllowed(BTC, false);
        ICoverPool.Quote memory q = _quote();
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.PerpNotAllowed.selector, BTC));
        _setPrice(BTC, 80_000e6);
        pool.trigger(id); // disallowing affects new sales only
        assertEq(uint8(pool.getCover(id).status), uint8(ICoverPool.Status.Paid));
    }

    function test_revert_check2_ExpiryNotInFuture() public {
        ICoverPool.Quote memory q = _quote();
        q.expiry = uint64(vm.getBlockTimestamp());
        _expectBuyRevert(
            q, abi.encodeWithSelector(ICoverPool.ExpiryNotInFuture.selector, q.expiry, vm.getBlockTimestamp())
        );
    }

    function test_revert_check2_DurationTooLong() public {
        ICoverPool.Quote memory q = _quote();
        q.expiry = uint64(vm.getBlockTimestamp() + 7 days + 1);
        _expectBuyRevert(
            q, abi.encodeWithSelector(ICoverPool.DurationTooLong.selector, q.expiry, vm.getBlockTimestamp() + 7 days)
        );
    }

    function test_buyCover_atMaxDuration_ok() public {
        ICoverPool.Quote memory q = _quote();
        q.expiry = uint64(vm.getBlockTimestamp() + 7 days);
        _buy(q);
    }

    function test_revert_check2_PayoutTooSmall() public {
        ICoverPool.Quote memory q = _quote();
        q.payout = 1e6 - 1;
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.PayoutTooSmall.selector, q.payout, 1e6));
    }

    function test_revert_check2_PremiumBelowFloor() public {
        ICoverPool.Quote memory q = _quote(); // payout 1,000 -> floor 20 bps = 2.000000
        q.premium = 2e6 - 1;
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.PremiumBelowFloor.selector, q.premium, 2e6));
    }

    function test_revert_check2_PremiumBelowFloor_zeroPremium() public {
        ICoverPool.Quote memory q = _quote();
        q.premium = 0;
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.PremiumBelowFloor.selector, 0, 2e6));
    }

    function test_revert_check2_PremiumBelowFloor_minPremiumRoundsUp() public {
        ICoverPool.Quote memory q = _quote();
        q.payout = 1_000_000_001; // x 20 / 10000 = 2,000,000.002 -> ceil 2,000,001
        q.premium = 2_000_000;
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.PremiumBelowFloor.selector, q.premium, 2_000_001));
        q.premium = 2_000_001;
        _buy(q);
    }

    function test_buyCover_premiumAtFloor_ok() public {
        ICoverPool.Quote memory q = _quote();
        q.premium = 2e6;
        _buy(q);
    }

    // ================================================================ check 3: spot deviation, breached, level distance

    function test_revert_check3_SpotDeviationTooHigh_above() public {
        _setPrice(BTC, 84_252e6 + 1); // just over +0.30 % vs spotRef 84,000
        ICoverPool.Quote memory q = _quote();
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.SpotDeviationTooHigh.selector, 84_252e6 + 1, BTC_PX));
    }

    function test_revert_check3_SpotDeviationTooHigh_below() public {
        _setPrice(BTC, 83_748e6 - 1); // just under -0.30 %
        ICoverPool.Quote memory q = _quote();
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.SpotDeviationTooHigh.selector, 83_748e6 - 1, BTC_PX));
    }

    function test_buyCover_spotDeviationAtLimit_ok() public {
        _setPrice(BTC, 84_252e6); // exactly +0.30 %
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

    /// @dev Floor 25 bps of 84,000 = 210: a long level must be <= 83,790.
    function test_revert_check3_LevelTooClose_long() public {
        ICoverPool.Quote memory q = _quote();
        q.level = 83_790e6 + 1;
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.LevelTooClose.selector, BTC_PX, q.level));
        q.level = 83_790e6;
        _buy(q);
    }

    function test_revert_check3_LevelTooClose_short() public {
        _setPosition(buyer, BTC, -1e5, 84_000e6, 20);
        ICoverPool.Quote memory q = _quote();
        q.isLong = false;
        q.level = 84_210e6 - 1;
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.LevelTooClose.selector, BTC_PX, q.level));
        q.level = 84_210e6;
        _buy(q);
    }

    /// @dev The level distance is measured from the live oracle price, not from the engine's spotRef.
    function test_revert_check3_LevelTooClose_usesOraclePrice() public {
        _setPrice(BTC, 83_800e6); // -0.238 % vs spotRef: inside the deviation band
        ICoverPool.Quote memory q = _quote();
        q.level = 83_600e6; // 238 bps from spotRef but only 23.9 bps from the oracle
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.LevelTooClose.selector, 83_800e6, q.level));
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

    // ================================================================ check 5: capacity on B

    function _bigPositions() internal {
        _bigPosition(buyer, BTC);
        _bigPosition(buyer, ETH);
        _bigPosition(buyer, SOL);
    }

    function _quoteOn(uint32 perp, uint64 px, uint256 payout) internal returns (ICoverPool.Quote memory q) {
        q = _quote();
        q.perpIndex = perp;
        q.spotRef = px;
        q.level = px / 2;
        q.payout = payout;
        q.premium = (payout * 20 + 9_999) / 10_000; // the on-chain floor
    }

    function test_revert_check5_UtilizationExceeded() public {
        _setLimits(PoolConfig.looseLimits());
        _bigPositions();
        _buy(_quoteOn(BTC, BTC_PX, 45_000e6));
        _buy(_quoteOn(ETH, ETH_PX, 30_000e6)); // locked 75k of max 80k
        ICoverPool.Quote memory q = _quoteOn(SOL, SOL_PX, 5_001e6); // SOL alone is far below its 50k cap
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.UtilizationExceeded.selector, 80_001e6, 80_000e6));
        _buy(_quoteOn(SOL, SOL_PX, 5_000e6)); // exactly at the limit is fine
    }

    function test_revert_check5_PerPerpCapExceeded() public {
        _setLimits(PoolConfig.looseLimits());
        _bigPositions();
        _buy(_quoteOn(BTC, BTC_PX, 45_000e6));
        ICoverPool.Quote memory q = _quoteOn(BTC, BTC_PX, 5_001e6); // pool total 50k is well under 80k
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.PerPerpCapExceeded.selector, BTC, 50_001e6, 50_000e6));
    }

    /// @dev Capital that asked to leave does not back new covers: B excludes escrowed shares.
    function test_check5_capacityBaseExcludesEscrowedShares() public {
        _setLimits(PoolConfig.looseLimits());
        _bigPositions();
        _request(lp, pool.balanceOf(lp) / 2);
        assertEq(pool.totalAssets(), LP_DEPOSIT, "escrowed shares still count in totalAssets");
        assertApproxEqAbs(pool.capacityBase(), LP_DEPOSIT / 2, 1);
        uint256 maxPerp = pool.capacityBase() * 5_000 / 10_000;
        ICoverPool.Quote memory q = _quoteOn(BTC, BTC_PX, maxPerp + 1);
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.PerPerpCapExceeded.selector, BTC, maxPerp + 1, maxPerp));
        _buy(_quoteOn(BTC, BTC_PX, maxPerp));
    }

    /// @dev Unearned premiums and owed payouts are not in B.
    function test_check5_capacityBaseExcludesUnearnedAndOwed() public {
        uint256 id = _buy(_quote());
        assertEq(pool.capacityBase(), LP_DEPOSIT);
        _setPrice(BTC, 80_000e6);
        usdc.setBlocked(buyer, true);
        pool.trigger(id); // deferred: owed 1,000
        assertEq(pool.owedAssets(), 1_000e6);
        assertEq(pool.capacityBase(), LP_DEPOSIT + 25e6 - 1_000e6);
    }

    // ================================================================ check 6: sale throttle

    address[] internal crowd;

    function _crowd(uint256 n) internal {
        for (uint256 i = crowd.length; i < n; ++i) {
            address a = makeAddr(string.concat("crowd", vm.toString(i)));
            _bigPosition(a, BTC);
            _fund(a);
            crowd.push(a);
        }
    }

    function _quoteFor(address who, uint256 payout) internal returns (ICoverPool.Quote memory q) {
        q = _quote();
        q.buyer = who;
        q.payout = payout;
        q.premium = (payout * 20 + 9_999) / 10_000;
    }

    /// @dev Testnet limits on a 100k pool: window cap 25,000, buyer cap 25 % of it = 6,250.
    function test_revert_check6_BuyerWindowCapExceeded() public {
        _crowd(1);
        _buy(_quoteFor(crowd[0], 6_000e6));
        ICoverPool.Quote memory q = _quoteFor(crowd[0], 250e6 + 1);
        _expectBuyRevert(
            q, abi.encodeWithSelector(ICoverPool.BuyerWindowCapExceeded.selector, crowd[0], 6_250e6 + 1, 6_250e6)
        );
        _buy(_quoteFor(crowd[0], 250e6)); // exactly the buyer cap
    }

    function test_revert_check6_SaleWindowCapExceeded() public {
        _crowd(5);
        for (uint256 i; i < 4; ++i) {
            _buy(_quoteFor(crowd[i], 6_250e6));
        }
        assertEq(pool.soldInWindow(), 25_000e6);
        ICoverPool.Quote memory q = _quoteFor(crowd[4], 1e6);
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.SaleWindowCapExceeded.selector, 25_001e6, 25_000e6));
    }

    function test_check6_windowResetsAfterSaleWindow() public {
        _crowd(5);
        for (uint256 i; i < 4; ++i) {
            _buy(_quoteFor(crowd[i], 6_250e6));
        }
        uint64 start = pool.windowStart();
        vm.warp(start + 3_600 - 1); // still inside [start, start + saleWindow)
        _expectBuyRevert(
            _quoteFor(crowd[4], 1e6),
            abi.encodeWithSelector(ICoverPool.SaleWindowCapExceeded.selector, 25_001e6, 25_000e6)
        );
        vm.warp(start + 3_600); // new window opens at the first sale after the old one ended
        uint256 b = pool.capacityBase();
        _buy(_quoteFor(crowd[4], 1e6));
        assertEq(pool.windowStart(), vm.getBlockTimestamp());
        assertEq(pool.windowAssets(), b, "snapshot of B before this sale's own accounting");
        assertEq(pool.soldInWindow(), 1e6);
        // the old window's buyer share does not carry over
        _buy(_quoteFor(crowd[0], 6_000e6));
        (uint64 s0, uint192 sold0) = pool.buyerWindow(crowd[0]);
        assertEq(s0, vm.getBlockTimestamp());
        assertEq(sold0, 6_000e6);
    }

    /// @dev A deposit mid-window does not raise the window's cap (the snapshot is the base for the whole window).
    function test_check6_depositMidWindowDoesNotRaiseCap() public {
        _crowd(5);
        _buy(_quoteFor(crowd[0], 1e6));
        _deposit(makeAddr("whale"), 1_000_000e6);
        assertEq(pool.windowAssets(), LP_DEPOSIT);
        for (uint256 i; i < 4; ++i) {
            _buy(_quoteFor(crowd[i + 1], i == 3 ? 5_999e6 : 6_250e6)); // 1 + 3 x 6,250 + 5,999 = 24,750
        }
        _expectBuyRevert(
            _quoteFor(crowd[0], 251e6),
            abi.encodeWithSelector(ICoverPool.SaleWindowCapExceeded.selector, 25_001e6, 25_000e6)
        );
    }

    /// @dev A cap lowered mid-window applies from the next sale, against the same snapshot.
    function test_check6_lowerCapAppliesFromNextSale() public {
        _crowd(2);
        _buy(_quoteFor(crowd[0], 5_000e6));
        ICoverPool.Limits memory l = PoolConfig.testnetLimits();
        l.maxSoldPerWindowBps = 500; // 5 % of 100k = 5,000
        l.maxPaidPerWindowBps = 500;
        _setLimits(l); // 600 s later, same window
        _expectBuyRevert(
            _quoteFor(crowd[1], 1e6),
            abi.encodeWithSelector(ICoverPool.SaleWindowCapExceeded.selector, 5_001e6, 5_000e6)
        );
    }

    // ================================================================ ordering and pause

    /// @dev A quote that fails several checks reports the earliest one in §5.3 order.
    function test_checkOrder_signatureBeforeEverythingElse() public {
        _setPosition(buyer, BTC, 0, 0, 0);
        _setPrice(BTC, 1e6);
        ICoverPool.Quote memory q = _quote();
        q.payout = 1;
        q.premium = 0;
        q.perpIndex = HYPE;
        bytes memory sig = _sign(q, 0xBAD);
        vm.warp(q.deadline + 1);
        vm.prank(makeAddr("other"));
        vm.expectRevert(ICoverPool.InvalidSignature.selector);
        pool.buyCover(q, sig);
    }

    function test_checkOrder_nonceBeforeAllowlist_allowlistBeforeExpiry() public {
        ICoverPool.Quote memory q = _quote();
        _buy(q);
        q.perpIndex = HYPE;
        q.expiry = uint64(vm.getBlockTimestamp());
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.NonceAlreadyUsed.selector, q.nonce));
        q.nonce = nextNonce++;
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.PerpNotAllowed.selector, HYPE));
    }

    function test_checkOrder_check2BeforePrice_premiumFloorLastInCheck2() public {
        _setPrice(BTC, 1e6); // deviates and breaches
        ICoverPool.Quote memory q = _quote();
        q.payout = 1e6 - 1;
        q.premium = 0;
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.PayoutTooSmall.selector, q.payout, 1e6));
        q.payout = 1_000e6;
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.PremiumBelowFloor.selector, 0, 2e6));
    }

    function test_checkOrder_deviationBeforeBreached_breachedBeforeDistance() public {
        ICoverPool.Quote memory q = _quote();
        q.level = 84_100e6; // breached for a long and within the distance floor
        _setPrice(BTC, 85_000e6); // deviates too
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.SpotDeviationTooHigh.selector, 85_000e6, BTC_PX));
        _setPrice(BTC, 84_050e6);
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.LevelAlreadyBreached.selector, 84_050e6, q.level));
    }

    function test_checkOrder_priceBeforePosition_positionBeforeCapacity_capacityBeforeThrottle() public {
        _setPosition(buyer, BTC, 0, 0, 0);
        ICoverPool.Quote memory q = _quote();
        q.level = 83_900e6; // too close
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.LevelTooClose.selector, BTC_PX, q.level));

        q = _quote();
        q.payout = 1_000_000e6; // exceeds capacity and the window caps too
        q.premium = 2_000e6;
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.NoPosition.selector, buyer, BTC));

        _bigPosition(buyer, BTC);
        _expectBuyRevert(
            q, abi.encodeWithSelector(ICoverPool.UtilizationExceeded.selector, 1_000_000e6, 80_000e6)
        );

        q.payout = 50_000e6; // inside capacity (per perp 50k), above the window cap 25k and buyer cap
        q.premium = 100e6;
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.SaleWindowCapExceeded.selector, 50_000e6, 25_000e6));
        q.payout = 7_000e6; // inside the window cap, above the buyer cap
        _expectBuyRevert(
            q, abi.encodeWithSelector(ICoverPool.BuyerWindowCapExceeded.selector, buyer, 7_000e6, 6_250e6)
        );
    }

    function test_revert_paused() public {
        _pause();
        ICoverPool.Quote memory q = _quote();
        _expectBuyRevert(q, abi.encodeWithSelector(Pausable.EnforcedPause.selector));
        _unpause();
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
        assertEq(pool.unearnedPremium(), 0);
        assertEq(pool.soldInWindow(), 0);
        assertFalse(pool.nonceUsed(q.nonce));
    }

    function test_revert_priceSourceRevertBubbles() public {
        _setPrice(BTC, 0); // the mock reverts PriceNotSet, never returns 0
        _expectBuyRevert(_quote(), abi.encodeWithSelector(MockPriceSource.PriceNotSet.selector, BTC));
    }
}
