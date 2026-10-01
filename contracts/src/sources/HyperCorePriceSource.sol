// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {IPriceSource} from "../interfaces/IPriceSource.sol";

/// @title HyperCorePriceSource — oracle price of a Hyperliquid perp, read from HyperCore precompiles
/// @notice Reads `oraclePx(uint32)` at 0x…0807 and `perpAssetInfo(uint32)` at 0x…080a
///         (HyperEVM read precompile) and normalizes to px6 = raw x 10^szDecimals.
/// @dev Precompiles take raw `abi.encode(args)` (no selector). An invalid perp index makes the precompile
///      fail and burn ALL forwarded gas, so every call is gas-capped and failures revert with a named error.
///      `szDecimals` is validated once and cached by the permissionless `cachePerp`; uncached perps are
///      read live (one extra precompile call) so a view call never depends on a prior transaction.
contract HyperCorePriceSource is IPriceSource {
    address public constant ORACLE_PX_PRECOMPILE = 0x0000000000000000000000000000000000000807;
    address public constant PERP_ASSET_INFO_PRECOMPILE = 0x000000000000000000000000000000000000080a;

    /// @dev Documented cost is 2000 + 65 x (input_len + output_len): ~6.2k for oraclePx, ~21k for
    ///      perpAssetInfo with a short coin name. Caps leave >2x headroom and bound the gas an invalid
    ///      index can burn.
    uint256 public constant ORACLE_PX_GAS = 50_000;
    uint256 public constant PERP_INFO_GAS = 100_000;

    /// @dev Shape returned by the 0x…080a precompile (hyper-evm-lib L1Read.PerpAssetInfo).
    struct PerpAssetInfo {
        string coin;
        uint32 marginTableId;
        uint8 szDecimals;
        uint8 maxLeverage;
        bool onlyIsolated;
    }

    struct CachedPerp {
        bool cached;
        uint8 szDecimals;
    }

    mapping(uint32 perpIndex => CachedPerp) public cachedPerp;

    event PerpCached(uint32 indexed perpIndex, string coin, uint8 szDecimals);

    error PrecompileCallFailed(address precompile, uint32 perpIndex);
    error InvalidPerpInfo(uint32 perpIndex, uint8 szDecimals);
    error InvalidOraclePrice(uint32 perpIndex);
    error PriceOverflow(uint32 perpIndex, uint256 px6);

    /// @notice Validate `perpIndex` against HyperCore and cache its szDecimals. Permissionless, idempotent.
    function cachePerp(uint32 perpIndex) external returns (uint8 szDecimals) {
        PerpAssetInfo memory info = _readPerpInfo(perpIndex);
        cachedPerp[perpIndex] = CachedPerp({cached: true, szDecimals: info.szDecimals});
        emit PerpCached(perpIndex, info.coin, info.szDecimals);
        return info.szDecimals;
    }

    /// @notice szDecimals of `perpIndex` (cached, or read live and validated).
    function szDecimalsOf(uint32 perpIndex) public view returns (uint8) {
        CachedPerp memory c = cachedPerp[perpIndex];
        if (c.cached) return c.szDecimals;
        return _readPerpInfo(perpIndex).szDecimals;
    }

    /// @inheritdoc IPriceSource
    function oraclePx6(uint32 perpIndex) external view returns (uint64) {
        uint8 szDecimals = szDecimalsOf(perpIndex); // validates the index before the price read
        uint64 raw = _readOraclePx(perpIndex);
        if (raw == 0) revert InvalidOraclePrice(perpIndex);
        uint256 px6 = uint256(raw) * 10 ** szDecimals; // raw has (6 - szDecimals) decimals
        if (px6 > type(uint64).max) revert PriceOverflow(perpIndex, px6);
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(px6); // range checked above
    }

    /// @notice Raw precompile value, unscaled (for debugging and off-chain cross-checks).
    function rawOraclePx(uint32 perpIndex) external view returns (uint64) {
        return _readOraclePx(perpIndex);
    }

    function _readOraclePx(uint32 perpIndex) private view returns (uint64) {
        // Fixed system precompile, not attacker code: no return-bomb risk.
        // forge-lint: disable-next-line(return-bomb)
        (bool ok, bytes memory res) = ORACLE_PX_PRECOMPILE.staticcall{gas: ORACLE_PX_GAS}(abi.encode(perpIndex));
        if (!ok || res.length < 32) revert PrecompileCallFailed(ORACLE_PX_PRECOMPILE, perpIndex);
        return abi.decode(res, (uint64));
    }

    function _readPerpInfo(uint32 perpIndex) private view returns (PerpAssetInfo memory info) {
        // forge-lint: disable-next-line(return-bomb)
        (bool ok, bytes memory res) = PERP_ASSET_INFO_PRECOMPILE.staticcall{gas: PERP_INFO_GAS}(abi.encode(perpIndex));
        // Minimum encoding of the struct: outer offset + 5 head words + string length word = 7 words.
        if (!ok || res.length < 224) revert PrecompileCallFailed(PERP_ASSET_INFO_PRECOMPILE, perpIndex);
        info = abi.decode(res, (PerpAssetInfo));
        // Prices have (6 - szDecimals) decimals, so szDecimals > 6 cannot be a valid perp.
        if (info.szDecimals > 6 || bytes(info.coin).length == 0) revert InvalidPerpInfo(perpIndex, info.szDecimals);
    }
}
