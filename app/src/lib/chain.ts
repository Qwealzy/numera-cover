import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Address,
  type EIP1193Provider,
  type WalletClient,
} from 'viem';
import { hyperEvmTestnet } from '../config';

export const publicClient = createPublicClient({
  chain: hyperEvmTestnet,
  transport: http(undefined, { batch: false, retryCount: 2 }),
  batch: { multicall: true },
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
          blockExplorerUrls: [hyperEvmTestnet.blockExplorers.default.url],
        },
      ],
    });
  }
}
