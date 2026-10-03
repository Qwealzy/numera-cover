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
      return 'The quote expired (quotes are valid for about 30 s). Get a new quote.';
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
    // CoverPool v2 (ARCHITECTURE §5.7): buyCover floors, allowlist and sale throttle
    case 'PerpNotAllowed':
      return `This pool does not sell cover on perp ${big(a[0])} (not on its on-chain allowlist).`;
    case 'PremiumBelowFloor':
      return `The price ${usdc(a[0])} is below the pool’s minimum price ${usdc(a[1])}. Get a new quote.`;
    case 'LevelTooClose':
      return `The level ${px(a[1])} is too close to the oracle ${px(a[0])}: the pool requires a minimum distance. Move the level further away.`;
    case 'SaleWindowCapExceeded':
      return `The pool’s sale limit for this window is reached (${usdc(a[0])} after this cover, limit ${usdc(a[1])}). Try a smaller payout or wait for the window to reset.`;
    case 'BuyerWindowCapExceeded':
      return `Your share of this window’s sale limit is used up (${usdc(a[1])} after this cover, your limit ${usdc(a[2])}). Wait for the window to reset.`;
    // v2 payouts
    case 'NothingOwed':
      return 'Nothing is owed to this address: every payout was already transferred or collected.';
    // v2 LP exits (queued redeem, §5.4)
    case 'NotShareOwner':
      return 'Only the share owner can request a redeem of their own shares.';
    case 'ControllerMustBeOwner':
      return 'A redeem request must be made for your own address (controller = owner).';
    case 'NotController':
      return 'Only the address that made the redeem request can withdraw against it.';
    case 'RequestClaimable':
      return 'Your earlier request is ready to withdraw: withdraw it or cancel it before requesting again.';
    case 'RequestNotClaimable': {
      const st = Number(big(a[0]));
      const why = st === 0 ? 'there is no redeem request' : st === 1 ? 'the request is still waiting for its delay' : st === 3 ? 'the withdraw window has lapsed; re-queue the request' : `state ${st}`;
      return `Nothing to withdraw yet: ${why}. Exits are queued: request, wait, then withdraw inside the withdraw window.`;
    }
    case 'ZeroShares':
      return 'Zero shares: enter an amount, or there is no request to cancel.';
    case 'ExceedsClaimable':
      return `More than the requested shares (${fmtFixed(big(a[0]), 12, 4)} asked, ${fmtFixed(big(a[1]), 12, 4)} in the request).`;
    case 'InsufficientFreeAssets':
      return `The pool’s free assets (${usdc(a[1])}) do not cover ${usdc(a[0])} now: withdraw part now, the rest stays ready until covers settle.`;
    case 'AsyncRedeemOnly':
      return 'Exits are queued on this pool (request, wait, withdraw); there is no instant preview.';
    case 'SharesToPool':
      return 'Pool shares cannot be sent to the pool itself; use the redeem request.';
    // v2 owner / timelock / guardian
    case 'NotGuardian':
      return 'Only the guardian can pause the pool this way.';
    case 'OpAlreadyQueued':
      return 'This configuration change is already queued.';
    case 'OpNotQueued':
      return 'This configuration change was not queued (queue it first, then wait for the delay).';
    case 'OpNotReady':
      return `This configuration change is queued but not executable before ${time(a[1])}.`;
    case 'OpStale':
      return `This configuration change went stale (was executable from ${time(a[1])} for 3 days); cancel and queue it again.`;
    case 'RenounceDisabled':
      return 'Renouncing ownership is disabled: a pool without owner could never be paused again.';
    case 'InvalidDelays':
      return 'The delays are outside the allowed bounds.';
    case 'StrictRequired':
      return 'Off testnet the pool must be deployed in strict mode.';
    case 'InvalidLimits':
      return 'These limits are outside the allowed bounds.';
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
      return 'The pool is paused: new covers and deposits are off. Trigger, expire, payout collection and LP exits still work.';
    case 'ERC20InsufficientAllowance':
      return `mUSDC allowance too low (${usdc(a[1])} approved, ${usdc(a[2])} needed). Approve again.`;
    case 'ERC20InsufficientBalance':
      // Pool shares (12 decimals) raise the same error on a v2 requestRedeem; the error does not say which token.
      return (
        `Not enough balance: ${usdc(a[1])} available, ${usdc(a[2])} needed (use the faucet for mUSDC). ` +
        `For an exit request this is pool shares: ${fmtFixed(big(a[1]), 12, 4)} held, ${fmtFixed(big(a[2]), 12, 4)} requested.`
      );
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
    case 'perp_not_allowed':
      return `Numera does not cover this perp yet: only the perps configured for the pools are quoted${r}.`;
    case 'level_too_close':
      return `The level is too close to the current price: it could be reached while the quote is still valid (30 s), or it is inside the pool’s on-chain minimum distance, so the pool does not sell it${r}. Move the level further away.`;
    case 'rate_limited':
      return `Too many quote requests in a short time${r}. Wait a few seconds and try again.`;
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
