// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CoverPool} from "../src/CoverPool.sol";
import {ICoverPool} from "../src/interfaces/ICoverPool.sol";
import {IPriceSource} from "../src/interfaces/IPriceSource.sol";
import {IPositionSource} from "../src/interfaces/IPositionSource.sol";
import {MockPriceSource} from "../src/mocks/MockPriceSource.sol";
import {MockPositionSource} from "../src/mocks/MockPositionSource.sol";
import {BlocklistUSDC} from "./utils/BlocklistUSDC.sol";
import {PoolConfig} from "./utils/PoolConfig.sol";

/// @dev Drives random LP actions (deposit, mint, request, cancel, claim, bypass attempts, share transfers), cover
///      actions (buy, trigger, expire, claimPayout), token refusals (blocklist / silent false), price moves, owner
///      timelock operations, pause / guardian pause and time warps. The handler is the pool owner. Every call is
///      try/caught so the handler itself never reverts; ghosts record what the invariants need.
contract V2Handler is Test {
    uint256 internal constant BPS = 10_000;

    CoverPool public pool;
    BlocklistUSDC internal usdc;
    MockPriceSource internal prices;
    MockPositionSource internal positions;
    address public guardian = makeAddr("inv-guardian");

    uint256[2] internal signerKeys = [uint256(0xA11CE), 0xB0B];
    address[3] public lps;
    address[3] public buyers;
    uint32[3] public perps = [uint32(3), 4, 0];
    uint256 internal nonce = 1;

    // ---------------------------------------------------------------- cover ghosts (invariants 2, 4, 5, 9)
    struct SaleGhost {
        uint64 pxAtSale;
        uint16 minPremiumBps;
        uint16 minLevelDistanceBps;
        bool allowedAtSale;
    }

    uint256[] public coverIds;
    mapping(uint256 coverId => SaleGhost) public saleGhost;

    // ---------------------------------------------------------------- violation flags (invariants 7, 8, 10, 12, 13)
    bool public throttleViolated;
    bool public breakerViolated;
    bool public exitBypassed;
    bool public roundingViolated;
    bool public timelockViolated;

    // ---------------------------------------------------------------- exit ghosts (invariant 10)
    mapping(address lp => uint256) public requestTime; // last request (the clock restarts on each)
    uint256 internal claimBurn;
    bool internal claimValid;

    // ---------------------------------------------------------------- timelock ghosts (invariant 13)
    struct Op {
        ICoverPool.OpKind kind;
        bytes data;
    }

    Op[] internal ops;
    mapping(bytes32 id => uint64) public queuedAt;
    ICoverPool.Limits internal ghostLimits;
    address public ghostSigner;
    address public ghostGuardian;
    mapping(uint32 perp => bool) public ghostAllowed;

    // ---------------------------------------------------------------- counters
    uint256 public nBought;
    uint256 public nTriggered;
    uint256 public nDeferred;
    uint256 public nExpired;
    uint256 public nClaimedLp;
    uint256 public nClaimedPayout;
    uint256 public nRequests;
    uint256 public nExecuted;
    uint256 public nBreakerTrips;

    constructor(BlocklistUSDC usdc_, MockPriceSource prices_, MockPositionSource positions_) {
        usdc = usdc_;
        prices = prices_;
        positions = positions_;
        lps = [makeAddr("inv-lp0"), makeAddr("inv-lp1"), makeAddr("inv-lp2")];
        buyers = [makeAddr("inv-b0"), makeAddr("inv-b1"), makeAddr("inv-b2")];
    }

    /// @dev Called once by the test after the pool exists (the pool's owner is this handler).
    function init(CoverPool pool_) external {
        pool = pool_;
        ghostLimits = pool.limits();
        ghostSigner = pool.quoteSigner();
        ghostGuardian = pool.guardian();
        for (uint256 i; i < 3; ++i) {
            ghostAllowed[perps[i]] = true;
            vm.prank(buyers[i]);
            usdc.approve(address(pool), type(uint256).max);
            vm.prank(lps[i]);
            usdc.approve(address(pool), type(uint256).max);
        }
    }

    function coverCount() external view returns (uint256) {
        return coverIds.length;
    }

    function ghostLimitsOf() external view returns (ICoverPool.Limits memory) {
        return ghostLimits;
    }

    function opCount() external view returns (uint256) {
        return ops.length;
    }

    function opIdAt(uint256 i) external view returns (bytes32) {
        return pool.opId(ops[i].kind, ops[i].data);
    }

    // ---------------------------------------------------------------- invariant 10 bookkeeping

    modifier trackSupply() {
        uint256 s0 = pool.totalSupply();
        claimBurn = 0;
        claimValid = false;
        _;
        uint256 s1 = pool.totalSupply();
        if (s1 < s0 && !(claimValid && s0 - s1 == claimBurn)) exitBypassed = true;
    }

    /// @dev Invariant 12: an LP action must not lower the value of one share.
    modifier noPriceDrop() {
        uint256 p0 = pool.convertToAssets(1e12);
        _;
        if (pool.convertToAssets(1e12) < p0) roundingViolated = true;
    }

    function _claimableNow(address lp) internal view returns (bool) {
        uint256 t = requestTime[lp];
        uint256 d = pool.withdrawDelay();
        return t != 0 && t + d <= vm.getBlockTimestamp() && vm.getBlockTimestamp() < t + d + pool.claimWindow();
    }

    // ================================================================ LP actions

    function deposit(uint256 lpSeed, uint256 amount) external trackSupply noPriceDrop {
        address lp = lps[lpSeed % 3];
        amount = bound(amount, 1, 300_000e6);
        usdc.mint(lp, amount);
        vm.prank(lp);
        try pool.deposit(amount, lp) {} catch {}
    }

    function mint(uint256 lpSeed, uint256 shares) external trackSupply noPriceDrop {
        address lp = lps[lpSeed % 3];
        shares = bound(shares, 1, 300_000e6 * 1e6);
        usdc.mint(lp, pool.convertToAssets(shares) + 1e6);
        vm.prank(lp);
        try pool.mint(shares, lp) {} catch {}
    }

    function requestRedeem(uint256 lpSeed, uint256 shares) external trackSupply noPriceDrop {
        address lp = lps[lpSeed % 3];
        shares = bound(shares, 0, pool.balanceOf(lp));
        vm.prank(lp);
        try pool.requestRedeem(shares, lp, lp) {
            requestTime[lp] = vm.getBlockTimestamp();
            nRequests++;
        } catch {}
    }

    function cancelRedeem(uint256 lpSeed) external trackSupply noPriceDrop {
        address lp = lps[lpSeed % 3];
        vm.prank(lp);
        try pool.cancelRedeemRequest() {
            requestTime[lp] = 0;
        } catch {}
    }

    function redeem(uint256 lpSeed, uint256 shares) external trackSupply noPriceDrop {
        address lp = lps[lpSeed % 3];
        (uint256 slot,,,) = pool.redeemRequestOf(lp);
        shares = bound(shares, 0, slot + 1);
        bool valid = _claimableNow(lp);
        vm.prank(lp);
        try pool.redeem(shares, lp, lp) {
            claimBurn = shares;
            claimValid = valid;
            if (!valid) exitBypassed = true;
            nClaimedLp++;
            if (shares == slot) requestTime[lp] = 0;
        } catch {}
    }

    function withdraw(uint256 lpSeed, uint256 assets) external trackSupply noPriceDrop {
        address lp = lps[lpSeed % 3];
        (uint256 slot,,,) = pool.redeemRequestOf(lp);
        assets = bound(assets, 0, pool.convertToAssets(slot) + 1);
        bool valid = _claimableNow(lp);
        uint256 s0 = pool.balanceOf(address(pool));
        vm.prank(lp);
        try pool.withdraw(assets, lp, lp) returns (uint256 burned) {
            claimBurn = burned;
            claimValid = valid && s0 - pool.balanceOf(address(pool)) == burned;
            if (!valid) exitBypassed = true;
            nClaimedLp++;
            if (burned == slot) requestTime[lp] = 0;
        } catch {}
    }

    /// @dev Invariant 10: withdraw/redeem without a Claimable slot always reverts (also a third party's).
    function bypassAttempt(uint256 lpSeed, uint256 amount, bool viaRedeem, bool asStranger) external trackSupply {
        address lp = lps[lpSeed % 3];
        (,,, ICoverPool.RequestState st) = pool.redeemRequestOf(lp);
        if (st == ICoverPool.RequestState.Claimable && !asStranger) return;
        address caller = asStranger ? makeAddr("stranger") : lp;
        amount = bound(amount, 1, 1e18);
        vm.prank(caller);
        if (viaRedeem) {
            try pool.redeem(amount, caller, lp) {
                exitBypassed = true;
            } catch {}
        } else {
            try pool.withdraw(amount, caller, lp) {
                exitBypassed = true;
            } catch {}
        }
    }

    function transferShares(uint256 fromSeed, uint256 toSeed, uint256 shares) external trackSupply {
        address from = lps[fromSeed % 3];
        address to = lps[toSeed % 3];
        shares = bound(shares, 0, pool.balanceOf(from));
        vm.prank(from);
        try pool.transfer(to, shares) {} catch {}
    }

    // ================================================================ cover actions

    struct BuyArgs {
        uint256 buyerSeed;
        uint256 perpSeed;
        bool isLong;
        uint256 payout;
        uint256 premiumBps;
        uint256 duration;
        uint256 distBps;
    }

    function buyCover(BuyArgs calldata a) external trackSupply {
        address b = buyers[a.buyerSeed % 3];
        uint32 perp = perps[a.perpSeed % 3];
        uint64 px = prices.px6Of(perp);
        ICoverPool.Limits memory l = pool.limits();
        // 1 in 8 quotes ignores the floors (the contract must reject those); the rest respect them
        bool probe = a.distBps % 8 == 0;
        uint256 dist = probe ? bound(a.distBps, 1, 1_500) : l.minLevelDistanceBps + 1 + bound(a.distBps, 0, 1_000);
        uint64 level =
            a.isLong ? uint64(uint256(px) * (BPS - dist) / BPS) : uint64(uint256(px) * (BPS + dist) / BPS);

        uint256 room = pool.capacityBase() * l.maxSoldPerWindowBps / BPS * l.maxBuyerWindowShareBps / BPS;
        uint256 payout = bound(a.payout, l.minPayout, l.minPayout > room ? l.minPayout : room);
        uint256 premium = probe
            ? payout * bound(a.premiumBps, 0, 300) / BPS
            : (payout * l.minPremiumBps + BPS - 1) / BPS + payout * bound(a.premiumBps, 0, 300) / BPS;
        if (!usdc.blocked(b)) usdc.mint(b, premium); // a blocked buyer cannot pay a premium either
        vm.prank(positions.owner());
        positions.setPosition(b, perp, a.isLong ? int64(1e5) : int64(-1e5), type(uint64).max, 1);

        ICoverPool.Quote memory q = ICoverPool.Quote({
            buyer: b,
            perpIndex: perp,
            isLong: a.isLong,
            level: level,
            payout: payout,
            premium: premium,
            expiry: uint64(vm.getBlockTimestamp() + bound(a.duration, 1, l.maxDuration)),
            spotRef: px,
            deadline: uint64(vm.getBlockTimestamp() + 30),
            nonce: nonce++
        });
        uint256 key = pool.quoteSigner() == vm.addr(signerKeys[0]) ? signerKeys[0] : signerKeys[1];
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, pool.quoteDigest(q));
        bool allowed = pool.perpAllowed(perp);
        vm.prank(b);
        try pool.buyCover(q, abi.encodePacked(r, s, v)) returns (uint256 id) {
            coverIds.push(id);
            saleGhost[id] = SaleGhost(px, l.minPremiumBps, l.minLevelDistanceBps, allowed);
            nBought++;
            // invariant 7, with the limits in force
            uint256 cap = pool.windowAssets() * l.maxSoldPerWindowBps / BPS;
            (uint64 bStart, uint192 bSold) = pool.buyerWindow(b);
            if (pool.soldInWindow() > cap) throttleViolated = true;
            if (bStart == pool.windowStart() && bSold > cap * l.maxBuyerWindowShareBps / BPS) throttleViolated = true;
        } catch {}
    }

    function movePrice(uint256 perpSeed, uint256 moveBps) external trackSupply {
        uint32 perp = perps[perpSeed % 3];
        uint256 px = uint256(prices.px6Of(perp)) * bound(moveBps, 8_500, 11_500) / BPS;
        if (px < 1e6) px = 1e6;
        if (px > 1e12) px = 1e12;
        vm.prank(prices.owner());
        prices.setPrice(perp, uint64(px));
    }

    /// @dev Like a keeper: scan from a random offset and trigger the first breached active cover.
    function triggerCover(uint256 idSeed) external trackSupply {
        uint256 n = coverIds.length;
        for (uint256 i; i < n; i++) {
            uint256 id = coverIds[(idSeed % n + i) % n];
            bool wasPaused = pool.paused();
            uint256 owedBefore = pool.owedAssets();
            try pool.trigger(id) {
                nTriggered++;
                if (pool.owedAssets() > owedBefore) nDeferred++;
                // invariant 8: above the breaker cap after a trigger -> paused
                uint256 cap = pool.paidWindowAssets() * pool.limits().maxPaidPerWindowBps / BPS;
                if (pool.paidInWindow() > cap && !pool.paused()) breakerViolated = true;
                if (!wasPaused && pool.paused()) nBreakerTrips++;
                return;
            } catch {}
        }
    }

    function expireCover(uint256 idSeed) external trackSupply {
        uint256 n = coverIds.length;
        for (uint256 i; i < n; i++) {
            try pool.expire(coverIds[(idSeed % n + i) % n]) {
                nExpired++;
                return;
            } catch {}
        }
    }

    /// @dev Half of the calls first lift the buyer's token refusal (as a real buyer would get unblocked), so
    ///      deferred payouts are also claimed successfully during the campaign, not only in afterInvariant.
    function claimPayout(uint256 buyerSeed, bool clearRefusal) external trackSupply {
        address b = buyers[buyerSeed % 3];
        if (clearRefusal) {
            usdc.setBlocked(b, false);
            usdc.setSilent(b, false);
        }
        vm.prank(b);
        try pool.claimPayout() {
            nClaimedPayout++;
        } catch {}
    }

    /// @dev Token refusals for the deferral path: blocklist (revert) or silent false return.
    function setRefusal(uint256 buyerSeed, uint256 mode) external trackSupply {
        address b = buyers[buyerSeed % 3];
        mode %= 4; // 0 blocked (reverts), 1 silent (returns false), 2-3 cleared: buyers are refused a quarter of the time
        usdc.setBlocked(b, mode == 0);
        usdc.setSilent(b, mode == 1);
    }

    // ================================================================ owner, timelock, pause

    function _queue(ICoverPool.OpKind kind, bytes memory data, bool ok) internal {
        if (!ok) return;
        bytes32 id = pool.opId(kind, data);
        ops.push(Op(kind, data));
        queuedAt[id] = uint64(vm.getBlockTimestamp());
    }

    function queueLimits(uint256[11] calldata r) external trackSupply {
        ICoverPool.Limits memory l;
        l.maxUtilizationBps = uint16(bound(r[0], 3_000, 9_000));
        l.perPerpCapBps = uint16(bound(r[1], 1_000, l.maxUtilizationBps));
        l.maxDuration = uint64(bound(r[2], 1 hours, 30 days));
        l.maxSpotDeviationBps = uint16(bound(r[3], 1, 500));
        l.minPayout = bound(r[4], 1, 2e6);
        l.minPremiumBps = uint16(bound(r[5], 1, 200));
        l.minLevelDistanceBps = uint16(bound(r[6], 1, 500));
        l.saleWindow = uint32(bound(r[7], 60, 7 days));
        l.maxSoldPerWindowBps = uint16(bound(r[8], 1, l.maxUtilizationBps));
        l.maxBuyerWindowShareBps = uint16(bound(r[9], 1, 10_000));
        l.maxPaidPerWindowBps = uint16(bound(r[10], 1, l.maxSoldPerWindowBps));
        bool ok;
        try pool.queueSetLimits(l) {
            ok = true;
        } catch {}
        _queue(ICoverPool.OpKind.Limits, abi.encode(l), ok);
    }

    function queueSigner(bool second) external trackSupply {
        address s = vm.addr(signerKeys[second ? 1 : 0]);
        bool ok;
        try pool.queueSetQuoteSigner(s) {
            ok = true;
        } catch {}
        _queue(ICoverPool.OpKind.QuoteSigner, abi.encode(s), ok);
    }

    function queuePerpAllowed(uint256 perpSeed, bool allowed) external trackSupply {
        uint32 perp = perps[perpSeed % 3];
        bool ok;
        try pool.queueSetPerpAllowed(perp, allowed) {
            ok = true;
        } catch {}
        _queue(ICoverPool.OpKind.PerpAllowed, abi.encode(perp, allowed), ok);
    }

    function queueGuardian(bool none) external trackSupply {
        address g = none ? address(0) : guardian;
        bool ok;
        try pool.queueSetGuardian(g) {
            ok = true;
        } catch {}
        _queue(ICoverPool.OpKind.Guardian, abi.encode(g), ok);
    }

    function executeOp(uint256 idx) external trackSupply {
        if (ops.length == 0) return;
        Op memory op = ops[idx % ops.length];
        bytes32 id = pool.opId(op.kind, op.data);
        bool ok;
        if (op.kind == ICoverPool.OpKind.Limits) {
            try pool.setLimits(abi.decode(op.data, (ICoverPool.Limits))) {
                ok = true;
            } catch {}
        } else if (op.kind == ICoverPool.OpKind.QuoteSigner) {
            try pool.setQuoteSigner(abi.decode(op.data, (address))) {
                ok = true;
            } catch {}
        } else if (op.kind == ICoverPool.OpKind.PerpAllowed) {
            (uint32 perp, bool allowed) = abi.decode(op.data, (uint32, bool));
            try pool.setPerpAllowed(perp, allowed) {
                ok = true;
            } catch {}
        } else {
            try pool.setGuardian(abi.decode(op.data, (address))) {
                ok = true;
            } catch {}
        }
        if (!ok) return;
        nExecuted++;
        uint256 eta = uint256(queuedAt[id]) + pool.configDelay();
        if (vm.getBlockTimestamp() < eta || vm.getBlockTimestamp() > eta + pool.CONFIG_GRACE()) timelockViolated = true;
        if (op.kind == ICoverPool.OpKind.Limits) {
            ghostLimits = abi.decode(op.data, (ICoverPool.Limits));
        } else if (op.kind == ICoverPool.OpKind.QuoteSigner) {
            ghostSigner = abi.decode(op.data, (address));
        } else if (op.kind == ICoverPool.OpKind.PerpAllowed) {
            (uint32 perp, bool allowed) = abi.decode(op.data, (uint32, bool));
            ghostAllowed[perp] = allowed;
        } else {
            ghostGuardian = abi.decode(op.data, (address));
        }
    }

    function cancelOp(uint256 idx) external trackSupply {
        if (ops.length == 0) return;
        Op memory op = ops[idx % ops.length];
        try pool.cancel(pool.opId(op.kind, op.data)) {} catch {}
    }

    /// @dev 1/8 guardian pause (by the guardian key, or by a stranger: must fail), 1/8 owner pause, else unpause,
    ///      so the pool is mostly open for sales while every pause path still runs.
    function pauseAction(uint256 seed) external trackSupply {
        seed %= 16;
        if (seed < 2) {
            vm.prank(seed == 0 ? guardian : makeAddr("stranger"));
            try pool.guardianPause() {} catch {}
        } else if (seed < 4) {
            try pool.setPaused(true) {} catch {}
        } else {
            try pool.setPaused(false) {} catch {}
        }
    }

    function warp(uint256 secs, bool long_) external trackSupply {
        vm.warp(vm.getBlockTimestamp() + bound(secs, 1, long_ ? 3 days : 2 hours));
    }
}

/// @notice ARCHITECTURE §5.8: all 13 v2 invariants under random action sequences (plus the v1 per-perp sum).
/// @dev Deeper sequences than the repo default (64) so windows, breaker trips, lapses and timelock executes occur.
/// forge-config: default.invariant.depth = 160
contract InvariantTest is Test {
    uint256 internal constant BPS = 10_000;

    CoverPool internal pool;
    BlocklistUSDC internal usdc;
    MockPriceSource internal prices;
    MockPositionSource internal positions;
    V2Handler internal handler;

    function setUp() public {
        vm.warp(1_790_000_000);
        usdc = new BlocklistUSDC();
        prices = new MockPriceSource(address(this));
        positions = new MockPositionSource(address(this));
        prices.setPrice(3, 84_000e6);
        prices.setPrice(4, 3_000e6);
        prices.setPrice(0, 150e6);

        handler = new V2Handler(usdc, prices, positions);
        pool = PoolConfig.deploy(
            IERC20(address(usdc)),
            address(handler),
            vm.addr(0xA11CE),
            handler.guardian(),
            IPriceSource(address(prices)),
            IPositionSource(address(positions)),
            PoolConfig.testnetLimits(),
            PoolConfig.perps3(3, 4, 0)
        );
        handler.init(pool);
        prices.transferOwnership(address(handler));
        positions.transferOwnership(address(handler));

        // seed liquidity (the handler's LPs, so requests and claims have shares to work with)
        for (uint256 j; j < 3; j++) {
            handler.deposit(j, 70_000e6);
        }

        bytes4[] memory sel = new bytes4[](30);
        sel[0] = V2Handler.deposit.selector;
        sel[1] = V2Handler.mint.selector;
        sel[2] = V2Handler.requestRedeem.selector;
        sel[3] = V2Handler.cancelRedeem.selector;
        sel[4] = V2Handler.redeem.selector;
        sel[5] = V2Handler.withdraw.selector;
        sel[6] = V2Handler.bypassAttempt.selector;
        sel[7] = V2Handler.transferShares.selector;
        sel[8] = V2Handler.buyCover.selector;
        sel[9] = V2Handler.buyCover.selector; // weighted: sales drive most of the state
        sel[10] = V2Handler.movePrice.selector;
        sel[11] = V2Handler.triggerCover.selector;
        sel[12] = V2Handler.expireCover.selector;
        sel[13] = V2Handler.claimPayout.selector;
        sel[14] = V2Handler.setRefusal.selector;
        sel[15] = V2Handler.queueLimits.selector;
        sel[16] = V2Handler.queueSigner.selector;
        sel[17] = V2Handler.queuePerpAllowed.selector;
        sel[18] = V2Handler.queueGuardian.selector;
        sel[19] = V2Handler.executeOp.selector;
        sel[20] = V2Handler.cancelOp.selector;
        sel[21] = V2Handler.pauseAction.selector;
        sel[22] = V2Handler.warp.selector;
        sel[23] = V2Handler.pauseAction.selector;
        sel[24] = V2Handler.buyCover.selector;
        sel[25] = V2Handler.buyCover.selector;
        sel[26] = V2Handler.triggerCover.selector;
        sel[27] = V2Handler.movePrice.selector;
        sel[28] = V2Handler.claimPayout.selector;
        sel[29] = V2Handler.triggerCover.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
        targetContract(address(handler));
    }

    // ================================================================ accounting

    /// 1. usdc.balanceOf(pool) >= lockedAssets + owedAssets + unearnedPremium
    function invariant_01_balanceCoversReserves() public view {
        assertGe(usdc.balanceOf(address(pool)), pool.lockedAssets() + pool.owedAssets() + pool.unearnedPremium());
    }

    /// 2. lockedAssets == Σ payout of Active covers; Σ lockedByPerp == lockedAssets (v1)
    function invariant_02_lockedEqualsActivePayouts() public view {
        uint256 sum;
        uint256 n = handler.coverCount();
        for (uint256 i; i < n; i++) {
            ICoverPool.Cover memory c = pool.getCover(handler.coverIds(i));
            if (c.status == ICoverPool.Status.Active) sum += c.payout;
        }
        assertEq(pool.lockedAssets(), sum);
        assertEq(pool.coverCount(), n);
        assertEq(pool.lockedByPerp(3) + pool.lockedByPerp(4) + pool.lockedByPerp(0), pool.lockedAssets());
    }

    /// 3. totalAssets() == usdc.balanceOf(pool) - owedAssets - unearnedPremium
    function invariant_03_totalAssetsFormula() public view {
        assertEq(pool.totalAssets(), usdc.balanceOf(address(pool)) - pool.owedAssets() - pool.unearnedPremium());
    }

    /// 4. unearnedPremium == Σ premium of Active covers
    function invariant_04_unearnedEqualsActivePremiums() public view {
        uint256 sum;
        uint256 n = handler.coverCount();
        for (uint256 i; i < n; i++) {
            ICoverPool.Cover memory c = pool.getCover(handler.coverIds(i));
            if (c.status == ICoverPool.Status.Active) sum += c.premium;
        }
        assertEq(pool.unearnedPremium(), sum);
    }

    /// 5. owedAssets == Σ owed[buyer]; owed[b] <= Σ payout of b's Paid covers
    function invariant_05_owed() public view {
        uint256 sum;
        uint256 n = handler.coverCount();
        for (uint256 j; j < 3; j++) {
            address b = handler.buyers(j);
            sum += pool.owed(b);
            uint256 paid;
            for (uint256 i; i < n; i++) {
                ICoverPool.Cover memory c = pool.getCover(handler.coverIds(i));
                if (c.buyer == b && c.status == ICoverPool.Status.Paid) paid += c.payout;
            }
            assertLe(pool.owed(b), paid);
        }
        assertEq(pool.owedAssets(), sum);
    }

    /// 6. balanceOf(pool) == totalEscrowedShares == Σ slot.shares
    function invariant_06_escrow() public view {
        uint256 sum;
        for (uint256 j; j < 3; j++) {
            (uint256 s,,,) = pool.redeemRequestOf(handler.lps(j));
            sum += s;
        }
        assertEq(pool.balanceOf(address(pool)), pool.totalEscrowedShares());
        assertEq(pool.totalEscrowedShares(), sum);
    }

    // ================================================================ sales and payouts

    /// 7. throttle caps hold after every sale, with the limits in force (ghost)
    function invariant_07_throttle() public view {
        assertFalse(handler.throttleViolated());
    }

    /// 8. above the paid cap after a trigger -> paused (ghost)
    function invariant_08_breaker() public view {
        assertFalse(handler.breakerViolated());
    }

    /// 9. every sold cover met the premium and level-distance floors and the allowlist at sale
    function invariant_09_floors() public view {
        uint256 n = handler.coverCount();
        for (uint256 i; i < n; i++) {
            uint256 id = handler.coverIds(i);
            ICoverPool.Cover memory c = pool.getCover(id);
            (uint64 px, uint16 minPrem, uint16 minDist, bool allowed) = handler.saleGhost(id);
            assertGe(c.premium * BPS, c.payout * minPrem, "premium floor");
            uint256 dist = px > c.level ? px - c.level : c.level - px;
            assertGe(dist * BPS, uint256(px) * minDist, "level distance floor");
            assertTrue(allowed, "perp allowed at sale");
        }
    }

    // ================================================================ exits

    /// 10. every totalSupply decrease is a claim from a Claimable slot; bypass attempts always revert (ghost)
    function invariant_10_noExitBypassesQueue() public view {
        assertFalse(handler.exitBypassed());
    }

    /// 12. no LP action lowers convertToAssets(1e12) (ghost)
    function invariant_12_rounding() public view {
        assertFalse(handler.roundingViolated());
    }

    // ================================================================ owner

    /// 13. config changes only via an execute with eta <= now; every queued entry has eta - queuedAt == configDelay
    function invariant_13_timelock() public view {
        assertFalse(handler.timelockViolated());
        assertEq(abi.encode(pool.limits()), abi.encode(handler.ghostLimitsOf()));
        assertEq(pool.quoteSigner(), handler.ghostSigner());
        assertEq(pool.guardian(), handler.ghostGuardian());
        for (uint256 j; j < 3; j++) {
            uint32 p = handler.perps(j);
            assertEq(pool.perpAllowed(p), handler.ghostAllowed(p));
        }
        uint256 n = handler.opCount();
        for (uint256 i; i < n; i++) {
            bytes32 id = handler.opIdAt(i);
            uint64 eta = pool.queuedEta(id);
            if (eta != 0) assertEq(eta - handler.queuedAt(id), pool.configDelay());
        }
    }

    /// 11. Liveness, once per run: pause, let every cover expire or trigger, wait maxDuration + withdrawDelay;
    ///     every requested slot (re-queued if lapsed) then claims in full. Owed payouts are claimable too.
    function afterInvariant() external {
        vm.startPrank(address(handler));
        if (!pool.paused()) pool.setPaused(true);
        vm.stopPrank();

        uint256 n = handler.coverCount();
        uint256 lastExpiry = vm.getBlockTimestamp();
        for (uint256 i; i < n; i++) {
            uint64 e = pool.getCover(handler.coverIds(i)).expiry;
            if (e > lastExpiry) lastExpiry = e;
        }
        uint256 wait = pool.limits().maxDuration;
        if (lastExpiry + 1 - vm.getBlockTimestamp() > wait) wait = lastExpiry + 1 - vm.getBlockTimestamp();
        vm.warp(vm.getBlockTimestamp() + wait + pool.withdrawDelay());
        for (uint256 i; i < n; i++) {
            uint256 id = handler.coverIds(i);
            if (pool.getCover(id).status == ICoverPool.Status.Active) pool.expire(id);
        }
        assertEq(pool.lockedAssets(), 0);
        assertEq(pool.unearnedPremium(), 0);

        address[3] memory requeued;
        for (uint256 j; j < 3; j++) {
            address lp = handler.lps(j);
            (uint256 s,,, ICoverPool.RequestState st) = pool.redeemRequestOf(lp);
            if (st == ICoverPool.RequestState.Claimable) {
                _claimAll(lp, s);
            } else if (st != ICoverPool.RequestState.None) {
                vm.prank(lp);
                pool.requestRedeem(0, lp, lp);
                requeued[j] = lp;
            }
        }
        vm.warp(vm.getBlockTimestamp() + pool.withdrawDelay());
        for (uint256 j; j < 3; j++) {
            if (requeued[j] == address(0)) continue;
            (uint256 s,,,) = pool.redeemRequestOf(requeued[j]);
            _claimAll(requeued[j], s);
        }
        assertEq(pool.totalEscrowedShares(), 0);

        for (uint256 j; j < 3; j++) {
            address b = handler.buyers(j);
            usdc.setBlocked(b, false);
            usdc.setSilent(b, false);
            if (pool.owed(b) > 0) {
                vm.prank(b);
                pool.claimPayout();
            }
        }
        assertEq(pool.owedAssets(), 0);
        invariant_01_balanceCoversReserves();

        // Cumulative activity over all runs of the campaign (env vars live for the whole forge process).
        _acc("INV_RUNS", 1);
        _acc("INV_BOUGHT", handler.nBought());
        _acc("INV_TRIGGERED", handler.nTriggered());
        _acc("INV_DEFERRED", handler.nDeferred());
        _acc("INV_EXPIRED", handler.nExpired());
        _acc("INV_LP_CLAIMS", handler.nClaimedLp());
        _acc("INV_PAYOUT_CLAIMS", handler.nClaimedPayout());
        _acc("INV_REQUESTS", handler.nRequests());
        _acc("INV_EXECUTED", handler.nExecuted());
        _acc("INV_BREAKER", handler.nBreakerTrips());
        console2.log("cumulative runs / bought / triggered", _get("INV_RUNS"), _get("INV_BOUGHT"), _get("INV_TRIGGERED"));
        console2.log("deferred / expired / lpClaims", _get("INV_DEFERRED"), _get("INV_EXPIRED"), _get("INV_LP_CLAIMS"));
        console2.log("payoutClaims / requests / executedOps", _get("INV_PAYOUT_CLAIMS"), _get("INV_REQUESTS"), _get("INV_EXECUTED"));
        console2.log("breakerTrips", _get("INV_BREAKER"));
    }

    function _get(string memory k) internal view returns (uint256) {
        return vm.envOr(k, uint256(0));
    }

    function _acc(string memory k, uint256 v) internal {
        vm.setEnv(k, vm.toString(_get(k) + v));
    }

    function _claimAll(address lp, uint256 shares) internal {
        uint256 expected = pool.convertToAssets(shares);
        address receiver = makeAddr("liveness-receiver");
        uint256 before = usdc.balanceOf(receiver);
        vm.prank(lp);
        uint256 assets = pool.redeem(shares, receiver, lp);
        assertEq(assets, expected);
        assertEq(usdc.balanceOf(receiver), before + assets);
        (uint256 left,,,) = pool.redeemRequestOf(lp);
        assertEq(left, 0, "claimed in full");
    }

    // ================================================================ non-vacuity

    /// @dev Proves the handler is not vacuous: each path really executes and the flags start clean.
    function test_handlerSmoke_allPathsReachable() public {
        handler.deposit(0, 100_000e6);
        handler.buyCover(V2Handler.BuyArgs(0, 0, true, 1_000e6, 100, 1 days, 500)); // long BTC, -5 %
        handler.buyCover(V2Handler.BuyArgs(1, 1, false, 2_000e6, 100, 1 hours, 500)); // short ETH, +5 %
        assertEq(handler.nBought(), 2);

        handler.setRefusal(0, 0); // buyer 0 blocklisted -> deferral
        handler.movePrice(0, 8_500); // BTC -15 % -> long cover breached
        handler.triggerCover(0);
        assertEq(handler.nTriggered(), 1);
        assertEq(handler.nDeferred(), 1);
        handler.setRefusal(0, 2);
        handler.claimPayout(0, false);
        assertEq(handler.nClaimedPayout(), 1);

        handler.requestRedeem(0, type(uint256).max);
        handler.warp(2 hours, false); // past the short cover's expiry; the request lapses (7,200 s > 600 + 3,600)
        handler.expireCover(1);
        assertEq(handler.nExpired(), 1);
        handler.requestRedeem(0, 0); // re-queue the lapsed slot
        handler.warp(600, false);
        (uint256 slot,,,) = pool.redeemRequestOf(handler.lps(0));
        handler.redeem(0, slot);
        assertEq(handler.nClaimedLp(), 1);

        handler.queueSigner(true);
        handler.warp(600, false);
        handler.executeOp(0);
        assertEq(handler.nExecuted(), 1);

        invariant_01_balanceCoversReserves();
        invariant_02_lockedEqualsActivePayouts();
        invariant_05_owed();
        invariant_06_escrow();
        invariant_09_floors();
        invariant_10_noExitBypassesQueue();
        invariant_12_rounding();
        invariant_13_timelock();
    }

    /// @dev Handler buys inside the caps succeed, otherwise the campaign would be vacuous.
    function testFuzz_handlerBuy_withinCapsSucceeds(uint256 perpSeed, bool isLong, uint256 payout, uint256 dur, uint256 dist)
        public
    {
        handler.buyCover(V2Handler.BuyArgs(0, perpSeed, isLong, payout, 100, dur, bound(dist, 30, 1_500)));
        assertEq(handler.nBought(), 1);
    }
}
