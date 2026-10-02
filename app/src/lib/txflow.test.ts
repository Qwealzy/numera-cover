import { beforeEach, describe, expect, it } from 'vitest';
import {
  InsufficientBalanceError,
  createGate,
  depositBlocker,
  depositFlow,
  ensureAllowance,
  isAllowanceRevert,
  minedFloor,
  noteMined,
  resetMinedFloor,
  simulateAfterApprove,
  waitForHead,
} from './txflow';

const nap = async () => {};
const USDC = (n: number) => BigInt(Math.round(n * 1e6));

/** A chain with one owner/spender allowance, an RPC read that lags `lag` blocks behind, and a log of wallet prompts. */
function world(opts: { balance: bigint; allowance?: bigint; lag?: number }) {
  const prompts: string[] = [];
  let head = 100n;
  // allowance history by block: the read RPC answers the value as of (head - lag)
  const allowanceAt: Array<[bigint, bigint]> = [[0n, opts.allowance ?? 0n]];
  const lag = BigInt(opts.lag ?? 0);
  const valueAt = (b: bigint) => [...allowanceAt].reverse().find(([at]) => at <= b)![1];
  const readAllowance = async () => valueAt(head - lag);
  const approve = async (amount: bigint) => {
    prompts.push('approve');
    head += 1n;
    allowanceAt.push([head, amount]);
    return { hash: '0x01', receipt: { blockNumber: head } };
  };
  const deposit = async (amount: bigint) => {
    prompts.push('deposit');
    head += 1n;
    allowanceAt.push([head, valueAt(head) - amount]);
    return { hash: '0x02', receipt: { blockNumber: head } };
  };
  return {
    prompts,
    readAllowance,
    approve,
    deposit,
    readBalance: async () => opts.balance,
    // the lagging RPC's head
    getHead: async () => head - lag,
  };
}

beforeEach(() => resetMinedFloor());

describe('ensureAllowance: at most one approve', () => {
  it('approves once and trusts the receipt even when the next read is stale', async () => {
    const w = world({ balance: USDC(2000), lag: 5 });
    const r = await ensureAllowance(USDC(2000), { readAllowance: w.readAllowance, approve: () => w.approve(USDC(2000)), sleep: nap });
    expect(r).toEqual({ approved: true, block: 101n });
    expect(await w.readAllowance()).toBe(0n); // the read RPC still says 0
    expect(w.prompts).toEqual(['approve']);
    expect(minedFloor()).toBe(101n);
  });

  it('skips the approve when the allowance already covers the amount', async () => {
    const w = world({ balance: USDC(10), allowance: USDC(10) });
    expect(await ensureAllowance(USDC(5), { readAllowance: w.readAllowance, approve: () => w.approve(USDC(5)) })).toEqual({ approved: false });
    expect(w.prompts).toEqual([]);
  });

  it('a wallet error after broadcast is recovered by reading the allowance, not by a second approve', async () => {
    const w = world({ balance: USDC(10) });
    const approve = async () => {
      await w.approve(USDC(10)); // mined…
      throw Object.assign(new Error('execution error'), { code: -32000 }); // …but the wallet reports an error
    };
    const r = await ensureAllowance(USDC(10), { readAllowance: w.readAllowance, approve, sleep: nap });
    expect(r).toEqual({ approved: true });
    expect(w.prompts).toEqual(['approve']);
  });

  it('a user rejection is thrown at once (no polling, no second approve)', async () => {
    const w = world({ balance: USDC(10) });
    let reads = 0;
    const rejected = Object.assign(new Error('User rejected the request.'), { code: 4001 });
    await expect(
      ensureAllowance(USDC(10), {
        readAllowance: async () => (reads++, 0n),
        approve: async () => {
          throw rejected;
        },
        sleep: nap,
      }),
    ).rejects.toBe(rejected);
    expect(reads).toBe(1);
    expect(w.prompts).toEqual([]);
  });

  it('a wallet error with no approve on chain is thrown after polling', async () => {
    const err = Object.assign(new Error('boom'), { code: -32000 });
    await expect(
      ensureAllowance(USDC(1), {
        readAllowance: async () => 0n,
        approve: async () => {
          throw err;
        },
        recoverTries: 2,
        sleep: nap,
      }),
    ).rejects.toBe(err);
  });
});

describe('depositFlow: one click = at most one approve + one deposit', () => {
  it('with a lagging allowance read: one approve, one deposit, deposit simulated in after-approve mode', async () => {
    const w = world({ balance: USDC(2000), lag: 3 });
    const waited: bigint[] = [];
    let afterApproveSeen: boolean | undefined;
    await depositFlow({
      amount: USDC(2000),

      waitHead: async (min) => waited.push(min),
      readBalance: w.readBalance,
      readAllowance: w.readAllowance,
      approve: () => w.approve(USDC(2000)),
      deposit: (afterApprove) => ((afterApproveSeen = afterApprove), w.deposit(USDC(2000))),
      sleep: nap,
    });
    expect(w.prompts).toEqual(['approve', 'deposit']);
    expect(afterApproveSeen).toBe(true);
    expect(waited).toEqual([0n, 101n]); // reads wait for the head to reach the approve's block
  });

  it('refuses before any wallet prompt when the fresh balance is below the amount (29.91 < 100)', async () => {
    const w = world({ balance: USDC(29.91) });
    const p = depositFlow({
      amount: USDC(100),

      waitHead: async () => {},
      readBalance: w.readBalance,
      readAllowance: w.readAllowance,
      approve: () => w.approve(USDC(100)),
      deposit: () => w.deposit(USDC(100)),
    });
    await expect(p).rejects.toBeInstanceOf(InsufficientBalanceError);
    await expect(p).rejects.toThrow('29.91');
    expect(w.prompts).toEqual([]);
  });

  it('waits for the read head to reach the last mined tx before reading the balance', async () => {
    noteMined(250n);
    const order: string[] = [];
    const w = world({ balance: USDC(5), allowance: USDC(5) });
    await depositFlow({
      amount: USDC(5),

      waitHead: async (min) => order.push(`head>=${min}`),
      readBalance: async () => (order.push('balance'), USDC(5)),
      readAllowance: w.readAllowance,
      approve: () => w.approve(USDC(5)),
      deposit: () => w.deposit(USDC(5)),
    });
    expect(order).toEqual(['head>=250', 'balance']);
    expect(w.prompts).toEqual(['deposit']);
  });

  it('zero amount never reaches the wallet', async () => {
    const w = world({ balance: USDC(5) });
    await expect(
      depositFlow({ amount: 0n, waitHead: async () => {}, readBalance: w.readBalance, readAllowance: w.readAllowance, approve: () => w.approve(0n), deposit: () => w.deposit(0n) }),
    ).rejects.toThrow('above 0');
    expect(w.prompts).toEqual([]);
  });
});

describe('createGate: a second click while a flow runs is dropped', () => {
  it('runs the first call only; frees after it settles (also on error)', async () => {
    const changes: boolean[] = [];
    const g = createGate((h) => changes.push(h));
    let release!: () => void;
    let calls = 0;
    const slow = () => (calls++, new Promise<string>((r) => (release = () => r('done'))));
    const first = g.with(slow);
    const second = g.with(slow); // same tick: React state would not have re-rendered the button yet
    expect(g.held).toBe(true);
    expect(await second).toBeUndefined();
    release();
    expect(await first).toBe('done');
    expect(calls).toBe(1);
    expect(g.held).toBe(false);
    await expect(g.with(async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(g.held).toBe(false);
    expect(await g.with(async () => 'again')).toBe('again');
    expect(changes).toEqual([true, false, true, false, true, false]);
  });

  it('double click on Deposit with a slow allowance read: one approve, one deposit', async () => {
    const g = createGate();
    const w = world({ balance: USDC(100) });
    let slowRead!: () => void;
    const readAllowance = () => new Promise<bigint>((r) => (slowRead = () => r(0n)));
    const click = () =>
      g.with(() =>
        depositFlow({
          amount: USDC(100),

          waitHead: async () => {},
          readBalance: w.readBalance,
          readAllowance,
          approve: () => w.approve(USDC(100)),
          deposit: () => w.deposit(USDC(100)),
          sleep: nap,
        }),
      );
    const a = click();
    const b = click();
    expect(await b).toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    slowRead();
    await a;
    expect(w.prompts).toEqual(['approve', 'deposit']);
  });
});

describe('simulateAfterApprove', () => {
  const allowanceErr = Object.assign(new Error('The contract function "deposit" reverted.'), {
    cause: { name: 'ContractFunctionRevertedError', data: { errorName: 'ERC20InsufficientAllowance', args: [] } },
  });
  it('retries an allowance revert right after our approve (stale RPC), never re-approving', async () => {
    let n = 0;
    const r = await simulateAfterApprove(async () => (++n < 3 ? Promise.reject(allowanceErr) : 'ok'), { afterApprove: true, sleep: nap });
    expect(r).toBe('ok');
    expect(n).toBe(3);
  });
  it('throws at once without a preceding approve, and on other reverts', async () => {
    let n = 0;
    await expect(simulateAfterApprove(async () => (n++, Promise.reject(allowanceErr)), { afterApprove: false, sleep: nap })).rejects.toBe(allowanceErr);
    expect(n).toBe(1);
    const other = new Error('EnforcedPause');
    await expect(simulateAfterApprove(async () => Promise.reject(other), { afterApprove: true, sleep: nap })).rejects.toBe(other);
  });
  it('gives up after `tries`', async () => {
    let n = 0;
    await expect(simulateAfterApprove(async () => (n++, Promise.reject(allowanceErr)), { afterApprove: true, tries: 3, sleep: nap })).rejects.toBe(allowanceErr);
    expect(n).toBe(3);
  });
  it('recognises the raw selector too', () => {
    expect(isAllowanceRevert({ data: '0xfb8f41b2000000' })).toBe(true);
    expect(isAllowanceRevert(new Error('nope'))).toBe(false);
  });
});

describe('waitForHead', () => {
  it('polls until the head reaches the block, tolerating read errors', async () => {
    const heads = [Promise.reject(new Error('rate limited')), Promise.resolve(9n), Promise.resolve(10n)];
    heads[0].catch(() => {});
    let i = 0;
    expect(await waitForHead(10n, () => heads[i++], { sleep: nap })).toBe(true);
    expect(i).toBe(3);
  });
  it('gives up after the timeout without throwing', async () => {
    expect(await waitForHead(10n, async () => 1n, { timeoutMs: 3000, intervalMs: 1000, sleep: nap })).toBe(false);
  });
});

describe('depositBlocker', () => {
  const base = { input: '100', amount: USDC(100), balance: USDC(29.91), busy: false };
  it('blocks above the wallet balance (the 100 vs 29.91 revert)', () => {
    expect(depositBlocker(base)).toBe('More than your wallet balance (29.91 mUSDC).');
  });
  it('blocks zero, empty, unknown balance, paused and a pending tx', () => {
    expect(depositBlocker({ ...base, input: '0', amount: 0n })).toBe('Enter an amount above 0.');
    expect(depositBlocker({ ...base, input: '', amount: undefined })).toBe('Enter an amount.');
    expect(depositBlocker({ ...base, balance: undefined })).toBe('Reading your mUSDC balance…');
    expect(depositBlocker({ ...base, balance: USDC(200), paused: true })).toMatch(/paused/);
    expect(depositBlocker({ ...base, balance: USDC(200), busy: true })).toMatch(/in progress/);
    expect(depositBlocker({ ...base, parseError: 'bad number' })).toBe('bad number');
  });
  it('allows an amount up to the balance', () => {
    expect(depositBlocker({ ...base, amount: USDC(29.91), input: '29.91' })).toBeUndefined();
  });
});
