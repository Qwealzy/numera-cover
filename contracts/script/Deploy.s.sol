// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CoverPool} from "../src/CoverPool.sol";
import {IPriceSource} from "../src/interfaces/IPriceSource.sol";
import {IPositionSource} from "../src/interfaces/IPositionSource.sol";
import {HyperCorePriceSource} from "../src/sources/HyperCorePriceSource.sol";
import {HyperCorePositionSource} from "../src/sources/HyperCorePositionSource.sol";
import {MockPriceSource} from "../src/mocks/MockPriceSource.sol";
import {MockPositionSource} from "../src/mocks/MockPositionSource.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// @title Deploy — CoverPool + sources on local (31337) or testnet (998) ONLY
/// @notice Env:
///   QUOTE_SIGNER  (required) engine signer address
///   MODE          `hypercore` (default; HyperCore precompile sources) | `mock` (MOCK demo pool, docs/how-it-works.md §8)
///   USDC          (optional) existing USDC token; unset -> deploys MockUSDC
///   OWNER         (optional) pool/mock owner; default the broadcasting sender
/// @dev Example (local): anvil & then
///   QUOTE_SIGNER=0x... MODE=mock forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
///   Forge's simulation EVM does not run HyperCore precompiles, so do not call source reads here.
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
    }

    function run() external returns (Deployment memory) {
        return deploy(
            Config({
                quoteSigner: vm.envAddress("QUOTE_SIGNER"),
                mode: vm.envOr("MODE", string("hypercore")),
                usdc: vm.envOr("USDC", address(0)),
                owner: vm.envOr("OWNER", msg.sender)
            })
        );
    }

    function deploy(Config memory c) public returns (Deployment memory d) {
        // Mainnet lock: never 999.
        require(block.chainid == 998 || block.chainid == 31337, "Deploy: only testnet (998) or local (31337)");

        address signer = c.quoteSigner;
        string memory mode = c.mode;
        address usdc = c.usdc;
        address owner = c.owner;
        require(signer != address(0), "Deploy: QUOTE_SIGNER required");

        bytes32 m = keccak256(bytes(mode));
        require(m == keccak256("hypercore") || m == keccak256("mock"), "Deploy: MODE must be hypercore or mock");
        d.mock = m == keccak256("mock");

        vm.startBroadcast();
        if (usdc == address(0)) usdc = address(new MockUSDC());
        if (d.mock) {
            d.priceSource = address(new MockPriceSource(owner));
            d.positionSource = address(new MockPositionSource(owner));
        } else {
            d.priceSource = address(new HyperCorePriceSource());
            d.positionSource = address(new HyperCorePositionSource());
        }
        d.pool = address(
            new CoverPool(
                IERC20(usdc), owner, signer, IPriceSource(d.priceSource), IPositionSource(d.positionSource)
            )
        );
        vm.stopBroadcast();
        d.usdc = usdc;

        console2.log("chainId       ", block.chainid);
        console2.log("mode          ", mode);
        console2.log("CoverPool     ", d.pool);
        console2.log("USDC          ", d.usdc);
        console2.log("priceSource   ", d.priceSource);
        console2.log("positionSource", d.positionSource);
        console2.log("owner         ", owner);
        console2.log("quoteSigner   ", signer);
    }
}
