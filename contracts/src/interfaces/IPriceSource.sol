// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @notice Oracle price feed used by CoverPool. Prices are px6 (USD x 1e6), docs/how-it-works.md §3.
interface IPriceSource {
    /// @return px6 Current oracle price of `perpIndex` in USD x 1e6. MUST revert (never return 0) when
    ///         the price is unavailable, so a missing price can never look like a breach.
    function oraclePx6(uint32 perpIndex) external view returns (uint64 px6);
}
