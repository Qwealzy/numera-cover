// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CoverPool} from "../src/CoverPool.sol";
import {ICoverPool} from "../src/interfaces/ICoverPool.sol";
import {IPriceSource} from "../src/interfaces/IPriceSource.sol";
import {IPositionSource} from "../src/interfaces/IPositionSource.sol";
import {BaseTest} from "./Base.t.sol";
import {PoolConfig} from "./utils/PoolConfig.sol";

/// @notice ERC-4626 deposits; v2 accounting (§5.3); queued redeem with withdrawDelay / claimWindow (§5.4).
contract VaultTest is BaseTest {
    uint256 internal constant DELAY = 600;
    uint256 internal constant WINDOW = 3_600;

    /// @dev Lock 50k (the per-perp cap) so half the pool is reserved. Needs the throttle out of the way.
    function _lockHalf() internal returns (uint256 id) {
        _setLimits(PoolConfig.looseLimits());
        _bigPosition(buyer, BTC);
        ICoverPool.Quote memory q = _quote();
        q.payout = 50_000e6;
        q.premium = 1_000e6;
        id = _buy(q);
    }

    function _state(address who) internal view returns (ICoverPool.RequestState st) {
        (,,, st) = pool.redeemRequestOf(who);
    }

    // ================================================================ metadata, deposits, accounting

    function test_metadata() public view {
        assertEq(pool.asset(), address(usdc));
        assertEq(pool.decimals(), 12, "6 USDC decimals + 6 offset");
        assertEq(pool.name(), "Numera Cover Pool USDC");
        assertEq(pool.symbol(), "nmUSDC");
    }

    function test_deposit_mintsShares() public {
        address lp2 = makeAddr("lp2");
        uint256 shares = _deposit(lp2, 1_000e6);
        assertEq(shares, 1_000e6 * 1e6, "1:1e6 share/asset at par");
        assertEq(pool.balanceOf(lp2), shares);
        assertEq(pool.totalAssets(), LP_DEPOSIT + 1_000e6);
        assertEq(pool.maxWithdraw(lp2), 0, "no instant exit: nothing requested");
    }

    function test_mint_works() public {
        address lp2 = makeAddr("lp2");
        usdc.mint(lp2, 1_000e6);
        vm.startPrank(lp2);
        usdc.approve(address(pool), 1_000e6);
        uint256 assets = pool.mint(1_000e6 * 1e6, lp2);
        vm.stopPrank();
        assertEq(assets, 1_000e6);
    }

    function test_totalAssets_isBalanceMinusOwedMinusUnearned() public {
        ICoverPool.Quote memory q = _quote();
        uint256 id = _buy(q);
        assertEq(pool.totalAssets(), usdc.balanceOf(address(pool)) - q.premium);
        usdc.setBlocked(buyer, true);
        _setPrice(BTC, q.level);
        pool.trigger(id);
        assertEq(pool.totalAssets(), usdc.balanceOf(address(pool)) - q.payout);
        assertEq(pool.owedAssets(), q.payout);
        assertEq(pool.unearnedPremium(), 0);
    }

    function test_freeAssets_excludesLocked() public {
        _lockHalf();
        assertEq(pool.lockedAssets(), 50_000e6);
        assertEq(pool.freeAssets(), LP_DEPOSIT - 50_000e6, "unearned premium is not free either");
    }

    function test_premium_raisesSharePriceOnlyWhenEarned() public {
        uint256 before = pool.convertToAssets(1e12);
        ICoverPool.Quote memory q = _quote();
        uint256 id = _buy(q);
        assertEq(pool.convertToAssets(1e12), before, "unearned while active");
        vm.warp(q.expiry + 1);
        pool.expire(id);
        assertGt(pool.convertToAssets(1e12), before);
        assertApproxEqAbs(pool.convertToAssets(pool.balanceOf(lp)), LP_DEPOSIT + q.premium, 1);
    }

    function test_payout_lowersSharePrice() public {
        ICoverPool.Quote memory q = _quote();
        uint256 id = _buy(q);
        _setPrice(BTC, q.level);
        pool.trigger(id);
        assertApproxEqAbs(pool.convertToAssets(pool.balanceOf(lp)), LP_DEPOSIT + q.premium - q.payout, 1);
    }

    function test_inflationAttack_mitigatedByDecimalsOffset() public {
        CoverPool fresh = PoolConfig.deploy(
            IERC20(address(usdc)),
            owner,
            signer,
            address(0),
            IPriceSource(address(prices)),
            IPositionSource(address(positions)),
            PoolConfig.testnetLimits(),
            PoolConfig.perps1(BTC)
        );
        address attacker = makeAddr("attacker");
        address victim = makeAddr("victim");
        usdc.mint(attacker, 10_000e6 + 1);
        usdc.mint(victim, 10_000e6);

        vm.startPrank(attacker);
        usdc.approve(address(fresh), 1);
        fresh.deposit(1, attacker); // 1 wei of USDC
        usdc.transfer(address(fresh), 10_000e6); // donation to inflate share price
        vm.stopPrank();

        vm.startPrank(victim);
        usdc.approve(address(fresh), 10_000e6);
        uint256 shares = fresh.deposit(10_000e6, victim);
        vm.stopPrank();

        assertGt(shares, 0, "victim not rounded to zero shares");
        assertGe(fresh.convertToAssets(shares), 10_000e6 * 999 / 1000, "victim loses < 0.1%");
        assertLt(fresh.convertToAssets(fresh.balanceOf(attacker)), 10_000e6, "attack unprofitable");
    }

    function test_pause_blocksDepositsAndMintsButNotExits() public {
        _request(lp, 1_000e6 * 1e6);
        _pause();
        assertEq(pool.maxDeposit(lp), 0);
        assertEq(pool.maxMint(lp), 0);

        usdc.mint(lp, 1e6);
        vm.startPrank(lp);
        usdc.approve(address(pool), 1e6);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxDeposit.selector, lp, 1e6, 0));
        pool.deposit(1e6, lp);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxMint.selector, lp, 1e12, 0));
        pool.mint(1e12, lp);
        pool.requestRedeem(1e12, lp, lp); // requests work while paused (adds to the Pending slot)
        pool.cancelRedeemRequest(); // cancels too
        pool.requestRedeem(1_000e6 * 1e6, lp, lp);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        pool.withdraw(1_000e6, lp, lp); // and claims
        vm.stopPrank();
    }

    function test_isERC4626_totalAssets() public view {
        assertEq(IERC4626(address(pool)).totalAssets(), usdc.balanceOf(address(pool)));
    }

    // ================================================================ escrow guard

    function test_revert_sharesToPool_transfer() public {
        vm.prank(lp);
        vm.expectRevert(ICoverPool.SharesToPool.selector);
        pool.transfer(address(pool), 1);
    }

    function test_revert_sharesToPool_depositReceiver() public {
        usdc.mint(lp, 1e6);
        vm.startPrank(lp);
        usdc.approve(address(pool), 1e6);
        vm.expectRevert(ICoverPool.SharesToPool.selector);
        pool.deposit(1e6, address(pool));
        vm.stopPrank();
    }

    function test_transferBetweenHolders_allowed() public {
        address lp2 = makeAddr("lp2");
        vm.prank(lp);
        pool.transfer(lp2, 1e12);
        assertEq(pool.balanceOf(lp2), 1e12);
    }

    // ================================================================ requestRedeem

    function test_request_movesSharesIntoEscrow() public {
        uint256 shares = pool.balanceOf(lp) / 4;
        vm.expectEmit(address(pool));
        emit ICoverPool.RedeemRequest(lp, lp, 0, lp, shares);
        vm.prank(lp);
        uint256 rid = pool.requestRedeem(shares, lp, lp);
        assertEq(rid, 0);
        assertEq(pool.balanceOf(address(pool)), shares);
        assertEq(pool.totalEscrowedShares(), shares);
        assertEq(pool.totalSupply(), LP_DEPOSIT * 1e6, "escrowed shares stay in totalSupply");
        (uint256 s, uint64 at, uint64 deadline, ICoverPool.RequestState st) = pool.redeemRequestOf(lp);
        assertEq(s, shares);
        assertEq(at, vm.getBlockTimestamp() + DELAY);
        assertEq(deadline, vm.getBlockTimestamp() + DELAY + WINDOW);
        assertEq(uint8(st), uint8(ICoverPool.RequestState.Pending));
        assertEq(pool.pendingRedeemRequest(0, lp), shares);
        assertEq(pool.claimableRedeemRequest(0, lp), 0);
        assertEq(pool.pendingRedeemRequest(1, lp), 0, "only requestId 0");
        assertEq(pool.maxRedeem(lp), 0);
        assertEq(pool.maxWithdraw(lp), 0);
    }

    function test_revert_request_notShareOwner() public {
        address other = makeAddr("other");
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(ICoverPool.NotShareOwner.selector, other, lp));
        pool.requestRedeem(1, lp, lp);
    }

    function test_revert_request_controllerMustBeOwner() public {
        address other = makeAddr("other");
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(ICoverPool.ControllerMustBeOwner.selector, other, lp));
        pool.requestRedeem(1, other, lp);
    }

    function test_revert_request_zeroShares() public {
        vm.prank(lp);
        vm.expectRevert(ICoverPool.ZeroShares.selector);
        pool.requestRedeem(0, lp, lp);
    }

    function test_revert_request_moreThanBalance() public {
        uint256 bal = pool.balanceOf(lp);
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, lp, bal, bal + 1));
        pool.requestRedeem(bal + 1, lp, lp);
    }

    function test_revert_request_whileClaimable() public {
        _request(lp, 1e12);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.prank(lp);
        vm.expectRevert(ICoverPool.RequestClaimable.selector);
        pool.requestRedeem(1e12, lp, lp);
    }

    function test_request_addsToPendingAndRestartsClock() public {
        _request(lp, 1e12);
        vm.warp(vm.getBlockTimestamp() + 300);
        _request(lp, 2e12);
        (uint256 s, uint64 at,,) = pool.redeemRequestOf(lp);
        assertEq(s, 3e12);
        assertEq(at, vm.getBlockTimestamp() + DELAY, "the clock restarts for the whole slot");
    }

    function test_request_lapsesAndRequeuesWithZero() public {
        _request(lp, 1e12);
        vm.warp(vm.getBlockTimestamp() + DELAY + WINDOW);
        assertEq(uint8(_state(lp)), uint8(ICoverPool.RequestState.Lapsed));
        assertEq(pool.pendingRedeemRequest(0, lp), 0);
        assertEq(pool.claimableRedeemRequest(0, lp), 0);
        assertEq(pool.maxRedeem(lp), 0);
        vm.prank(lp);
        vm.expectRevert(
            abi.encodeWithSelector(ICoverPool.RequestNotClaimable.selector, ICoverPool.RequestState.Lapsed)
        );
        pool.redeem(1e12, lp, lp);

        _request(lp, 0); // re-queue
        assertEq(uint8(_state(lp)), uint8(ICoverPool.RequestState.Pending));
        vm.warp(vm.getBlockTimestamp() + DELAY);
        assertEq(pool.claimableRedeemRequest(0, lp), 1e12);
        vm.prank(lp);
        pool.redeem(1e12, lp, lp);
    }

    function test_state_boundaries() public {
        _request(lp, 1e12);
        uint256 t = vm.getBlockTimestamp();
        vm.warp(t + DELAY - 1);
        assertEq(uint8(_state(lp)), uint8(ICoverPool.RequestState.Pending));
        vm.warp(t + DELAY);
        assertEq(uint8(_state(lp)), uint8(ICoverPool.RequestState.Claimable));
        vm.warp(t + DELAY + WINDOW - 1);
        assertEq(uint8(_state(lp)), uint8(ICoverPool.RequestState.Claimable));
        vm.warp(t + DELAY + WINDOW);
        assertEq(uint8(_state(lp)), uint8(ICoverPool.RequestState.Lapsed));
        assertEq(uint8(_state(makeAddr("nobody"))), uint8(ICoverPool.RequestState.None));
    }

    // ================================================================ cancel

    function test_cancel_returnsSharesInAnyState() public {
        uint256 bal = pool.balanceOf(lp);
        _request(lp, 5e12);
        vm.warp(vm.getBlockTimestamp() + DELAY + WINDOW); // Lapsed
        vm.expectEmit(address(pool));
        emit ICoverPool.RedeemRequestCancelled(lp, 5e12);
        vm.prank(lp);
        assertEq(pool.cancelRedeemRequest(), 5e12);
        assertEq(pool.balanceOf(lp), bal);
        assertEq(pool.totalEscrowedShares(), 0);
        assertEq(uint8(_state(lp)), uint8(ICoverPool.RequestState.None));
    }

    function test_revert_cancel_empty() public {
        vm.prank(lp);
        vm.expectRevert(ICoverPool.ZeroShares.selector);
        pool.cancelRedeemRequest();
    }

    // ================================================================ redeem / withdraw (claims)

    function test_redeem_claimsAtClaimTimePrice() public {
        uint256 shares = _requestAllAndMature(lp);
        assertEq(pool.maxRedeem(lp), shares);
        address receiver = makeAddr("receiver");
        uint256 expected = pool.convertToAssets(shares);
        vm.expectEmit(address(pool));
        emit IERC4626.Withdraw(lp, receiver, lp, expected, shares);
        vm.prank(lp);
        uint256 assets = pool.redeem(shares, receiver, lp);
        assertEq(assets, expected);
        assertEq(usdc.balanceOf(receiver), assets);
        assertEq(pool.totalEscrowedShares(), 0);
        assertEq(pool.balanceOf(address(pool)), 0);
        assertEq(uint8(_state(lp)), uint8(ICoverPool.RequestState.None), "slot deleted at 0");
    }

    function test_withdraw_partialKeepsSlotClaimable() public {
        uint256 shares = _requestAllAndMature(lp);
        vm.prank(lp);
        uint256 burned = pool.withdraw(1_000e6, lp, lp);
        assertEq(burned, 1_000e6 * 1e6);
        (uint256 s, uint64 at,, ICoverPool.RequestState st) = pool.redeemRequestOf(lp);
        assertEq(s, shares - burned);
        assertEq(at, vm.getBlockTimestamp(), "clock unchanged by a claim");
        assertEq(uint8(st), uint8(ICoverPool.RequestState.Claimable));
    }

    function test_revert_claim_notController() public {
        _requestAllAndMature(lp);
        address other = makeAddr("other");
        vm.startPrank(other);
        vm.expectRevert(abi.encodeWithSelector(ICoverPool.NotController.selector, other, lp));
        pool.redeem(1, other, lp);
        vm.expectRevert(abi.encodeWithSelector(ICoverPool.NotController.selector, other, lp));
        pool.withdraw(1, other, lp);
        vm.stopPrank();
    }

    function test_revert_claim_pending() public {
        _request(lp, 1e12);
        vm.prank(lp);
        vm.expectRevert(
            abi.encodeWithSelector(ICoverPool.RequestNotClaimable.selector, ICoverPool.RequestState.Pending)
        );
        pool.redeem(1e12, lp, lp);
    }

    /// @dev No exit bypasses the queue: a holder without a slot cannot withdraw at all.
    function test_revert_claim_noRequest() public {
        vm.startPrank(lp);
        vm.expectRevert(abi.encodeWithSelector(ICoverPool.RequestNotClaimable.selector, ICoverPool.RequestState.None));
        pool.withdraw(1, lp, lp);
        vm.expectRevert(abi.encodeWithSelector(ICoverPool.RequestNotClaimable.selector, ICoverPool.RequestState.None));
        pool.redeem(1, lp, lp);
        vm.stopPrank();
    }

    function test_revert_claim_zeroShares() public {
        _requestAllAndMature(lp);
        vm.startPrank(lp);
        vm.expectRevert(ICoverPool.ZeroShares.selector);
        pool.redeem(0, lp, lp);
        vm.expectRevert(ICoverPool.ZeroShares.selector);
        pool.withdraw(0, lp, lp);
        vm.stopPrank();
    }

    function test_revert_claim_exceedsClaimable() public {
        _request(lp, 1e12);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.startPrank(lp);
        vm.expectRevert(abi.encodeWithSelector(ICoverPool.ExceedsClaimable.selector, 1e12 + 1, 1e12));
        pool.redeem(1e12 + 1, lp, lp);
        vm.expectRevert(abi.encodeWithSelector(ICoverPool.ExceedsClaimable.selector, 2e12, 1e12));
        pool.withdraw(2e6, lp, lp);
        vm.stopPrank();
    }

    function test_revert_claim_insufficientFreeAssets() public {
        _lockHalf();
        uint256 shares = _requestAllAndMature(lp);
        uint256 free = pool.freeAssets();
        assertEq(free, LP_DEPOSIT - 50_000e6);
        uint256 assets = pool.convertToAssets(shares);
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(ICoverPool.InsufficientFreeAssets.selector, assets, free));
        pool.redeem(shares, lp, lp);
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(ICoverPool.InsufficientFreeAssets.selector, free + 1, free));
        pool.withdraw(free + 1, lp, lp);
    }

    function test_maxWithdraw_maxRedeem_boundedByFreeAssets() public {
        _lockHalf();
        _requestAllAndMature(lp);
        uint256 free = pool.freeAssets();
        assertEq(pool.maxWithdraw(lp), free);
        uint256 maxShares = pool.maxRedeem(lp);
        assertLe(pool.convertToAssets(maxShares), free);
        vm.prank(lp);
        pool.redeem(maxShares, lp, lp);
        assertGe(usdc.balanceOf(address(pool)), pool.lockedAssets() + pool.unearnedPremium());
        assertEq(uint8(_state(lp)), uint8(ICoverPool.RequestState.Claimable), "the rest stays Claimable");
    }

    function test_withdrawExactlyMaxWithdraw_keepsReserves() public {
        _lockHalf();
        _requestAllAndMature(lp);
        uint256 maxW = pool.maxWithdraw(lp);
        vm.prank(lp);
        pool.withdraw(maxW, lp, lp);
        assertEq(usdc.balanceOf(address(pool)), pool.lockedAssets() + pool.unearnedPremium(), "only reserves remain");
        assertEq(pool.maxWithdraw(lp), 0);
    }

    function test_expire_releasesReservesForClaims() public {
        uint256 id = _lockHalf();
        uint256 shares = _requestAllAndMature(lp);
        vm.warp(pool.getCover(id).expiry + 1);
        pool.expire(id);
        _request(lp, 0); // lapsed by now: re-queue
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.prank(lp);
        uint256 assets = pool.redeem(shares, lp, lp);
        assertEq(assets, LP_DEPOSIT + 1_000e6 - 1, "everything plus the earned premium (minus rounding)");
    }

    /// @dev Escrowed shares bear every payout until claimed.
    function test_escrowedSharesBearPayouts() public {
        ICoverPool.Quote memory q = _quote();
        uint256 id = _buy(q);
        uint256 shares = _requestAllAndMature(lp);
        _setPrice(BTC, q.level);
        pool.trigger(id);
        vm.prank(lp);
        uint256 assets = pool.redeem(shares, lp, lp);
        assertApproxEqAbs(assets, LP_DEPOSIT + q.premium - q.payout, 1);
    }

    function test_revert_previewRedeemAndWithdraw() public {
        vm.expectRevert(ICoverPool.AsyncRedeemOnly.selector);
        pool.previewRedeem(1);
        vm.expectRevert(ICoverPool.AsyncRedeemOnly.selector);
        pool.previewWithdraw(1);
    }

    /// @dev Rounding favours the pool: a claim never lowers the share price for the LPs who stay.
    function testFuzz_claim_doesNotLowerSharePrice(uint256 deposit2, uint256 claimShares, uint256 gain) public {
        address lp2 = makeAddr("lp2");
        _deposit(lp2, bound(deposit2, 1, 1_000_000e6));
        usdc.mint(address(pool), bound(gain, 0, 50_000e6)); // donation shifts the price off par
        uint256 shares = _requestAllAndMature(lp);
        claimShares = bound(claimShares, 1, shares);
        uint256 before = pool.convertToAssets(1e12);
        vm.prank(lp);
        pool.redeem(claimShares, lp, lp);
        assertGe(pool.convertToAssets(1e12), before);
    }

    function testFuzz_withdraw_doesNotLowerSharePrice(uint256 assets, uint256 gain) public {
        usdc.mint(address(pool), bound(gain, 0, 50_000e6));
        _deposit(makeAddr("lp2"), 7_777e6);
        _requestAllAndMature(lp);
        assets = bound(assets, 1, pool.maxWithdraw(lp));
        uint256 before = pool.convertToAssets(1e12);
        vm.prank(lp);
        pool.withdraw(assets, lp, lp);
        assertGe(pool.convertToAssets(1e12), before);
    }
}
