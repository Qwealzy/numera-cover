// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Test-only 6-decimal dollar with a blocklist, like real USDC: a transfer to or from a blocked address
///      reverts. `silent` addresses instead make `transfer` return false (a non-reverting refusal).
contract BlocklistUSDC is ERC20 {
    mapping(address => bool) public blocked;
    mapping(address => bool) public silent;

    error Blocked(address account);

    constructor() ERC20("Blocklist USDC (test)", "bUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address account, bool isBlocked) external {
        blocked[account] = isBlocked;
    }

    function setSilent(address account, bool isSilent) external {
        silent[account] = isSilent;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (silent[to]) return false;
        return super.transfer(to, value);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blocked[from]) revert Blocked(from);
        if (blocked[to]) revert Blocked(to);
        super._update(from, to, value);
    }
}
