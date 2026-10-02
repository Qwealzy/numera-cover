// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CoverPool} from "../src/CoverPool.sol";
import {ICoverPool} from "../src/interfaces/ICoverPool.sol";
import {IPriceSource} from "../src/interfaces/IPriceSource.sol";
import {IPositionSource} from "../src/interfaces/IPositionSource.sol";
import {MockPriceSource} from "../src/mocks/MockPriceSource.sol";
import {BaseTest} from "./Base.t.sol";
import {PoolConfig} from "./utils/PoolConfig.sol";

/// @notice §5.5 owner controls (Ownable2Step, timelock, guardian, pause), §5.2 limit bounds, §5.6 constructor.
contract AdminTest is BaseTest {
    uint64 internal constant DELAY = 600;
    uint64 internal constant GRACE = 14 days;

    // ================================================================ initial state (constructor, §5.5 / §5.6)

    function test_initialState() public view {
        assertEq(pool.owner(), owner);
        assertEq(pool.quoteSigner(), signer);
        assertEq(pool.guardian(), guardian);
        assertEq(pool.configDelay(), 600);
        assertEq(pool.withdrawDelay(), 600);
        assertEq(pool.claimWindow(), 3_600);
        assertFalse(pool.strict());
        assertEq(pool.CONFIG_GRACE(), 14 days);
        assertTrue(pool.perpAllowed(BTC));
        assertTrue(pool.perpAllowed(ETH));
        assertTrue(pool.perpAllowed(SOL));
        assertFalse(pool.perpAllowed(HYPE));
        assertEq(abi.encode(pool.limits()), abi.encode(PoolConfig.testnetLimits()));
    }

    function test_individualLimitGetters() public view {
        ICoverPool.Limits memory l = pool.limits();
        assertEq(pool.maxUtilizationBps(), l.maxUtilizationBps);
        assertEq(pool.perPerpCapBps(), l.perPerpCapBps);
        assertEq(pool.maxDuration(), l.maxDuration);
        assertEq(pool.maxSpotDeviationBps(), l.maxSpotDeviationBps);
        assertEq(pool.minPayout(), l.minPayout);
        assertEq(pool.minPremiumBps(), l.minPremiumBps);
        assertEq(pool.minLevelDistanceBps(), l.minLevelDistanceBps);
        assertEq(pool.saleWindow(), l.saleWindow);
        assertEq(pool.maxSoldPerWindowBps(), l.maxSoldPerWindowBps);
        assertEq(pool.maxBuyerWindowShareBps(), l.maxBuyerWindowShareBps);
        assertEq(pool.maxPaidPerWindowBps(), l.maxPaidPerWindowBps);
    }

    function test_constructor_emitsSettingEvents() public {
        ICoverPool.Limits memory l = PoolConfig.testnetLimits();
        vm.expectEmit();
        emit ICoverPool.QuoteSignerUpdated(signer);
        vm.expectEmit();
        emit ICoverPool.LimitsUpdated(l);
        vm.expectEmit();
        emit ICoverPool.GuardianUpdated(guardian);
        vm.expectEmit();
        emit ICoverPool.PerpAllowedUpdated(BTC, true);
        vm.expectEmit();
        emit ICoverPool.PerpAllowedUpdated(ETH, true);
        vm.expectEmit();
        emit ICoverPool.PerpAllowedUpdated(SOL, true);
        _newPool(l);
    }

    // ================================================================ constructor reverts (§5.6)

    struct Ctor {
        address usdc;
        address owner;
        address signer;
        address guardian;
        address prices;
        address positions;
        ICoverPool.Limits limits;
        uint32[] perps;
        uint64 configDelay;
        uint64 withdrawDelay;
        uint64 claimWindow;
        bool strict;
    }

    function _ctor() internal view returns (Ctor memory c) {
        c = Ctor(
            address(usdc),
            owner,
            signer,
            guardian,
            address(prices),
            address(positions),
            PoolConfig.testnetLimits(),
            PoolConfig.perps3(BTC, ETH, SOL),
            DELAY,
            600,
            3_600,
            false
        );
    }

    function _strictCtor() internal view returns (Ctor memory c) {
        c = _ctor();
        c.strict = true;
        c.configDelay = 48 hours;
        c.withdrawDelay = 7 days;
        c.claimWindow = 1 days;
    }

    function _deploy(Ctor memory c) internal returns (CoverPool) {
        return new CoverPool(
            IERC20(c.usdc),
            c.owner,
            c.signer,
            c.guardian,
            IPriceSource(c.prices),
            IPositionSource(c.positions),
            c.limits,
            c.perps,
            c.configDelay,
            c.withdrawDelay,
            c.claimWindow,
            c.strict
        );
    }

    function _expectCtorRevert(Ctor memory c, bytes memory err) internal {
        vm.expectRevert(err);
        _deploy(c);
    }

    function test_revert_ctor_zeroAddresses() public {
        bytes memory zero = abi.encodeWithSelector(ICoverPool.ZeroAddress.selector);
        Ctor memory c = _ctor();
        c.usdc = address(0);
        // ERC4626 reads asset decimals in its constructor; a zero asset falls back to 18 and then reverts here
        _expectCtorRevert(c, zero);
        c = _ctor();
        c.signer = address(0);
        _expectCtorRevert(c, zero);
        c = _ctor();
        c.prices = address(0);
        _expectCtorRevert(c, zero);
        c = _ctor();
        c.positions = address(0);
        _expectCtorRevert(c, zero);
        c = _ctor();
        c.owner = address(0);
        _expectCtorRevert(c, abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
    }

    function test_ctor_guardianMayBeZero() public {
        Ctor memory c = _ctor();
        c.guardian = address(0);
        assertEq(_deploy(c).guardian(), address(0));
    }

    function test_revert_ctor_strictRequiredOffTestnet() public {
        Ctor memory c = _ctor();
        vm.chainId(999);
        _expectCtorRevert(c, abi.encodeWithSelector(ICoverPool.StrictRequired.selector));
        vm.chainId(1);
        _expectCtorRevert(c, abi.encodeWithSelector(ICoverPool.StrictRequired.selector));
        // a strict deploy is accepted on any chain (the deploy scripts still refuse 999)
        assertTrue(_deploy(_strictCtor()).strict());
        vm.chainId(998);
        assertFalse(_deploy(c).strict());
    }

    function test_revert_ctor_invalidDelays_always() public {
        bytes memory err = abi.encodeWithSelector(ICoverPool.InvalidDelays.selector);
        Ctor memory c = _ctor();
        c.configDelay = 5 minutes - 1;
        _expectCtorRevert(c, err);
        c.configDelay = 30 days + 1;
        _expectCtorRevert(c, err);
        c = _ctor();
        c.withdrawDelay = 5 minutes - 1;
        _expectCtorRevert(c, err);
        c.withdrawDelay = 60 days + 1;
        _expectCtorRevert(c, err);
        c = _ctor();
        c.claimWindow = 10 minutes - 1;
        _expectCtorRevert(c, err);
        c.claimWindow = 7 days + 1;
        _expectCtorRevert(c, err);
        // bounds are inclusive
        c = _ctor();
        (c.configDelay, c.withdrawDelay, c.claimWindow) = (5 minutes, 5 minutes, 10 minutes);
        _deploy(c);
        (c.configDelay, c.withdrawDelay, c.claimWindow) = (30 days, 60 days, 7 days);
        c.limits.maxDuration = 30 days;
        _deploy(c);
    }

    function test_revert_ctor_invalidDelays_strict() public {
        bytes memory err = abi.encodeWithSelector(ICoverPool.InvalidDelays.selector);
        Ctor memory c = _strictCtor();
        c.configDelay = 48 hours - 1;
        _expectCtorRevert(c, err);
        c = _strictCtor();
        c.claimWindow = 1 days + 1; // also > withdrawDelay / 7
        _expectCtorRevert(c, err);
        c = _strictCtor();
        c.withdrawDelay = 14 days;
        c.claimWindow = 1 days + 1; // <= withdrawDelay / 7 but > 1 day
        _expectCtorRevert(c, err);
        c = _strictCtor();
        c.withdrawDelay = 6 days;
        c.limits.maxDuration = 6 days;
        c.claimWindow = uint64(6 days) / 7 + 1; // > withdrawDelay / 7
        _expectCtorRevert(c, err);
        c.claimWindow = uint64(6 days) / 7;
        _deploy(c);
    }

    /// @dev Strict: withdrawDelay >= maxDuration, checked by _validateLimits (now and in every later setLimits).
    function test_revert_ctor_strict_withdrawDelayBelowMaxDuration() public {
        Ctor memory c = _strictCtor();
        c.withdrawDelay = 7 days - 1;
        c.claimWindow = 10 minutes;
        _expectCtorRevert(c, abi.encodeWithSelector(ICoverPool.InvalidLimits.selector));
    }

    function test_revert_ctor_invalidLimits() public {
        Ctor memory c = _ctor();
        c.limits.minPremiumBps = 0;
        _expectCtorRevert(c, abi.encodeWithSelector(ICoverPool.InvalidLimits.selector));
    }

    function test_revert_ctor_badPerpFailsWithSourceError() public {
        Ctor memory c = _ctor();
        c.perps = PoolConfig.perps3(BTC, 777, ETH);
        _expectCtorRevert(c, abi.encodeWithSelector(MockPriceSource.PriceNotSet.selector, uint32(777)));
    }

    // ================================================================ limit bounds (§5.2 table)

    function _expectLimitsRevert(ICoverPool.Limits memory l) internal {
        vm.prank(owner);
        vm.expectRevert(ICoverPool.InvalidLimits.selector);
        pool.queueSetLimits(l);
    }

    /// @dev Queues (must succeed) and cancels, so the same limits can be probed again.
    function _expectLimitsOk(ICoverPool.Limits memory l) internal {
        vm.startPrank(owner);
        pool.cancel(pool.queueSetLimits(l));
        vm.stopPrank();
    }

    /// @dev Memory structs assign by reference; probes need independent copies.
    function _copy(ICoverPool.Limits memory l) internal pure returns (ICoverPool.Limits memory) {
        return abi.decode(abi.encode(l), (ICoverPool.Limits));
    }

    function test_limitBounds_always() public {
        ICoverPool.Limits memory base = PoolConfig.testnetLimits();
        ICoverPool.Limits memory l;

        // maxUtilizationBps 1 .. 9000 (perPerpCap, maxSold, maxPaid follow it down)
        l = _copy(base);
        l.maxUtilizationBps = 0;
        _expectLimitsRevert(l);
        l.maxUtilizationBps = 9_001;
        _expectLimitsRevert(l);
        l.maxUtilizationBps = 9_000;
        _expectLimitsOk(l);
        l = _copy(base);
        (l.maxUtilizationBps, l.perPerpCapBps, l.maxSoldPerWindowBps, l.maxPaidPerWindowBps) = (1, 1, 1, 1);
        _expectLimitsOk(l);

        // perPerpCapBps 1 .. maxUtilizationBps
        l = _copy(base);
        l.perPerpCapBps = 0;
        _expectLimitsRevert(l);
        l.perPerpCapBps = base.maxUtilizationBps + 1;
        _expectLimitsRevert(l);
        l.perPerpCapBps = base.maxUtilizationBps;
        _expectLimitsOk(l);

        // maxDuration 1 hour .. 30 days
        l = _copy(base);
        l.maxDuration = 1 hours - 1;
        _expectLimitsRevert(l);
        l.maxDuration = 30 days + 1;
        _expectLimitsRevert(l);
        l.maxDuration = 1 hours;
        _expectLimitsOk(l);
        l.maxDuration = 30 days;
        _expectLimitsOk(l);

        // maxSpotDeviationBps 1 .. 500
        l = _copy(base);
        l.maxSpotDeviationBps = 0;
        _expectLimitsRevert(l);
        l.maxSpotDeviationBps = 501;
        _expectLimitsRevert(l);
        l.maxSpotDeviationBps = 500;
        _expectLimitsOk(l);

        // minPayout 1 .. 1,000,000e6
        l = _copy(base);
        l.minPayout = 0;
        _expectLimitsRevert(l);
        l.minPayout = 1_000_000e6 + 1;
        _expectLimitsRevert(l);
        l.minPayout = 1_000_000e6;
        _expectLimitsOk(l);
        l.minPayout = 1;
        _expectLimitsOk(l);

        // minPremiumBps 1 .. 5000
        l = _copy(base);
        l.minPremiumBps = 0;
        _expectLimitsRevert(l);
        l.minPremiumBps = 5_001;
        _expectLimitsRevert(l);
        l.minPremiumBps = 5_000;
        _expectLimitsOk(l);

        // minLevelDistanceBps 1 .. 2000
        l = _copy(base);
        l.minLevelDistanceBps = 0;
        _expectLimitsRevert(l);
        l.minLevelDistanceBps = 2_001;
        _expectLimitsRevert(l);
        l.minLevelDistanceBps = 2_000;
        _expectLimitsOk(l);
        l.minLevelDistanceBps = 1;
        _expectLimitsOk(l);

        // saleWindow 60 s .. 7 days
        l = _copy(base);
        l.saleWindow = 59;
        _expectLimitsRevert(l);
        l.saleWindow = 7 days + 1;
        _expectLimitsRevert(l);
        l.saleWindow = 60;
        _expectLimitsOk(l);
        l.saleWindow = 7 days;
        _expectLimitsOk(l);

        // maxSoldPerWindowBps 1 .. maxUtilizationBps
        l = _copy(base);
        l.maxSoldPerWindowBps = 0;
        _expectLimitsRevert(l);
        l.maxSoldPerWindowBps = base.maxUtilizationBps + 1;
        _expectLimitsRevert(l);
        l.maxSoldPerWindowBps = base.maxUtilizationBps;
        _expectLimitsOk(l);

        // maxBuyerWindowShareBps 1 .. 10000
        l = _copy(base);
        l.maxBuyerWindowShareBps = 0;
        _expectLimitsRevert(l);
        l.maxBuyerWindowShareBps = 10_001;
        _expectLimitsRevert(l);
        l.maxBuyerWindowShareBps = 10_000;
        _expectLimitsOk(l);

        // maxPaidPerWindowBps 1 .. maxSoldPerWindowBps
        l = _copy(base);
        l.maxPaidPerWindowBps = 0;
        _expectLimitsRevert(l);
        l.maxPaidPerWindowBps = base.maxSoldPerWindowBps + 1;
        _expectLimitsRevert(l);
        l.maxPaidPerWindowBps = base.maxSoldPerWindowBps;
        _expectLimitsOk(l);
    }

    function test_limitBounds_strictColumn() public {
        pool = _deploy(_strictCtor());
        ICoverPool.Limits memory base = PoolConfig.testnetLimits(); // valid in strict mode too
        _expectLimitsOk(base);
        ICoverPool.Limits memory l;

        l = _copy(base);
        l.maxDuration = 7 days + 1; // > withdrawDelay
        _expectLimitsRevert(l);
        l = _copy(base);
        l.maxSpotDeviationBps = 101;
        _expectLimitsRevert(l);
        l.maxSpotDeviationBps = 100;
        _expectLimitsOk(l);
        l = _copy(base);
        l.minLevelDistanceBps = 9;
        _expectLimitsRevert(l);
        l.minLevelDistanceBps = 10;
        _expectLimitsOk(l);
        l = _copy(base);
        l.saleWindow = 3_599;
        _expectLimitsRevert(l);
        l = _copy(base);
        l.maxSoldPerWindowBps = 2_501;
        _expectLimitsRevert(l);
        l = _copy(base);
        l.maxPaidPerWindowBps = base.maxSoldPerWindowBps + 1;
        _expectLimitsRevert(l);
    }

    // ================================================================ Ownable2Step, renounce

    function test_ownable2Step_transferAndAccept() public {
        address next = makeAddr("next");
        vm.prank(owner);
        pool.transferOwnership(next);
        assertEq(pool.owner(), owner, "not yet");
        assertEq(pool.pendingOwner(), next);
        vm.prank(makeAddr("other"));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, makeAddr("other")));
        pool.acceptOwnership();
        vm.prank(next);
        pool.acceptOwnership();
        assertEq(pool.owner(), next);
    }

    function test_revert_renounceDisabled() public {
        vm.prank(owner);
        vm.expectRevert(ICoverPool.RenounceDisabled.selector);
        pool.renounceOwnership();
        assertEq(pool.owner(), owner);
    }

    function test_queuedOpsSurviveOwnershipTransfer() public {
        address s2 = vm.addr(0xB0B);
        vm.prank(owner);
        pool.queueSetQuoteSigner(s2);
        address next = makeAddr("next");
        vm.prank(owner);
        pool.transferOwnership(next);
        vm.prank(next);
        pool.acceptOwnership();
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        pool.setQuoteSigner(s2);
        vm.prank(next);
        pool.setQuoteSigner(s2);
        assertEq(pool.quoteSigner(), s2);
    }

    function test_onlyOwner_everywhere() public {
        ICoverPool.Limits memory l = PoolConfig.testnetLimits();
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, lp);
        vm.startPrank(lp);
        vm.expectRevert(err);
        pool.queueSetQuoteSigner(lp);
        vm.expectRevert(err);
        pool.queueSetLimits(l);
        vm.expectRevert(err);
        pool.queueSetPerpAllowed(HYPE, true);
        vm.expectRevert(err);
        pool.queueSetGuardian(lp);
        vm.expectRevert(err);
        pool.setQuoteSigner(lp);
        vm.expectRevert(err);
        pool.setLimits(l);
        vm.expectRevert(err);
        pool.setPerpAllowed(HYPE, true);
        vm.expectRevert(err);
        pool.setGuardian(lp);
        vm.expectRevert(err);
        pool.cancel(bytes32(0));
        vm.expectRevert(err);
        pool.setPaused(true);
        vm.stopPrank();
    }

    // ================================================================ timelock

    function test_timelock_queueExecute_signer() public {
        address s2 = vm.addr(0xB0B);
        bytes memory data = abi.encode(s2);
        bytes32 id = pool.opId(ICoverPool.OpKind.QuoteSigner, data);
        assertEq(id, keccak256(abi.encode(ICoverPool.OpKind.QuoteSigner, data)));
        uint64 eta = uint64(vm.getBlockTimestamp()) + DELAY;

        vm.expectEmit(address(pool));
        emit ICoverPool.ConfigQueued(id, ICoverPool.OpKind.QuoteSigner, data, eta);
        vm.prank(owner);
        assertEq(pool.queueSetQuoteSigner(s2), id);
        assertEq(pool.queuedEta(id), eta);
        assertEq(pool.quoteSigner(), signer, "nothing changes at queue time");

        vm.warp(eta - 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ICoverPool.OpNotReady.selector, id, eta));
        pool.setQuoteSigner(s2);

        vm.warp(eta);
        vm.expectEmit(address(pool));
        emit ICoverPool.ConfigExecuted(id);
        vm.expectEmit(address(pool));
        emit ICoverPool.QuoteSignerUpdated(s2);
        vm.prank(owner);
        pool.setQuoteSigner(s2);
        assertEq(pool.quoteSigner(), s2);
        assertEq(pool.queuedEta(id), 0, "entry deleted");

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ICoverPool.OpNotQueued.selector, id));
        pool.setQuoteSigner(s2);
    }

    function test_timelock_limits_perp_guardian() public {
        ICoverPool.Limits memory l = PoolConfig.testnetLimits();
        l.maxDuration = 2 days;
        vm.startPrank(owner);
        pool.queueSetLimits(l);
        pool.queueSetPerpAllowed(HYPE, true);
        pool.queueSetPerpAllowed(SOL, false);
        address g2 = makeAddr("g2");
        pool.queueSetGuardian(g2);
        vm.warp(vm.getBlockTimestamp() + DELAY);

        vm.expectEmit(address(pool));
        emit ICoverPool.LimitsUpdated(l);
        pool.setLimits(l);
        assertEq(pool.maxDuration(), 2 days);
        vm.expectEmit(address(pool));
        emit ICoverPool.PerpAllowedUpdated(HYPE, true);
        pool.setPerpAllowed(HYPE, true);
        pool.setPerpAllowed(SOL, false);
        vm.expectEmit(address(pool));
        emit ICoverPool.GuardianUpdated(g2);
        pool.setGuardian(g2);
        vm.stopPrank();
        assertTrue(pool.perpAllowed(HYPE));
        assertFalse(pool.perpAllowed(SOL));
        assertEq(pool.guardian(), g2);
    }

    /// @dev The executed arguments must be exactly the queued ones: any other value has another op id.
    function test_revert_timelock_executeOtherArgs() public {
        vm.prank(owner);
        pool.queueSetQuoteSigner(vm.addr(0xB0B));
        vm.warp(vm.getBlockTimestamp() + DELAY);
        address evil = makeAddr("evil");
        bytes32 id = pool.opId(ICoverPool.OpKind.QuoteSigner, abi.encode(evil));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ICoverPool.OpNotQueued.selector, id));
        pool.setQuoteSigner(evil);
    }

    function test_revert_timelock_alreadyQueued() public {
        vm.startPrank(owner);
        bytes32 id = pool.queueSetGuardian(address(0));
        vm.expectRevert(abi.encodeWithSelector(ICoverPool.OpAlreadyQueued.selector, id));
        pool.queueSetGuardian(address(0));
        vm.stopPrank();
    }

    function test_timelock_graceAndStale() public {
        vm.prank(owner);
        bytes32 id = pool.queueSetGuardian(address(0));
        uint64 eta = pool.queuedEta(id);
        uint256 snap = vm.snapshotState();
        vm.warp(uint256(eta) + GRACE); // last valid second
        vm.prank(owner);
        pool.setGuardian(address(0));
        assertEq(pool.guardian(), address(0));
        vm.revertToState(snap);

        vm.warp(uint256(eta) + GRACE + 1);
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(ICoverPool.OpStale.selector, id, eta));
        pool.setGuardian(address(0));
        // a stale entry still occupies its id: cancel before re-queueing
        vm.expectRevert(abi.encodeWithSelector(ICoverPool.OpAlreadyQueued.selector, id));
        pool.queueSetGuardian(address(0));
        pool.cancel(id);
        pool.queueSetGuardian(address(0));
        vm.stopPrank();
        assertEq(pool.queuedEta(id), vm.getBlockTimestamp() + DELAY);
    }

    function test_timelock_cancel() public {
        vm.prank(owner);
        bytes32 id = pool.queueSetGuardian(address(0));
        vm.expectEmit(address(pool));
        emit ICoverPool.ConfigCancelled(id);
        vm.prank(owner);
        pool.cancel(id);
        assertEq(pool.queuedEta(id), 0);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ICoverPool.OpNotQueued.selector, id));
        pool.setGuardian(address(0));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ICoverPool.OpNotQueued.selector, id));
        pool.cancel(id);
    }

    function test_timelock_requeueAfterExecute() public {
        vm.startPrank(owner);
        bytes32 id = pool.queueSetGuardian(address(0));
        vm.warp(vm.getBlockTimestamp() + DELAY);
        pool.setGuardian(address(0));
        assertEq(pool.queueSetGuardian(address(0)), id);
        vm.stopPrank();
    }

    function test_revert_queue_validation() public {
        ICoverPool.Limits memory l = PoolConfig.testnetLimits();
        l.maxUtilizationBps = 0;
        vm.startPrank(owner);
        vm.expectRevert(ICoverPool.ZeroAddress.selector);
        pool.queueSetQuoteSigner(address(0));
        vm.expectRevert(ICoverPool.InvalidLimits.selector);
        pool.queueSetLimits(l);
        vm.expectRevert(abi.encodeWithSelector(MockPriceSource.PriceNotSet.selector, uint32(777)));
        pool.queueSetPerpAllowed(777, true);
        pool.queueSetPerpAllowed(777, false); // disallowing needs no price
        vm.stopPrank();
    }

    /// @dev Execute re-validates: a perp that lost its price between queue and execute is refused.
    function test_revert_execute_revalidatesPerp() public {
        vm.prank(owner);
        pool.queueSetPerpAllowed(HYPE, true);
        _setPrice(HYPE, 0);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MockPriceSource.PriceNotSet.selector, HYPE));
        pool.setPerpAllowed(HYPE, true);
    }

    function test_executeSignerChange_invalidatesOutstandingQuotes() public {
        ICoverPool.Quote memory q = _quote();
        q.deadline = uint64(vm.getBlockTimestamp() + DELAY + 30);
        bytes memory sig = _sign(q, signerKey);
        _setQuoteSigner(vm.addr(0xB0B));
        vm.prank(buyer);
        vm.expectRevert(ICoverPool.InvalidSignature.selector);
        pool.buyCover(q, sig);
    }

    // ================================================================ guardian and pause

    function test_guardianPause() public {
        vm.prank(guardian);
        pool.guardianPause();
        assertTrue(pool.paused());
        vm.prank(guardian);
        pool.guardianPause(); // no-op if already paused
        assertTrue(pool.paused());
    }

    function test_revert_guardianPause_notGuardian() public {
        vm.prank(owner);
        vm.expectRevert(ICoverPool.NotGuardian.selector);
        pool.guardianPause();
    }

    function test_revert_guardianPause_noGuardian() public {
        Ctor memory c = _ctor();
        c.guardian = address(0);
        pool = _deploy(c);
        vm.prank(address(0x1234));
        vm.expectRevert(ICoverPool.NotGuardian.selector);
        pool.guardianPause();
    }

    function test_guardianCannotUnpause() public {
        vm.prank(guardian);
        pool.guardianPause();
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        pool.setPaused(false);
    }

    function test_setPaused_immediate() public {
        _pause();
        assertTrue(pool.paused());
        _unpause();
        assertFalse(pool.paused());
        vm.prank(owner);
        vm.expectRevert(Pausable.ExpectedPause.selector);
        pool.setPaused(false);
    }
}
