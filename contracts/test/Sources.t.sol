// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CoverPool} from "../src/CoverPool.sol";
import {ICoverPool} from "../src/interfaces/ICoverPool.sol";
import {HyperCorePriceSource} from "../src/sources/HyperCorePriceSource.sol";
import {HyperCorePositionSource} from "../src/sources/HyperCorePositionSource.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {IPriceSource} from "../src/interfaces/IPriceSource.sol";
import {IPositionSource} from "../src/interfaces/IPositionSource.sol";
import {PoolConfig} from "./utils/PoolConfig.sol";

// ---------------------------------------------------------------- precompile stand-ins (vm.etch'd)
// HyperCore precompiles take raw abi.encode(args) with no selector. The stand-ins decode the same input in
// their fallback. Setters have non-zero selectors, so they never collide with small encoded indices.

contract OraclePxPrecompileMock {
    mapping(uint32 => uint64) internal px;

    function set(uint32 perp, uint64 raw) external {
        px[perp] = raw;
    }

    fallback(bytes calldata data) external returns (bytes memory) {
        return abi.encode(px[abi.decode(data, (uint32))]);
    }
}

contract PerpAssetInfoPrecompileMock {
    mapping(uint32 => bool) internal exists;
    mapping(uint32 => HyperCorePriceSource.PerpAssetInfo) internal info;

    function set(uint32 perp, string calldata coin, uint8 szDecimals) external {
        exists[perp] = true;
        info[perp] = HyperCorePriceSource.PerpAssetInfo(coin, 0, szDecimals, 40, false);
    }

    fallback(bytes calldata data) external returns (bytes memory) {
        uint32 perp = abi.decode(data, (uint32));
        // Real precompile on an invalid index: fails and burns all forwarded gas.
        if (!exists[perp]) {
            assembly {
                invalid()
            }
        }
        return abi.encode(info[perp]);
    }
}

contract PositionPrecompileMock {
    mapping(address => mapping(uint16 => HyperCorePositionSource.Position)) internal pos;

    function set(address user, uint16 perp, int64 szi, uint64 entryNtl, uint32 leverage) external {
        pos[user][perp] = HyperCorePositionSource.Position(szi, entryNtl, 0, leverage, false);
    }

    fallback(bytes calldata data) external returns (bytes memory) {
        (address user, uint16 perp) = abi.decode(data, (address, uint16));
        return abi.encode(pos[user][perp]);
    }
}

contract RevertingPrecompileMock {
    fallback() external {
        revert("precompile error");
    }
}

/// @notice HyperCore source readers against etched precompile stand-ins at 0x…0800 / 0x…0807 / 0x…080a.
contract SourcesTest is Test {
    address internal constant POSITION = 0x0000000000000000000000000000000000000800;
    address internal constant ORACLE_PX = 0x0000000000000000000000000000000000000807;
    address internal constant PERP_INFO = 0x000000000000000000000000000000000000080a;

    uint32 internal constant BTC = 3; // testnet indices (research table)
    uint32 internal constant ETH = 4;
    uint32 internal constant SOL = 0;
    uint32 internal constant UNKNOWN = 999;

    HyperCorePriceSource internal priceSrc;
    HyperCorePositionSource internal posSrc;
    address internal trader = makeAddr("trader");

    function setUp() public {
        vm.etch(ORACLE_PX, address(new OraclePxPrecompileMock()).code);
        vm.etch(PERP_INFO, address(new PerpAssetInfoPrecompileMock()).code);
        vm.etch(POSITION, address(new PositionPrecompileMock()).code);

        // Raw values have (6 - szDecimals) decimals.
        PerpAssetInfoPrecompileMock(PERP_INFO).set(BTC, "BTC", 5);
        PerpAssetInfoPrecompileMock(PERP_INFO).set(ETH, "ETH", 4);
        PerpAssetInfoPrecompileMock(PERP_INFO).set(SOL, "SOL", 2);
        OraclePxPrecompileMock(ORACLE_PX).set(BTC, 842456); // 84,245.6 USD [RUN 2026-10-01]
        OraclePxPrecompileMock(ORACLE_PX).set(ETH, 301250); // 3,012.50 USD (2 decimals)
        OraclePxPrecompileMock(ORACLE_PX).set(SOL, 1504321); // 150.4321 USD

        priceSrc = new HyperCorePriceSource();
        posSrc = new HyperCorePositionSource();
    }

    // ================================================================ price: px6 normalization

    function test_oraclePx6_btc_rawTimesTenPowSzDecimals() public view {
        assertEq(priceSrc.oraclePx6(BTC), 84_245_600_000); // 842456 x 10^5
        assertEq(priceSrc.rawOraclePx(BTC), 842456);
    }

    function test_oraclePx6_eth_and_sol() public view {
        assertEq(priceSrc.oraclePx6(ETH), 3_012_500_000); // 301250 x 10^4
        assertEq(priceSrc.oraclePx6(SOL), 150_432_100); // 1504321 x 10^2
    }

    function test_cachePerp_storesAndSurvivesInfoPrecompileOutage() public {
        vm.expectEmit(true, false, false, true, address(priceSrc));
        emit HyperCorePriceSource.PerpCached(BTC, "BTC", 5);
        assertEq(priceSrc.cachePerp(BTC), 5);
        (bool cached, uint8 sz) = priceSrc.cachedPerp(BTC);
        assertTrue(cached);
        assertEq(sz, 5);

        vm.etch(PERP_INFO, ""); // info precompile gone: cached perp still prices
        assertEq(priceSrc.oraclePx6(BTC), 84_245_600_000);
        vm.expectRevert(
            abi.encodeWithSelector(HyperCorePriceSource.PrecompileCallFailed.selector, PERP_INFO, ETH)
        );
        priceSrc.oraclePx6(ETH);
    }

    // ================================================================ price: failure paths

    function test_revert_invalidIndex_namedErrorAndGasCapped() public {
        uint256 g0 = gasleft();
        try priceSrc.oraclePx6(UNKNOWN) {
            fail();
        } catch (bytes memory err) {
            assertEq(
                err, abi.encodeWithSelector(HyperCorePriceSource.PrecompileCallFailed.selector, PERP_INFO, UNKNOWN)
            );
        }
        uint256 used = g0 - gasleft();
        // invalid() burns everything forwarded; the cap bounds the loss.
        assertGe(used, priceSrc.PERP_INFO_GAS() * 9 / 10, "stand-in did burn the forwarded gas");
        assertLt(used, priceSrc.PERP_INFO_GAS() + 30_000, "gas cap bounded the burn");
    }

    function test_revert_cachePerp_invalidIndex() public {
        vm.expectRevert(
            abi.encodeWithSelector(HyperCorePriceSource.PrecompileCallFailed.selector, PERP_INFO, UNKNOWN)
        );
        priceSrc.cachePerp(UNKNOWN);
    }

    function test_revert_noPrecompile_emptyCode() public {
        // A plain chain (anvil, unforked) has no code at 0x…0807: empty return data -> named error.
        vm.etch(ORACLE_PX, "");
        vm.expectRevert(
            abi.encodeWithSelector(HyperCorePriceSource.PrecompileCallFailed.selector, ORACLE_PX, BTC)
        );
        priceSrc.oraclePx6(BTC);
    }

    function test_revert_precompileReverts() public {
        vm.etch(ORACLE_PX, address(new RevertingPrecompileMock()).code);
        vm.expectRevert(
            abi.encodeWithSelector(HyperCorePriceSource.PrecompileCallFailed.selector, ORACLE_PX, BTC)
        );
        priceSrc.oraclePx6(BTC);
    }

    function test_revert_zeroPriceNeverLooksLikeABreach() public {
        OraclePxPrecompileMock(ORACLE_PX).set(BTC, 0);
        vm.expectRevert(abi.encodeWithSelector(HyperCorePriceSource.InvalidOraclePrice.selector, BTC));
        priceSrc.oraclePx6(BTC);
    }

    function test_revert_szDecimalsAboveSix() public {
        PerpAssetInfoPrecompileMock(PERP_INFO).set(7, "BAD", 7);
        vm.expectRevert(abi.encodeWithSelector(HyperCorePriceSource.InvalidPerpInfo.selector, 7, 7));
        priceSrc.oraclePx6(7);
    }

    function test_revert_priceOverflow() public {
        PerpAssetInfoPrecompileMock(PERP_INFO).set(8, "BIG", 6);
        OraclePxPrecompileMock(ORACLE_PX).set(8, type(uint64).max);
        vm.expectRevert(
            abi.encodeWithSelector(
                HyperCorePriceSource.PriceOverflow.selector, 8, uint256(type(uint64).max) * 1e6
            )
        );
        priceSrc.oraclePx6(8);
    }

    // ================================================================ position

    function test_position_long() public {
        PositionPrecompileMock(POSITION).set(trader, uint16(BTC), 12345, 10_400_000_000, 20);
        (int64 szi, uint64 entryNtl, uint32 lev) = posSrc.position(trader, BTC);
        assertEq(szi, 12345);
        assertEq(entryNtl, 10_400_000_000);
        assertEq(lev, 20);
    }

    function test_position_short() public {
        PositionPrecompileMock(POSITION).set(trader, uint16(ETH), -500, 1_500_000_000, 5);
        (int64 szi,, uint32 lev) = posSrc.position(trader, ETH);
        assertEq(szi, -500);
        assertEq(lev, 5);
    }

    function test_position_none_isZero() public view {
        (int64 szi, uint64 entryNtl, uint32 lev) = posSrc.position(trader, SOL);
        assertEq(szi, 0);
        assertEq(entryNtl, 0);
        assertEq(lev, 0);
    }

    function test_revert_position_indexAboveUint16() public {
        vm.expectRevert(abi.encodeWithSelector(HyperCorePositionSource.PerpIndexOutOfRange.selector, 70_000));
        posSrc.position(trader, 70_000);
    }

    function test_revert_position_noPrecompile() public {
        vm.etch(POSITION, "");
        vm.expectRevert(
            abi.encodeWithSelector(HyperCorePositionSource.PrecompileCallFailed.selector, POSITION, BTC)
        );
        posSrc.position(trader, BTC);
    }

    // ================================================================ CoverPool on HyperCore sources, end to end

    function test_coverPool_onHyperCoreSources_buyAndTrigger() public {
        // A realistic clock: the sale window opens at the first sale once now >= windowStart(0) + saleWindow.
        vm.warp(1_790_000_000);
        uint256 key = 0xA11CE;
        MockUSDC usdc = new MockUSDC();
        // The constructor validates BTC through the price source (precompile stand-ins answer here).
        CoverPool pool = PoolConfig.deploy(
            IERC20(address(usdc)),
            address(this),
            vm.addr(key),
            address(0),
            IPriceSource(address(priceSrc)),
            IPositionSource(address(posSrc)),
            PoolConfig.testnetLimits(),
            PoolConfig.perps1(BTC)
        );
        usdc.mint(address(this), 100_000e6);
        usdc.approve(address(pool), 100_000e6);
        pool.deposit(100_000e6, address(this));

        // 1 BTC long at 20x, entryNtl 84,245.6 USD (assumed px6 scale) -> cap 4,212.28 USDC
        PositionPrecompileMock(POSITION).set(trader, uint16(BTC), 1e5, 84_245_600_000, 20);
        usdc.mint(trader, 100e6);
        vm.prank(trader);
        usdc.approve(address(pool), 100e6);

        ICoverPool.Quote memory q = ICoverPool.Quote({
            buyer: trader,
            perpIndex: BTC,
            isLong: true,
            level: 80_000e6,
            payout: 4_000e6,
            premium: 50e6,
            expiry: uint64(vm.getBlockTimestamp() + 1 days),
            spotRef: 84_245_600_000,
            deadline: uint64(vm.getBlockTimestamp() + 60),
            nonce: 7
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, pool.quoteDigest(q));
        vm.prank(trader);
        uint256 id = pool.buyCover(q, abi.encodePacked(r, s, v));

        OraclePxPrecompileMock(ORACLE_PX).set(BTC, 799999); // 79,999.9 USD
        pool.trigger(id);
        assertEq(usdc.balanceOf(trader), 100e6 - 50e6 + 4_000e6);
        assertEq(pool.lockedAssets(), 0);
    }

    /// @dev A bad perp index fails the pool deploy with the price source's own error (§5.5).
    function test_revert_coverPool_constructorValidatesPerps() public {
        MockUSDC usdc = new MockUSDC();
        vm.expectRevert(
            abi.encodeWithSelector(HyperCorePriceSource.PrecompileCallFailed.selector, PERP_INFO, UNKNOWN)
        );
        PoolConfig.deploy(
            IERC20(address(usdc)),
            address(this),
            address(1),
            address(0),
            IPriceSource(address(priceSrc)),
            IPositionSource(address(posSrc)),
            PoolConfig.testnetLimits(),
            PoolConfig.perps3(BTC, UNKNOWN, ETH)
        );
    }
}
