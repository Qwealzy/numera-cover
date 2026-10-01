// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CoverPool} from "../src/CoverPool.sol";
import {ICoverPool} from "../src/interfaces/ICoverPool.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockPriceSource} from "../src/mocks/MockPriceSource.sol";
import {MockPositionSource} from "../src/mocks/MockPositionSource.sol";

/// @dev Drives random deposit / withdraw / redeem / buyCover / price moves / trigger / expire / time warps.
contract PoolHandler is Test {
    CoverPool internal pool;
    MockUSDC internal usdc;
    MockPriceSource internal prices;
    MockPositionSource internal positions;
    uint256 internal signerKey;

    address[3] internal lps;
    address internal buyer = makeAddr("inv-buyer");
    uint32[3] internal perps = [uint32(3), 4, 0];

    uint256[] public coverIds;
    uint256 internal nonce = 1;

    // ghost counters (reported, also used to show the run did real work)
    uint256 public ghostBought;
    uint256 public ghostTriggered;
    uint256 public ghostExpired;
    uint256 public ghostWithdrawn;

    constructor(CoverPool pool_, MockUSDC usdc_, MockPriceSource prices_, MockPositionSource positions_, uint256 key)
    {
        pool = pool_;
        usdc = usdc_;
        prices = prices_;
        positions = positions_;
        signerKey = key;
        lps = [makeAddr("lp0"), makeAddr("lp1"), makeAddr("lp2")];
        vm.prank(buyer);
        usdc.approve(address(pool), type(uint256).max);
    }

    function coverCountTracked() external view returns (uint256) {
        return coverIds.length;
    }

    // ---------------------------------------------------------------- LP actions

    function deposit(uint256 lpSeed, uint256 amount) external {
        address lp = lps[lpSeed % 3];
        amount = bound(amount, 1, 500_000e6);
        usdc.mint(lp, amount);
        vm.startPrank(lp);
        usdc.approve(address(pool), amount);
        pool.deposit(amount, lp);
        vm.stopPrank();
    }

    function withdraw(uint256 lpSeed, uint256 amount) external {
        address lp = lps[lpSeed % 3];
        uint256 max = pool.maxWithdraw(lp);
        if (max == 0) return;
        amount = bound(amount, 1, max);
        vm.prank(lp);
        pool.withdraw(amount, lp, lp);
        ghostWithdrawn++;
    }

    function redeem(uint256 lpSeed, uint256 shares) external {
        address lp = lps[lpSeed % 3];
        uint256 max = pool.maxRedeem(lp);
        if (max == 0) return;
        shares = bound(shares, 1, max);
        vm.prank(lp);
        pool.redeem(shares, lp, lp);
        ghostWithdrawn++;
    }

    // ---------------------------------------------------------------- cover actions

    function buyCover(uint256 perpSeed, bool isLong, uint256 payout, uint256 premium, uint256 duration, uint256 distBps)
        external
    {
        uint32 perp = perps[perpSeed % 3];
        uint64 px = prices.px6Of(perp);
        distBps = bound(distBps, 1, 1_000); // levels within 10 % so random price moves breach often
        uint64 level = isLong ? uint64(uint256(px) * (10_000 - distBps) / 10_000) : uint64(uint256(px) * (10_000 + distBps) / 10_000);
        if (isLong ? level >= px : level <= px) return; // rounding at tiny prices

        // Payout up to 20 % of assets: most buys fit, while repeated buys still hit the per-perp and
        // utilization caps (those revert and are skipped).
        uint256 cap = pool.totalAssets() / 5;
        if (cap < 1e6) return;
        payout = bound(payout, 1e6, cap);
        premium = bound(premium, 0, payout / 2);
        usdc.mint(buyer, premium);

        vm.prank(positions.owner());
        positions.setPosition(buyer, perp, isLong ? int64(1e5) : int64(-1e5), type(uint64).max, 1);

        ICoverPool.Quote memory q = ICoverPool.Quote({
            buyer: buyer,
            perpIndex: perp,
            isLong: isLong,
            level: level,
            payout: payout,
            premium: premium,
            expiry: uint64(block.timestamp + bound(duration, 1, 7 days)),
            spotRef: px,
            deadline: uint64(block.timestamp + 60),
            nonce: nonce++
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, pool.quoteDigest(q));
        vm.prank(buyer);
        try pool.buyCover(q, abi.encodePacked(r, s, v)) returns (uint256 id) {
            coverIds.push(id);
            ghostBought++;
        } catch {}
    }

    function movePrice(uint256 perpSeed, uint256 moveBps) external {
        uint32 perp = perps[perpSeed % 3];
        uint256 px = uint256(prices.px6Of(perp)) * bound(moveBps, 7_000, 13_000) / 10_000;
        if (px < 1e6) px = 1e6;
        if (px > 1e12) px = 1e12;
        vm.prank(prices.owner());
        prices.setPrice(perp, uint64(px));
    }

    /// @dev Like a keeper: scan from a random offset and trigger the first breached active cover.
    function triggerCover(uint256 idSeed) external {
        uint256 n = coverIds.length;
        for (uint256 i; i < n; i++) {
            try pool.trigger(coverIds[(idSeed % n + i) % n]) {
                ghostTriggered++;
                return;
            } catch {}
        }
    }

    function expireCover(uint256 idSeed) external {
        uint256 n = coverIds.length;
        for (uint256 i; i < n; i++) {
            try pool.expire(coverIds[(idSeed % n + i) % n]) {
                ghostExpired++;
                return;
            } catch {}
        }
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 12 hours));
    }
}

/// @notice The pool is always solvent: USDC balance >= lockedAssets, under random action sequences.
contract InvariantTest is Test {
    CoverPool internal pool;
    MockUSDC internal usdc;
    MockPriceSource internal prices;
    MockPositionSource internal positions;
    PoolHandler internal handler;

    function setUp() public {
        vm.warp(1_790_000_000);
        uint256 key = 0xA11CE;
        usdc = new MockUSDC();
        prices = new MockPriceSource(address(this));
        positions = new MockPositionSource(address(this));
        pool = new CoverPool(IERC20(address(usdc)), address(this), vm.addr(key), prices, positions);
        prices.setPrice(3, 84_000e6);
        prices.setPrice(4, 3_000e6);
        prices.setPrice(0, 150e6);

        handler = new PoolHandler(pool, usdc, prices, positions, key);
        prices.transferOwnership(address(handler));
        positions.transferOwnership(address(handler));

        // seed liquidity so early buys can succeed
        usdc.mint(address(this), 200_000e6);
        usdc.approve(address(pool), 200_000e6);
        pool.deposit(200_000e6, address(this));

        targetContract(address(handler));
    }

    function invariant_usdcBalanceCoversLockedAssets() public view {
        assertGe(usdc.balanceOf(address(pool)), pool.lockedAssets());
    }

    function invariant_lockedEqualsActivePayouts() public view {
        uint256 sum;
        uint256 n = handler.coverCountTracked();
        for (uint256 i; i < n; i++) {
            ICoverPool.Cover memory c = pool.getCover(handler.coverIds(i));
            if (c.status == ICoverPool.Status.Active) sum += c.payout;
        }
        assertEq(pool.lockedAssets(), sum);
        assertEq(pool.coverCount(), n);
    }

    function invariant_perPerpLocksSumToTotal() public view {
        assertEq(pool.lockedByPerp(3) + pool.lockedByPerp(4) + pool.lockedByPerp(0), pool.lockedAssets());
    }

    function invariant_totalAssetsIsBalance() public view {
        assertEq(pool.totalAssets(), usdc.balanceOf(address(pool)));
    }

    /// @dev Per-run activity, visible with `forge test --match-contract InvariantTest -vv`.
    function afterInvariant() external view {
        console2.log(
            "bought/triggered/expired/withdrawn",
            handler.ghostBought(),
            handler.ghostTriggered(),
            handler.ghostExpired() * 1e6 + handler.ghostWithdrawn() // packed: expired x1e6 + withdrawn
        );
    }

    /// @dev Handler buys inside the caps must succeed, otherwise the invariant campaign would be vacuous.
    function testFuzz_handlerBuy_withinCapsSucceeds(uint256 perpSeed, bool isLong, uint256 payout, uint256 dur, uint256 dist)
        public
    {
        handler.buyCover(perpSeed, isLong, bound(payout, 1e6, 90_000e6), 0, dur, dist);
        assertEq(handler.ghostBought(), 1);
    }

    /// @dev Proves the handler is not vacuous: each path (buy, trigger, expire, withdraw) really executes.
    function test_handlerSmoke_allPathsReachable() public {
        handler.deposit(0, 100_000e6);
        handler.buyCover(0, true, 1_000e6, 10e6, 1 days, 500); // long BTC, level -5 %
        handler.buyCover(1, false, 2_000e6, 10e6, 1 hours, 500); // short ETH, level +5 %
        assertEq(handler.ghostBought(), 2);

        handler.movePrice(0, 7_000); // BTC -30 % -> long cover breached
        handler.triggerCover(0);
        assertEq(handler.ghostTriggered(), 1);

        handler.warp(2 hours); // past the short cover's expiry
        handler.expireCover(1);
        assertEq(handler.ghostExpired(), 1);

        handler.withdraw(0, type(uint256).max);
        assertEq(handler.ghostWithdrawn(), 1);
        invariant_usdcBalanceCoversLockedAssets();
        invariant_lockedEqualsActivePayouts();
        assertEq(pool.lockedAssets(), 0);
    }
}
