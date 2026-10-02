// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CoverPool} from "../src/CoverPool.sol";
import {ICoverPool} from "../src/interfaces/ICoverPool.sol";
import {IPriceSource} from "../src/interfaces/IPriceSource.sol";
import {IPositionSource} from "../src/interfaces/IPositionSource.sol";
import {BlocklistUSDC} from "./utils/BlocklistUSDC.sol";
import {MockPriceSource} from "../src/mocks/MockPriceSource.sol";
import {MockPositionSource} from "../src/mocks/MockPositionSource.sol";
import {PoolConfig} from "./utils/PoolConfig.sol";

/// @dev Shared fixture: a 100k USDC v2 pool on mock sources with the testnet limits (ARCHITECTURE §5.2),
///      perps BTC/ETH/SOL allowed, one long BTC trader, a signer key, a guardian.
abstract contract BaseTest is Test {
    uint32 internal constant BTC = 3; // testnet index; tests never assume mainnet indices
    uint32 internal constant ETH = 4;
    uint32 internal constant SOL = 0;
    uint32 internal constant HYPE = 135; // priced but not allowlisted

    uint64 internal constant BTC_PX = 84_000e6; // px6
    uint64 internal constant ETH_PX = 3_000e6;
    uint64 internal constant SOL_PX = 150e6;
    uint64 internal constant HYPE_PX = 40e6;

    uint256 internal constant LP_DEPOSIT = 100_000e6;
    uint256 internal constant T0 = 1_790_000_000;

    BlocklistUSDC internal usdc; // MockUSDC behaviour plus a USDC-style blocklist
    MockPriceSource internal prices;
    MockPositionSource internal positions;
    CoverPool internal pool;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal lp = makeAddr("lp");
    address internal buyer = makeAddr("buyer");
    uint256 internal signerKey = 0xA11CE;
    address internal signer;

    uint256 internal nextNonce = 1;

    function setUp() public virtual {
        vm.warp(T0);
        signer = vm.addr(signerKey);

        usdc = new BlocklistUSDC();
        prices = new MockPriceSource(owner);
        positions = new MockPositionSource(owner);

        vm.startPrank(owner);
        prices.setPrice(BTC, BTC_PX);
        prices.setPrice(ETH, ETH_PX);
        prices.setPrice(SOL, SOL_PX);
        prices.setPrice(HYPE, HYPE_PX);
        // 1 BTC long at 20x: entryNtl 84,000 USD (px6 units) -> margin cap 4,200 USDC
        positions.setPosition(buyer, BTC, 1e5, 84_000e6, 20);
        vm.stopPrank();

        pool = _newPool(_initialLimits());

        _deposit(lp, LP_DEPOSIT);
        _fund(buyer);
    }

    /// @dev Override to start a test contract with other limits.
    function _initialLimits() internal pure virtual returns (ICoverPool.Limits memory) {
        return PoolConfig.testnetLimits();
    }

    function _newPool(ICoverPool.Limits memory l) internal returns (CoverPool) {
        return PoolConfig.deploy(
            IERC20(address(usdc)),
            owner,
            signer,
            guardian,
            IPriceSource(address(prices)),
            IPositionSource(address(positions)),
            l,
            PoolConfig.perps3(BTC, ETH, SOL)
        );
    }

    // ---------------------------------------------------------------- helpers

    function _fund(address who) internal {
        usdc.mint(who, 1_000_000e6);
        vm.prank(who);
        usdc.approve(address(pool), type(uint256).max);
    }

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
            expiry: uint64(vm.getBlockTimestamp() + 1 days),
            spotRef: BTC_PX,
            deadline: uint64(vm.getBlockTimestamp() + 30),
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

    /// @dev Queue, wait configDelay, execute a limits change (the only way limits change, §5.5).
    function _setLimits(ICoverPool.Limits memory l) internal {
        vm.prank(owner);
        pool.queueSetLimits(l);
        vm.warp(vm.getBlockTimestamp() + pool.configDelay());
        vm.prank(owner);
        pool.setLimits(l);
    }

    function _setQuoteSigner(address s) internal {
        vm.prank(owner);
        pool.queueSetQuoteSigner(s);
        vm.warp(vm.getBlockTimestamp() + pool.configDelay());
        vm.prank(owner);
        pool.setQuoteSigner(s);
    }

    function _setPerpAllowed(uint32 perp, bool allowed) internal {
        vm.prank(owner);
        pool.queueSetPerpAllowed(perp, allowed);
        vm.warp(vm.getBlockTimestamp() + pool.configDelay());
        vm.prank(owner);
        pool.setPerpAllowed(perp, allowed);
    }

    function _pause() internal {
        vm.prank(owner);
        pool.setPaused(true);
    }

    function _unpause() internal {
        vm.prank(owner);
        pool.setPaused(false);
    }

    /// @dev Request `shares` for `who` (owner = controller = caller).
    function _request(address who, uint256 shares) internal {
        vm.prank(who);
        pool.requestRedeem(shares, who, who);
    }

    /// @dev Request all of `who`'s shares and warp to the start of the claim window.
    function _requestAllAndMature(address who) internal returns (uint256 shares) {
        shares = pool.balanceOf(who);
        _request(who, shares);
        vm.warp(vm.getBlockTimestamp() + pool.withdrawDelay());
    }

    function _bigPosition(address who, uint32 perp) internal {
        _setPosition(who, perp, perp == ETH ? int64(1e4) : int64(1e5), 10_000_000e6, 10); // cap 1,000,000
    }
}
