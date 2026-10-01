import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { backoffMs, cached, invalidate, isRateLimited } from './rpc';
import { modelText } from './calibration';
import { depsKey } from '../hooks';

describe('isRateLimited', () => {
  it('detects -32005 / 429 anywhere in the cause chain', () => {
    expect(isRateLimited({ code: -32005, message: 'rate limited' })).toBe(true);
    expect(isRateLimited(new Error('outer', { cause: { status: 429 } }))).toBe(true);
    expect(isRateLimited({ message: 'x', cause: { details: 'rate limited' } })).toBe(true);
    expect(isRateLimited(new Error('execution reverted'))).toBe(false);
  });
});

describe('backoffMs', () => {
  it('doubles from 4 s and caps at 60 s, never below the poll interval', () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffMs(n))).toEqual([4000, 8000, 16000, 32000, 60000, 60000]);
    expect(backoffMs(1, 15000)).toBe(15000);
  });
});

describe('cached', () => {
  it('shares one in-flight read and does not cache failures', async () => {
    invalidate();
    let n = 0;
    const f = () => new Promise<number>((r) => setTimeout(() => r(++n), 5));
    const [a, b] = await Promise.all([cached('k', 1000, f), cached('k', 1000, f)]);
    expect([a, b, n]).toEqual([1, 1, 1]);
    await expect(cached('bad', 1000, () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(await cached('bad', 1000, async () => 7)).toBe(7);
    invalidate();
    expect(await cached('k', 1000, f)).toBe(2);
  });
});

describe('depsKey', () => {
  it('differs per pool and handles bigints', () => {
    expect(depsKey(['0xa', 1n])).not.toBe(depsKey(['0xb', 1n]));
    expect(depsKey(['0xa', 1n])).not.toBe(depsKey(['0xa', 2n]));
  });
});

describe('modelText (Model screen text from the synced calibration.md)', () => {
  const md = readFileSync(path.join(__dirname, '..', 'generated', 'calibration.md'), 'utf8');
  it('extracts the adopted method, the floor and the priced formula', () => {
    const t = modelText(md);
    expect(t.formula).toMatch(/priced\s*=\s*max\(p \* k, q\)/);
    expect(t.adopted).toMatch(/one z table per horizon, pooled over coins/i);
    expect(t.perBucket).toMatch(/Wilson one-sided 95 % upper bound/);
    expect(t.lookup).toMatch(/never rises as the level moves away/);
    expect(t.lookup).not.toMatch(/Quote API/);
    expect(`${t.formula} ${t.adopted} ${t.lookup}`).not.toMatch(/pooled buckets/);
  });
  it('degrades to empty strings on an unrelated document', () => {
    expect(modelText('# nothing here')).toEqual({ formula: '', lookup: '', adopted: '', perBucket: '', title: '' });
  });
});
