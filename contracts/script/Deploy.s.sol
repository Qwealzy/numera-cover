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
import {OraclePxStandIn, PerpAssetInfoStandIn, PositionStandIn} from "./HyperCoreStandIns.sol";

/// @title Deploy — CoverPool v2 + sources on local (31337) or testnet (998) ONLY
/// @notice Normally run through `node scripts/deploy-v2.mjs` (ARCHITECTURE §5.9), which fills this env from
///         deployments/testnet.json, the Info API and .env, and passes --skip-simulation --slow
///         --disable-block-gas-limit (see BIG_BLOCK_GAS_LIMIT). Env:
///   QUOTE_SIGNER   (required) engine signer address
///   PERPS          (required) comma-separated perp indices, copied from deployments/<env>.json `perps`
///                  (never hardcoded: indices differ per network)
///   MODE           `hypercore` (default; HyperCore precompile sources) | `mock` (MOCK demo pool)
///   STANDIN_PX6    (hypercore, required) comma-separated px6 per PERPS entry for the LOCAL precompile stand-ins
///                  (the wrapper fetches them from the Info API); never sent on chain
///   MOCK_PX6       (mock, required) comma-separated initial px6 prices, one per PERPS entry: the pool
///                  constructor validates every perp through the price source, so the mock needs a price first
///   DEPLOYER_KEY   (optional) broadcast key, read here so it never appears in a command line; unset -> forge's
///                  sender (--sender / --unlocked on anvil)
///   USDC           (optional) existing USDC token; unset -> deploys MockUSDC
///   OWNER          (optional) pool/mock owner; default the broadcaster
///   GUARDIAN       (optional) guardian pause key; default none (address 0)
///   CONFIG_DELAY / WITHDRAW_DELAY / CLAIM_WINDOW (optional) seconds; default the testnet values 600/600/3600
///   STRICT         (optional) default false; false is accepted only on 998/31337 (the pool enforces it too)
/// @dev Deploy order (ARCHITECTURE §5.9): price and position sources -> cachePerp for each perp (hypercore) or
///      setPrice (mock) -> pool. Forge's local EVM has no HyperCore precompiles, so for MODE=hypercore `run()`
///      etches stand-ins (script/HyperCoreStandIns.sol) and configures them BEFORE `vm.startBroadcast`.
///      `deploy()` never etches and never calls a stand-in itself, so no transaction to a precompile address is
///      recorded (DeployTest checks this). On chain, forge's per-transaction eth_estimateGas runs the real
///      precompiles; on anvil the hypercore route therefore aborts at estimation, by design.
contract Deploy is Script {
    address internal constant POSITION_PRECOMPILE = 0x0000000000000000000000000000000000000800;
    address internal constant ORACLE_PX_PRECOMPILE = 0x0000000000000000000000000000000000000807;
    address internal constant PERP_INFO_PRECOMPILE = 0x000000000000000000000000000000000000080a;
    /// @notice HyperEVM big-block gas limit (ARCHITECTURE §5.9). The CoverPool creation alone (~4.9M) needs more
    ///         than the 3M small-block limit. forge's local pass forks the RPC's latest block, almost always a 3M
    ///         small block on HyperEVM, and caps every broadcast transaction at that block's gas limit even with
    ///         --block-gas-limit; only --disable-block-gas-limit lifts it (2026-10-02 testnet run: the pool
    ///         creation ran out of gas and forge only said "Failed to decode return value: 0x").
    uint256 public constant BIG_BLOCK_GAS_LIMIT = 30_000_000;

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
        uint256 deployerKey; // 0 = forge's sender; never logged
    }

    function run() external returns (Deployment memory) {
        // Mainnet lock before anything else (deploy() checks again).
        require(block.chainid == 998 || block.chainid == 31337, "Deploy: only testnet (998) or local (31337)");
        uint256[] memory none = new uint256[](0);
        uint256[] memory perps = vm.envOr("PERPS", ",", none);
        uint256[] memory px = vm.envOr("MOCK_PX6", ",", none);
        uint256 key = vm.envOr("DEPLOYER_KEY", uint256(0));
        Config memory c = Config({
            quoteSigner: vm.envAddress("QUOTE_SIGNER"),
            mode: vm.envOr("MODE", string("hypercore")),
            usdc: vm.envOr("USDC", address(0)),
            owner: vm.envOr("OWNER", key != 0 ? vm.addr(key) : msg.sender),
            guardian: vm.envOr("GUARDIAN", address(0)),
            perps: _toUint32(perps),
            mockPx6: _toUint64(px, "Deploy: bad MOCK_PX6"),
            configDelay: uint64(vm.envOr("CONFIG_DELAY", uint256(600))),
            withdrawDelay: uint64(vm.envOr("WITHDRAW_DELAY", uint256(600))),
            claimWindow: uint64(vm.envOr("CLAIM_WINDOW", uint256(3_600))),
            strict: vm.envOr("STRICT", false),
            deployerKey: key
        });
        if (keccak256(bytes(c.mode)) == keccak256("hypercore")) {
            // LOCAL ONLY, before the broadcast window opens.
            installStandIns(c.perps, _toUint64(vm.envOr("STANDIN_PX6", ",", none), "Deploy: bad STANDIN_PX6"));
        }
        return deploy(c);
    }

    /// @notice Etch and configure the HyperCore precompile stand-ins (forge's local pass only). Never call this
    ///         while broadcasting.
    function installStandIns(uint32[] memory perps, uint64[] memory px6) public {
        require(perps.length > 0 && px6.length == perps.length, "Deploy: STANDIN_PX6 needs one price per perp");
        vm.etch(ORACLE_PX_PRECOMPILE, address(new OraclePxStandIn()).code);
        vm.etch(PERP_INFO_PRECOMPILE, address(new PerpAssetInfoStandIn()).code);
        vm.etch(POSITION_PRECOMPILE, address(new PositionStandIn()).code);
        for (uint256 i; i < perps.length; ++i) {
            OraclePxStandIn(ORACLE_PX_PRECOMPILE).set(perps[i], px6[i]); // szDecimals 0: raw = px6
            PerpAssetInfoStandIn(PERP_INFO_PRECOMPILE).set(perps[i]);
        }
    }

    function _toUint32(uint256[] memory a) internal pure returns (uint32[] memory out) {
        out = new uint32[](a.length);
        for (uint256 i; i < a.length; ++i) {
            require(a[i] <= type(uint32).max, "Deploy: perp index out of range");
            out[i] = uint32(a[i]);
        }
    }

    function _toUint64(uint256[] memory a, string memory err) internal pure returns (uint64[] memory out) {
        out = new uint64[](a.length);
        for (uint256 i; i < a.length; ++i) {
            require(a[i] > 0 && a[i] <= type(uint64).max, err);
            out[i] = uint64(a[i]);
        }
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

        if (c.deployerKey != 0) vm.startBroadcast(c.deployerKey);
        else vm.startBroadcast();
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
