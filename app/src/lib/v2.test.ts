import { describe, expect, it } from 'vitest';
import { encodeErrorResult, getAddress } from 'viem';
import { coverPoolAbi } from '../generated/abi';
import { POOLS, USDC, detectVersion, parseV2Pools, type PoolConfig } from '../config';
import { contractErrorMessage, decodeRevert } from './errors';
import { decodeV2, readSnapshot } from './pool';
import { premiumMatches, type Breakdown, type QuoteJson } from './quote';
import { exitView, pauseCause, premiumFloor, saleWindow, type V2Stats } from './v2';

const LIMITS = {
  maxUtilizationBps: 8000,
  perPerpCapBps: 5000,
  maxDuration: 604_800n,
  maxSpotDeviationBps: 30,
  minPayout: 1_000_000n,
  minPremiumBps: 20,
  minLevelDistanceBps: 25,
  saleWindow: 3600,
  maxSoldPerWindowBps: 2500,
  maxBuyerWindowShareBps: 2500,
  maxPaidPerWindowBps: 1500,
};
const T = 1_790_000_000;

function stats(over: Partial<V2Stats> = {}): V2Stats {
  return {
    limits: LIMITS,
    capacityBase: 10_000_000_000n,
    unearnedPremium: 0n,
    owedAssets: 0n,
    windowStart: 0n,
    windowAssets: 0n,
    soldInWindow: 0n,
    paidWindowStart: 0n,
    paidWindowAssets: 0n,
    paidInWindow: 0n,
    totalEscrowedShares: 0n,
    withdrawDelay: 600n,
    claimWindow: 3600n,
    configDelay: 600n,
    guardian: '0x0000000000000000000000000000000000000000',
    strict: false,
    blockTimestamp: BigInt(T),
    ...over,
  };
}

describe('LP exit state machine (§5.4)', () => {
  const req = (shares: bigint, at = T + 600) => ({ shares, claimableAt: BigInt(at), claimDeadline: BigInt(at + 3600), state: 1 });
  const S = 10n ** 12n;

  it('none: only a request is possible, and only with shares in the wallet', () => {
    const v = exitView(undefined, T, 0n, 5n * S);
    expect(v).toMatchObject({ phase: 'none', canRequest: true, canCancel: false, canClaim: false, canRequeue: false });
    expect(exitView(req(0n), T, 0n, 0n).canRequest).toBe(false);
  });

  it('request -> pending countdown -> claimable window -> lapsed, from the slot timestamps', () => {
    const r = req(5n * S);
    const pending = exitView(r, T, 0n, 0n);
    expect(pending).toMatchObject({ phase: 'pending', secondsLeft: 600, canCancel: true, canClaim: false, canRequest: false });
    expect(exitView(r, T, 0n, 1n).canRequest).toBe(true); // adding shares restarts the clock (allowed)
    const open = exitView(r, T + 600, 5n * S, 1n);
    expect(open).toMatchObject({ phase: 'claimable', secondsLeft: 3600, canClaim: true, partialOnly: false, canRequest: false, canCancel: true });
    expect(exitView(r, T + 600 + 3599, 5n * S, 0n).phase).toBe('claimable');
    const lapsed = exitView(r, T + 600 + 3600, 5n * S, 0n);
    expect(lapsed).toMatchObject({ phase: 'lapsed', canRequeue: true, canClaim: false, canCancel: true });
  });

  it('partial claim when free assets cover only part of the slot; nothing when maxRedeem is 0', () => {
    expect(exitView(req(5n * S), T + 700, 2n * S, 0n)).toMatchObject({ canClaim: true, partialOnly: true });
    expect(exitView(req(5n * S), T + 700, 0n, 0n)).toMatchObject({ phase: 'claimable', canClaim: false });
  });
});

describe('sale window, breaker and floor', () => {
  it('open window: sold / cap on the window snapshot, resets in N s; buyer share', () => {
    const v = stats({ windowStart: BigInt(T - 100), windowAssets: 8_000_000_000n, soldInWindow: 1_500_000_000n });
    const w = saleWindow(v, T, { start: BigInt(T - 100), sold: 400_000_000n });
    expect(w).toMatchObject({ reset: false, sold: 1_500_000_000n, cap: 2_000_000_000n, resetsIn: 3500, buyerSold: 400_000_000n, buyerCap: 500_000_000n });
    const after = saleWindow(v, T + 3500, { start: BigInt(T - 100), sold: 400_000_000n });
    expect(after).toMatchObject({ reset: true, sold: 0n, cap: 2_500_000_000n, resetsIn: undefined, buyerSold: 0n });
  });

  it('paused by breaker vs by the owner', () => {
    expect(pauseCause(false, stats())).toBe('running');
    const tripped = stats({ paidWindowStart: BigInt(T), paidWindowAssets: 10_000_000_000n, paidInWindow: 1_600_000_000n });
    expect(pauseCause(true, tripped)).toBe('breaker');
    expect(pauseCause(true, stats({ paidWindowStart: BigInt(T), paidWindowAssets: 10_000_000_000n, paidInWindow: 1_000_000_000n }))).toBe('owner');
    expect(pauseCause(true, stats())).toBe('owner'); // unpause zeroes the breaker window
  });

  it('premium floor is ceil(payout × bps / 1e4) and the app accepts a floor-raised quote', () => {
    expect(premiumFloor(100_000_000n, 20)).toBe(200_000n);
    expect(premiumFloor(4_999n, 20)).toBe(10n);
    const q = { payout: 100_000_000, premium: 200_000 } as QuoteJson;
    const b = { sigma: 0.5, touchProb: 1e-9, loading: 0.2, premium: 200_000, model: 'gbm-touch-v1', pricedProb: 1e-6, fee: 0, floorApplied: true } as Breakdown;
    expect(premiumMatches(q, b, 20)).toBe(true);
    expect(premiumMatches(q, b, undefined)).toBe(false); // floor unknown yet: cannot verify
    expect(premiumMatches({ ...q, premium: 300_000 }, b, 20)).toBe(false); // not the floor
    expect(premiumMatches(q, { ...b, pricedProb: 0.1 }, 20)).toBe(false); // the model is above the floor: no raise
  });
});

describe('version detection and v2 pools', () => {
  it('config word wins; else the minPremiumBps/limits probe', () => {
    expect(detectVersion('v2', false)).toBe('v2');
    expect(detectVersion(undefined, true)).toBe('v2');
    expect(detectVersion(undefined, false)).toBe('v1');
    expect(detectVersion(undefined, undefined)).toBe('v1');
  });

  it('parses deployments/testnet-v2.json pools as separate v2 entries', () => {
    const a = (n: number) => '0x' + n.toString(16).padStart(40, '0');
    const raw = {
      contract: 'CoverPool v2',
      pools: {
        mock: { chainId: 998, mode: 'mock', pool: a(1), priceSource: a(2), positionSource: a(3), usdc: a(4), txs: [{ name: 'CoverPool', function: 'create', hash: '0x' + 'ab'.repeat(32) }] },
        hypercore: { chainId: 31337, pool: a(5), priceSource: a(6), positionSource: a(7) }, // other chain
        weird: { chainId: 998, pool: a(8), priceSource: a(9), positionSource: a(10) },
      },
    };
    const ps = parseV2Pools(raw, 998, 'http://e', USDC);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ key: 'mock-v2', kind: 'mock', version: 'v2', short: 'MOCK v2', pool: getAddress(a(1)), usdc: getAddress(a(4)), deployTx: '0x' + 'ab'.repeat(32) });
    expect(parseV2Pools(null, 998, 'e', USDC)).toEqual([]);
    expect(POOLS.hypercore.version).toBeUndefined(); // v1 entries: detected on chain
  });

  const ok = (result: unknown) => ({ status: 'success' as const, result });
  const fail = { status: 'failure' as const, error: new Error('reverted') };

  it('decodeV2: a v1 pool (probe reverts) stays v1 with no v2 state', () => {
    const opt = Array.from({ length: 22 }, (_, i) => (i === 0 ? ok(BigInt(T)) : fail));
    expect(decodeV2(POOLS.mock, opt, true)).toEqual({ version: 'v1' });
  });

  it('decodeV2: probe + limits -> v2 with typed pool and user state', () => {
    const pool = [20, LIMITS, 9n, 1n, 2n, BigInt(T), 3n, 4n, 0n, 0n, 0n, 5n, 600n, 3600n, 600n, '0x0000000000000000000000000000000000000000', false];
    const user = [7n, [5n, BigInt(T + 600), BigInt(T + 4200), 1], 0n, [BigInt(T), 4n]];
    const opt = [ok(BigInt(T)), ...pool.map(ok), ...user.map(ok)];
    const r = decodeV2(POOLS.mock, opt, true);
    expect(r.version).toBe('v2');
    expect(r.v2).toMatchObject({ capacityBase: 9n, unearnedPremium: 1n, owedAssets: 2n, totalEscrowedShares: 5n, withdrawDelay: 600n, limits: LIMITS });
    expect(r.v2User).toMatchObject({ owed: 7n, request: { shares: 5n, state: 1 }, buyerWindow: { start: BigInt(T), sold: 4n } });
    const v2conf: PoolConfig = { ...POOLS.mock, version: 'v2' };
    expect(() => decodeV2(v2conf, [ok(BigInt(T)), fail, ...pool.slice(1).map(ok), ...user.map(ok)], true)).toThrow('reverted');
  });

  it('readSnapshot reports v1 for a pool whose v2 views revert (existing pools keep working)', async () => {
    const calls: { functionName: string }[][] = [];
    const client = {
      multicall: async ({ contracts }: { contracts: { functionName: string; args?: unknown[] }[] }) => {
        calls.push(contracts);
        return contracts.map((c) =>
          ['minPremiumBps', 'limits', 'capacityBase', 'redeemRequestOf', 'owed'].includes(c.functionName) ? fail : c.functionName === 'paused' ? ok(false) : ok(0n),
        );
      },
      readContract: async () => 0n,
    };
    const s = await readSnapshot(POOLS.hypercore, undefined, [3], client as never);
    expect(calls).toHaveLength(1);
    expect(s.stats.version).toBe('v1');
    expect(s.stats.v2).toBeUndefined();
  });
});

describe('v2 error mapping', () => {
  it('every v2 custom error has a specific message', () => {
    const names = coverPoolAbi.filter((x) => x.type === 'error').map((x) => (x as { name: string }).name);
    for (const n of [
      'PerpNotAllowed',
      'PremiumBelowFloor',
      'LevelTooClose',
      'SaleWindowCapExceeded',
      'BuyerWindowCapExceeded',
      'NothingOwed',
      'NotShareOwner',
      'ControllerMustBeOwner',
      'NotController',
      'RequestClaimable',
      'RequestNotClaimable',
      'ZeroShares',
      'ExceedsClaimable',
      'InsufficientFreeAssets',
      'AsyncRedeemOnly',
      'SharesToPool',
      'NotGuardian',
      'OpAlreadyQueued',
      'OpNotQueued',
      'OpNotReady',
      'OpStale',
      'RenounceDisabled',
      'InvalidDelays',
      'StrictRequired',
      'InvalidLimits',
    ]) {
      expect(names).toContain(n);
      expect(contractErrorMessage(n, [0n, 0n, 0n])).not.toMatch(/^Contract reverted/);
    }
  });

  it('decodes v2 reverts with readable units', () => {
    const d = decodeRevert(encodeErrorResult({ abi: coverPoolAbi, errorName: 'PremiumBelowFloor', args: [150_000n, 200_000n] }));
    expect(d?.name).toBe('PremiumBelowFloor');
    expect(contractErrorMessage(d!.name, d!.args)).toMatch(/0\.15 mUSDC.*0\.20 mUSDC/);
    const r = decodeRevert(encodeErrorResult({ abi: coverPoolAbi, errorName: 'RequestNotClaimable', args: [1] }));
    expect(contractErrorMessage(r!.name, r!.args)).toMatch(/still waiting for its delay/);
    expect(contractErrorMessage('RequestNotClaimable', [3])).toMatch(/lapsed; re-queue/);
    expect(contractErrorMessage('SaleWindowCapExceeded', [2_600_000_000n, 2_500_000_000n])).toMatch(/2,600\.00 mUSDC.*2,500\.00 mUSDC/);
    expect(contractErrorMessage('InsufficientFreeAssets', [5_000_000n, 1_000_000n])).toMatch(/claim part now/);
  });
});
