import { describe, expect, it } from 'vitest';
import { fmtBps, fmtDuration, fmtFixed, fmtPx6, fmtRatio, fmtShares, fmtUsdc, parseDecimal, pxDigits, usdToPx6 } from './format';

describe('px6 / USDC / share formatting (ARCHITECTURE §3)', () => {
  it('px6 = USD × 1e6', () => {
    expect(fmtPx6(84_847_000_000n)).toBe('$84,847.00');
    expect(fmtPx6(80_000_000_000n)).toBe('$80,000.00');
    expect(fmtPx6(118_220_000n)).toBe('$118.22');
    expect(fmtPx6(123_456n)).toBe('$0.1235'); // small prices keep 4 dp
    expect(pxDigits(999n)).toBe(6);
  });

  it('rounds half away from zero, exactly', () => {
    expect(fmtFixed(1_005n, 3, 2)).toBe('1.01');
    expect(fmtFixed(-1_005n, 3, 2)).toBe('-1.01');
    expect(fmtFixed(1_004n, 3, 2)).toBe('1.00');
    expect(fmtFixed(5n, 0, 2)).toBe('5.00');
  });

  it('USDC has 6 decimals', () => {
    expect(fmtUsdc(10_000_000_000n)).toBe('10,000.00');
    expect(fmtUsdc(2_500_000n, 6)).toBe('2.500000');
    expect(fmtUsdc(1n, 6)).toBe('0.000001');
  });

  it('pool shares have 12 decimals', () => {
    // 10k USDC first deposit at 1:1 → 10_000 × 1e12 share units
    expect(fmtShares(10_000n * 10n ** 12n)).toBe('10,000.0000');
    expect(fmtShares(1n, 12)).toBe('0.000000000001');
  });

  it('share price = convertToAssets(1e12) in USDC units', () => {
    expect(fmtFixed(1_000_000n, 6, 6)).toBe('1.000000');
    expect(fmtFixed(1_002_500n, 6, 6)).toBe('1.002500');
  });

  it('ratios and bps', () => {
    expect(fmtRatio(2_000n, 10_000n)).toBe('20.00 %');
    expect(fmtRatio(1n, 0n)).toBe('—');
    expect(fmtBps(8000)).toBe('80.00 %');
    expect(fmtBps(100)).toBe('1.00 %');
  });

  it('durations', () => {
    expect(fmtDuration(3 * 86400 + 4 * 3600)).toBe('3d 4h');
    expect(fmtDuration(2 * 3600 + 5 * 60)).toBe('2h 05m');
    expect(fmtDuration(45)).toBe('45s');
    expect(fmtDuration(0)).toBe('ended');
  });
});

describe('parseDecimal', () => {
  it('parses user input into fixed point', () => {
    expect(parseDecimal('78294', 6)).toBe(78_294_000_000n);
    expect(parseDecimal('1,234.5', 6)).toBe(1_234_500_000n);
    expect(parseDecimal('$9.95', 6)).toBe(9_950_000n);
    expect(parseDecimal('.5', 6)).toBe(500_000n);
    expect(parseDecimal('0.00117', 5)).toBe(117n); // BTC size → szi with szDecimals 5
  });
  it('rejects garbage, negatives and excess precision', () => {
    expect(() => parseDecimal('abc', 6)).toThrow();
    expect(() => parseDecimal('-1', 6)).toThrow();
    expect(() => parseDecimal('1.0000001', 6)).toThrow(/at most 6/);
    expect(() => parseDecimal('', 6)).toThrow();
  });
  it('usdToPx6 has no float drift', () => {
    expect(usdToPx6(84847.1)).toBe(84_847_100_000n);
    expect(usdToPx6(0.1 + 0.2)).toBe(300_000n);
  });
});
