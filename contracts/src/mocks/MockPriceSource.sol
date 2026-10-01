// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPriceSource} from "../interfaces/IPriceSource.sol";

/// @title MockPriceSource — operator-set prices for tests and the MOCK-labelled demo pool (ARCHITECTURE §8)
/// @notice Never back a real pool with this. Prices are px6 (USD x 1e6).
contract MockPriceSource is IPriceSource, Ownable {
    mapping(uint32 perpIndex => uint64) public px6Of;

    event PriceSet(uint32 indexed perpIndex, uint64 px6);

    error PriceNotSet(uint32 perpIndex);

    constructor(address owner_) Ownable(owner_) {}

    function setPrice(uint32 perpIndex, uint64 px6) external onlyOwner {
        px6Of[perpIndex] = px6;
        emit PriceSet(perpIndex, px6);
    }

    /// @inheritdoc IPriceSource
    function oraclePx6(uint32 perpIndex) external view returns (uint64 px6) {
        px6 = px6Of[perpIndex];
        if (px6 == 0) revert PriceNotSet(perpIndex);
    }
}
