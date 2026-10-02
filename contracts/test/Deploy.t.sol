// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {CoverPool} from "../src/CoverPool.sol";
import {ICoverPool} from "../src/interfaces/ICoverPool.sol";
import {MockPriceSource} from "../src/mocks/MockPriceSource.sol";
import {HyperCorePriceSource} from "../src/sources/HyperCorePriceSource.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {OraclePxPrecompileMock, PerpAssetInfoPrecompileMock} from "./Sources.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPriceSource} from "../src/interfaces/IPriceSource.sol";
import {IPositionSource} from "../src/interfaces/IPositionSource.sol";
import {MockPositionSource} from "../src/mocks/MockPositionSource.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// @notice Deploy script refuses mainnet, wires the right sources per MODE and passes the v2 constructor args.
/// @dev Calls `deploy(Config)` directly: env vars are process-global and tests run in parallel.
contract DeployTest is Test {
    address internal constant ORACLE_PX = 0x0000000000000000000000000000000000000807;
    address internal constant PERP_INFO = 0x000000000000000000000000000000000000080a;

    Deploy internal script;
    address internal signer = makeAddr("signer");

    function setUp() public {
        script = new Deploy();
    }

    function _cfg(string memory mode) internal view returns (Deploy.Config memory c) {
        c.quoteSigner = signer;
        c.mode = mode;
        c.owner = address(this);
        c.perps = new uint32[](2);
        (c.perps[0], c.perps[1]) = (3, 4); // values as in deployments/testnet.json; the script reads PERPS
        c.mockPx6 = new uint64[](2);
        (c.mockPx6[0], c.mockPx6[1]) = (84_000e6, 3_000e6);
        c.configDelay = 600;
        c.withdrawDelay = 600;
        c.claimWindow = 3_600;
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

    function test_revert_noPerps() public {
        Deploy.Config memory c = _cfg("mock");
        c.perps = new uint32[](0);
        vm.expectRevert(bytes("Deploy: PERPS required (from deployments/<env>.json)"));
        script.deploy(c);
    }

    function test_revert_mockPricesMismatch() public {
        Deploy.Config memory c = _cfg("mock");
        c.mockPx6 = new uint64[](1);
        vm.expectRevert(bytes("Deploy: MOCK_PX6 needs one price per perp"));
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
        assertEq(MockPriceSource(d.priceSource).owner(), address(this), "handed to the owner after seeding");
        assertEq(MockPriceSource(d.priceSource).px6Of(3), 84_000e6);
        assertTrue(pool.perpAllowed(3));
        assertTrue(pool.perpAllowed(4));
        assertFalse(pool.perpAllowed(0));
        assertEq(pool.configDelay(), 600);
        assertEq(pool.withdrawDelay(), 600);
        assertEq(pool.claimWindow(), 3_600);
        assertFalse(pool.strict());
        assertEq(pool.guardian(), address(0));
        assertEq(abi.encode(pool.limits()), abi.encode(script.testnetLimits()));
    }

    function test_testnetLimits_matchSpecTable() public view {
        ICoverPool.Limits memory l = script.testnetLimits();
        assertEq(l.maxUtilizationBps, 8_000);
        assertEq(l.perPerpCapBps, 5_000);
        assertEq(l.maxDuration, 604_800);
        assertEq(l.maxSpotDeviationBps, 30);
        assertEq(l.minPayout, 1e6);
        assertEq(l.minPremiumBps, 20);
        assertEq(l.minLevelDistanceBps, 25);
        assertEq(l.saleWindow, 3_600);
        assertEq(l.maxSoldPerWindowBps, 2_500);
        assertEq(l.maxBuyerWindowShareBps, 2_500);
        assertEq(l.maxPaidPerWindowBps, 1_500);
    }

    /// @dev HyperCore precompiles are stood in by vm.etch'd mocks; on chain the real ones answer.
    function test_deploy_hypercore_testnet_existingUsdc() public {
        vm.chainId(998);
        vm.etch(ORACLE_PX, address(new OraclePxPrecompileMock()).code);
        vm.etch(PERP_INFO, address(new PerpAssetInfoPrecompileMock()).code);
        PerpAssetInfoPrecompileMock(PERP_INFO).set(3, "BTC", 5);
        PerpAssetInfoPrecompileMock(PERP_INFO).set(4, "ETH", 4);
        OraclePxPrecompileMock(ORACLE_PX).set(3, 842456);
        OraclePxPrecompileMock(ORACLE_PX).set(4, 301250);

        Deploy.Config memory c = _cfg("hypercore");
        c.usdc = address(0x2B3370eE501B4a559b57D449569354196457D8Ab); // testnet USDC (research table)
        c.guardian = makeAddr("guardian");
        Deploy.Deployment memory d = script.deploy(c);
        assertFalse(d.mock);
        CoverPool pool = CoverPool(d.pool);
        assertEq(pool.asset(), c.usdc);
        assertEq(address(pool.positionSource()), d.positionSource);
        assertEq(pool.guardian(), c.guardian);
        assertEq(HyperCorePriceSource(d.priceSource).ORACLE_PX_PRECOMPILE(), address(0x807));
        (bool cached, uint8 szDecimals) = HyperCorePriceSource(d.priceSource).cachedPerp(3);
        assertTrue(cached, "cachePerp ran before the pool");
        assertEq(szDecimals, 5);
        assertTrue(pool.perpAllowed(4));
    }

    function test_revert_hypercore_unknownPerpFailsDeploy() public {
        vm.etch(ORACLE_PX, address(new OraclePxPrecompileMock()).code);
        vm.etch(PERP_INFO, address(new PerpAssetInfoPrecompileMock()).code);
        PerpAssetInfoPrecompileMock(PERP_INFO).set(3, "BTC", 5);
        OraclePxPrecompileMock(ORACLE_PX).set(3, 842456);
        vm.expectRevert(abi.encodeWithSelector(HyperCorePriceSource.PrecompileCallFailed.selector, PERP_INFO, 4));
        script.deploy(_cfg("hypercore"));
    }

    address internal constant POSITION = 0x0000000000000000000000000000000000000800;

    function _isPrecompile(address a) internal pure returns (bool) {
        return a == POSITION || a == ORACLE_PX || a == PERP_INFO;
    }

    /// @dev The §5.9 route: run() installs the stand-ins before the broadcast window; inside deploy() every
    ///      access to a precompile address comes from the price source's internal reads, never from the
    ///      broadcaster (i.e. no broadcast transaction targets a precompile).
    function test_hypercore_standIns_noBroadcastTxToPrecompiles() public {
        vm.chainId(998);
        Deploy.Config memory c = _cfg("hypercore");
        script.installStandIns(c.perps, c.mockPx6); // stand-in px6 (the wrapper passes STANDIN_PX6)

        vm.startStateDiffRecording();
        Deploy.Deployment memory d = script.deploy(c);
        Vm.AccountAccess[] memory acc = vm.stopAndReturnStateDiff();

        uint256 reads;
        for (uint256 i; i < acc.length; ++i) {
            if (!_isPrecompile(acc[i].account)) continue;
            assertEq(acc[i].accessor, d.priceSource, "only the price source touches a precompile address");
            assertTrue(acc[i].depth > 1, "never a top-level (broadcast) call");
            reads++;
        }
        assertGt(reads, 0, "the stand-ins answered cachePerp and the constructor check");
        assertTrue(CoverPool(d.pool).perpAllowed(3));
        assertEq(CoverPool(d.pool).priceSource().oraclePx6(3), 84_000e6, "stand-in: szDecimals 0, raw = px6");
    }

    function test_revert_installStandIns_needsOnePricePerPerp() public {
        uint32[] memory perps = new uint32[](2);
        uint64[] memory px = new uint64[](1);
        vm.expectRevert(bytes("Deploy: STANDIN_PX6 needs one price per perp"));
        script.installStandIns(perps, px);
    }

    /// @dev DEPLOYER_KEY is read inside the script: the broadcaster is that key's address.
    function test_deploy_withDeployerKey() public {
        uint256 key = 0xD3910;
        address deployer = vm.addr(key);
        Deploy.Config memory c = _cfg("mock");
        c.deployerKey = key;
        uint64 n0 = vm.getNonce(deployer);
        Deploy.Deployment memory d = script.deploy(c);
        assertEq(vm.getNonce(deployer), n0 + 7, "MockUSDC, price source, 2x setPrice, transfer, position source, pool");
        assertEq(MockPriceSource(d.priceSource).owner(), address(this), "handed from the key's address to the owner");
    }

    /// @dev The pool refuses strict = false off testnet/local even if a script were changed (§5.6).
    function test_strictFlag_passedThrough() public {
        Deploy.Config memory c = _cfg("mock");
        c.strict = true;
        c.configDelay = 48 hours;
        c.withdrawDelay = 8 days;
        c.claimWindow = 1 days;
        Deploy.Deployment memory d = script.deploy(c);
        assertTrue(CoverPool(d.pool).strict());
    }

    /// @dev 2026-10-02 testnet run: forge's local pass took the RPC's 3M small-block gas limit, the CoverPool
    ///      creation ran out of gas and forge only said "Failed to decode return value: 0x". The pool creation alone
    ///      needs more than a small block and fits a big block, so the wrapper must pass
    ///      --block-gas-limit BIG_BLOCK_GAS_LIMIT (scripts/lib/deployv2.test.mjs checks the flag).
    function test_poolCreation_needsBigBlockGasLimit() public {
        Deploy.Config memory c = _cfg("mock");
        MockPriceSource mp = new MockPriceSource(address(this));
        for (uint256 i; i < c.perps.length; ++i) {
            mp.setPrice(c.perps[i], c.mockPx6[i]);
        }
        address usdc = address(new MockUSDC());
        address pos = address(new MockPositionSource(address(this)));

        try this.createPool{gas: 3_000_000}(c, usdc, address(mp), pos) {
            fail("pool creation fits a 3M small block: the big-block flag is no longer needed");
        } catch {}
        address pool = this.createPool{gas: script.BIG_BLOCK_GAS_LIMIT()}(c, usdc, address(mp), pos);
        assertTrue(CoverPool(pool).perpAllowed(3), "fits a big block");
    }

    function createPool(Deploy.Config memory c, address usdc, address price, address pos) external returns (address) {
        return address(
            new CoverPool(
                IERC20(usdc),
                c.owner,
                c.quoteSigner,
                c.guardian,
                IPriceSource(price),
                IPositionSource(pos),
                script.testnetLimits(),
                c.perps,
                c.configDelay,
                c.withdrawDelay,
                c.claimWindow,
                false
            )
        );
    }
}
