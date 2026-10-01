import { beforeEach, describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { POOLS } from '../config';
import { loadCovers } from './covers';
import { invalidate } from './rpc';
import { readSnapshot, Status, type ReadClient } from './pool';

const deployer = getAddress('0x2BA514Ca28fc6f34072F2cBB7467D0849cfF52A9');
// cover 1 on the MOCK pool as getCover(1) decodes it (struct → object)
const cover1 = {
  buyer: deployer,
  perpIndex: 3,
  isLong: true,
  level: 80_000_000_000n,
  payout: 10_000_000n,
  premium: 123_456n,
  start: 1_790_000_000n,
  expiry: 1_790_086_400n,
  status: 2,
};

type Call = { address: string; functionName: string; args?: readonly unknown[] };

function fakeClient(onMulticall: (calls: Call[]) => unknown[]): ReadClient & { calls: Call[][] } {
  const calls: Call[][] = [];
  return {
    calls,
    multicall: (async (p: { contracts: Call[] }) => {
      calls.push(p.contracts);
      return onMulticall(p.contracts);
    }) as unknown as ReadClient['multicall'],
    readContract: (async () => {
      throw new Error('unexpected readContract');
    }) as unknown as ReadClient['readContract'],
  } as ReadClient & { calls: Call[][] };
}

describe('loadCovers (data function of useCovers)', () => {
  beforeEach(() => invalidate());

  it('returns MOCK cover 1 when coverCount is 1 (the "Recent covers" empty bug)', async () => {
    const client = fakeClient((cs) => cs.map(() => cover1));
    const list = await loadCovers(POOLS.mock, 1n, 10_000_000n, client);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 1n, buyer: deployer, perpIndex: 3, isLong: true, payout: 10_000_000n, status: Status.Paid });
    // reads getCover(1) from the MOCK pool, nothing else
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toHaveLength(1);
    expect(client.calls[0][0]).toMatchObject({ address: POOLS.mock.pool, functionName: 'getCover', args: [1n] });
  });

  it('reads newest first and keys by pool: the same count on another pool is a separate read', async () => {
    const client = fakeClient((cs) => cs.map(() => cover1));
    const a = await loadCovers(POOLS.mock, 3n, 0n, client);
    expect(a.map((c) => c.id)).toEqual([3n, 2n, 1n]);
    await loadCovers(POOLS.hypercore, 3n, 0n, client);
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1][0].address).toBe(POOLS.hypercore.pool);
    // identical read within the cache window is deduped
    await loadCovers(POOLS.mock, 3n, 0n, client);
    expect(client.calls).toHaveLength(2);
  });

  it('a trigger/expiry (lockedAssets change) forces a fresh read', async () => {
    const client = fakeClient((cs) => cs.map(() => cover1));
    await loadCovers(POOLS.mock, 1n, 10_000_000n, client);
    await loadCovers(POOLS.mock, 1n, 0n, client);
    expect(client.calls).toHaveLength(2);
  });

  it('coverCount 0 → [] without any RPC call', async () => {
    const client = fakeClient(() => []);
    expect(await loadCovers(POOLS.mock, 0n, 0n, client)).toEqual([]);
    expect(client.calls).toHaveLength(0);
  });

  it('throws (UI shows loading/error) instead of returning [] when covers exist but the read fails', async () => {
    const failing = fakeClient(() => {
      throw Object.assign(new Error('rate limited'), { code: -32005 });
    });
    await expect(loadCovers(POOLS.mock, 1n, 0n, failing)).rejects.toThrow(/rate limited/);
    const short = fakeClient(() => []);
    await expect(loadCovers(POOLS.mock, 1n, 0n, short)).rejects.toThrow(/Read 0 of 1 covers/);
    // failures are not cached
    const ok = fakeClient((cs) => cs.map(() => cover1));
    expect(await loadCovers(POOLS.mock, 1n, 0n, ok)).toHaveLength(1);
  });
});

describe('readSnapshot', () => {
  it('reads block, pool stats and every oracle price in ONE multicall', async () => {
    const perps = [3, 4];
    const client = fakeClient((cs) =>
      cs.map((c) => {
        if (c.functionName === 'oraclePx6') return c.args?.[0] === 3 ? { status: 'success', result: 84_000_000_000n } : { status: 'failure', error: new Error('x') };
        if (c.functionName === 'getBlockNumber') return { status: 'success', result: 123n };
        if (c.functionName === 'paused') return { status: 'success', result: false };
        if (c.functionName === 'coverCount') return { status: 'success', result: 1n };
        return { status: 'success', result: 0n };
      }),
    );
    const s = await readSnapshot(POOLS.mock, undefined, perps, client);
    expect(client.calls).toHaveLength(1);
    expect(s.stats.block).toBe(123n);
    expect(s.stats.coverCount).toBe(1n);
    expect(s.stats.user).toBeUndefined();
    expect(s.oracle.get(3)).toEqual({ ok: true, px6: 84_000_000_000n });
    expect(s.oracle.get(4)?.ok).toBe(false);
    expect(client.calls[0].filter((c) => c.functionName === 'oraclePx6').every((c) => c.address === POOLS.mock.priceSource)).toBe(true);
  });

  it('fails the whole snapshot when a stats read fails (no half-filled numbers)', async () => {
    const client = fakeClient((cs) => cs.map((c) => (c.functionName === 'totalAssets' ? { status: 'failure', error: new Error('boom') } : { status: 'success', result: 0n })));
    await expect(readSnapshot(POOLS.mock, undefined, [3], client)).rejects.toThrow('boom');
  });
});
