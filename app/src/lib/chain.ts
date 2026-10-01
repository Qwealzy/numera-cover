import {
  createPublicClient,
  createWalletClient,
  custom,
  type Address,
  type EIP1193Provider,
  type WalletClient,
} from 'viem';
import { EXPLORER_URL, READ_RPC_URLS, hyperEvmTestnet } from '../config';
import { readTransport } from './transport';

/**
 * Reads for the polling UI. No transport-level retries: viem would retry a -32005 after 150–600 ms and
 * spend more of the per-IP budget; usePoll backs off instead (4 s … 60 s). No JSON-RPC batching: the
 * testnet RPC accepts batches but counts every call inside one against the limit (measured 2026-10-01),
 * so Multicall3 (one eth_call for many reads) is the lever; readContract calls are folded into it.
 * A call the official RPC rate-limits moves to the fallback RPC(s) of READ_RPC_URLS (lib/transport.ts).
 */
export const publicClient = createPublicClient({
  chain: hyperEvmTestnet,
  transport: readTransport(READ_RPC_URLS, { chainId: hyperEvmTestnet.id, retryCount: 0 }),
  // viem splits a multicall into 1 kB-calldata chunks (one eth_call each) by default; keep it to one call
  batch: { multicall: { batchSize: 16_384 } },
});

/** Reads on the user's own transaction path (simulate, receipt wait): a few spaced retries. */
export const txPublicClient = createPublicClient({
  chain: hyperEvmTestnet,
  transport: readTransport(READ_RPC_URLS, { chainId: hyperEvmTestnet.id, retryCount: 3, retryDelay: 1500 }),
  pollingInterval: 2000,
});

declare global {
  interface Window {
    ethereum?: EIP1193Provider & { on?: (ev: string, cb: (...a: unknown[]) => void) => void; removeListener?: (ev: string, cb: (...a: unknown[]) => void) => void };
  }
}

export const hasInjectedWallet = () => typeof window !== 'undefined' && !!window.ethereum;

export function walletClient(account: Address): WalletClient {
  if (!window.ethereum) throw new Error('No browser wallet found. Install MetaMask, Rabby or another EIP-1193 wallet.');
  return createWalletClient({ account, chain: hyperEvmTestnet, transport: custom(window.ethereum) });
}

export async function requestAccounts(): Promise<Address[]> {
  if (!window.ethereum) throw new Error('No browser wallet found. Install MetaMask, Rabby or another EIP-1193 wallet.');
  return (await window.ethereum.request({ method: 'eth_requestAccounts' })) as Address[];
}

export async function currentChainId(): Promise<number | undefined> {
  if (!window.ethereum) return undefined;
  const hex = (await window.ethereum.request({ method: 'eth_chainId' })) as string;
  return parseInt(hex, 16);
}

/** Switch the wallet to chain 998, adding it first if the wallet does not know it. */
export async function ensureTestnet(): Promise<void> {
  if (!window.ethereum) throw new Error('No browser wallet found.');
  const id = `0x${hyperEvmTestnet.id.toString(16)}`;
  if ((await currentChainId()) === hyperEvmTestnet.id) return;
  try {
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: id }] });
  } catch (e) {
    const code = (e as { code?: number; data?: { originalError?: { code?: number } } }).code;
    const inner = (e as { data?: { originalError?: { code?: number } } }).data?.originalError?.code;
    if (code !== 4902 && inner !== 4902) throw e;
    await window.ethereum.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: id,
          chainName: hyperEvmTestnet.name,
          nativeCurrency: hyperEvmTestnet.nativeCurrency,
          rpcUrls: [...hyperEvmTestnet.rpcUrls.default.http],
          // only when an explorer is configured (VITE_EXPLORER_URL); wallets accept the field omitted
          ...(EXPLORER_URL ? { blockExplorerUrls: [EXPLORER_URL] } : {}),
        },
      ],
    });
  }
}
