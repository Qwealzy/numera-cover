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

// ---------------------------------------------------------------- account abstraction modes
//
// Info API `userAbstraction` returns "unifiedAccount" | "portfolioMargin" | "disabled" | "default" |
// "dexAbstraction" (https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint).
// Docs, https://hyperliquid.gitbook.io/hyperliquid-docs/trading/account-abstraction-modes : a unified
// account has ONE balance per asset that collateralizes all cross positions in that asset and is unified
// with the spot balance; for API users "unified account and portfolio margin show all balances and holds in
// the spot clearinghouse state. Individual perp dex user states are not meaningful." The docs' unified
// account ratio is crossMaintenanceMarginUsed / (spot total − isolated margin) per collateral token.
// Liquidation at ratio >= 1 is our reading; the docs do not state the threshold.
// Observed on testnet 2026-10-02: spot USDC `total` moves 1:1 with the perp accountValue (constant
// difference), so it already includes the cross unrealized PnL, i.e. it is the account value the documented
// cross formula needs.

export type AbstractionMode = 'unifiedAccount' | 'portfolioMargin' | 'disabled' | 'default' | 'dexAbstraction';

/** How collateral enters the liquidation formula. */
export type AccountMode = 'unified' | 'portfolio' | 'standard';

export function accountModeOf(a: string | undefined | null): AccountMode {
  if (a === 'unifiedAccount') return 'unified';
  if (a === 'portfolioMargin') return 'portfolio';
  return 'standard'; // disabled / default / dexAbstraction / unknown: perp balance in clearinghouseState
}

export const ACCOUNT_MODE_LABEL: Record<AccountMode, string> = {
  unified: 'unified account',
  portfolio: 'portfolio margin',
  standard: 'standard account',
};

/** What the liq computation knows about the account beyond clearinghouseState. */
export interface AccountCtx {
  mode: AccountMode;
  /** Spot `total` of the perp collateral (USDC), read when mode is unified/portfolio. */
  spotCollateralTotal?: number;
}

export type LiqFormula = 'api' | 'isolated' | 'cross' | 'unified-cross' | 'mock';

export interface LiqResult {
  px: number | null;
  source: 'api' | 'computed';
  /** Which formula produced `px`. */
  formula?: LiqFormula;
  /** Inputs used when computed, for the "how is this computed" tooltip. */
  inputs?: LiqInput;
  /** Where margin_available came from, in words. */
  marginNote?: string;
  /** Caveat shown with the value (approximation, fallback). */
  caveat?: string;
}

const isolatedMarginSum = (account: ApiAccount) =>
  account.assetPositions.reduce((s, a) => s + (a.position.leverage.type === 'isolated' ? Number(a.position.marginUsed) || 0 : 0), 0);

const f6 = (x: number) => (Number.isFinite(x) ? x.toFixed(6) : String(x));

/**
 * Liq price for one Info API position. The API's `liquidationPx` wins whenever it is non-null; otherwise
 * the documented formula with margin_available =
 * - isolated: position margin − its maintenance;
 * - cross, standard account: perp account value − cross maintenance;
 * - cross, unified account / portfolio margin: (spot USDC total − isolated margin) − cross maintenance,
 *   i.e. the denominator of the docs' unified account ratio minus its numerator.
 */
export function positionLiq(pos: ApiPosition, account: ApiAccount, markPx: number, ctx: AccountCtx = { mode: 'standard' }): LiqResult {
  if (pos.liquidationPx !== null && pos.liquidationPx !== undefined && pos.liquidationPx !== '') {
    const v = Number(pos.liquidationPx);
    if (Number.isFinite(v) && v > 0) return { px: v, source: 'api', formula: 'api' };
  }
  const szi = Number(pos.szi);
  const size = Math.abs(szi);
  const side: Side = szi >= 0 ? 1 : -1;
  const price = markPx > 0 ? markPx : Number(pos.positionValue) / size;
  const crossMm = Number(account.crossMaintenanceMarginUsed);
  let marginAvailable: number;
  let formula: LiqFormula;
  let marginNote: string;
  let caveat: string | undefined;
  if (pos.leverage.type === 'isolated') {
    const mm = maintenanceMargin(size, price, pos.maxLeverage);
    marginAvailable = Number(pos.marginUsed) - mm;
    formula = 'isolated';
    marginNote = `isolated margin ${f6(Number(pos.marginUsed))} − maintenance ${f6(mm)}`;
  } else if (ctx.mode !== 'standard' && ctx.spotCollateralTotal !== undefined && Number.isFinite(ctx.spotCollateralTotal)) {
    const iso = isolatedMarginSum(account);
    marginAvailable = ctx.spotCollateralTotal - iso - crossMm;
    formula = 'unified-cross';
    marginNote = `spot USDC total ${f6(ctx.spotCollateralTotal)} − isolated margin ${f6(iso)} − cross maintenance ${f6(crossMm)}`;
    if (ctx.mode === 'portfolio') caveat = 'portfolio margin: only USDC collateral counted (other eligible collateral ignored), a conservative estimate';
  } else {
    const av = Number(account.crossMarginSummary.accountValue);
    marginAvailable = av - crossMm;
    formula = 'cross';
    marginNote = `perp account value ${f6(av)} − cross maintenance ${f6(crossMm)}`;
    if (ctx.mode !== 'standard') caveat = `${ACCOUNT_MODE_LABEL[ctx.mode]}, but the spot balance could not be read: perp-only estimate, closer to the price than the real one`;
  }
  const inputs: LiqInput = { side, size, price, marginAvailable, maxLeverage: pos.maxLeverage };
  return { px: liqPrice(inputs), source: 'computed', formula, inputs, marginNote, caveat };
}

/** Tooltip text for the liq chip: which formula and which inputs. */
export function liqExplain(liq: LiqResult, mode?: AccountMode): string {
  if (liq.source === 'api') return 'From the Info API (clearinghouseState liquidationPx)';
  const i = liq.inputs;
  if (liq.formula === 'mock' || !i) return 'MOCK estimate: isolated margin at entry (entryNtl ÷ leverage), no account data';
  const name =
    liq.formula === 'isolated' ? 'isolated' : liq.formula === 'unified-cross' ? `cross formula, ${ACCOUNT_MODE_LABEL[mode ?? 'unified']} collateral` : 'cross formula, perp account';
  const lines = [
    `Computed (Info API liquidationPx was null): Hyperliquid ${name}`,
    'liq = mark − side × margin_available / size / (1 − side / (2 × maxLeverage))',
    `mark ${i.price}, side ${i.side}, size ${i.size}, maxLeverage ${i.maxLeverage}`,
    `margin_available ${f6(i.marginAvailable)} = ${liq.marginNote ?? ''}`,
    liq.px ? `liq = ${liq.px.toFixed(2)}` : 'no liquidation price: collateral covers the position at any price above 0',
  ];
  if (liq.caveat) lines.push(`Note: ${liq.caveat}`);
  return lines.join('\n');
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
 * triggers the cover while mark liquidates, so the level sits a little before liquidation (docs/how-it-works.md §8).
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
