import { describe, expect, it } from 'vitest';
import { defaultLevel, liqPrice, maintenanceLeverage, mockPositionLiq, positionLiq, type ApiAccount, type ApiPosition } from './liq';

// Real testnet snapshot, 2026-10-01 (docs/research/hyperliquid.md; Info API clearinghouseState for
// 0x66DD…d5e7): BTC long 0.00117 @ 85065, 10× cross, liquidationPx null, maxLeverage 40.
const account: ApiAccount = {
  marginSummary: { accountValue: '9.775935', totalNtlPos: '99.33885', totalRawUsd: '-89.562915', totalMarginUsed: '9.933885' },
  crossMarginSummary: { accountValue: '9.775935', totalNtlPos: '99.33885', totalRawUsd: '-89.562915', totalMarginUsed: '9.933885' },
  crossMaintenanceMarginUsed: '1.241735',
  assetPositions: [],
};
const btc: ApiPosition = {
  coin: 'BTC',
  szi: '0.00117',
  entryPx: '85065.0',
  positionValue: '99.33885',
  unrealizedPnl: '-0.1872',
  liquidationPx: null,
  marginUsed: '9.933885',
  maxLeverage: 40,
  leverage: { type: 'cross', value: 10 },
};
const mark = 99.33885 / 0.00117; // 84905.0

describe('liqPrice (HL formula)', () => {
  it('maintenance leverage is twice max leverage', () => {
    expect(maintenanceLeverage(40)).toBe(80);
  });

  it('reproduces the formula by hand for the testnet BTC cross long', () => {
    // by hand: l = 1/80 = 0.0125; margin_available = 9.775935 − 1.241735 = 8.5342
    // liq = 84905 − 1 × 8.5342 / 0.00117 / (1 − 0.0125) = 84905 − 7294.188034 / 0.9875 = 84905 − 7386.519528
    const hand = 84905 - 8.5342 / 0.00117 / (1 - 0.0125);
    expect(hand).toBeCloseTo(77518.48, 1);
    const r = positionLiq(btc, account, mark);
    expect(r.source).toBe('computed');
    expect(r.px).toBeCloseTo(hand, 6);
  });

  it('is consistent with equity == maintenance margin at the liquidation price', () => {
    const r = positionLiq(btc, account, mark);
    const P = r.px!;
    // account value moves with the position's PnL; maintenance margin is notional / 80
    const equity = 9.775935 + 0.00117 * (P - mark);
    const mm = (0.00117 * P) / 80;
    // API fields are rounded to 1e-6 USD (crossMaintenanceMarginUsed 1.241735 vs 99.33885/80 = 1.2417356)
    expect(equity).toBeCloseTo(mm, 5);
    // same answer from rawUsd: equity = rawUsd + szi × P  → P = −rawUsd / (szi × (1 − 1/80))
    expect(P).toBeCloseTo(89.562915 / (0.00117 * (1 - 1 / 80)), 2);
  });

  it('uses the Info API value when present', () => {
    const r = positionLiq({ ...btc, liquidationPx: '70000.5' }, account, mark);
    expect(r).toEqual({ px: 70000.5, source: 'api' });
  });

  it('short: liquidation is above the price', () => {
    const px = liqPrice({ side: -1, size: 2, price: 100, marginAvailable: 20, maxLeverage: 10 });
    // 100 + 20/2/(1 + 0.05) = 109.5238…
    expect(px).toBeCloseTo(100 + 10 / 1.05, 9);
  });

  it('isolated: margin available is the position margin minus maintenance', () => {
    const iso: ApiPosition = { ...btc, leverage: { type: 'isolated', value: 10 }, marginUsed: '10' };
    const r = positionLiq(iso, account, 85000);
    const mmr = (0.00117 * 85000) / 80;
    expect(r.px).toBeCloseTo(85000 - (10 - mmr) / 0.00117 / (1 - 1 / 80), 6);
  });

  it('returns null when there is no liquidation price', () => {
    expect(liqPrice({ side: 1, size: 1, price: 100, marginAvailable: 1000, maxLeverage: 10 })).toBeNull();
    expect(liqPrice({ side: 1, size: 0, price: 100, marginAvailable: 10, maxLeverage: 10 })).toBeNull();
  });

  it('mock position estimate: 10× long liquidates a bit under 10 % below entry', () => {
    const px = mockPositionLiq(1, 1, 100, 10, 40)!;
    // margin 10, mm 1.25 → 100 − 8.75 / 0.9875
    expect(px).toBeCloseTo(100 - 8.75 / 0.9875, 9);
  });
});

describe('defaultLevel', () => {
  it('sits 1 % above the liq price for a long, rounded to 5 significant digits', () => {
    expect(defaultLevel(77518.48, 84847, 1, 0.01)).toBe(78294);
  });
  it('sits below the liq price for a short', () => {
    expect(defaultLevel(110, 100, -1, 0.01)).toBe(108.9);
  });
  it('falls back to the midpoint when spot is inside the buffer', () => {
    expect(defaultLevel(99.5, 100, 1, 0.01)).toBe(99.75);
  });
  it('none when already past liquidation', () => {
    expect(defaultLevel(100, 99, 1, 0.01)).toBeNull();
  });
});
