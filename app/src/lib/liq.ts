// Liquidation price (Hyperliquid docs, trading/liquidations; research doc §Prices and liquidation):
//
//   liq_price = price − side × margin_available / position_size / (1 − l × side)
//   l = 1 / MAINTENANCE_LEVERAGE,  maintenance margin = half of initial margin at max leverage
//   → MAINTENANCE_LEVERAGE = 2 × maxLeverage
//   cross:    margin_available = account_value − maintenance_margin_required (whole cross account)
//   isolated: margin_available = isolated_margin − maintenance_margin_required (this position)
//
// `price` is the current mark price (liquidations use mark). The Info API's `liquidationPx` is used when
// present; it was observed `null` for a cross position on testnet, hence this function.
// Limitation: assumes the first margin tier (single maxLeverage); tiered tables lower max leverage for
// very large notionals.

export type Side = 1 | -1;

export interface LiqInput {
  side: Side; // +1 long, −1 short
  size: number; // |position size| in coin units
  price: number; // current mark price, USD
  marginAvailable: number; // USD
  maxLeverage: number; // asset max leverage (initial), maintenance = 2×
}

export const maintenanceLeverage = (maxLeverage: number) => 2 * maxLeverage;

/** Liquidation price per the HL formula; null when there is none (≤ 0, or size 0). */
export function liqPrice({ side, size, price, marginAvailable, maxLeverage }: LiqInput): number | null {
  if (!(size > 0) || !(price > 0) || !(maxLeverage > 0)) return null;
  const l = 1 / maintenanceLeverage(maxLeverage);
  const px = price - (side * marginAvailable) / size / (1 - l * side);
  return Number.isFinite(px) && px > 0 ? px : null;
}

/** Maintenance margin of one position at `price`. */
export const maintenanceMargin = (size: number, price: number, maxLeverage: number) =>
  (size * price) / maintenanceLeverage(maxLeverage);

// ---------------------------------------------------------------- Info API shapes

export interface ApiPosition {
  coin: string;
  szi: string;
  entryPx: string;
  positionValue: string;
  unrealizedPnl: string;
  liquidationPx: string | null;
  marginUsed: string;
  maxLeverage: number;
  leverage: { type: 'cross' | 'isolated'; value: number; rawUsd?: string };
}

export interface ApiAccount {
  marginSummary: { accountValue: string; totalNtlPos: string; totalRawUsd: string; totalMarginUsed: string };
  crossMarginSummary: { accountValue: string; totalNtlPos: string; totalRawUsd: string; totalMarginUsed: string };
  crossMaintenanceMarginUsed: string;
  assetPositions: { type: string; position: ApiPosition }[];
}

export interface LiqResult {
  px: number | null;
  source: 'api' | 'computed';
  /** Inputs used when computed, for the "how is this computed" tooltip. */
  inputs?: LiqInput;
}

/** Liq price for one Info API position: API value when present, else the formula. */
export function positionLiq(pos: ApiPosition, account: ApiAccount, markPx: number): LiqResult {
  if (pos.liquidationPx !== null && pos.liquidationPx !== undefined && pos.liquidationPx !== '') {
    const v = Number(pos.liquidationPx);
    if (Number.isFinite(v) && v > 0) return { px: v, source: 'api' };
  }
  const szi = Number(pos.szi);
  const size = Math.abs(szi);
  const side: Side = szi >= 0 ? 1 : -1;
  const price = markPx > 0 ? markPx : Number(pos.positionValue) / size;
  let marginAvailable: number;
  if (pos.leverage.type === 'isolated') {
    marginAvailable = Number(pos.marginUsed) - maintenanceMargin(size, price, pos.maxLeverage);
  } else {
    marginAvailable = Number(account.crossMarginSummary.accountValue) - Number(account.crossMaintenanceMarginUsed);
  }
  const inputs: LiqInput = { side, size, price, marginAvailable, maxLeverage: pos.maxLeverage };
  return { px: liqPrice(inputs), source: 'computed', inputs };
}

/**
 * Liq estimate for a position that only exists as (szi, entryNtl, leverage) — the MOCK position source.
 * Treated as isolated at entry: margin = entryNtl / leverage, price = entry price, no accrued PnL.
 */
export function mockPositionLiq(sizeAbs: number, side: Side, entryPx: number, leverage: number, maxLeverage: number) {
  if (!(leverage > 0)) return null;
  const margin = (sizeAbs * entryPx) / leverage;
  return liqPrice({
    side,
    size: sizeAbs,
    price: entryPx,
    marginAvailable: margin - maintenanceMargin(sizeAbs, entryPx, maxLeverage),
    maxLeverage,
  });
}

/**
 * Default trigger level: `buffer` (fraction of liq price) beyond the liq price toward spot — the oracle
 * triggers the cover while mark liquidates, so the level sits a little before liquidation (§8).
 * If spot is closer than that, use the midpoint. Rounded to 5 significant digits.
 */
export function defaultLevel(liq: number, spot: number, side: Side, buffer: number): number | null {
  if (!(liq > 0) || !(spot > 0)) return null;
  if (side === 1 && liq >= spot) return null;
  if (side === -1 && liq <= spot) return null;
  let lvl = side === 1 ? liq * (1 + buffer) : liq * (1 - buffer);
  if ((side === 1 && lvl >= spot) || (side === -1 && lvl <= spot)) lvl = (liq + spot) / 2;
  const r = roundSig(lvl, 5);
  const inside = side === 1 ? r > liq && r < spot : r < liq && r > spot;
  return inside ? r : lvl;
}

export function roundSig(x: number, sig: number): number {
  if (x === 0 || !Number.isFinite(x)) return x;
  const p = Math.pow(10, sig - Math.ceil(Math.log10(Math.abs(x))));
  return Math.round(x * p) / p;
}
