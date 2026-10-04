// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {ICoverPool} from "./interfaces/ICoverPool.sol";
import {IPriceSource} from "./interfaces/IPriceSource.sol";
import {IPositionSource} from "./interfaces/IPositionSource.sol";

/// @title CoverPool v2 — Numera liquidation cover for Hyperliquid perps
/// @notice ERC-4626 USDC underwriter vault (synchronous deposits, queued ERC-7540-style redeems) plus a book of
///         parametric covers sold against EIP-712 quotes signed by the off-chain actuarial engine, with on-chain
///         pricing floors, a sale throttle, a payout circuit breaker, a timelocked owner and a guardian pause.
///         Spec: docs/ARCHITECTURE.md §5 (v2).
/// @dev Accounting: totalAssets = USDC balance - owedAssets - unearnedPremium. Every payout is locked at sale;
///      LP claims are bounded by freeAssets = totalAssets - lockedAssets, so the balance always covers
///      locked + owed + unearned. Pause blocks buyCover, deposit and mint only.
contract CoverPool is ICoverPool, ERC4626, EIP712, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ================================================================ constants

    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(address buyer,uint32 perpIndex,bool isLong,uint64 level,uint256 payout,uint256 premium,uint64 expiry,uint64 spotRef,uint64 deadline,uint256 nonce)"
    );
    /// @notice Execute window after an operation's eta (§5.5).
    uint64 public constant CONFIG_GRACE = 3 days;
    uint256 private constant BPS = 10_000;
    /// @dev Share decimals = 6 (USDC) + 6. Virtual shares/assets defeat the first-depositor inflation attack.
    uint8 private constant DECIMALS_OFFSET = 6;

    // ================================================================ immutables (§5.6)

    IPriceSource public immutable priceSource;
    IPositionSource public immutable positionSource;
    uint64 public immutable configDelay;
    uint64 public immutable withdrawDelay;
    uint64 public immutable claimWindow;
    bool public immutable strict;

    // ================================================================ storage

    address public quoteSigner;
    address public guardian;
    Limits private _limits;
    mapping(uint32 perpIndex => bool) public perpAllowed;
    mapping(bytes32 id => uint64 eta) public queuedEta;

    // cover book
    /// @inheritdoc ICoverPool
    uint256 public lockedAssets;
    mapping(uint32 perpIndex => uint256) public lockedByPerp;
    mapping(uint256 nonce => bool) public nonceUsed;
    /// @notice Number of covers ever sold; cover ids are 1..coverCount (0 = none).
    uint256 public coverCount;
    mapping(uint256 coverId => Cover) private _covers;

    // accounting (§5.3)
    uint256 public unearnedPremium; // Σ premium of Active covers
    uint256 public owedAssets; // Σ owed[buyer]
    mapping(address buyer => uint256) public owed;

    // sale throttle (§5.3 check 6)
    uint64 public windowStart;
    uint256 public windowAssets; // B snapshot at the sale window's start
    uint256 public soldInWindow; // gross payout sold in the current sale window
    mapping(address buyer => BuyerWindow) public buyerWindow;

    // payout breaker (§5.3 trigger step 2)
    uint64 public paidWindowStart;
    uint256 public paidWindowAssets; // B snapshot at the breaker window's start
    uint256 public paidInWindow; // payouts paid or deferred in the current breaker window

    // queued redeem (§5.4)
    struct RedeemSlot {
        uint256 shares;
        uint64 claimableAt;
    }

    mapping(address controller => RedeemSlot) private _redeemSlots;
    uint256 public totalEscrowedShares; // Σ slot.shares == balanceOf(address(this))

    // ================================================================ constructor (§5.6)

    constructor(
        IERC20 usdc,
        address owner_,
        address quoteSigner_,
        address guardian_,
        IPriceSource priceSource_,
        IPositionSource positionSource_,
        Limits memory limits_,
        uint32[] memory perps,
        uint64 configDelay_,
        uint64 withdrawDelay_,
        uint64 claimWindow_,
        bool strict_
    ) ERC20("Numera Cover Pool USDC", "nmUSDC") ERC4626(usdc) EIP712("Numera", "1") Ownable(owner_) {
        if (
            address(usdc) == address(0) || quoteSigner_ == address(0) || address(priceSource_) == address(0)
                || address(positionSource_) == address(0)
        ) revert ZeroAddress();
        // A non-testnet deploy can never get testnet delays or testnet limits.
        if (!strict_ && block.chainid != 998 && block.chainid != 31337) revert StrictRequired();
        if (
            configDelay_ < 5 minutes || configDelay_ > 30 days || withdrawDelay_ < 5 minutes
                || withdrawDelay_ > 60 days || claimWindow_ < 10 minutes || claimWindow_ > 7 days
                || (strict_ && (configDelay_ < 48 hours || claimWindow_ > withdrawDelay_ / 7 || claimWindow_ > 1 days))
        ) revert InvalidDelays();

        priceSource = priceSource_;
        positionSource = positionSource_;
        configDelay = configDelay_;
        withdrawDelay = withdrawDelay_;
        claimWindow = claimWindow_;
        strict = strict_;

        _validateLimits(limits_); // strict: maxDuration < withdrawDelay is checked here (InvalidLimits)
        _setQuoteSigner(quoteSigner_);
        _setLimits(limits_);
        _setGuardian(guardian_);
        for (uint256 i; i < perps.length; ++i) {
            // A bad index fails the deploy with the source's own error; the price itself is not needed.
            // forge-lint: disable-next-line(unused-return, calls-loop)
            priceSource_.oraclePx6(perps[i]);
            _setPerpAllowed(perps[i], true);
        }
    }

    // ================================================================ cover book (§5.3)

    /// @inheritdoc ICoverPool
    function buyCover(Quote calldata q, bytes calldata sig)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 coverId)
    {
        Limits memory l = _limits;
        _checkQuote(q, sig, l); // 1 + 2
        _checkPrice(q, l); // 3 (one price read)
        _checkPosition(q); // 4
        uint256 b = capacityBase();
        _checkCapacity(q, b, l); // 5
        (bool reset, uint256 soldAfter, uint256 buyerSoldAfter) = _checkThrottle(q, b, l); // 6

        // 7. effects, then pull premium
        nonceUsed[q.nonce] = true;
        lockedAssets += q.payout;
        lockedByPerp[q.perpIndex] += q.payout;
        unearnedPremium += q.premium;
        if (reset) {
            // forge-lint: disable-next-line(unsafe-typecast)
            windowStart = uint64(block.timestamp); // fits uint64 until year 584e9
            windowAssets = b;
        }
        soldInWindow = soldAfter;
        buyerWindow[msg.sender] = BuyerWindow(windowStart, SafeCast.toUint192(buyerSoldAfter));
        coverId = ++coverCount;
        _covers[coverId] = Cover({
            buyer: msg.sender,
            perpIndex: q.perpIndex,
            isLong: q.isLong,
            level: q.level,
            payout: q.payout,
            premium: q.premium,
            // forge-lint: disable-next-line(unsafe-typecast)
            start: uint64(block.timestamp),
            expiry: q.expiry,
            status: Status.Active
        });
        // Earlier external calls are view (STATICCALL) source reads; they cannot re-enter.
        // forge-lint: disable-next-line(reentrancy-events)
        emit CoverPurchased(coverId, msg.sender, q.perpIndex, q.isLong, q.level, q.payout, q.premium, q.expiry);

        IERC20(asset()).safeTransferFrom(msg.sender, address(this), q.premium);
    }

    /// @inheritdoc ICoverPool
    /// @dev Never reverts on the breaker or on a refused transfer: the payout is credited first and stays owed
    ///      (claimPayout) if the token refuses it.
    function trigger(uint256 coverId) external nonReentrant {
        Cover storage c = _covers[coverId];
        if (c.status != Status.Active) revert CoverNotActive(coverId);
        if (block.timestamp > c.expiry) revert CoverPastExpiry(coverId, c.expiry);
        uint64 px = priceSource.oraclePx6(c.perpIndex);
        if (!_breached(c.isLong, px, c.level)) revert LevelNotBreached(px, c.level);

        uint256 b = capacityBase(); // B before step 1
        address buyer = c.buyer;
        uint256 payout = c.payout;

        // 1. settle
        c.status = Status.Paid;
        _settle(c);

        // 2. payout breaker
        uint32 window = _limits.saleWindow;
        uint256 paid = payout;
        if (block.timestamp >= uint256(paidWindowStart) + window) {
            // forge-lint: disable-next-line(unsafe-typecast)
            paidWindowStart = uint64(block.timestamp);
            paidWindowAssets = b;
        } else {
            paid += paidInWindow;
        }
        paidInWindow = paid;
        uint256 cap = paidWindowAssets * _limits.maxPaidPerWindowBps / BPS;
        if (paid > cap && !paused()) {
            _pause();
            emit LossBreakerTripped(paid, cap);
        }

        // 3. credit first
        owed[buyer] += payout;
        owedAssets += payout;
        emit CoverTriggered(coverId, px, msg.sender);

        // 4. attempt the transfer; reverse the credit on success
        if (IERC20(asset()).trySafeTransfer(buyer, payout)) {
            owed[buyer] -= payout;
            owedAssets -= payout;
        } else {
            emit PayoutDeferred(coverId, buyer, payout);
        }
    }

    /// @inheritdoc ICoverPool
    function expire(uint256 coverId) external nonReentrant {
        Cover storage c = _covers[coverId];
        if (c.status != Status.Active) revert CoverNotActive(coverId);
        if (block.timestamp <= c.expiry) revert CoverNotYetExpired(coverId, c.expiry);

        c.status = Status.Expired;
        _settle(c);

        emit CoverExpired(coverId);
    }

    /// @inheritdoc ICoverPool
    /// @dev The caller's own balance only; works while paused. No redirect to another address.
    function claimPayout() external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        owedAssets -= amount;
        emit PayoutClaimed(msg.sender, amount);
        IERC20(asset()).safeTransfer(msg.sender, amount);
    }

    /// @inheritdoc ICoverPool
    function getCover(uint256 coverId) external view returns (Cover memory) {
        return _covers[coverId];
    }

    // ================================================================ EIP-712 helpers (§4)

    /// @notice EIP-712 struct hash of a quote.
    function quoteStructHash(Quote calldata q) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                QUOTE_TYPEHASH,
                q.buyer,
                q.perpIndex,
                q.isLong,
                q.level,
                q.payout,
                q.premium,
                q.expiry,
                q.spotRef,
                q.deadline,
                q.nonce
            )
        );
    }

    /// @notice Digest the quote signer signs: keccak256("\x19\x01" ‖ domainSeparator ‖ structHash).
    function quoteDigest(Quote calldata q) public view returns (bytes32) {
        return _hashTypedDataV4(quoteStructHash(q));
    }

    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ================================================================ limits views (§5.2)

    /// @inheritdoc ICoverPool
    function limits() external view returns (Limits memory) {
        return _limits;
    }

    function maxUtilizationBps() external view returns (uint16) {
        return _limits.maxUtilizationBps;
    }

    function perPerpCapBps() external view returns (uint16) {
        return _limits.perPerpCapBps;
    }

    function maxDuration() external view returns (uint64) {
        return _limits.maxDuration;
    }

    function maxSpotDeviationBps() external view returns (uint16) {
        return _limits.maxSpotDeviationBps;
    }

    function minPayout() external view returns (uint256) {
        return _limits.minPayout;
    }

    function minPremiumBps() external view returns (uint16) {
        return _limits.minPremiumBps;
    }

    function minLevelDistanceBps() external view returns (uint16) {
        return _limits.minLevelDistanceBps;
    }

    function saleWindow() external view returns (uint32) {
        return _limits.saleWindow;
    }

    function maxSoldPerWindowBps() external view returns (uint16) {
        return _limits.maxSoldPerWindowBps;
    }

    function maxBuyerWindowShareBps() external view returns (uint16) {
        return _limits.maxBuyerWindowShareBps;
    }

    function maxPaidPerWindowBps() external view returns (uint16) {
        return _limits.maxPaidPerWindowBps;
    }

    // ================================================================ vault accounting (§5.3)

    /// @notice USDC balance minus owed payouts and unearned premiums (saturating; the invariants keep it exact).
    function totalAssets() public view override returns (uint256) {
        uint256 bal = IERC20(asset()).balanceOf(address(this));
        uint256 reserved = owedAssets + unearnedPremium;
        return bal > reserved ? bal - reserved : 0;
    }

    /// @notice totalAssets - lockedAssets (saturating): the most LP claims can take in total.
    function freeAssets() public view returns (uint256) {
        uint256 assets = totalAssets();
        return assets > lockedAssets ? assets - lockedAssets : 0;
    }

    /// @inheritdoc ICoverPool
    /// @dev B = totalAssets - assets of escrowed (requested) shares, saturating at 0.
    function capacityBase() public view returns (uint256) {
        uint256 assets = totalAssets();
        uint256 escrowed = _convertToAssets(totalEscrowedShares, Math.Rounding.Floor);
        return assets > escrowed ? assets - escrowed : 0;
    }

    // ================================================================ deposits (synchronous, blocked while paused)

    function deposit(uint256 assets, address receiver) public override nonReentrant returns (uint256) {
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override nonReentrant returns (uint256) {
        return super.mint(shares, receiver);
    }

    function maxDeposit(address receiver) public view override returns (uint256) {
        return paused() ? 0 : super.maxDeposit(receiver);
    }

    function maxMint(address receiver) public view override returns (uint256) {
        return paused() ? 0 : super.maxMint(receiver);
    }

    // ================================================================ queued redeem (§5.4)

    /// @inheritdoc ICoverPool
    function requestRedeem(uint256 shares, address controller, address owner_)
        external
        nonReentrant
        returns (uint256 requestId)
    {
        if (msg.sender != owner_) revert NotShareOwner(msg.sender, owner_);
        if (controller != owner_) revert ControllerMustBeOwner(controller, owner_);
        RedeemSlot storage s = _redeemSlots[controller];
        if (_stateOf(s.shares, s.claimableAt) == RequestState.Claimable) revert RequestClaimable();
        uint256 total = s.shares + shares;
        if (total == 0) revert ZeroShares();

        super._update(owner_, address(this), shares); // into the escrow; ERC20 balance error if short
        s.shares = total;
        totalEscrowedShares += shares;
        // forge-lint: disable-next-line(unsafe-typecast)
        s.claimableAt = uint64(block.timestamp) + withdrawDelay; // the clock restarts for the whole slot
        emit RedeemRequest(controller, owner_, 0, msg.sender, shares);
        return 0;
    }

    /// @inheritdoc ICoverPool
    function cancelRedeemRequest() external nonReentrant returns (uint256 shares) {
        shares = _redeemSlots[msg.sender].shares;
        if (shares == 0) revert ZeroShares();
        delete _redeemSlots[msg.sender];
        totalEscrowedShares -= shares;
        super._update(address(this), msg.sender, shares);
        emit RedeemRequestCancelled(msg.sender, shares);
    }

    /// @notice Claim `shares` of a Claimable slot at the current share price (assets rounded down).
    function redeem(uint256 shares, address receiver, address controller)
        public
        override
        nonReentrant
        returns (uint256 assets)
    {
        RedeemSlot storage s = _claimableSlot(controller);
        assets = _convertToAssets(shares, Math.Rounding.Floor);
        _claim(s, controller, receiver, assets, shares);
    }

    /// @notice Claim `assets` from a Claimable slot at the current share price (shares rounded up).
    function withdraw(uint256 assets, address receiver, address controller)
        public
        override
        nonReentrant
        returns (uint256 shares)
    {
        RedeemSlot storage s = _claimableSlot(controller);
        shares = _convertToShares(assets, Math.Rounding.Ceil);
        _claim(s, controller, receiver, assets, shares);
    }

    function maxRedeem(address controller) public view override returns (uint256) {
        RedeemSlot memory s = _redeemSlots[controller];
        if (_stateOf(s.shares, s.claimableAt) != RequestState.Claimable) return 0;
        return Math.min(s.shares, _convertToShares(freeAssets(), Math.Rounding.Floor));
    }

    function maxWithdraw(address controller) public view override returns (uint256) {
        RedeemSlot memory s = _redeemSlots[controller];
        if (_stateOf(s.shares, s.claimableAt) != RequestState.Claimable) return 0;
        return Math.min(_convertToAssets(s.shares, Math.Rounding.Floor), freeAssets());
    }

    /// @dev Exits are asynchronous; there is no instant preview.
    function previewRedeem(uint256) public pure override returns (uint256) {
        revert AsyncRedeemOnly();
    }

    function previewWithdraw(uint256) public pure override returns (uint256) {
        revert AsyncRedeemOnly();
    }

    /// @inheritdoc ICoverPool
    function redeemRequestOf(address controller)
        external
        view
        returns (uint256 shares, uint64 claimableAt, uint64 claimDeadline, RequestState state)
    {
        RedeemSlot memory s = _redeemSlots[controller];
        state = _stateOf(s.shares, s.claimableAt);
        if (state != RequestState.None) {
            (shares, claimableAt, claimDeadline) = (s.shares, s.claimableAt, s.claimableAt + claimWindow);
        }
    }

    /// @inheritdoc ICoverPool
    function pendingRedeemRequest(uint256 requestId, address controller) external view returns (uint256) {
        return _sharesIn(requestId, controller, RequestState.Pending);
    }

    /// @inheritdoc ICoverPool
    function claimableRedeemRequest(uint256 requestId, address controller) external view returns (uint256) {
        return _sharesIn(requestId, controller, RequestState.Claimable);
    }

    // ================================================================ owner: timelock, guardian, pause (§5.5)

    /// @inheritdoc ICoverPool
    function queueSetQuoteSigner(address signer) external onlyOwner returns (bytes32) {
        if (signer == address(0)) revert ZeroAddress();
        return _queue(OpKind.QuoteSigner, abi.encode(signer));
    }

    /// @inheritdoc ICoverPool
    function queueSetLimits(Limits calldata l) external onlyOwner returns (bytes32) {
        _validateLimits(l);
        return _queue(OpKind.Limits, abi.encode(l));
    }

    /// @inheritdoc ICoverPool
    function queueSetPerpAllowed(uint32 perpIndex, bool allowed) external onlyOwner returns (bytes32) {
        // forge-lint: disable-next-line(unused-return)
        if (allowed) priceSource.oraclePx6(perpIndex); // validates the perp (the source reverts if unknown)
        return _queue(OpKind.PerpAllowed, abi.encode(perpIndex, allowed));
    }

    /// @inheritdoc ICoverPool
    function queueSetGuardian(address guardian_) external onlyOwner returns (bytes32) {
        return _queue(OpKind.Guardian, abi.encode(guardian_));
    }

    /// @inheritdoc ICoverPool
    /// @dev Executing a signer change invalidates every outstanding quote.
    function setQuoteSigner(address signer) external onlyOwner {
        _consume(OpKind.QuoteSigner, abi.encode(signer));
        if (signer == address(0)) revert ZeroAddress();
        _setQuoteSigner(signer);
    }

    /// @inheritdoc ICoverPool
    function setLimits(Limits calldata l) external onlyOwner {
        _consume(OpKind.Limits, abi.encode(l));
        _validateLimits(l);
        _setLimits(l);
    }

    /// @inheritdoc ICoverPool
    /// @dev Disallowing a perp affects new sales only; existing covers still trigger and expire.
    function setPerpAllowed(uint32 perpIndex, bool allowed) external onlyOwner {
        _consume(OpKind.PerpAllowed, abi.encode(perpIndex, allowed));
        // forge-lint: disable-next-line(unused-return)
        if (allowed) priceSource.oraclePx6(perpIndex); // validates the perp (the source reverts if unknown)
        _setPerpAllowed(perpIndex, allowed);
    }

    /// @inheritdoc ICoverPool
    function setGuardian(address guardian_) external onlyOwner {
        _consume(OpKind.Guardian, abi.encode(guardian_));
        _setGuardian(guardian_);
    }

    /// @inheritdoc ICoverPool
    function cancel(bytes32 id) external onlyOwner {
        if (queuedEta[id] == 0) revert OpNotQueued(id);
        delete queuedEta[id];
        emit ConfigCancelled(id);
    }

    /// @inheritdoc ICoverPool
    function opId(OpKind kind, bytes memory data) public pure returns (bytes32) {
        return keccak256(abi.encode(kind, data));
    }

    /// @inheritdoc ICoverPool
    /// @dev Pauses immediately; no-op if already paused. The guardian can never unpause.
    function guardianPause() external {
        if (msg.sender != guardian) revert NotGuardian();
        if (!paused()) _pause();
    }

    /// @inheritdoc ICoverPool
    /// @dev Unpausing also resets the breaker window, so the next payout opens a fresh one instead of
    ///      re-tripping on the payouts that tripped it.
    function setPaused(bool paused_) external onlyOwner {
        if (paused_) {
            _pause();
        } else {
            _unpause();
            paidWindowStart = 0;
            paidInWindow = 0;
        }
    }

    /// @notice Disabled: a renounced pool could never be paused again.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    // ================================================================ buyCover checks (§5.3, in order)

    /// @dev Check 1 (signature, buyer, deadline, nonce) and check 2 (allowlist, expiry, payout, premium floor).
    function _checkQuote(Quote calldata q, bytes calldata sig, Limits memory l) private view {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(quoteDigest(q), sig);
        if (err != ECDSA.RecoverError.NoError || recovered != quoteSigner) revert InvalidSignature();
        if (q.buyer != msg.sender) revert BuyerMismatch(q.buyer, msg.sender);
        if (block.timestamp > q.deadline) revert QuoteDeadlinePassed(q.deadline, block.timestamp);
        if (nonceUsed[q.nonce]) revert NonceAlreadyUsed(q.nonce);

        if (!perpAllowed[q.perpIndex]) revert PerpNotAllowed(q.perpIndex);
        if (q.expiry <= block.timestamp) revert ExpiryNotInFuture(q.expiry, block.timestamp);
        uint256 maxExpiry = block.timestamp + l.maxDuration;
        if (q.expiry > maxExpiry) revert DurationTooLong(q.expiry, maxExpiry);
        if (q.payout < l.minPayout) revert PayoutTooSmall(q.payout, l.minPayout);
        if (q.premium * BPS < q.payout * l.minPremiumBps) {
            revert PremiumBelowFloor(q.premium, Math.ceilDiv(q.payout * l.minPremiumBps, BPS));
        }
    }

    /// @dev Check 3: one oracle read; spot deviation, not already breached, level-distance floor.
    function _checkPrice(Quote calldata q, Limits memory l) private view {
        uint64 px = priceSource.oraclePx6(q.perpIndex);
        uint256 dev = px > q.spotRef ? px - q.spotRef : q.spotRef - px;
        if (dev * BPS > uint256(q.spotRef) * l.maxSpotDeviationBps) revert SpotDeviationTooHigh(px, q.spotRef);
        if (_breached(q.isLong, px, q.level)) revert LevelAlreadyBreached(px, q.level);
        uint256 dist = px > q.level ? px - q.level : q.level - px;
        if (dist * BPS < uint256(px) * l.minLevelDistanceBps) revert LevelTooClose(px, q.level);
    }

    /// @dev Check 4: buyer holds a same-direction position; payout <= initial-margin estimate.
    function _checkPosition(Quote calldata q) private view {
        (int64 szi, uint64 entryNtl, uint32 leverage) = positionSource.position(msg.sender, q.perpIndex);
        if (szi == 0) revert NoPosition(msg.sender, q.perpIndex);
        if ((szi > 0) != q.isLong) revert PositionSideMismatch(szi, q.isLong);
        uint256 cap = _marginCap(entryNtl, leverage);
        if (q.payout > cap) revert PayoutExceedsMarginCap(q.payout, cap);
    }

    /// @dev Check 5: pool and per-perp utilization against the capacity base B, before the premium arrives.
    function _checkCapacity(Quote calldata q, uint256 b, Limits memory l) private view {
        uint256 lockedAfter = lockedAssets + q.payout;
        uint256 maxLocked = b * l.maxUtilizationBps / BPS;
        if (lockedAfter > maxLocked) revert UtilizationExceeded(lockedAfter, maxLocked);
        uint256 perpLockedAfter = lockedByPerp[q.perpIndex] + q.payout;
        uint256 maxPerpLocked = b * l.perPerpCapBps / BPS;
        if (perpLockedAfter > maxPerpLocked) revert PerPerpCapExceeded(q.perpIndex, perpLockedAfter, maxPerpLocked);
    }

    /// @dev Check 6: sale throttle against the window-start snapshot, then the buyer's share of the window cap.
    function _checkThrottle(Quote calldata q, uint256 b, Limits memory l)
        private
        view
        returns (bool reset, uint256 soldAfter, uint256 buyerSoldAfter)
    {
        uint64 ws = windowStart;
        reset = block.timestamp >= uint256(ws) + l.saleWindow;
        uint256 cap = (reset ? b : windowAssets) * l.maxSoldPerWindowBps / BPS;
        soldAfter = (reset ? 0 : soldInWindow) + q.payout;
        if (soldAfter > cap) revert SaleWindowCapExceeded(soldAfter, cap);

        BuyerWindow memory bw = buyerWindow[msg.sender];
        buyerSoldAfter = (reset || bw.start != ws ? 0 : uint256(bw.sold)) + q.payout;
        // The spec defines the buyer cap on the integer window cap (§5.3 check 6).
        // forge-lint: disable-next-line(divide-before-multiply)
        uint256 buyerCap = cap * l.maxBuyerWindowShareBps / BPS;
        if (buyerSoldAfter > buyerCap) revert BuyerWindowCapExceeded(msg.sender, buyerSoldAfter, buyerCap);
    }

    // ================================================================ internal

    /// @dev Bounds of §5.2 (always) plus the strict-mode column. Constructor, queue time and execute time.
    function _validateLimits(Limits memory l) private view {
        bool bad = l.maxUtilizationBps == 0 || l.maxUtilizationBps > 9_000 || l.perPerpCapBps == 0
            || l.perPerpCapBps > l.maxUtilizationBps || l.maxDuration < 1 hours || l.maxDuration > 30 days
            || l.maxSpotDeviationBps == 0 || l.maxSpotDeviationBps > 500 || l.minPayout == 0
            || l.minPayout > 1_000_000e6 || l.minPremiumBps == 0 || l.minPremiumBps > 5_000
            || l.minLevelDistanceBps == 0 || l.minLevelDistanceBps > 2_000 || l.saleWindow < 60
            || l.saleWindow > 7 days || l.maxSoldPerWindowBps == 0 || l.maxSoldPerWindowBps > l.maxUtilizationBps
            || l.maxBuyerWindowShareBps == 0 || l.maxBuyerWindowShareBps > BPS || l.maxPaidPerWindowBps == 0
            || l.maxPaidPerWindowBps > l.maxSoldPerWindowBps;
        if (strict) {
            bad = bad || l.maxDuration >= withdrawDelay || l.maxSpotDeviationBps > 100 || l.minLevelDistanceBps < 10
                || l.saleWindow < 3_600 || l.maxSoldPerWindowBps > 2_500;
        }
        if (bad) revert InvalidLimits();
    }

    function _queue(OpKind kind, bytes memory data) private returns (bytes32 id) {
        id = opId(kind, data);
        if (queuedEta[id] != 0) revert OpAlreadyQueued(id);
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 eta = uint64(block.timestamp) + configDelay;
        queuedEta[id] = eta;
        emit ConfigQueued(id, kind, data, eta);
    }

    /// @dev Execute-side checks: queued, ready, not stale; then delete and emit ConfigExecuted.
    function _consume(OpKind kind, bytes memory data) private {
        bytes32 id = opId(kind, data);
        uint64 eta = queuedEta[id];
        if (eta == 0) revert OpNotQueued(id);
        if (block.timestamp < eta) revert OpNotReady(id, eta);
        if (block.timestamp > uint256(eta) + CONFIG_GRACE) revert OpStale(id, eta);
        delete queuedEta[id];
        emit ConfigExecuted(id);
    }

    function _setQuoteSigner(address signer) private {
        quoteSigner = signer;
        emit QuoteSignerUpdated(signer);
    }

    function _setLimits(Limits memory l) private {
        _limits = l;
        emit LimitsUpdated(l);
    }

    function _setPerpAllowed(uint32 perpIndex, bool allowed) private {
        perpAllowed[perpIndex] = allowed;
        emit PerpAllowedUpdated(perpIndex, allowed);
    }

    function _setGuardian(address guardian_) private {
        guardian = guardian_;
        emit GuardianUpdated(guardian_);
    }

    /// @dev Unlock a settling cover's payout (total and per perp) and release its premium to the pool.
    function _settle(Cover storage c) private {
        uint256 payout = c.payout;
        lockedAssets -= payout;
        lockedByPerp[c.perpIndex] -= payout;
        unearnedPremium -= c.premium;
    }

    function _stateOf(uint256 shares, uint64 claimableAt) private view returns (RequestState) {
        if (shares == 0) return RequestState.None;
        if (block.timestamp < claimableAt) return RequestState.Pending;
        if (block.timestamp < uint256(claimableAt) + claimWindow) return RequestState.Claimable;
        return RequestState.Lapsed;
    }

    function _sharesIn(uint256 requestId, address controller, RequestState want) private view returns (uint256) {
        RedeemSlot memory s = _redeemSlots[controller];
        return requestId == 0 && _stateOf(s.shares, s.claimableAt) == want ? s.shares : 0;
    }

    /// @dev Claim checks 1 and 2.
    function _claimableSlot(address controller) private view returns (RedeemSlot storage s) {
        if (msg.sender != controller) revert NotController(msg.sender, controller);
        s = _redeemSlots[controller];
        RequestState st = _stateOf(s.shares, s.claimableAt);
        if (st != RequestState.Claimable) revert RequestNotClaimable(st);
    }

    /// @dev Claim checks 3 and 4, then effects: burn from the escrow and pay `receiver`.
    function _claim(RedeemSlot storage s, address controller, address receiver, uint256 assets, uint256 shares)
        private
    {
        if (shares == 0) revert ZeroShares();
        uint256 slotShares = s.shares;
        if (shares > slotShares) revert ExceedsClaimable(shares, slotShares);
        uint256 free = freeAssets();
        if (assets > free) revert InsufficientFreeAssets(assets, free);

        if (shares == slotShares) delete _redeemSlots[controller];
        else s.shares = slotShares - shares;
        totalEscrowedShares -= shares;
        _burn(address(this), shares);
        emit Withdraw(msg.sender, receiver, controller, assets, shares);
        IERC20(asset()).safeTransfer(receiver, assets);
    }

    /// @dev Rejects any transfer or mint of shares to the pool; the escrow moves through super._update.
    function _update(address from, address to, uint256 value) internal override {
        if (to == address(this)) revert SharesToPool();
        super._update(from, to, value);
    }

    /// @dev Long cover pays when oracle <= level, short cover when oracle >= level.
    function _breached(bool isLong, uint64 px, uint64 level) internal pure returns (bool) {
        return isLong ? px <= level : px >= level;
    }

    /// @dev Initial-margin estimate = entryNtl / leverage, in USDC 6-dec units (entryNtl is USD x 1e6,
    ///      verified on testnet, docs/research/hyperliquid.md).
    function _marginCap(uint64 entryNtl, uint32 leverage) internal pure returns (uint256) {
        if (leverage == 0) return 0;
        return uint256(entryNtl) / leverage;
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return DECIMALS_OFFSET;
    }

    /// @dev ERC20 and ERC4626 both define decimals(); ERC4626 adds the offset.
    function decimals() public view override(ERC4626) returns (uint8) {
        return super.decimals();
    }
}
