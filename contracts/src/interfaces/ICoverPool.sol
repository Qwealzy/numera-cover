// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Cover book interface of CoverPool. Types, function names and event signatures are the frozen
///         contract of ARCHITECTURE §4–5; do not change them without changing the doc first.
interface ICoverPool {
    // ---------------------------------------------------------------- types (§4, §5)

    /// @dev EIP-712 type string (exact):
    /// Quote(address buyer,uint32 perpIndex,bool isLong,uint64 level,uint256 payout,uint256 premium,uint64 expiry,uint64 spotRef,uint64 deadline,uint256 nonce)
    struct Quote {
        address buyer; // must equal msg.sender
        uint32 perpIndex;
        bool isLong; // direction of the covered position
        uint64 level; // px6 trigger level
        uint256 payout; // USDC (6 dec)
        uint256 premium; // USDC (6 dec)
        uint64 expiry; // cover end (unix s)
        uint64 spotRef; // px6 oracle price the engine priced against
        uint64 deadline; // quote must be used before this (unix s)
        uint256 nonce; // unique per quote; contract marks used
    }

    enum Status {
        None,
        Active,
        Paid,
        Expired
    }

    struct Cover {
        address buyer;
        uint32 perpIndex;
        bool isLong;
        uint64 level;
        uint256 payout;
        uint256 premium;
        uint64 start;
        uint64 expiry;
        Status status;
    }

    // ---------------------------------------------------------------- events (§5, frozen)

    event CoverPurchased(
        uint256 indexed coverId,
        address indexed buyer,
        uint32 indexed perpIndex,
        bool isLong,
        uint64 level,
        uint256 payout,
        uint256 premium,
        uint64 expiry
    );
    event CoverTriggered(uint256 indexed coverId, uint64 oraclePx, address caller);
    event CoverExpired(uint256 indexed coverId);

    // ---------------------------------------------------------------- admin events (additions)

    event QuoteSignerUpdated(address indexed signer);
    event LimitsUpdated(
        uint16 maxUtilizationBps,
        uint16 perPerpCapBps,
        uint64 maxDuration,
        uint16 maxSpotDeviationBps,
        uint256 minPayout
    );

    // ---------------------------------------------------------------- buyCover errors, in check order (§5)

    // check 1
    error InvalidSignature();
    error BuyerMismatch(address buyer, address sender);
    error QuoteDeadlinePassed(uint64 deadline, uint256 nowTs);
    error NonceAlreadyUsed(uint256 nonce);
    // check 2
    error ExpiryNotInFuture(uint64 expiry, uint256 nowTs);
    error DurationTooLong(uint64 expiry, uint256 maxExpiry);
    error PayoutTooSmall(uint256 payout, uint256 minPayout);
    // check 3
    error SpotDeviationTooHigh(uint64 oraclePx, uint64 spotRef);
    error LevelAlreadyBreached(uint64 oraclePx, uint64 level);
    // check 4
    error NoPosition(address buyer, uint32 perpIndex);
    error PositionSideMismatch(int64 szi, bool isLong);
    error PayoutExceedsMarginCap(uint256 payout, uint256 marginCap);
    // check 5
    error UtilizationExceeded(uint256 lockedAfter, uint256 maxLocked);
    error PerPerpCapExceeded(uint32 perpIndex, uint256 perpLockedAfter, uint256 maxPerpLocked);

    // ---------------------------------------------------------------- trigger / expire errors

    error CoverNotActive(uint256 coverId);
    error CoverPastExpiry(uint256 coverId, uint64 expiry);
    error LevelNotBreached(uint64 oraclePx, uint64 level);
    error CoverNotYetExpired(uint256 coverId, uint64 expiry);

    // ---------------------------------------------------------------- admin errors

    error ZeroAddress();
    error InvalidLimits();

    // ---------------------------------------------------------------- functions (§5)

    function buyCover(Quote calldata q, bytes calldata sig) external returns (uint256 coverId);
    function trigger(uint256 coverId) external; // permissionless
    function expire(uint256 coverId) external; // permissionless, after expiry
    function getCover(uint256 coverId) external view returns (Cover memory);
    function lockedAssets() external view returns (uint256);
}
