// A wallet write must reach the wallet exactly once. viem's sendTransaction falls back to
// wallet_sendTransaction when eth_sendTransaction fails with -32000/-32602/-32601/-32004: for a wallet that
// already broadcast the tx this is a second prompt for the same approve, which is what the founder saw on
// the v2 pools on 2026-10-02 (two Approval logs, one deposit). The -32603 / no-code / -32005 cases guard
// viem's transport retries (sendTransaction passes retryCount 0 today; this pins it).
import { afterEach, describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { walletClient } from './chain';
import { mockUSDCAbi } from '../generated/abi';
import { hyperEvmTestnet } from '../config';

const ACCOUNT = getAddress('0x66dda666bf32cae48cf190bbad04effc90b7d5e7');
const TOKEN = getAddress('0x8675000000000000000000000000000000000001');
const SPENDER = getAddress('0x493c14a92da0905b06a91a1e87a75d4bff75e4a6');

const HASH = `0x${'ab'.repeat(32)}` as const;

/** Every wallet method that would open a confirmation prompt. */
const PROMPTS = new Set(['eth_sendTransaction', 'wallet_sendTransaction']);

function mockWallet(sendError: unknown) {
  const calls: string[] = [];
  const provider = {
    request: async ({ method }: { method: string }) => {
      calls.push(method);
      if (method === 'eth_chainId') return `0x${hyperEvmTestnet.id.toString(16)}`;
      if (method === 'eth_sendTransaction') throw sendError;
      // a wallet that treats wallet_sendTransaction as eth_sendTransaction: a second prompt, then a hash
      if (method === 'wallet_sendTransaction') return HASH;
      throw new Error(`unexpected ${method}`);
    },
  };
  (globalThis as unknown as { window: unknown }).window = { ethereum: provider };
  return calls;
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('walletClient never re-sends a write', () => {
  for (const [name, err] of [
    // viem's sendTransaction answers -32000 / -32602 / -32601 / -32004 by re-sending the same request as
    // wallet_sendTransaction: the root cause of the duplicate approves (second gas limit 39.5k = estimated
    // after the first approve had already set the allowance).
    ['invalid input -32000 (wallet error after its own broadcast)', { code: -32000, message: 'execution error' }],
    ['invalid params -32602', { code: -32602, message: 'invalid params' }],
    ['internal error -32603 (wallet broadcast hiccup)', { code: -32603, message: 'Internal JSON-RPC error.' }],
    ['plain Error without a code (viem: UnknownRpcError -1)', new Error('Request failed')],
    ['rate limited -32005', { code: -32005, message: 'rate limited' }],
  ] as const) {
    it(`one wallet prompt on ${name}`, async () => {
      const calls = mockWallet(err);
      await expect(
        walletClient(ACCOUNT).writeContract({
          address: TOKEN,
          abi: mockUSDCAbi,
          functionName: 'approve',
          args: [SPENDER, 2_000_000_000n],
          chain: hyperEvmTestnet,
          account: ACCOUNT,
          gas: 100_000n,
        }),
      ).rejects.toThrow();
      expect(calls.filter((m) => PROMPTS.has(m))).toEqual(['eth_sendTransaction']);
    }, 20_000);
  }
});
