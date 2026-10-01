import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatTransactionReceipt, type Hex, type RpcTransactionReceipt } from 'viem';
import { decodeReceipt, fetchReceipt } from './receipt';

// Real receipts, fetched 2026-10-02 with eth_getTransactionReceipt from https://rpcs.chain.link/hyperevm/testnet
// (chain 998): the founder wallet's buyCover (cover #1) and deposit(100e6) on the HyperCore pool.
const fixture = (name: string) =>
  (JSON.parse(readFileSync(path.join(__dirname, 'fixtures', `receipt-${name}.json`), 'utf8')) as { result: RpcTransactionReceipt }).result;
const BUY = '0x3fb5c7073c2b9add2005ac541ac6626bb8b147c68c9ef1e0a35739df86166d44';
const DEPOSIT = '0xc005aa76d91ef85a8f1f675083919f35cf54a8bfda48ca364fde71d8c602ac1a';
const WALLET = '0x66DDA666bf32Cae48cf190bbAd04Effc90b7d5e7';
const POOL = '0xDa611E1a07260005ea5641e9Fe633CD4d10C341e'.toLowerCase();

const arg = (ev: { args: { name: string; raw: string; pretty?: string }[] }, n: string) => ev.args.find((a) => a.name === n);

describe('decodeReceipt (real testnet receipts)', () => {
  it('buyCover: success, block, from/to, gas, CoverPurchased decoded with units', () => {
    const r = decodeReceipt(formatTransactionReceipt(fixture('buycover')));
    expect(r.hash).toBe(BUY);
    expect(r.status).toBe('success');
    expect(r.blockNumber).toBe(65774354n);
    expect(r.from).toBe(WALLET);
    expect(r.to?.toLowerCase()).toBe(POOL);
    expect(r.gasUsed).toBeGreaterThan(0n);
    const names = r.events.map((e) => e.name);
    expect(names).toContain('CoverPurchased');
    expect(names).not.toContain('undecoded log');
    const cp = r.events.find((e) => e.name === 'CoverPurchased')!;
    expect(cp.contract).toMatch(/^CoverPool/);
    expect(arg(cp, 'coverId')?.raw).toBe('1');
    expect(arg(cp, 'buyer')?.raw).toBe(WALLET);
    expect(arg(cp, 'perpIndex')?.pretty).toBe('BTC (perp 3)');
    expect(arg(cp, 'isLong')?.raw).toBe('true');
    expect(arg(cp, 'level')?.raw).toBe('78306000000');
    expect(arg(cp, 'payout')).toMatchObject({ raw: '5000000', pretty: '5.000000 mUSDC' });
    expect(arg(cp, 'premium')).toMatchObject({ raw: '91874', pretty: '0.091874 mUSDC' });
    // the premium moves buyer -> pool as an mUSDC Transfer in the same tx
    const t = r.events.find((e) => e.name === 'Transfer' && e.contract === 'mUSDC')!;
    expect(arg(t, 'from')?.raw).toBe(WALLET);
    expect(arg(t, 'value')).toMatchObject({ raw: '91874', pretty: '0.091874 mUSDC' });
  });

  it('deposit: ERC-4626 Deposit, share mint and mUSDC transfer decoded', () => {
    const r = decodeReceipt(formatTransactionReceipt(fixture('deposit')));
    expect(r.hash).toBe(DEPOSIT);
    expect(r.status).toBe('success');
    expect(r.blockNumber).toBe(65774467n);
    expect(r.from).toBe(WALLET);
    const dep = r.events.find((e) => e.name === 'Deposit')!;
    expect(dep.contract).toMatch(/^CoverPool/);
    expect(arg(dep, 'assets')).toMatchObject({ raw: '100000000', pretty: '100.000000 mUSDC' });
    expect(arg(dep, 'shares')?.pretty).toMatch(/ shares$/);
    const usdc = r.events.find((e) => e.name === 'Transfer' && e.contract === 'mUSDC')!;
    expect(arg(usdc, 'value')?.raw).toBe('100000000');
    const mint = r.events.find((e) => e.name === 'Transfer' && e.contract.startsWith('CoverPool'))!;
    expect(arg(mint, 'from')?.raw).toBe('0x0000000000000000000000000000000000000000');
    expect(arg(mint, 'value')?.pretty).toMatch(/ shares$/);
  });

  it('logs from unknown contracts are listed as undecoded, not dropped', () => {
    const raw = fixture('buycover');
    const other = { ...raw, logs: raw.logs.map((l) => ({ ...l, address: '0x000000000000000000000000000000000000dead' as Hex })) };
    const r = decodeReceipt(formatTransactionReceipt(other));
    expect(r.events).toHaveLength(raw.logs.length);
    expect(r.events.every((e) => e.name === 'undecoded log' && e.contract === 'unknown contract')).toBe(true);
  });

  it('fetchReceipt reads through the client and retries a rate-limited answer', async () => {
    let n = 0;
    const client = {
      getTransactionReceipt: async () => {
        if (n++ === 0) throw Object.assign(new Error('rate limited'), { code: -32005 });
        return formatTransactionReceipt(fixture('buycover'));
      },
    } as unknown as Parameters<typeof fetchReceipt>[1];
    // first retry delay is ~1.5 s
    const r = await fetchReceipt(BUY, client);
    expect(n).toBe(2);
    expect(r.events.some((e) => e.name === 'CoverPurchased')).toBe(true);
  }, 10_000);
});
