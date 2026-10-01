// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CoverPool} from "../src/CoverPool.sol";
import {ICoverPool} from "../src/interfaces/ICoverPool.sol";
import {BaseTest} from "./Base.t.sol";

/// @notice F1: ERC-4626 deposit/withdraw; withdrawals limited to free assets (totalAssets - lockedAssets).
contract VaultTest is BaseTest {
    /// @dev Lock 50k (the per-perp cap) so half the pool is reserved.
    function _lockHalf() internal returns (uint256 id) {
        _setPosition(buyer, BTC, 1e5, 10_000_000e6, 10);
        ICoverPool.Quote memory q = _quote();
        q.payout = 50_000e6;
        q.premium = 1_000e6;
        id = _buy(q);
    }

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
        assertEq(pool.maxWithdraw(lp2), 1_000e6);
    }

    function test_withdraw_allWhenNothingLocked() public {
        vm.prank(lp);
        pool.withdraw(LP_DEPOSIT, lp, lp);
        assertEq(usdc.balanceOf(lp), LP_DEPOSIT);
        assertEq(pool.balanceOf(lp), 0);
        assertEq(pool.totalAssets(), 0);
    }

    function test_maxWithdraw_limitedToFreeAssets() public {
        _lockHalf();
        uint256 free = LP_DEPOSIT + 1_000e6 - 50_000e6;
        assertEq(pool.lockedAssets(), 50_000e6);
        assertEq(pool.freeAssets(), free);
        assertEq(pool.maxWithdraw(lp), free);
        assertLe(pool.convertToAssets(pool.maxRedeem(lp)), free);
    }

    function test_revert_withdrawMoreThanFreeAssets() public {
        _lockHalf();
        uint256 free = pool.freeAssets();
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxWithdraw.selector, lp, free + 1, free));
        pool.withdraw(free + 1, lp, lp);
    }

    function test_revert_redeemMoreThanFreeAssets() public {
        _lockHalf();
        uint256 maxShares = pool.maxRedeem(lp);
        uint256 all = pool.balanceOf(lp);
        assertLt(maxShares, all);
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxRedeem.selector, lp, all, maxShares));
        pool.redeem(all, lp, lp);
    }

    function test_withdrawExactlyFreeAssets_keepsLockedReserved() public {
        _lockHalf();
        uint256 free = pool.freeAssets();
        vm.prank(lp);
        pool.withdraw(free, lp, lp);
        assertEq(usdc.balanceOf(address(pool)), pool.lockedAssets(), "only reserves remain");
        assertEq(pool.maxWithdraw(lp), 0);
    }

    function test_redeemMaxRedeem_neverTouchesReserves() public {
        _lockHalf();
        uint256 shares = pool.maxRedeem(lp);
        vm.prank(lp);
        pool.redeem(shares, lp, lp);
        assertGe(usdc.balanceOf(address(pool)), pool.lockedAssets());
    }

    function test_expire_releasesReservesForWithdrawal() public {
        uint256 id = _lockHalf();
        vm.warp(pool.getCover(id).expiry + 1);
        pool.expire(id);
        assertEq(pool.maxWithdraw(lp), LP_DEPOSIT + 1_000e6 - 1, "everything withdrawable (minus rounding)");
    }

    function test_premium_raisesSharePrice() public {
        uint256 before = pool.convertToAssets(1e12);
        ICoverPool.Quote memory q = _quote();
        _buy(q);
        uint256 afterBuy = pool.convertToAssets(1e12);
        assertGt(afterBuy, before);
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
        CoverPool fresh = new CoverPool(IERC20(address(usdc)), owner, signer, prices, positions);
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
        assertGe(fresh.previewRedeem(shares), 10_000e6 * 999 / 1000, "victim loses < 0.1%");
        assertLt(fresh.previewRedeem(fresh.balanceOf(attacker)), 10_000e6, "attack unprofitable");
    }

    function test_pause_blocksDepositsButNotWithdrawals() public {
        vm.prank(owner);
        pool.setPaused(true);
        assertEq(pool.maxDeposit(lp), 0);
        assertEq(pool.maxMint(lp), 0);

        usdc.mint(lp, 1e6);
        vm.startPrank(lp);
        usdc.approve(address(pool), 1e6);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxDeposit.selector, lp, 1e6, 0));
        pool.deposit(1e6, lp);
        pool.withdraw(1_000e6, lp, lp); // exits still work
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- admin

    function test_admin_onlyOwner() public {
        vm.startPrank(lp);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, lp));
        pool.setQuoteSigner(lp);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, lp));
        pool.setLimits(9000, 6000, 1 days, 50, 5e6);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, lp));
        pool.setPaused(true);
        vm.stopPrank();
    }

    function test_admin_setLimits() public {
        vm.expectEmit(address(pool));
        emit ICoverPool.LimitsUpdated(9000, 6000, 1 days, 50, 5e6);
        vm.prank(owner);
        pool.setLimits(9000, 6000, 1 days, 50, 5e6);
        assertEq(pool.maxUtilizationBps(), 9000);
        assertEq(pool.perPerpCapBps(), 6000);
        assertEq(pool.maxDuration(), 1 days);
        assertEq(pool.maxSpotDeviationBps(), 50);
        assertEq(pool.minPayout(), 5e6);
    }

    function test_admin_defaults() public view {
        assertEq(pool.maxUtilizationBps(), 8000);
        assertEq(pool.perPerpCapBps(), 5000);
        assertEq(pool.maxDuration(), 7 days);
        assertEq(pool.maxSpotDeviationBps(), 100);
        assertEq(pool.minPayout(), 1e6);
        assertEq(pool.quoteSigner(), signer);
    }

    function test_revert_admin_invalidLimits() public {
        vm.startPrank(owner);
        vm.expectRevert(ICoverPool.InvalidLimits.selector);
        pool.setLimits(10_001, 5000, 1 days, 100, 1e6);
        vm.expectRevert(ICoverPool.InvalidLimits.selector);
        pool.setLimits(0, 5000, 1 days, 100, 1e6);
        vm.expectRevert(ICoverPool.InvalidLimits.selector);
        pool.setLimits(8000, 0, 1 days, 100, 1e6);
        vm.expectRevert(ICoverPool.InvalidLimits.selector);
        pool.setLimits(8000, 5000, 0, 100, 1e6);
        vm.expectRevert(ICoverPool.InvalidLimits.selector);
        pool.setLimits(8000, 5000, 1 days, 100, 0);
        vm.expectRevert(ICoverPool.ZeroAddress.selector);
        pool.setQuoteSigner(address(0));
        vm.stopPrank();
    }

    function test_isERC4626() public view {
        assertEq(IERC4626(address(pool)).totalAssets(), usdc.balanceOf(address(pool)));
    }
}
