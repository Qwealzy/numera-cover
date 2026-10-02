// Write paths. Every write is simulated first (so a revert shows its decoded reason before the wallet
// pops up), then sent through the injected wallet, then awaited. Testnet (998) only.
import type { Address, Hex, TransactionReceipt } from 'viem';
import { ensureTestnet, txPublicClient as publicClient, walletClient } from './chain';
import { coverPoolAbi, mockPositionSourceAbi, mockPriceSourceAbi, mockUSDCAbi } from '../generated/abi';
import { FAUCET_AMOUNT, hyperEvmTestnet, USDC } from '../config';
import { toContractQuote, type QuoteJson } from './quote';
import { purchasedCoverIds, rememberPurchase } from './purchases';
import { minedFloor, noteMined, simulateAfterApprove, waitForHead } from './txflow';

export interface TxDone {
  hash: Hex;
  receipt: TransactionReceipt;
}

type SimArgs = Parameters<typeof publicClient.simulateContract>[0];

/** The read RPC's head (uncached): reads after our own tx wait for it to pass that tx's block. */
export const headBlock = () => publicClient.getBlockNumber({ cacheTime: 0 });
/** Best effort: wait until the read RPC has the block of this page's last mined tx (or `min`). */
export const waitReadHead = (min: bigint = minedFloor()) => waitForHead(min > minedFloor() ? min : minedFloor(), headBlock);

/**
 * `afterApprove`: this write follows an approve mined moments ago; an ERC20InsufficientAllowance from the
 * simulation then means the read RPC is behind, so it is simulated again (never approved again).
 */
async function send(
  account: Address,
  args: Omit<SimArgs, 'account' | 'chain'>,
  onHash?: (h: Hex) => void,
  opts: { afterApprove?: boolean } = {},
): Promise<TxDone> {
  await ensureTestnet();
  await waitReadHead();
  const { request } = await simulateAfterApprove(() => publicClient.simulateContract({ ...args, account } as SimArgs), {
    afterApprove: !!opts.afterApprove,
  });
  const hash = await walletClient(account).writeContract({ ...request, chain: hyperEvmTestnet, account } as Parameters<
    ReturnType<typeof walletClient>['writeContract']
  >[0]);
  onHash?.(hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  noteMined(receipt.blockNumber);
  if (receipt.status !== 'success') throw new Error(`Transaction reverted on-chain (${hash}).`);
  return { hash, receipt };
}

export const faucet = (account: Address, onHash?: (h: Hex) => void) =>
  send(account, { address: USDC, abi: mockUSDCAbi, functionName: 'mint', args: [account, FAUCET_AMOUNT] }, onHash);

export const approveUsdc = (account: Address, spender: Address, amount: bigint, onHash?: (h: Hex) => void, token: Address = USDC) =>
  send(account, { address: token, abi: mockUSDCAbi, functionName: 'approve', args: [spender, amount] }, onHash);

export async function readAllowance(owner: Address, spender: Address, token: Address = USDC): Promise<bigint> {
  return publicClient.readContract({ address: token, abi: mockUSDCAbi, functionName: 'allowance', args: [owner, spender] });
}

export async function readBalance(owner: Address, token: Address = USDC): Promise<bigint> {
  return publicClient.readContract({ address: token, abi: mockUSDCAbi, functionName: 'balanceOf', args: [owner] });
}

/**
 * buyCover(quote, sig); returns the new cover id parsed from CoverPurchased, and remembers the purchase tx
 * in this browser (lib/purchases.ts) so the My covers Tx cell finds it with one receipt read.
 * `afterApprove`: the premium approve was mined moments ago (see send).
 */
export async function buyCover(account: Address, pool: Address, q: QuoteJson, sig: Hex, onHash?: (h: Hex) => void, afterApprove = false) {
  const done = await send(
    account,
    { address: pool, abi: coverPoolAbi, functionName: 'buyCover', args: [toContractQuote(q), sig] },
    onHash,
    { afterApprove },
  );
  const coverId = coverIdFromReceipt(done.receipt, pool);
  if (coverId !== undefined) rememberPurchase(hyperEvmTestnet.id, pool, coverId, done.hash, done.receipt.blockNumber);
  return { ...done, coverId };
}

export const coverIdFromReceipt = (receipt: TransactionReceipt, pool: Address): bigint | undefined => purchasedCoverIds(receipt, pool)[0];

export const triggerCover = (account: Address, pool: Address, id: bigint, onHash?: (h: Hex) => void) =>
  send(account, { address: pool, abi: coverPoolAbi, functionName: 'trigger', args: [id] }, onHash);

export const expireCover = (account: Address, pool: Address, id: bigint, onHash?: (h: Hex) => void) =>
  send(account, { address: pool, abi: coverPoolAbi, functionName: 'expire', args: [id] }, onHash);

export const deposit = (account: Address, pool: Address, assets: bigint, onHash?: (h: Hex) => void, afterApprove = false) =>
  send(account, { address: pool, abi: coverPoolAbi, functionName: 'deposit', args: [assets, account] }, onHash, { afterApprove });

export const withdraw = (account: Address, pool: Address, assets: bigint, onHash?: (h: Hex) => void) =>
  send(account, { address: pool, abi: coverPoolAbi, functionName: 'withdraw', args: [assets, account, account] }, onHash);

// ---------------------------------------------------------------- CoverPool v2 (ARCHITECTURE §5.3, §5.4)

/** requestRedeem(shares, controller = owner = account). shares = 0 re-queues a lapsed slot (clock restarts). */
export const requestRedeem = (account: Address, pool: Address, shares: bigint, onHash?: (h: Hex) => void) =>
  send(account, { address: pool, abi: coverPoolAbi, functionName: 'requestRedeem', args: [shares, account, account] }, onHash);

/** cancelRedeemRequest(): the slot's shares go back to the caller (any state). */
export const cancelRedeem = (account: Address, pool: Address, onHash?: (h: Hex) => void) =>
  send(account, { address: pool, abi: coverPoolAbi, functionName: 'cancelRedeemRequest', args: [] }, onHash);

/** Claim `shares` of a Claimable slot: redeem(shares, receiver = account, controller = account). */
export const claimShares = (account: Address, pool: Address, shares: bigint, onHash?: (h: Hex) => void) =>
  send(account, { address: pool, abi: coverPoolAbi, functionName: 'redeem', args: [shares, account, account] }, onHash);

/** Claim `assets` from a Claimable slot: v2 withdraw(assets, receiver = account, controller = account). */
export const claimAssets = (account: Address, pool: Address, assets: bigint, onHash?: (h: Hex) => void) => withdraw(account, pool, assets, onHash);

/** claimPayout(): the caller's own owed (deferred) payouts. */
export const claimPayout = (account: Address, pool: Address, onHash?: (h: Hex) => void) =>
  send(account, { address: pool, abi: coverPoolAbi, functionName: 'claimPayout', args: [] }, onHash);

export const setMockPrice = (account: Address, src: Address, perp: number, px6: bigint, onHash?: (h: Hex) => void) =>
  send(account, { address: src, abi: mockPriceSourceAbi, functionName: 'setPrice', args: [perp, px6] }, onHash);

export const setMockPosition = (
  account: Address,
  src: Address,
  user: Address,
  perp: number,
  szi: bigint,
  entryNtl: bigint,
  leverage: number,
  onHash?: (h: Hex) => void,
) => send(account, { address: src, abi: mockPositionSourceAbi, functionName: 'setPosition', args: [user, perp, szi, entryNtl, leverage] }, onHash);
