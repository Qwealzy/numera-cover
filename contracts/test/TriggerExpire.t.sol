// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {ICoverPool} from "../src/interfaces/ICoverPool.sol";
import {BaseTest} from "./Base.t.sol";

/// @notice trigger pays exactly once on breach before expiry; expire releases after expiry.
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
        vm.prank(owner);
        pool.setPaused(true);
        _setPrice(BTC, 70_000e6);
        pool.trigger(id);
    }

    // ================================================================ expire

    function test_expire_afterExpiry_releasesLock() public {
        (uint256 id, ICoverPool.Quote memory q) = _longCover();
        uint256 poolBalance = usdc.balanceOf(address(pool));
        vm.warp(q.expiry + 1);
        vm.expectEmit(true, false, false, true, address(pool));
        emit ICoverPool.CoverExpired(id);
        vm.prank(keeper);
        pool.expire(id);
        assertEq(pool.lockedAssets(), 0);
        assertEq(pool.lockedByPerp(BTC), 0);
        assertEq(usdc.balanceOf(address(pool)), poolBalance, "no transfer on expiry; LPs keep premium");
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
