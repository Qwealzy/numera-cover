// Human messages for contract custom errors (ICoverPool, sources, OZ) and Quote API error codes (docs/how-it-works.md §6).
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  UserRejectedRequestError,
  type Abi,
  type Hex,
} from 'viem';

type AbiError = Extract<Abi[number], { type: 'error' }>;
import * as abis from '../generated/abi';
import { fmtFixed, fmtPx6, fmtUsdc } from './format';

/** Every custom error of every app contract (pool + sources + mocks), deduplicated by name. */
export const allErrorsAbi: Abi = (Object.values(abis) as readonly Abi[])
  .flat()
  .filter((x): x is AbiError => x.type === 'error')
  .filter((x, i, arr) => arr.findIndex((y) => y.name === x.name) === i);

/** Decode raw revert data against all known errors; undefined if unknown. */
export function decodeRevert(data: Hex | undefined): { name: string; args?: readonly unknown[] } | undefined {
  if (!data || data.length < 10) return undefined;
  try {
    const d = decodeErrorResult({ abi: allErrorsAbi, data });
    return { name: d.errorName, args: d.args };
  } catch {
    return undefined;
  }
}

type Args = readonly unknown[] | undefined;
const big = (v: unknown) => (typeof v === 'bigint' ? v : BigInt(String(v ?? 0)));
const px = (v: unknown) => fmtPx6(big(v));
const usdc = (v: unknown) => fmtUsdc(big(v)) + ' mUSDC';
const time = (v: unknown) => new Date(Number(big(v)) * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

/** Message for a decoded custom error name + args. Unknown names fall through to the raw name. */
export function contractErrorMessage(name: string, args?: Args): string {
  const a = args ?? [];
  switch (name) {
    // buyCover check 1
    case 'InvalidSignature':
      return 'The quote signature is not from this pool’s quote signer (wrong engine/pool pairing, or a fixture quote).';
    case 'BuyerMismatch':
      return 'This quote was issued for a different address than the connected wallet. Get a new quote.';
    case 'QuoteDeadlinePassed':
      return 'The quote expired (quotes are valid for about 60 s). Get a new quote.';
    case 'NonceAlreadyUsed':
      return 'This quote was already used. Get a new quote.';
    // check 2
    case 'ExpiryNotInFuture':
      return 'The cover end time is already in the past. Get a new quote.';
    case 'DurationTooLong':
      return `The cover lasts longer than the pool allows (latest end ${time(a[1])}).`;
    case 'PayoutTooSmall':
      return `Payout is below the pool minimum of ${usdc(a[1])}.`;
    // check 3
    case 'SpotDeviationTooHigh':
      return `The oracle moved since the quote (now ${px(a[0])}, quoted against ${px(a[1])}). Get a new quote.`;
    case 'LevelAlreadyBreached':
      return `The oracle (${px(a[0])}) is already past your level (${px(a[1])}). Choose a level further away.`;
    // check 4
    case 'NoPosition':
      return 'The pool’s position source shows no position for your address on this perp. Cover requires an open position.';
    case 'PositionSideMismatch':
      return `Your position is ${big(a[0]) > 0n ? 'long' : 'short'}, the quote covers the other side.`;
    case 'PayoutExceedsMarginCap':
      return `Payout ${usdc(a[0])} is above your margin cap ${usdc(a[1])} (entry notional ÷ leverage).`;
    // check 5
    case 'UtilizationExceeded':
      return `Pool capacity reached: locked after this cover would be ${usdc(a[0])}, the limit is ${usdc(a[1])}. Try a smaller payout.`;
    case 'PerPerpCapExceeded':
      return `Capacity for this perp reached (limit ${usdc(a[2])}). Try a smaller payout.`;
    // trigger / expire
    case 'CoverNotActive':
      return `Cover #${big(a[0])} is no longer active (already paid or expired).`;
    case 'CoverPastExpiry':
      return `Cover #${big(a[0])} has ended (${time(a[1])}); it can only be expired now.`;
    case 'LevelNotBreached':
      return `Not breached: oracle ${px(a[0])}, level ${px(a[1])}.`;
    case 'CoverNotYetExpired':
      return `Cover #${big(a[0])} runs until ${time(a[1])}; it can be expired after that.`;
    // sources
    case 'PriceNotSet':
      return `MOCK price source has no price for perp ${big(a[0])}. The operator must set one.`;
    case 'PrecompileCallFailed':
      return `HyperCore precompile read failed for perp ${big(a[1])}.`;
    case 'InvalidOraclePrice':
      return `HyperCore returned no oracle price for perp ${big(a[0])}.`;
    case 'PerpIndexOutOfRange':
    case 'InvalidPerpInfo':
      return `Perp index ${big(a[0])} is not valid on this network.`;
    // OpenZeppelin
    case 'EnforcedPause':
      return 'The pool is paused: new covers and deposits are off. Trigger, expire and withdrawals still work.';
    case 'ERC20InsufficientAllowance':
      return `mUSDC allowance too low (${usdc(a[1])} approved, ${usdc(a[2])} needed). Approve again.`;
    case 'ERC20InsufficientBalance':
      return `Not enough mUSDC (${usdc(a[1])} available, ${usdc(a[2])} needed). Use the faucet.`;
    case 'ERC4626ExceededMaxWithdraw':
      return `Withdrawal above the maximum ${usdc(a[2])} (only free, unlocked assets can leave).`;
    case 'ERC4626ExceededMaxRedeem':
      return `Redeem above the maximum ${fmtFixed(big(a[2]), 12, 4)} shares (only free assets can leave).`;
    case 'ERC4626ExceededMaxDeposit':
      return 'Deposits are not accepted right now (pool paused).';
    case 'OwnableUnauthorizedAccount':
      return 'Only the owner of this contract can do that.';
    default:
      return `Contract reverted: ${name}${a.length ? `(${a.map(String).join(', ')})` : ''}`;
  }
}

/** Message for a §6 API error code. */
export function apiErrorMessage(code: string, reason?: string): string {
  const r = reason ? ` (${reason})` : '';
  switch (code) {
    case 'level_already_breached':
      return 'The oracle is already past this level — nothing to cover. Choose a level further from the price.';
    case 'prob_too_high':
      return 'The level is so close that the touch is more likely than not within this duration; the pool does not sell it. Move the level away or shorten the duration.';
    case 'capacity':
      return `Payout is above what the engine will quote${r}.`;
    case 'duration_out_of_range':
      return `Duration is outside what the engine quotes${r}.`;
    case 'unknown_perp':
      return `The engine does not list this perp${r}.`;
    case 'market_data_unavailable':
      return `The engine could not read market data right now${r}. Try again shortly.`;
    case 'signer_unavailable':
      return 'The engine has no signing key configured, so it cannot issue quotes.';
    case 'chain_not_allowed':
      return 'The engine refuses to sign for this chain.';
    case 'unknown_pool':
      return `The engine does not sign quotes for this pool${r}. Point the app at an engine that serves it.`;
    case 'invalid_request':
      return `The quote request was rejected as invalid${r}.`;
    case 'engine_unreachable':
      return `The pricing engine is not reachable${r}.`;
    default:
      return `Quote refused: ${code}${r}`;
  }
}

/** Best human message for anything thrown by viem / the wallet / fetch. */
export function describeError(e: unknown): string {
  if (e instanceof BaseError) {
    const rejected = e.walk((x) => x instanceof UserRejectedRequestError);
    if (rejected) return 'You rejected the request in your wallet.';
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      if (revert.data?.errorName) return contractErrorMessage(revert.data.errorName, revert.data.args);
      const d = decodeRevert(revert.raw);
      if (d) return contractErrorMessage(d.name, d.args);
      if (revert.reason) return `Contract reverted: ${revert.reason}`;
    }
    // Some paths (estimateGas through a wallet) only carry raw data deeper in the cause chain.
    const raw = e.walk((x) => typeof (x as { data?: unknown }).data === 'string' && /^0x[0-9a-f]{8}/i.test((x as { data: string }).data));
    const d = raw ? decodeRevert((raw as unknown as { data: Hex }).data) : undefined;
    if (d) return contractErrorMessage(d.name, d.args);
    return e.shortMessage || e.message;
  }
  const code = (e as { code?: number })?.code;
  if (code === 4001) return 'You rejected the request in your wallet.';
  if (e instanceof Error) return e.message;
  return String(e);
}
