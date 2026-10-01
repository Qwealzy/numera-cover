// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPositionSource} from "../interfaces/IPositionSource.sol";

/// @title HyperCorePositionSource — a user's perp position, read from the HyperCore 0x…0800 precompile
/// @notice `position(address user, uint16 perp)` → `(int64 szi, uint64 entryNtl, int64 isolatedRawUsd,
///         uint32 leverage, bool isIsolated)` (docs/research/hyperliquid.md §Read precompiles).
/// @dev The precompile takes the perp index as uint16; larger indices are rejected with a named error.
///      Scaling of `entryNtl` is UNVERIFIED (assumed USD x 1e6); it is passed through unchanged and
///      interpreted only in CoverPool._marginCap.
contract HyperCorePositionSource is IPositionSource {
    address public constant POSITION_PRECOMPILE = 0x0000000000000000000000000000000000000800;

    /// @dev Documented cost 2000 + 65 x (64 + 160) = ~16.6k; cap leaves headroom and bounds burnt gas.
    uint256 public constant POSITION_GAS = 100_000;

    /// @dev Shape returned by the 0x…0800 precompile (hyper-evm-lib L1Read.Position).
    struct Position {
        int64 szi;
        uint64 entryNtl;
        int64 isolatedRawUsd;
        uint32 leverage;
        bool isIsolated;
    }

    error PrecompileCallFailed(address precompile, uint32 perpIndex);
    error PerpIndexOutOfRange(uint32 perpIndex);

    /// @inheritdoc IPositionSource
    function position(address user, uint32 perpIndex)
        external
        view
        returns (int64 szi, uint64 entryNtl, uint32 leverage)
    {
        Position memory p = rawPosition(user, perpIndex);
        return (p.szi, p.entryNtl, p.leverage);
    }

    /// @notice Full precompile result (for debugging and verifying entryNtl scaling on testnet).
    function rawPosition(address user, uint32 perpIndex) public view returns (Position memory) {
        if (perpIndex > type(uint16).max) revert PerpIndexOutOfRange(perpIndex);
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes memory input = abi.encode(user, uint16(perpIndex)); // range checked above
        // Fixed system precompile, not attacker code: no return-bomb risk.
        // forge-lint: disable-next-line(return-bomb)
        (bool ok, bytes memory res) = POSITION_PRECOMPILE.staticcall{gas: POSITION_GAS}(input);
        if (!ok || res.length < 160) revert PrecompileCallFailed(POSITION_PRECOMPILE, perpIndex);
        return abi.decode(res, (Position));
    }
}
