// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPositionSource} from "../interfaces/IPositionSource.sol";

/// @title MockPositionSource — operator-set positions for tests and the MOCK-labelled demo pool
/// @notice Never back a real pool with this.
contract MockPositionSource is IPositionSource, Ownable {
    struct Pos {
        int64 szi;
        uint64 entryNtl;
        uint32 leverage;
    }

    mapping(address user => mapping(uint32 perpIndex => Pos)) private _pos;

    event PositionSet(address indexed user, uint32 indexed perpIndex, int64 szi, uint64 entryNtl, uint32 leverage);

    constructor(address owner_) Ownable(owner_) {}

    function setPosition(address user, uint32 perpIndex, int64 szi, uint64 entryNtl, uint32 leverage)
        external
        onlyOwner
    {
        _pos[user][perpIndex] = Pos(szi, entryNtl, leverage);
        emit PositionSet(user, perpIndex, szi, entryNtl, leverage);
    }

    /// @inheritdoc IPositionSource
    function position(address user, uint32 perpIndex)
        external
        view
        returns (int64 szi, uint64 entryNtl, uint32 leverage)
    {
        Pos memory p = _pos[user][perpIndex];
        return (p.szi, p.entryNtl, p.leverage);
    }
}
