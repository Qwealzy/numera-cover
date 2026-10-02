// Multi-step write flows (approve -> deposit) and click guards. Pure and dependency-injected so the rules
// are unit-tested (txflow.test.ts):
//   - one click runs at most one flow (a synchronous gate, not React state, which lags a render);
//   - an approve is trusted from its mined receipt: the allowance is never re-read to decide to approve again;
//   - reads that follow our own tx wait until the read RPC's head reaches that tx's block (the read transport
//     can fall back to a lagging RPC, and HyperEVM eth_call serves only `latest`);
//   - the wallet balance is checked fresh before the wallet opens.
import { fmtUsdc } from './format';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- click gate

export interface Gate {
  readonly held: boolean;
  /** Runs `fn` unless a previous call is still running; then returns undefined without calling it. */
  with<T>(fn: () => Promise<T>): Promise<T | undefined>;
}

export function createGate(onChange?: (held: boolean) => void): Gate {
  let held = false;
  return {
    get held() {
      return held;
    },
    async with<T>(fn: () => Promise<T>): Promise<T | undefined> {
      if (held) return undefined;
      held = true;
      onChange?.(true);
      try {
        return await fn();
      } finally {
        held = false;
        onChange?.(false);
      }
    },
  };
}

// ---------------------------------------------------------------- read-after-write floor

let floor = 0n;
/** Remember a block in which one of this page's txs was mined. */
export function noteMined(block: bigint | undefined): void {
  if (block !== undefined && block > floor) floor = block;
}
/** Highest block of a tx this page saw mined (0 before any). */
export const minedFloor = (): bigint => floor;
/** Test hook. */
export function resetMinedFloor(): void {
  floor = 0n;
}

/**
 * Wait until `head()` reaches `min` (polls every `intervalMs`, up to `timeoutMs`). Returns whether it did;
 * a head read that fails counts as "not yet". Never throws: it only makes the next read less stale.
 */
export async function waitForHead(
  min: bigint,
  head: () => Promise<bigint>,
  opts: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  if (min <= 0n) return true;
  const { timeoutMs = 20_000, intervalMs = 1_000, sleep: nap = sleep } = opts;
  for (let waited = 0; ; waited += intervalMs) {
    try {
      if ((await head()) >= min) return true;
    } catch {
      /* not yet */
    }
    if (waited >= timeoutMs) return false;
    await nap(intervalMs);
  }
}

// ---------------------------------------------------------------- errors

const ALLOWANCE_SELECTOR = '0xfb8f41b2'; // ERC20InsufficientAllowance(address,uint256,uint256)

function walk(e: unknown, test: (x: { code?: unknown; name?: unknown; message?: unknown; data?: unknown }) => boolean): boolean {
  let cur = e as { code?: unknown; name?: unknown; message?: unknown; data?: unknown; cause?: unknown } | undefined;
  for (let i = 0; cur && i < 10; i++) {
    if (test(cur)) return true;
    cur = cur.cause as typeof cur;
  }
  return false;
}

/** The wallet user declined (EIP-1193 4001, CAIP 5000). */
export const isUserRejection = (e: unknown): boolean =>
  walk(e, (x) => x.code === 4001 || x.code === 5000 || x.name === 'UserRejectedRequestError');

/** A simulation reverted with ERC20InsufficientAllowance (decoded or raw). */
export const isAllowanceRevert = (e: unknown): boolean =>
  walk(e, (x) => {
    const d = x.data as { errorName?: unknown } | string | undefined;
    if (typeof d === 'object' && d?.errorName === 'ERC20InsufficientAllowance') return true;
    if (typeof d === 'string' && d.toLowerCase().startsWith(ALLOWANCE_SELECTOR)) return true;
    return typeof x.message === 'string' && (x.message.includes('ERC20InsufficientAllowance') || x.message.includes(ALLOWANCE_SELECTOR));
  });

/**
 * simulate(); when it reverts with ERC20InsufficientAllowance right after our own mined approve, the read
 * RPC is behind: wait and simulate again (never approve again). Other errors are thrown at once.
 */
export async function simulateAfterApprove<T>(
  simulate: () => Promise<T>,
  opts: { afterApprove: boolean; tries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<T> {
  const { tries = 4, delayMs = 2_000, sleep: nap = sleep } = opts;
  for (let i = 1; ; i++) {
    try {
      return await simulate();
    } catch (e) {
      if (!opts.afterApprove || i >= tries || !isAllowanceRevert(e)) throw e;
      await nap(delayMs);
    }
  }
}

// ---------------------------------------------------------------- approve once

export interface Mined {
  receipt: { blockNumber: bigint };
}

export interface AllowanceResult {
  /** An approve was sent in this call. */
  approved: boolean;
  /** Block of the approve receipt; undefined when no approve was sent or it was recovered by reading. */
  block?: bigint;
}

/**
 * Make sure `needed` is approved, sending at most ONE approve. The allowance is read once before; after a
 * mined approve the receipt is trusted (no re-read, so a lagging RPC cannot cause a second approve). If the
 * wallet reports an error after it may already have broadcast (not a user rejection), the allowance is
 * polled for a while: when it reaches `needed`, the approve went through; otherwise the error is thrown.
 */
export async function ensureAllowance(
  needed: bigint,
  d: {
    readAllowance: () => Promise<bigint>;
    approve: () => Promise<Mined>;
    recoverTries?: number;
    recoverDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<AllowanceResult> {
  if ((await d.readAllowance()) >= needed) return { approved: false };
  try {
    const r = await d.approve();
    noteMined(r.receipt.blockNumber);
    return { approved: true, block: r.receipt.blockNumber };
  } catch (e) {
    if (isUserRejection(e)) throw e;
    const { recoverTries = 6, recoverDelayMs = 2_500, sleep: nap = sleep } = d;
    for (let i = 0; i < recoverTries; i++) {
      await nap(recoverDelayMs);
      try {
        if ((await d.readAllowance()) >= needed) return { approved: true };
      } catch {
        /* keep polling */
      }
    }
    throw e;
  }
}

// ---------------------------------------------------------------- deposit

export class InsufficientBalanceError extends Error {
  constructor(
    readonly balance: bigint,
    readonly needed: bigint,
  ) {
    super(`Not enough mUSDC: ${fmtUsdc(balance)} in your wallet, ${fmtUsdc(needed)} needed. Nothing was sent.`);
    this.name = 'InsufficientBalanceError';
  }
}

/**
 * Deposit `amount`: fresh balance check (after the read head caught up with our last tx), at most one
 * approve, then exactly one deposit. `approve` / `deposit` are the wallet writes; `deposit` is told whether
 * an approve was just mined so its simulation tolerates a lagging allowance read.
 */
export async function depositFlow<D>(d: {
  amount: bigint;
  waitHead: (min: bigint) => Promise<unknown>;
  readBalance: () => Promise<bigint>;
  readAllowance: () => Promise<bigint>;
  approve: () => Promise<Mined>;
  deposit: (afterApprove: boolean) => Promise<D>;
  recoverDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<D> {
  if (d.amount <= 0n) throw new Error('Enter an amount above 0.');
  await d.waitHead(minedFloor());
  const balance = await d.readBalance();
  if (balance < d.amount) throw new InsufficientBalanceError(balance, d.amount);
  const a = await ensureAllowance(d.amount, {
    readAllowance: d.readAllowance,
    approve: d.approve,
    recoverDelayMs: d.recoverDelayMs,
    sleep: d.sleep,
  });
  if (a.block !== undefined) await d.waitHead(a.block);
  return d.deposit(a.approved);
}

// ---------------------------------------------------------------- deposit button

/** Why Deposit is disabled, or undefined when it can be clicked. */
export function depositBlocker(x: {
  input: string;
  amount: bigint | undefined;
  parseError?: string;
  balance: bigint | undefined;
  paused?: boolean;
  busy: boolean;
}): string | undefined {
  if (x.busy) return 'A transaction is in progress: finish or reject it in your wallet first.';
  if (x.parseError) return x.parseError;
  if (!x.input.trim() || x.amount === undefined) return 'Enter an amount.';
  if (x.amount <= 0n) return 'Enter an amount above 0.';
  if (x.paused) return 'The pool is paused: deposits are off.';
  if (x.balance === undefined) return 'Reading your mUSDC balance…';
  if (x.amount > x.balance) return `More than your wallet balance (${fmtUsdc(x.balance)} mUSDC).`;
  return undefined;
}
