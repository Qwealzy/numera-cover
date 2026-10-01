// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CoverPool} from "../src/CoverPool.sol";
import {ICoverPool} from "../src/interfaces/ICoverPool.sol";
import {IPriceSource} from "../src/interfaces/IPriceSource.sol";
import {IPositionSource} from "../src/interfaces/IPositionSource.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockPriceSource} from "../src/mocks/MockPriceSource.sol";
import {MockPositionSource} from "../src/mocks/MockPositionSource.sol";

/// @dev Shared fixture: a 100k USDC pool on mock sources, one long BTC trader, a signer key.
abstract contract BaseTest is Test {
    uint32 internal constant BTC = 3; // testnet index; tests never assume mainnet indices
    uint32 internal constant ETH = 4;
    uint32 internal constant SOL = 0;

    uint64 internal constant BTC_PX = 84_000e6; // px6
    uint64 internal constant ETH_PX = 3_000e6;
    uint64 internal constant SOL_PX = 150e6;

    uint256 internal constant LP_DEPOSIT = 100_000e6;
    uint256 internal constant T0 = 1_790_000_000;

    MockUSDC internal usdc;
    MockPriceSource internal prices;
    MockPositionSource internal positions;
    CoverPool internal pool;

    address internal owner = makeAddr("owner");
    address internal lp = makeAddr("lp");
    address internal buyer = makeAddr("buyer");
    uint256 internal signerKey = 0xA11CE;
    address internal signer;

    uint256 internal nextNonce = 1;

    function setUp() public virtual {
        vm.warp(T0);
        signer = vm.addr(signerKey);

        usdc = new MockUSDC();
        prices = new MockPriceSource(owner);
        positions = new MockPositionSource(owner);
        pool = new CoverPool(IERC20(address(usdc)), owner, signer, prices, positions);

        vm.startPrank(owner);
        prices.setPrice(BTC, BTC_PX);
        prices.setPrice(ETH, ETH_PX);
        prices.setPrice(SOL, SOL_PX);
        // 1 BTC long at 20x: entryNtl 84,000 USD (px6 units) -> margin cap 4,200 USDC
        positions.setPosition(buyer, BTC, 1e5, 84_000e6, 20);
        vm.stopPrank();

        _deposit(lp, LP_DEPOSIT);

        usdc.mint(buyer, 1_000_000e6);
        vm.prank(buyer);
        usdc.approve(address(pool), type(uint256).max);
    }

    // ---------------------------------------------------------------- helpers

    function _deposit(address who, uint256 amount) internal returns (uint256 shares) {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(pool), amount);
        shares = pool.deposit(amount, who);
        vm.stopPrank();
    }

    /// @dev Default valid quote: long BTC, level 80k, payout 1,000, premium 25, 1 day.
    function _quote() internal returns (ICoverPool.Quote memory q) {
        q = ICoverPool.Quote({
            buyer: buyer,
            perpIndex: BTC,
            isLong: true,
            level: 80_000e6,
            payout: 1_000e6,
            premium: 25e6,
            expiry: uint64(block.timestamp + 1 days),
            spotRef: BTC_PX,
            deadline: uint64(block.timestamp + 60),
            nonce: nextNonce++
        });
    }

    function _sign(ICoverPool.Quote memory q, uint256 key) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, pool.quoteDigest(q));
        return abi.encodePacked(r, s, v);
    }

    function _buy(ICoverPool.Quote memory q) internal returns (uint256 id) {
        bytes memory sig = _sign(q, signerKey);
        vm.prank(q.buyer);
        id = pool.buyCover(q, sig);
    }

    function _expectBuyRevert(ICoverPool.Quote memory q, bytes memory err) internal {
        bytes memory sig = _sign(q, signerKey);
        vm.prank(q.buyer);
        vm.expectRevert(err);
        pool.buyCover(q, sig);
    }

    function _setPrice(uint32 perp, uint64 px) internal {
        vm.prank(owner);
        prices.setPrice(perp, px);
    }

    function _setPosition(address who, uint32 perp, int64 szi, uint64 entryNtl, uint32 lev) internal {
        vm.prank(owner);
        positions.setPosition(who, perp, szi, entryNtl, lev);
    }
}
