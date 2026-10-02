// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

/// @title HyperCore precompile stand-ins for forge's LOCAL pass only
/// @notice Forge's local EVM has no HyperCore precompiles, so `HyperCorePriceSource.cachePerp` and the CoverPool
///         constructor's perp check would revert there. `Deploy.run()` etches these at 0x…0800 / 0x…0807 /
///         0x…080a and configures them BEFORE `vm.startBroadcast`; nothing calls them inside the broadcast
///         window, so no transaction to a precompile address is ever recorded. On chain the real precompiles
///         answer (forge's per-transaction eth_estimateGas runs them; a bad perp aborts there).
/// @dev Like the real precompiles they take raw abi.encode(args) without a selector. Stand-in prices use
///      szDecimals = 0, so raw = px6 (HyperCorePriceSource computes px6 = raw x 10^szDecimals).

contract OraclePxStandIn {
    mapping(uint32 => uint64) internal px;

    function set(uint32 perp, uint64 raw) external {
        px[perp] = raw;
    }

    fallback(bytes calldata data) external returns (bytes memory) {
        return abi.encode(px[abi.decode(data, (uint32))]);
    }
}

contract PerpAssetInfoStandIn {
    struct PerpAssetInfo {
        string coin;
        uint32 marginTableId;
        uint8 szDecimals;
        uint8 maxLeverage;
        bool onlyIsolated;
    }

    mapping(uint32 => bool) internal known;

    function set(uint32 perp) external {
        known[perp] = true;
    }

    fallback(bytes calldata data) external returns (bytes memory) {
        uint32 perp = abi.decode(data, (uint32));
        require(known[perp], "stand-in: unknown perp");
        return abi.encode(PerpAssetInfo("STANDIN", 0, 0, 1, false));
    }
}

/// @dev Every position reads as none (the deploy never reads positions; present so all three addresses answer).
contract PositionStandIn {
    fallback(bytes calldata) external returns (bytes memory) {
        return abi.encode(int64(0), uint64(0), int64(0), uint32(0), false);
    }
}
