// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CoverPool} from "../../src/CoverPool.sol";
import {ICoverPool} from "../../src/interfaces/ICoverPool.sol";
import {IPriceSource} from "../../src/interfaces/IPriceSource.sol";
import {IPositionSource} from "../../src/interfaces/IPositionSource.sol";

/// @dev Shared v2 deploy parameters for tests: the testnet column of ARCHITECTURE §5.2 / §5.6.
library PoolConfig {
    uint64 internal constant CONFIG_DELAY = 600;
    uint64 internal constant WITHDRAW_DELAY = 600;
    uint64 internal constant CLAIM_WINDOW = 3_600;

    function testnetLimits() internal pure returns (ICoverPool.Limits memory) {
        return ICoverPool.Limits({
            maxUtilizationBps: 8_000,
            perPerpCapBps: 5_000,
            maxDuration: 604_800,
            maxSpotDeviationBps: 30,
            minPayout: 1e6,
            minPremiumBps: 20,
            minLevelDistanceBps: 25,
            saleWindow: 3_600,
            maxSoldPerWindowBps: 2_500,
            maxBuyerWindowShareBps: 2_500,
            maxPaidPerWindowBps: 1_500
        });
    }

    /// @dev Limits that keep the throttle out of the way (window cap = utilization cap, one buyer may fill it),
    ///      for tests of other checks. Still inside the always-bounds.
    function looseLimits() internal pure returns (ICoverPool.Limits memory l) {
        l = testnetLimits();
        l.maxSoldPerWindowBps = l.maxUtilizationBps;
        l.maxBuyerWindowShareBps = 10_000;
        l.maxPaidPerWindowBps = l.maxSoldPerWindowBps;
    }

    function perps1(uint32 a) internal pure returns (uint32[] memory p) {
        p = new uint32[](1);
        p[0] = a;
    }

    function perps3(uint32 a, uint32 b, uint32 c) internal pure returns (uint32[] memory p) {
        p = new uint32[](3);
        (p[0], p[1], p[2]) = (a, b, c);
    }

    function deploy(
        IERC20 usdc,
        address owner,
        address signer,
        address guardian,
        IPriceSource prices,
        IPositionSource positions,
        ICoverPool.Limits memory l,
        uint32[] memory perps
    ) internal returns (CoverPool) {
        return new CoverPool(
            usdc, owner, signer, guardian, prices, positions, l, perps, CONFIG_DELAY, WITHDRAW_DELAY, CLAIM_WINDOW, false
        );
    }

    function ctorArgs(
        address usdc,
        address owner,
        address signer,
        address prices,
        address positions,
        uint32[] memory perps
    ) internal pure returns (bytes memory) {
        return abi.encode(
            usdc,
            owner,
            signer,
            address(0),
            prices,
            positions,
            testnetLimits(),
            perps,
            CONFIG_DELAY,
            WITHDRAW_DELAY,
            CLAIM_WINDOW,
            false
        );
    }
}
