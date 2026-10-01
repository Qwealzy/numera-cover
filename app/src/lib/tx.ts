// Write paths. Every write is simulated first (so a revert shows its decoded reason before the wallet
// pops up), then sent through the injected wallet, then awaited. Testnet (998) only.
import type { Address, Hex, TransactionReceipt } from 'viem';
import { ensureTestnet, txPublicClient as publicClient, walletClient } from './chain';
import { coverPoolAbi, mockPositionSourceAbi, mockPriceSourceAbi, mockUSDCAbi } from '../generated/abi';
import { FAUCET_AMOUNT, hyperEvmTestnet, USDC } from '../config';
import { toContractQuote, type QuoteJson } from './quote';
import { purchasedCoverIds, rememberPurchase } from './purchases';

export interface TxDone {
  hash: Hex;
  receipt: TransactionReceipt;
}

type SimArgs = Parameters<typeof publicClient.simulateContract>[0];

async function send(account: Address, args: Omit<SimArgs, 'account' | 'chain'>, onHash?: (h: Hex) => void): Promise<TxDone> {
  await ensureTestnet();
  const { request } = await publicClient.simulateContract({ ...args, account } as SimArgs);
  const hash = await walletClient(account).writeContract({ ...request, chain: hyperEvmTestnet, account } as Parameters<
    ReturnType<typeof walletClient>['writeContract']
  >[0]);
  onHash?.(hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== 'success') throw new Error(`Transaction reverted on-chain (${hash}).`);
  return { hash, receipt };
}

export const faucet = (account: Address, onHash?: (h: Hex) => void) =>
  send(account, { address: USDC, abi: mockUSDCAbi, functionName: 'mint', args: [account, FAUCET_AMOUNT] }, onHash);

export const approveUsdc = (account: Address, spender: Address, amount: bigint, onHash?: (h: Hex) => void) =>
  send(account, { address: USDC, abi: mockUSDCAbi, functionName: 'approve', args: [spender, amount] }, onHash);

export async function readAllowance(owner: Address, spender: Address): Promise<bigint> {
  return publicClient.readContract({ address: USDC, abi: mockUSDCAbi, functionName: 'allowance', args: [owner, spender] });
}

/**
 * buyCover(quote, sig); returns the new cover id parsed from CoverPurchased, and remembers the purchase tx
 * in this browser (lib/purchases.ts) so the My covers Tx cell finds it with one receipt read.
 */
export async function buyCover(account: Address, pool: Address, q: QuoteJson, sig: Hex, onHash?: (h: Hex) => void) {
  const done = await send(
    account,
    { address: pool, abi: coverPoolAbi, functionName: 'buyCover', args: [toContractQuote(q), sig] },
    onHash,
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

export const deposit = (account: Address, pool: Address, assets: bigint, onHash?: (h: Hex) => void) =>
  send(account, { address: pool, abi: coverPoolAbi, functionName: 'deposit', args: [assets, account] }, onHash);

export const withdraw = (account: Address, pool: Address, assets: bigint, onHash?: (h: Hex) => void) =>
  send(account, { address: pool, abi: coverPoolAbi, functionName: 'withdraw', args: [assets, account, account] }, onHash);

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
