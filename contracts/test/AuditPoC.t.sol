// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CoverPool} from "../src/CoverPool.sol";
import {IPriceSource} from "../src/interfaces/IPriceSource.sol";
import {IPositionSource} from "../src/interfaces/IPositionSource.sol";
import {ICoverPool} from "../src/interfaces/ICoverPool.sol";
import {BaseTest} from "./Base.t.sol";
import {PoolConfig} from "./utils/PoolConfig.sol";

/// @notice The 2026-10-02 audit PoCs against v1, re-run against v2: they now fail or are bounded.
///         PoC 1 = H1 (LP withdrawal race), PoC 2 = H2 (compromised signer, zero-premium drain),
///         H-1 = the spec review's mid-window deposit that would raise a live sale cap (throttle_model.py).
contract AuditPoCTest is BaseTest {
    uint256 internal constant BPS = 10_000;

    // ================================================================ PoC 1: LP withdrawal race (H1)

    /// v1: a fast LP withdrew at par one tick before a near-certain payout and the slow LP ate the loss.
    /// v2: no instant exit. The fast LP must request and wait withdrawDelay; the payout lands first, and the
    /// escrowed shares bear it pro rata, so both LPs lose the same.
    function test_poc1_lpWithdrawalRace_closed() public {
        address lp2 = makeAddr("lp2");
        _deposit(lp2, LP_DEPOSIT); // pool: lp 100k + lp2 100k
        _bigPosition(buyer, BTC);
        ICoverPool.Quote memory q = _quote();
        q.payout = 12_500e6; // the testnet buyer cap: 25 % x 25 % of 200k
        q.premium = 125e6;
        uint256 id = _buy(q);

        _setPrice(BTC, q.level + 1); // one tick above the level
        vm.startPrank(lp);
        vm.expectRevert(
            abi.encodeWithSelector(ICoverPool.RequestNotClaimable.selector, ICoverPool.RequestState.None)
        );
        pool.withdraw(1, lp, lp); // v1's instant exit is gone
        pool.requestRedeem(pool.balanceOf(lp), lp, lp);
        vm.expectRevert(
            abi.encodeWithSelector(ICoverPool.RequestNotClaimable.selector, ICoverPool.RequestState.Pending)
        );
        pool.withdraw(1, lp, lp);
        vm.stopPrank();

        _setPrice(BTC, q.level);
        pool.trigger(id); // lands before the request matures

        vm.warp(vm.getBlockTimestamp() + pool.withdrawDelay());
        uint256 maxShares = pool.maxRedeem(lp);
        vm.prank(lp);
        uint256 fastOut = pool.redeem(maxShares, lp, lp);
        uint256 slowValue = pool.convertToAssets(pool.balanceOf(lp2));
        console2.log("fast LP claimed        ", fastOut);
        console2.log("slow LP value          ", slowValue);
        assertApproxEqAbs(fastOut, slowValue, 2, "loss shared pro rata");
        assertApproxEqAbs(fastOut, LP_DEPOSIT + q.premium / 2 - q.payout / 2, 2);
    }

    // ================================================================ PoC 2: compromised signer drain (H2)

    address[] internal attackers;

    function _attackers(uint256 n) internal {
        for (uint256 i = attackers.length; i < n; ++i) {
            address a = makeAddr(string.concat("attacker", vm.toString(i)));
            _bigPosition(a, BTC); // each address needs its own HyperCore position (check 4)
            _fund(a);
            attackers.push(a);
        }
    }

    function _evilQuote(address a, uint256 payout, uint64 px, uint64 level, uint256 premium)
        internal
        returns (ICoverPool.Quote memory q)
    {
        q = ICoverPool.Quote({
            buyer: a,
            perpIndex: BTC,
            isLong: true,
            level: level,
            payout: payout,
            premium: premium,
            expiry: uint64(vm.getBlockTimestamp() + 7 days),
            spotRef: px,
            deadline: uint64(vm.getBlockTimestamp() + 30),
            nonce: nextNonce++
        });
    }

    /// v1: zero-premium quotes one tick from spot drained > 99 % in 8 rounds.
    /// v2: the v1 quote is rejected by both floors.
    function test_poc2_v1QuoteRejected_byFloors() public {
        _attackers(1);
        ICoverPool.Quote memory q = _evilQuote(attackers[0], 6_000e6, BTC_PX, BTC_PX - 1, 0);
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.PremiumBelowFloor.selector, 0, 12e6));
        q.premium = 12e6;
        _expectBuyRevert(q, abi.encodeWithSelector(ICoverPool.LevelTooClose.selector, BTC_PX, BTC_PX - 1));
    }

    /// v2 with the leaked key, selling and triggering at once: floor premium, minimum distance, four funded
    /// addresses, every cover triggered. The window cap bounds round 1 at 25 % of B; the breaker pauses within
    /// that window, so the following rounds sell nothing. Loss = 25 % x (1 - 0.2 %) = 24.95 % for THIS path only:
    /// it is not a general bound (ARCHITECTURE §5.3: the patient path is bounded by maxUtilization, and with
    /// non-strict delays an attacker who supplies capital defeats the per-window bound, audit M-1).
    function test_poc2_compromisedSigner_boundedByThrottleAndBreaker() public {
        _attackers(4);
        uint256 start = pool.totalAssets();
        uint256 sold;
        for (uint256 round; round < 8; ++round) {
            uint64 px = prices.px6Of(BTC);
            uint64 level = uint64(uint256(px) * (BPS - 25) / BPS); // exactly the distance floor
            uint256 cap = (pool.paused() ? 0 : pool.capacityBase()) * 2_500 / BPS * 2_500 / BPS;
            uint256[] memory ids = new uint256[](4);
            uint256 n;
            for (uint256 i; i < 4; ++i) {
                if (cap < 1e6) break;
                ICoverPool.Quote memory q = _evilQuote(attackers[i], cap, px, level, (cap * 20 + BPS - 1) / BPS);
                bytes memory sig = _sign(q, signerKey);
                vm.prank(attackers[i]);
                try pool.buyCover(q, sig) returns (uint256 id) {
                    ids[n++] = id;
                    sold += cap;
                } catch {}
            }
            _setPrice(BTC, level); // the oracle moves 25 bps
            for (uint256 i; i < n; ++i) {
                pool.trigger(ids[i]); // never reverts, even when the breaker trips
            }
            _setPrice(BTC, px);
            vm.warp(vm.getBlockTimestamp() + 3_600); // next sale window
        }
        uint256 end = pool.totalAssets();
        console2.log("pool before            ", start);
        console2.log("pool after 8 rounds    ", end);
        console2.log("sold (all triggered)   ", sold);
        assertTrue(pool.paused(), "breaker tripped");
        assertEq(sold, 25_000e6, "one window of sales, then paused");
        assertEq(end, start - 25_000e6 + 4 * 12_500_000, "loss 24.95 %");
        assertGe(end * BPS, start * (BPS - 2_495), "within c = 0.2495");
    }

    /// The breaker cannot be bypassed by spreading triggers: a deferred payout counts, and the owner must
    /// unpause. While paused, every new sale reverts.
    function test_poc2_afterBreaker_salesBlocked() public {
        test_poc2_compromisedSigner_boundedByThrottleAndBreaker();
        ICoverPool.Quote memory q = _evilQuote(attackers[0], 1e6, BTC_PX, 80_000e6, 1e6);
        _expectBuyRevert(q, abi.encodeWithSelector(Pausable.EnforcedPause.selector));
    }

    /// An owner (or a stolen owner key) cannot swap in an attacker signer instantly any more.
    function test_poc2_signerRotationIsTimelocked() public {
        address evil = vm.addr(0xE71);
        vm.prank(owner);
        bytes32 id = pool.queueSetQuoteSigner(evil);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(ICoverPool.OpNotReady.selector, id, uint64(vm.getBlockTimestamp() + 600))
        );
        pool.setQuoteSigner(evil);
        assertEq(pool.quoteSigner(), signer);
    }

    // ================================================================ H-1: deposit inflation inside one window

    /// Review H-1: with a cap on *current* assets an attacker could deposit mid-window and sell again
    /// (throttle_model.py: "current-A cap" loses ~59 % in 6 rounds at 3x deposits). v2 snapshots B at the window
    /// start: after the first round the window is full whatever the attacker deposits. The breaker is set to the
    /// sale cap here so that only the throttle is under test.
    function test_h1_depositMidWindow_doesNotRaiseCap() public {
        ICoverPool.Limits memory l = PoolConfig.testnetLimits();
        l.maxPaidPerWindowBps = l.maxSoldPerWindowBps; // isolate the throttle from the breaker
        _setLimits(l);
        _attackers(4);
        address whale = makeAddr("whale");
        uint256 honestStart = pool.convertToAssets(pool.balanceOf(lp));

        uint64 px = BTC_PX;
        uint64 level = uint64(uint256(px) * (BPS - 25) / BPS);
        uint256 cap = pool.capacityBase() * 2_500 / BPS * 2_500 / BPS; // 6,250 per address
        uint256[] memory ids = new uint256[](4);
        for (uint256 i; i < 4; ++i) {
            ids[i] = _buy(_evilQuote(attackers[i], cap, px, level, (cap * 20 + BPS - 1) / BPS));
        }
        _setPrice(BTC, level);
        for (uint256 i; i < 4; ++i) {
            pool.trigger(ids[i]);
        }
        _setPrice(BTC, px);
        assertFalse(pool.paused());

        for (uint256 r; r < 5; ++r) {
            _deposit(whale, 3 * usdc.balanceOf(address(pool))); // 3x the pool, as in the model
            assertEq(pool.windowAssets(), LP_DEPOSIT, "snapshot unchanged");
            ICoverPool.Quote memory q = _evilQuote(attackers[r % 4], 1e6, px, level, 1e6);
            _expectBuyRevert(
                q, abi.encodeWithSelector(ICoverPool.SaleWindowCapExceeded.selector, 25_001e6, 25_000e6)
            );
        }
        uint256 honestEnd = pool.convertToAssets(pool.balanceOf(lp));
        uint256 lossBps = (honestStart - honestEnd) * BPS / honestStart;
        console2.log("honest LP loss (bps)   ", lossBps);
        assertLe(lossBps, 2_495, "bounded by one window: c = 0.2495");
    }

    // ================================================================ L-1: strict withdrawDelay vs maxDuration

    function _strictPool(uint64 withdrawDelay_) internal returns (CoverPool) {
        return new CoverPool(
            IERC20(address(usdc)),
            owner,
            signer,
            guardian,
            IPriceSource(address(prices)),
            IPositionSource(address(positions)),
            PoolConfig.testnetLimits(), // maxDuration 7 days
            PoolConfig.perps3(BTC, ETH, SOL),
            48 hours,
            withdrawDelay_,
            1 days,
            true
        );
    }

    /// Audit L-1: with withdrawDelay == maxDuration, a cover sold in the request's second could still be
    /// triggered in the first second the request is claimable (claim at par, then trigger). v2 requires
    /// withdrawDelay > maxDuration in strict mode, so the configuration is refused and, at +1 s, the cover has
    /// expired before the claim opens.
    function test_l1_strictEqualityRefused_andOverlapClosed() public {
        vm.expectRevert(ICoverPool.InvalidLimits.selector);
        _strictPool(7 days); // == maxDuration

        pool = _strictPool(7 days + 1);
        _deposit(lp, LP_DEPOSIT);
        _fund(buyer);
        ICoverPool.Quote memory q = _quote();
        q.expiry = uint64(vm.getBlockTimestamp() + 7 days); // the longest cover, sold in the request's second
        uint256 id = _buy(q);
        _request(lp, pool.balanceOf(lp));
        (,uint64 claimableAt,,) = pool.redeemRequestOf(lp);
        assertGt(claimableAt, q.expiry, "claim opens after the last second the cover can trigger");

        vm.warp(q.expiry); // last trigger second: the request is still Pending
        assertEq(pool.maxWithdraw(lp), 0);
        vm.warp(claimableAt); // first claim second: the cover can no longer trigger
        _setPrice(BTC, q.level);
        vm.expectRevert(abi.encodeWithSelector(ICoverPool.CoverPastExpiry.selector, id, q.expiry));
        pool.trigger(id);
    }

    /// Strict pools also refuse a later setLimits that would reach equality.
    function test_l1_strictSetLimitsEqualityRefused() public {
        pool = _strictPool(7 days + 1);
        ICoverPool.Limits memory l = PoolConfig.testnetLimits();
        l.maxDuration = 7 days + 1;
        vm.prank(owner);
        vm.expectRevert(ICoverPool.InvalidLimits.selector);
        pool.queueSetLimits(l);
    }

    // ================================================================ v1 PoC 4 and 5 (M-level), for completeness

    /// v1 PoC 4: a stale quote for a level 1 % away accepted after a 0.99 % adverse move. v2: the deviation band
    /// is 30 bps and the distance floor (25 bps) is measured from the live oracle price.
    function test_poc4_staleQuoteAfterAdverseMove_rejected() public {
        ICoverPool.Quote memory q = _quote();
        q.level = uint64(uint256(BTC_PX) * 9_900 / 10_000);
        _setPrice(BTC, uint64(uint256(BTC_PX) * 9_901 / 10_000));
        _expectBuyRevert(
            q,
            abi.encodeWithSelector(
                ICoverPool.SpotDeviationTooHigh.selector, uint64(uint256(BTC_PX) * 9_901 / 10_000), BTC_PX
            )
        );
        _setPrice(BTC, uint64(uint256(BTC_PX) * 9_975 / 10_000)); // inside the band
        q.level = uint64(uint256(BTC_PX) * 9_955 / 10_000); // ~20 bps from the oracle
        _expectBuyRevert(
            q, abi.encodeWithSelector(ICoverPool.LevelTooClose.selector, uint64(uint256(BTC_PX) * 9_975 / 10_000), q.level)
        );
    }

    /// v1 PoC 5: the owner widened the deviation check to 100 % instantly. v2: at most 500 bps, and timelocked.
    function test_poc5_ownerCannotNeuterSpotCheck() public {
        ICoverPool.Limits memory l = PoolConfig.testnetLimits();
        l.maxSpotDeviationBps = 10_000;
        vm.prank(owner);
        vm.expectRevert(ICoverPool.InvalidLimits.selector);
        pool.queueSetLimits(l);
    }
}
