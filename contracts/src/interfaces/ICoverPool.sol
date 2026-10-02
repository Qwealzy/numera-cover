// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

/// @notice CoverPool v2 interface: types, events, errors and the cover-book / queue / timelock functions.
///         This is the frozen contract of docs/ARCHITECTURE.md §4–5 (mirrored in docs/how-it-works.md);
///         do not change it without changing the doc first.
interface ICoverPool {
    // ================================================================ types (§4, §5.1–§5.5)

    /// @dev EIP-712 type string (exact, unchanged from v1):
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

    /// @dev §5.2. bps are uint16 (10_000 = 100 %), durations seconds, USDC 6 decimals.
    struct Limits {
        uint16 maxUtilizationBps; // lockedAssets <= B x this
        uint16 perPerpCapBps; // lockedByPerp[i] <= B x this
        uint64 maxDuration; // expiry <= now + this (s)
        uint16 maxSpotDeviationBps; // |px - spotRef| <= spotRef x this
        uint256 minPayout; // USDC 6 dec
        uint16 minPremiumBps; // premium >= payout x this
        uint16 minLevelDistanceBps; // |px - level| >= px x this
        uint32 saleWindow; // window length (s) for the sale throttle and the payout breaker
        uint16 maxSoldPerWindowBps; // payout sold per window <= windowAssets x this
        uint16 maxBuyerWindowShareBps; // one buyer's share of the window's sale cap
        uint16 maxPaidPerWindowBps; // payouts paid per window above paidWindowAssets x this -> auto-pause
    }

    /// @dev §5.3: `sold` counts only while `start == windowStart`.
    struct BuyerWindow {
        uint64 start;
        uint192 sold;
    }

    /// @dev §5.4: state of a controller's redeem slot.
    enum RequestState {
        None,
        Pending,
        Claimable,
        Lapsed
    }

    /// @dev §5.5: timelocked operation kinds; op id = keccak256(abi.encode(kind, data)).
    enum OpKind {
        QuoteSigner,
        Limits,
        PerpAllowed,
        Guardian
    }

    // ================================================================ events

    // cover book (§5.1, unchanged)
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

    // payouts (§5.3)
    event PayoutDeferred(uint256 indexed coverId, address indexed buyer, uint256 amount);
    event PayoutClaimed(address indexed buyer, uint256 amount);
    event LossBreakerTripped(uint256 paidInWindow, uint256 cap);

    // queued redeem (§5.4; claims emit the ERC-4626 Withdraw event)
    event RedeemRequest(
        address indexed controller, address indexed owner, uint256 indexed requestId, address sender, uint256 shares
    );
    event RedeemRequestCancelled(address indexed controller, uint256 shares);

    // owner and timelock (§5.5)
    event ConfigQueued(bytes32 indexed id, OpKind kind, bytes data, uint64 eta);
    event ConfigExecuted(bytes32 indexed id);
    event ConfigCancelled(bytes32 indexed id);
    event QuoteSignerUpdated(address indexed signer);
    event LimitsUpdated(Limits limits);
    event PerpAllowedUpdated(uint32 indexed perpIndex, bool allowed);
    event GuardianUpdated(address indexed guardian);

    // ================================================================ buyCover errors, in check order (§5.3)

    // check 1
    error InvalidSignature();
    error BuyerMismatch(address buyer, address sender);
    error QuoteDeadlinePassed(uint64 deadline, uint256 nowTs);
    error NonceAlreadyUsed(uint256 nonce);
    // check 2
    error PerpNotAllowed(uint32 perpIndex);
    error ExpiryNotInFuture(uint64 expiry, uint256 nowTs);
    error DurationTooLong(uint64 expiry, uint256 maxExpiry);
    error PayoutTooSmall(uint256 payout, uint256 minPayout);
    error PremiumBelowFloor(uint256 premium, uint256 minPremium);
    // check 3
    error SpotDeviationTooHigh(uint64 oraclePx, uint64 spotRef);
    error LevelAlreadyBreached(uint64 oraclePx, uint64 level);
    error LevelTooClose(uint64 oraclePx, uint64 level);
    // check 4
    error NoPosition(address buyer, uint32 perpIndex);
    error PositionSideMismatch(int64 szi, bool isLong);
    error PayoutExceedsMarginCap(uint256 payout, uint256 marginCap);
    // check 5
    error UtilizationExceeded(uint256 lockedAfter, uint256 maxLocked);
    error PerPerpCapExceeded(uint32 perpIndex, uint256 perpLockedAfter, uint256 maxPerpLocked);
    // check 6
    error SaleWindowCapExceeded(uint256 soldAfter, uint256 cap);
    error BuyerWindowCapExceeded(address buyer, uint256 soldAfter, uint256 cap);

    // ================================================================ trigger / expire / claimPayout errors

    error CoverNotActive(uint256 coverId);
    error CoverPastExpiry(uint256 coverId, uint64 expiry);
    error LevelNotBreached(uint64 oraclePx, uint64 level);
    error CoverNotYetExpired(uint256 coverId, uint64 expiry);
    error NothingOwed();

    // ================================================================ queued redeem errors (§5.4)

    error NotShareOwner(address sender, address owner);
    error ControllerMustBeOwner(address controller, address owner);
    error NotController(address sender, address controller);
    error RequestClaimable();
    error RequestNotClaimable(RequestState state);
    error ZeroShares();
    error ExceedsClaimable(uint256 shares, uint256 claimable);
    error InsufficientFreeAssets(uint256 assets, uint256 free);
    error AsyncRedeemOnly();
    error SharesToPool();

    // ================================================================ owner / timelock / deploy errors (§5.5, §5.6)

    error ZeroAddress();
    error InvalidLimits();
    error NotGuardian();
    error OpAlreadyQueued(bytes32 id);
    error OpNotQueued(bytes32 id);
    error OpNotReady(bytes32 id, uint64 eta);
    error OpStale(bytes32 id, uint64 eta);
    error RenounceDisabled();
    error InvalidDelays();
    error StrictRequired();

    // ================================================================ cover book (§5.1, §5.3)

    function buyCover(Quote calldata q, bytes calldata sig) external returns (uint256 coverId);
    function trigger(uint256 coverId) external; // permissionless
    function expire(uint256 coverId) external; // permissionless, after expiry
    function claimPayout() external;
    function getCover(uint256 coverId) external view returns (Cover memory);
    function lockedAssets() external view returns (uint256);
    function limits() external view returns (Limits memory);
    function capacityBase() external view returns (uint256);

    // ================================================================ queued redeem (§5.4)

    function requestRedeem(uint256 shares, address controller, address owner) external returns (uint256 requestId);
    function cancelRedeemRequest() external returns (uint256 shares);
    function redeemRequestOf(address controller)
        external
        view
        returns (uint256 shares, uint64 claimableAt, uint64 claimDeadline, RequestState state);
    function pendingRedeemRequest(uint256 requestId, address controller) external view returns (uint256 shares);
    function claimableRedeemRequest(uint256 requestId, address controller) external view returns (uint256 shares);

    // ================================================================ owner, timelock, guardian (§5.5)

    function queueSetQuoteSigner(address signer) external returns (bytes32 id);
    function queueSetLimits(Limits calldata l) external returns (bytes32 id);
    function queueSetPerpAllowed(uint32 perpIndex, bool allowed) external returns (bytes32 id);
    function queueSetGuardian(address guardian) external returns (bytes32 id);
    function setQuoteSigner(address signer) external;
    function setLimits(Limits calldata l) external;
    function setPerpAllowed(uint32 perpIndex, bool allowed) external;
    function setGuardian(address guardian) external;
    function cancel(bytes32 id) external;
    function guardianPause() external;
    function setPaused(bool paused) external;
    function opId(OpKind kind, bytes memory data) external pure returns (bytes32);
}
