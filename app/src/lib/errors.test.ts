import { describe, expect, it } from 'vitest';
import { BaseError, ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult, UserRejectedRequestError } from 'viem';
import { coverPoolAbi, mockPriceSourceAbi } from '../generated/abi';
import { apiErrorMessage, contractErrorMessage, decodeRevert, describeError } from './errors';

describe('contract error mapping', () => {
  it('every ICoverPool custom error has a specific message', () => {
    const names = coverPoolAbi.filter((x) => x.type === 'error').map((x) => (x as { name: string }).name);
    for (const n of [
      'InvalidSignature',
      'BuyerMismatch',
      'QuoteDeadlinePassed',
      'NonceAlreadyUsed',
      'ExpiryNotInFuture',
      'DurationTooLong',
      'PayoutTooSmall',
      'SpotDeviationTooHigh',
      'LevelAlreadyBreached',
      'NoPosition',
      'PositionSideMismatch',
      'PayoutExceedsMarginCap',
      'UtilizationExceeded',
      'PerPerpCapExceeded',
      'CoverNotActive',
      'CoverPastExpiry',
      'LevelNotBreached',
      'CoverNotYetExpired',
    ]) {
      expect(names).toContain(n);
      expect(contractErrorMessage(n, [0n, 0n, 0n])).not.toMatch(/^Contract reverted/);
    }
  });

  it('formats args in human units (px6, USDC)', () => {
    expect(contractErrorMessage('LevelAlreadyBreached', [84_000_000_000n, 85_000_000_000n])).toBe(
      'The oracle ($84,000.00) is already past your level ($85,000.00). Choose a level further away.',
    );
    expect(contractErrorMessage('PayoutExceedsMarginCap', [20_000_000n, 9_952_605n])).toMatch(/20\.00 mUSDC.*9\.95 mUSDC/);
  });

  it('decodes raw revert data, including source errors bubbled through the pool', () => {
    const data = encodeErrorResult({ abi: mockPriceSourceAbi, errorName: 'PriceNotSet', args: [3] });
    expect(decodeRevert(data)).toEqual({ name: 'PriceNotSet', args: [3] });
    expect(decodeRevert('0x12345678')).toBeUndefined();
  });

  it('describeError walks viem errors', () => {
    const data = encodeErrorResult({ abi: coverPoolAbi, errorName: 'UtilizationExceeded', args: [9_000_000_000n, 8_000_000_000n] });
    const revert = new ContractFunctionRevertedError({ abi: coverPoolAbi, data, functionName: 'buyCover' });
    const wrapped = new ContractFunctionExecutionError(revert as BaseError, { abi: coverPoolAbi, functionName: 'buyCover', args: [] });
    expect(describeError(wrapped)).toMatch(/^Pool capacity reached: locked after this cover would be 9,000.00 mUSDC/);

    // pool ABI does not know PriceNotSet → falls back to the all-contracts error table
    const raw = encodeErrorResult({ abi: mockPriceSourceAbi, errorName: 'PriceNotSet', args: [3] });
    const unknown = new ContractFunctionRevertedError({ abi: coverPoolAbi, data: raw, functionName: 'buyCover' });
    expect(describeError(unknown)).toMatch(/MOCK price source has no price for perp 3/);

    expect(describeError(new UserRejectedRequestError(new Error('x')))).toBe('You rejected the request in your wallet.');
    expect(describeError({ code: 4001 })).toBe('You rejected the request in your wallet.');
  });
});

describe('API error mapping (§6)', () => {
  it('maps known codes', () => {
    expect(apiErrorMessage('level_already_breached')).toMatch(/already past this level/);
    expect(apiErrorMessage('prob_too_high')).toMatch(/more likely than not/);
    expect(apiErrorMessage('capacity', 'payout exceeds engine cap 1')).toMatch(/engine cap/);
    expect(apiErrorMessage('unknown_pool')).toMatch(/does not sign quotes for this pool/);
  });
  it('unknown codes are shown verbatim', () => {
    expect(apiErrorMessage('weird', 'why')).toBe('Quote refused: weird (why)');
  });
});
