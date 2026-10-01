// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ICoverPool} from "./interfaces/ICoverPool.sol";
import {IPriceSource} from "./interfaces/IPriceSource.sol";
import {IPositionSource} from "./interfaces/IPositionSource.sol";

/// @title CoverPool — Numera liquidation cover for Hyperliquid perps
/// @notice ERC-4626 USDC underwriter vault plus a book of parametric covers sold against EIP-712 quotes
///         signed by the off-chain actuarial engine (ARCHITECTURE §4–5, D6, D7).
///         Solvency: every cover's payout is locked at sale (`lockedAssets`), and LP withdrawals are limited
///         to `totalAssets - lockedAssets`, so `USDC balance >= lockedAssets` always holds.
/// @dev Pause stops new covers and new deposits only. Trigger, expire and withdrawals of free assets keep
///      working while paused so buyers can always be paid and LPs can always leave with free capital.
contract CoverPool is ICoverPool, ERC4626, EIP712, Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- constants

    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(address buyer,uint32 perpIndex,bool isLong,uint64 level,uint256 payout,uint256 premium,uint64 expiry,uint64 spotRef,uint64 deadline,uint256 nonce)"
    );
    uint256 private constant BPS = 10_000;
    /// @dev Share decimals = 6 (USDC) + 6. Virtual shares/assets defeat the first-depositor inflation attack.
    uint8 private constant DECIMALS_OFFSET = 6;

    // ---------------------------------------------------------------- immutables

    IPriceSource public immutable priceSource;
    IPositionSource public immutable positionSource;

    // ---------------------------------------------------------------- storage

    address public quoteSigner;

    uint16 public maxUtilizationBps = 8_000; // locked <= 80 % of totalAssets
    uint16 public perPerpCapBps = 5_000; // locked on one perp <= 50 % of totalAssets
    uint64 public maxDuration = 7 days;
    uint16 public maxSpotDeviationBps = 100; // oracle within 1 % of the quote's spotRef
    uint256 public minPayout = 1e6; // 1 USDC

    /// @inheritdoc ICoverPool
    uint256 public lockedAssets;
    mapping(uint32 perpIndex => uint256) public lockedByPerp;
    mapping(uint256 nonce => bool) public nonceUsed;

    /// @notice Number of covers ever sold; cover ids are 1..coverCount (0 = none).
    uint256 public coverCount;
    mapping(uint256 coverId => Cover) private _covers;

    // ---------------------------------------------------------------- constructor

    constructor(
        IERC20 usdc,
        address owner_,
        address quoteSigner_,
        IPriceSource priceSource_,
        IPositionSource positionSource_
    ) ERC20("Numera Cover Pool USDC", "nmUSDC") ERC4626(usdc) EIP712("Numera", "1") Ownable(owner_) {
        if (
            address(usdc) == address(0) || quoteSigner_ == address(0) || address(priceSource_) == address(0)
                || address(positionSource_) == address(0)
        ) revert ZeroAddress();
        quoteSigner = quoteSigner_;
        priceSource = priceSource_;
        positionSource = positionSource_;
        emit QuoteSignerUpdated(quoteSigner_);
    }

    // ---------------------------------------------------------------- cover book

    /// @inheritdoc ICoverPool
    function buyCover(Quote calldata q, bytes calldata sig)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 coverId)
    {
        _checkQuote(q, sig); // 1 + 2
        _checkPrice(q); // 3
        _checkPosition(q); // 4
        _checkCapacity(q); // 5

        // 6. effects, then pull premium
        nonceUsed[q.nonce] = true;
        lockedAssets += q.payout;
        lockedByPerp[q.perpIndex] += q.payout;
        coverId = ++coverCount;
        _covers[coverId] = Cover({
            buyer: msg.sender,
            perpIndex: q.perpIndex,
            isLong: q.isLong,
            level: q.level,
            payout: q.payout,
            premium: q.premium,
            // forge-lint: disable-next-line(unsafe-typecast)
            start: uint64(block.timestamp), // fits uint64 until year 584e9
            expiry: q.expiry,
            status: Status.Active
        });
        // Earlier external calls are view (STATICCALL) source reads; they cannot re-enter.
        // forge-lint: disable-next-line(reentrancy-events)
        emit CoverPurchased(coverId, msg.sender, q.perpIndex, q.isLong, q.level, q.payout, q.premium, q.expiry);

        IERC20(asset()).safeTransferFrom(msg.sender, address(this), q.premium);
    }

    /// @inheritdoc ICoverPool
    function trigger(uint256 coverId) external nonReentrant {
        Cover storage c = _covers[coverId];
        if (c.status != Status.Active) revert CoverNotActive(coverId);
        if (block.timestamp > c.expiry) revert CoverPastExpiry(coverId, c.expiry);
        uint64 px = priceSource.oraclePx6(c.perpIndex);
        if (!_breached(c.isLong, px, c.level)) revert LevelNotBreached(px, c.level);

        c.status = Status.Paid;
        _unlock(c.perpIndex, c.payout);
        emit CoverTriggered(coverId, px, msg.sender);

        IERC20(asset()).safeTransfer(c.buyer, c.payout);
    }

    /// @inheritdoc ICoverPool
    function expire(uint256 coverId) external nonReentrant {
        Cover storage c = _covers[coverId];
        if (c.status != Status.Active) revert CoverNotActive(coverId);
        if (block.timestamp <= c.expiry) revert CoverNotYetExpired(coverId, c.expiry);

        c.status = Status.Expired;
        _unlock(c.perpIndex, c.payout);

        emit CoverExpired(coverId);
    }

    /// @inheritdoc ICoverPool
    function getCover(uint256 coverId) external view returns (Cover memory) {
        return _covers[coverId];
    }

    // ---------------------------------------------------------------- EIP-712 helpers

    /// @notice EIP-712 struct hash of a quote (ARCHITECTURE §4).
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

    // ---------------------------------------------------------------- vault views

    /// @notice USDC not reserved for active covers; the most LPs can withdraw in total.
    function freeAssets() public view returns (uint256) {
        uint256 assets = totalAssets();
        return assets > lockedAssets ? assets - lockedAssets : 0;
    }

    /// @dev totalAssets = USDC balance (ERC4626 default): premiums raise share price, payouts lower it.
    function maxWithdraw(address owner_) public view override returns (uint256) {
        return Math.min(super.maxWithdraw(owner_), freeAssets());
    }

    function maxRedeem(address owner_) public view override returns (uint256) {
        return Math.min(super.maxRedeem(owner_), _convertToShares(freeAssets(), Math.Rounding.Floor));
    }

    function maxDeposit(address receiver) public view override returns (uint256) {
        return paused() ? 0 : super.maxDeposit(receiver);
    }

    function maxMint(address receiver) public view override returns (uint256) {
        return paused() ? 0 : super.maxMint(receiver);
    }

    // ---------------------------------------------------------------- admin

    function setQuoteSigner(address signer) external onlyOwner {
        if (signer == address(0)) revert ZeroAddress();
        quoteSigner = signer;
        emit QuoteSignerUpdated(signer);
    }

    function setLimits(
        uint16 maxUtilizationBps_,
        uint16 perPerpCapBps_,
        uint64 maxDuration_,
        uint16 maxSpotDeviationBps_,
        uint256 minPayout_
    ) external onlyOwner {
        if (
            maxUtilizationBps_ == 0 || maxUtilizationBps_ > BPS || perPerpCapBps_ == 0 || perPerpCapBps_ > BPS
                || maxDuration_ == 0 || maxSpotDeviationBps_ > BPS || minPayout_ == 0
        ) revert InvalidLimits();
        maxUtilizationBps = maxUtilizationBps_;
        perPerpCapBps = perPerpCapBps_;
        maxDuration = maxDuration_;
        maxSpotDeviationBps = maxSpotDeviationBps_;
        minPayout = minPayout_;
        emit LimitsUpdated(maxUtilizationBps_, perPerpCapBps_, maxDuration_, maxSpotDeviationBps_, minPayout_);
    }

    function setPaused(bool paused_) external onlyOwner {
        if (paused_) _pause();
        else _unpause();
    }

    // ---------------------------------------------------------------- buyCover checks (§5, in order)

    /// @dev Check 1 (signature, buyer, deadline, nonce) and check 2 (expiry window, minimum payout).
    function _checkQuote(Quote calldata q, bytes calldata sig) private view {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(quoteDigest(q), sig);
        if (err != ECDSA.RecoverError.NoError || recovered != quoteSigner) revert InvalidSignature();
        if (q.buyer != msg.sender) revert BuyerMismatch(q.buyer, msg.sender);
        if (block.timestamp > q.deadline) revert QuoteDeadlinePassed(q.deadline, block.timestamp);
        if (nonceUsed[q.nonce]) revert NonceAlreadyUsed(q.nonce);

        if (q.expiry <= block.timestamp) revert ExpiryNotInFuture(q.expiry, block.timestamp);
        uint256 maxExpiry = block.timestamp + maxDuration;
        if (q.expiry > maxExpiry) revert DurationTooLong(q.expiry, maxExpiry);
        if (q.payout < minPayout) revert PayoutTooSmall(q.payout, minPayout);
    }

    /// @dev Check 3: oracle within maxSpotDeviationBps of the engine's spotRef, level not already breached.
    function _checkPrice(Quote calldata q) private view {
        uint64 px = priceSource.oraclePx6(q.perpIndex);
        uint256 diff = px > q.spotRef ? px - q.spotRef : q.spotRef - px;
        if (diff * BPS > uint256(q.spotRef) * maxSpotDeviationBps) revert SpotDeviationTooHigh(px, q.spotRef);
        if (_breached(q.isLong, px, q.level)) revert LevelAlreadyBreached(px, q.level);
    }

    /// @dev Check 4 (D3): buyer holds a same-direction position; payout <= initial-margin estimate.
    function _checkPosition(Quote calldata q) private view {
        (int64 szi, uint64 entryNtl, uint32 leverage) = positionSource.position(msg.sender, q.perpIndex);
        if (szi == 0) revert NoPosition(msg.sender, q.perpIndex);
        if ((szi > 0) != q.isLong) revert PositionSideMismatch(szi, q.isLong);
        uint256 cap = _marginCap(entryNtl, leverage);
        if (q.payout > cap) revert PayoutExceedsMarginCap(q.payout, cap);
    }

    /// @dev Check 5 (D6): pool and per-perp utilization, against totalAssets before this premium arrives.
    function _checkCapacity(Quote calldata q) private view {
        uint256 assets = totalAssets();
        uint256 lockedAfter = lockedAssets + q.payout;
        uint256 maxLocked = assets * maxUtilizationBps / BPS;
        if (lockedAfter > maxLocked) revert UtilizationExceeded(lockedAfter, maxLocked);
        uint256 perpLockedAfter = lockedByPerp[q.perpIndex] + q.payout;
        uint256 maxPerpLocked = assets * perPerpCapBps / BPS;
        if (perpLockedAfter > maxPerpLocked) revert PerPerpCapExceeded(q.perpIndex, perpLockedAfter, maxPerpLocked);
    }

    // ---------------------------------------------------------------- internal

    /// @dev Long cover pays when oracle <= level, short cover when oracle >= level (ARCHITECTURE §3).
    function _breached(bool isLong, uint64 px, uint64 level) internal pure returns (bool) {
        return isLong ? px <= level : px >= level;
    }

    /// @dev Initial-margin estimate = entryNtl / leverage, in USDC 6-dec units.
    ///      UNVERIFIED SCALING: assumes the 0x…0800 precompile's `entryNtl` is USD x 1e6 (= USDC units).
    ///      If testnet shows another scale, fix it here (one line); nothing else depends on it.
    function _marginCap(uint64 entryNtl, uint32 leverage) internal pure returns (uint256) {
        if (leverage == 0) return 0;
        return uint256(entryNtl) / leverage;
    }

    function _unlock(uint32 perpIndex, uint256 payout) private {
        lockedAssets -= payout;
        lockedByPerp[perpIndex] -= payout;
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return DECIMALS_OFFSET;
    }

    /// @dev ERC20 and ERC4626 both define decimals(); ERC4626 adds the offset.
    function decimals() public view override(ERC4626) returns (uint8) {
        return super.decimals();
    }
}
