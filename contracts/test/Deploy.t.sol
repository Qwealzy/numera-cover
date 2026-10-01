// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CoverPool} from "../src/CoverPool.sol";
import {MockPriceSource} from "../src/mocks/MockPriceSource.sol";
import {HyperCorePriceSource} from "../src/sources/HyperCorePriceSource.sol";
import {Deploy} from "../script/Deploy.s.sol";

/// @notice F8 (contract side): deploy script refuses mainnet and wires the right sources per MODE.
/// @dev Calls `deploy(Config)` directly: env vars are process-global and tests run in parallel.
contract DeployTest is Test {
    Deploy internal script;
    address internal signer = makeAddr("signer");

    function setUp() public {
        script = new Deploy();
    }

    function _cfg(string memory mode) internal view returns (Deploy.Config memory) {
        return Deploy.Config({quoteSigner: signer, mode: mode, usdc: address(0), owner: address(this)});
    }

    function test_revert_mainnetChainId() public {
        vm.chainId(999);
        vm.expectRevert(bytes("Deploy: only testnet (998) or local (31337)"));
        script.deploy(_cfg("mock"));
    }

    function test_revert_unknownChainId() public {
        vm.chainId(1);
        vm.expectRevert(bytes("Deploy: only testnet (998) or local (31337)"));
        script.deploy(_cfg("hypercore"));
    }

    function test_revert_badMode() public {
        vm.expectRevert(bytes("Deploy: MODE must be hypercore or mock"));
        script.deploy(_cfg("real"));
    }

    function test_revert_noSigner() public {
        Deploy.Config memory c = _cfg("mock");
        c.quoteSigner = address(0);
        vm.expectRevert(bytes("Deploy: QUOTE_SIGNER required"));
        script.deploy(c);
    }

    function test_deploy_mock_local() public {
        Deploy.Deployment memory d = script.deploy(_cfg("mock"));
        CoverPool pool = CoverPool(d.pool);
        assertTrue(d.mock);
        assertEq(pool.quoteSigner(), signer);
        assertEq(pool.owner(), address(this));
        assertEq(pool.asset(), d.usdc);
        assertEq(address(pool.priceSource()), d.priceSource);
        assertEq(MockPriceSource(d.priceSource).owner(), address(this));
    }

    function test_deploy_hypercore_testnet_existingUsdc() public {
        vm.chainId(998);
        Deploy.Config memory c = _cfg("hypercore");
        c.usdc = address(0x2B3370eE501B4a559b57D449569354196457D8Ab); // testnet USDC (research table)
        Deploy.Deployment memory d = script.deploy(c);
        assertFalse(d.mock);
        assertEq(CoverPool(d.pool).asset(), c.usdc);
        assertEq(address(CoverPool(d.pool).positionSource()), d.positionSource);
        assertEq(HyperCorePriceSource(d.priceSource).ORACLE_PX_PRECOMPILE(), address(0x807));
    }
}
