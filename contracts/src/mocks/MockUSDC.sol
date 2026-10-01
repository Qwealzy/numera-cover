// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDC — 6-decimal test dollar with public mint. LOCAL / TESTNET ONLY, worthless by design.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC (Numera testnet)", "mUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Anyone can mint; this token has no value.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
