// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CoverPool} from "../src/CoverPool.sol";
import {ICoverPool} from "../src/interfaces/ICoverPool.sol";
import {IPriceSource} from "../src/interfaces/IPriceSource.sol";
import {IPositionSource} from "../src/interfaces/IPositionSource.sol";
import {HyperCorePriceSource} from "../src/sources/HyperCorePriceSource.sol";
import {HyperCorePositionSource} from "../src/sources/HyperCorePositionSource.sol";
import {MockPriceSource} from "../src/mocks/MockPriceSource.sol";
import {MockPositionSource} from "../src/mocks/MockPositionSource.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// @title Deploy — CoverPool v2 + sources on local (31337) or testnet (998) ONLY
/// @notice Env:
///   QUOTE_SIGNER   (required) engine signer address
///   PERPS          (required) comma-separated perp indices, copied from deployments/<env>.json `perps`
///                  (never hardcoded: indices differ per network)
///   MODE           `hypercore` (default; HyperCore precompile sources) | `mock` (MOCK demo pool)
///   MOCK_PX6       (mock mode, required) comma-separated initial px6 prices, one per PERPS entry: the pool
///                  constructor validates every perp through the price source, so the mock needs a price first
///   USDC           (optional) existing USDC token; unset -> deploys MockUSDC
///   OWNER          (optional) pool/mock owner; default the broadcasting sender
///   GUARDIAN       (optional) guardian pause key; default none (address 0)
///   CONFIG_DELAY / WITHDRAW_DELAY / CLAIM_WINDOW (optional) seconds; default the testnet values 600/600/3600
///   STRICT         (optional) default false; false is accepted only on 998/31337 (the pool enforces it too)
/// @dev Deploy order (ARCHITECTURE §5.9): price and position sources -> cachePerp for each perp (hypercore) or
///      setPrice (mock) -> pool. Forge's local EVM does not run HyperCore precompiles, so a hypercore-mode run
///      only works where the precompiles answer (the chain itself, or tests that mock them).
///   Local example: anvil & then
///   QUOTE_SIGNER=0x... MODE=mock PERPS=3,4 MOCK_PX6=84000000000,3000000000 \
///     forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
contract Deploy is Script {
    struct Deployment {
        address pool;
        address usdc;
        address priceSource;
        address positionSource;
        bool mock;
    }

    struct Config {
        address quoteSigner;
        string mode;
        address usdc;
        address owner;
        address guardian;
        uint32[] perps;
        uint64[] mockPx6;
        uint64 configDelay;
        uint64 withdrawDelay;
        uint64 claimWindow;
        bool strict;
    }

    function run() external returns (Deployment memory) {
        uint256[] memory none = new uint256[](0);
        uint256[] memory perps = vm.envOr("PERPS", ",", none);
        uint256[] memory px = vm.envOr("MOCK_PX6", ",", none);
        Config memory c = Config({
            quoteSigner: vm.envAddress("QUOTE_SIGNER"),
            mode: vm.envOr("MODE", string("hypercore")),
            usdc: vm.envOr("USDC", address(0)),
            owner: vm.envOr("OWNER", msg.sender),
            guardian: vm.envOr("GUARDIAN", address(0)),
            perps: new uint32[](perps.length),
            mockPx6: new uint64[](px.length),
            configDelay: uint64(vm.envOr("CONFIG_DELAY", uint256(600))),
            withdrawDelay: uint64(vm.envOr("WITHDRAW_DELAY", uint256(600))),
            claimWindow: uint64(vm.envOr("CLAIM_WINDOW", uint256(3_600))),
            strict: vm.envOr("STRICT", false)
        });
        for (uint256 i; i < perps.length; ++i) {
            require(perps[i] <= type(uint32).max, "Deploy: perp index out of range");
            c.perps[i] = uint32(perps[i]);
        }
        for (uint256 i; i < px.length; ++i) {
            require(px[i] > 0 && px[i] <= type(uint64).max, "Deploy: bad MOCK_PX6");
            c.mockPx6[i] = uint64(px[i]);
        }
        return deploy(c);
    }

    /// @notice Testnet limits (ARCHITECTURE §5.2 table, "Testnet value" column).
    function testnetLimits() public pure returns (ICoverPool.Limits memory) {
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

    function deploy(Config memory c) public returns (Deployment memory d) {
        // Mainnet lock: never 999.
        require(block.chainid == 998 || block.chainid == 31337, "Deploy: only testnet (998) or local (31337)");
        require(c.quoteSigner != address(0), "Deploy: QUOTE_SIGNER required");
        require(c.perps.length > 0, "Deploy: PERPS required (from deployments/<env>.json)");

        bytes32 m = keccak256(bytes(c.mode));
        require(m == keccak256("hypercore") || m == keccak256("mock"), "Deploy: MODE must be hypercore or mock");
        d.mock = m == keccak256("mock");
        if (d.mock) require(c.mockPx6.length == c.perps.length, "Deploy: MOCK_PX6 needs one price per perp");

        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        d.usdc = c.usdc == address(0) ? address(new MockUSDC()) : c.usdc;
        if (d.mock) {
            // Owned by the broadcaster until the initial prices are set, then handed to the owner.
            MockPriceSource mp = new MockPriceSource(sender);
            for (uint256 i; i < c.perps.length; ++i) {
                mp.setPrice(c.perps[i], c.mockPx6[i]);
            }
            if (c.owner != sender) mp.transferOwnership(c.owner);
            d.priceSource = address(mp);
            d.positionSource = address(new MockPositionSource(c.owner));
        } else {
            HyperCorePriceSource hp = new HyperCorePriceSource();
            for (uint256 i; i < c.perps.length; ++i) {
                hp.cachePerp(c.perps[i]);
            }
            d.priceSource = address(hp);
            d.positionSource = address(new HyperCorePositionSource());
        }
        d.pool = address(
            new CoverPool(
                IERC20(d.usdc),
                c.owner,
                c.quoteSigner,
                c.guardian,
                IPriceSource(d.priceSource),
                IPositionSource(d.positionSource),
                testnetLimits(),
                c.perps,
                c.configDelay,
                c.withdrawDelay,
                c.claimWindow,
                c.strict
            )
        );
        vm.stopBroadcast();

        console2.log("chainId       ", block.chainid);
        console2.log("mode          ", c.mode);
        console2.log("CoverPool     ", d.pool);
        console2.log("USDC          ", d.usdc);
        console2.log("priceSource   ", d.priceSource);
        console2.log("positionSource", d.positionSource);
        console2.log("owner         ", c.owner);
        console2.log("quoteSigner   ", c.quoteSigner);
        console2.log("guardian      ", c.guardian);
        console2.log("perps         ", c.perps.length);
    }
}
