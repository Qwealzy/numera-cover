// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CoverPool} from "../src/CoverPool.sol";
import {ICoverPool} from "../src/interfaces/ICoverPool.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockPriceSource} from "../src/mocks/MockPriceSource.sol";
import {MockPositionSource} from "../src/mocks/MockPositionSource.sol";

/// @notice Shared EIP-712 test vector (ARCHITECTURE §4). The engine computes the same values independently.
///         The committed file test/vectors/quote_vector.json is checked here; regenerate it from this code
///         with `WRITE_VECTORS=true forge test --match-contract QuoteVectorTest`.
contract QuoteVectorTest is Test {
    // Vector domain: anvil's first deployment address on chain 31337.
    address internal constant POOL = 0x5FbDB2315678afecb367f032d93F642f64180aa3;
    // anvil key #0 (public test key) and its address
    uint256 internal constant SIGNER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    address internal constant SIGNER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address internal constant BUYER = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8; // anvil #1

    string internal constant VECTOR_PATH = "./test/vectors/quote_vector.json";
    string internal constant QUOTE_TYPE =
        "Quote(address buyer,uint32 perpIndex,bool isLong,uint64 level,uint256 payout,uint256 premium,uint64 expiry,uint64 spotRef,uint64 deadline,uint256 nonce)";

    MockUSDC internal usdc;
    MockPriceSource internal prices;
    MockPositionSource internal positions;
    CoverPool internal pool;

    function setUp() public {
        usdc = new MockUSDC();
        prices = new MockPriceSource(address(this));
        positions = new MockPositionSource(address(this));
        deployCodeTo(
            "CoverPool.sol:CoverPool",
            abi.encode(address(usdc), address(this), SIGNER, address(prices), address(positions)),
            POOL
        );
        pool = CoverPool(POOL);
    }

    function _vectorQuote() internal pure returns (ICoverPool.Quote memory) {
        return ICoverPool.Quote({
            buyer: BUYER,
            perpIndex: 3,
            isLong: true,
            level: 80000000000,
            payout: 100000000,
            premium: 2500000,
            expiry: 1790900000,
            spotRef: 84000000000,
            deadline: 1790890000,
            nonce: 1
        });
    }

    /// @dev Independent, by-the-spec computation (no CoverPool code involved).
    function _manual(ICoverPool.Quote memory q)
        internal
        pure
        returns (bytes32 typeHash, bytes32 structHash, bytes32 domainSeparator, bytes32 digest)
    {
        typeHash = keccak256(bytes(QUOTE_TYPE));
        structHash = keccak256(
            abi.encode(
                typeHash,
                q.buyer,
                q.perpIndex,
                q.isLong,
                q.level,
                q.payout,
                q.premium,
                q.expiry,
                q.spotRef,
                q.deadline,
                q.nonce
            )
        );
        domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Numera"),
                keccak256("1"),
                uint256(31337),
                POOL
            )
        );
        digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function test_vector_contractMatchesSpec() public view {
        assertEq(block.chainid, 31337);
        assertEq(vm.addr(SIGNER_KEY), SIGNER);
        ICoverPool.Quote memory q = _vectorQuote();
        (bytes32 typeHash, bytes32 structHash, bytes32 domainSeparator, bytes32 digest) = _manual(q);

        assertEq(pool.QUOTE_TYPEHASH(), typeHash, "typeHash");
        assertEq(pool.quoteStructHash(q), structHash, "structHash");
        assertEq(pool.DOMAIN_SEPARATOR(), domainSeparator, "domainSeparator");
        assertEq(pool.quoteDigest(q), digest, "digest");

        (, string memory name, string memory version, uint256 chainId, address verifying,,) = pool.eip712Domain();
        assertEq(name, "Numera");
        assertEq(version, "1");
        assertEq(chainId, 31337);
        assertEq(verifying, POOL);
    }

    function test_vector_signatureRecoversSigner() public pure {
        (,,, bytes32 digest) = _manual(_vectorQuote());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, digest);
        assertEq(ecrecover(digest, v, r, s), SIGNER);
    }

    /// @dev The contract accepts the vector signature end to end (buyCover at the vector address/time).
    function test_vector_buyCoverAccepts() public {
        ICoverPool.Quote memory q = _vectorQuote();
        prices.setPrice(3, 84000000000);
        positions.setPosition(BUYER, 3, 1e5, 84000000000, 20); // cap 4,200 USDC >= payout 100
        usdc.mint(address(this), 10_000e6);
        usdc.approve(POOL, 10_000e6);
        pool.deposit(10_000e6, address(this));
        usdc.mint(BUYER, q.premium);
        vm.prank(BUYER);
        usdc.approve(POOL, q.premium);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, pool.quoteDigest(q));
        vm.warp(q.deadline - 30);
        vm.prank(BUYER);
        assertEq(pool.buyCover(q, abi.encodePacked(r, s, v)), 1);
    }

    function test_vector_matchesCommittedJson() public view {
        ICoverPool.Quote memory q = _vectorQuote();
        (bytes32 typeHash, bytes32 structHash, bytes32 domainSeparator, bytes32 digest) = _manual(q);
        string memory json = vm.readFile(VECTOR_PATH);
        assertEq(vm.parseJsonBytes32(json, ".typeHash"), typeHash, "typeHash");
        assertEq(vm.parseJsonBytes32(json, ".structHash"), structHash, "structHash");
        assertEq(vm.parseJsonBytes32(json, ".domainSeparator"), domainSeparator, "domainSeparator");
        assertEq(vm.parseJsonBytes32(json, ".digest"), digest, "digest");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, digest);
        assertEq(vm.parseJsonBytes(json, ".signature"), abi.encodePacked(r, s, v), "signature (RFC 6979)");
    }

    /// @dev Regenerates the committed vector file from the code above (opt-in, so normal runs never write).
    function test_vector_write() public {
        if (!vm.envOr("WRITE_VECTORS", false)) return;
        ICoverPool.Quote memory q = _vectorQuote();
        (bytes32 typeHash, bytes32 structHash, bytes32 domainSeparator, bytes32 digest) = _manual(q);
        assertEq(pool.quoteDigest(q), digest);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, digest);

        string memory o = "vector";
        vm.serializeString(o, "typeString", QUOTE_TYPE);
        vm.serializeBytes32(o, "typeHash", typeHash);
        vm.serializeBytes32(o, "structHash", structHash);
        vm.serializeBytes32(o, "domainSeparator", domainSeparator);
        vm.serializeBytes32(o, "digest", digest);
        vm.serializeBytes(o, "signature", abi.encodePacked(r, s, v));
        string memory json = vm.serializeAddress(o, "signer", SIGNER);
        vm.writeJson(json, VECTOR_PATH);
    }
}
