// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

/// @notice Perp position of a user, used by CoverPool to check insurable interest (ARCHITECTURE §5, D3).
interface IPositionSource {
    /// @return szi Signed position size (> 0 long, < 0 short, 0 none), HyperCore raw units.
    /// @return entryNtl Entry notional. Assumed USD x 1e6 (UNVERIFIED, see research §Read precompiles).
    /// @return leverage Position leverage (integer, e.g. 20 for 20x).
    function position(address user, uint32 perpIndex)
        external
        view
        returns (int64 szi, uint64 entryNtl, uint32 leverage);
}
