// Quote API client (docs/how-it-works.md §6) + a fixture with the same shape for UI work without the engine.
import { getAddress, hashTypedData, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { parseDecimal, PX_DECIMALS, USDC_DECIMALS } from './format';

/** §6 request body. level: px6 int, payout: USDC 6-dec int. */
export interface QuoteRequest {
  buyer: Address;
  perpIndex: number;
  isLong: boolean;
  level: number;
  payout: number;
  durationSec: number;
  /** Pool the quote is signed for (EIP-712 verifyingContract). Optional engine extension. */
  pool?: Address;
}

/** §4 Quote as JSON numbers (engine keeps every field ≤ 2^53, nonce included). */
export interface QuoteJson {
  buyer: string;
  perpIndex: number;
  isLong: boolean;
  level: number;
  payout: number;
  premium: number;
  expiry: number;
  spotRef: number;
  deadline: number;
  nonce: number;
}

export interface Breakdown {
  sigma: number;
  touchProb: number;
  loading: number;
  premium: number;
  model: string;
  // additive engine fields (not in §6)
  tailMultiplier?: number;
  tailFloor?: number;
  pricedProb?: number;
  fee?: number;
  coin?: string;
  /** Standardized distance ln(L/S)/(σ√T) — "distance in σ". */
  z?: number;
  /** Where S / spotRef came from: the pool's own price source, or the Info API fallback. */
  spotSource?: 'pool' | 'info_api';
  pool?: string;
}

export interface QuoteOk {
  quote: QuoteJson;
  signature: Hex;
  breakdown: Breakdown;
  fixture?: boolean;
}
export interface QuoteErr {
  error: string;
  reason: string;
}
export type QuoteResult = { ok: true; value: QuoteOk } | { ok: false; error: QuoteErr };

/** viem-ready struct for CoverPool.buyCover. */
export function toContractQuote(q: QuoteJson) {
  return {
    buyer: getAddress(q.buyer),
    perpIndex: q.perpIndex,
    isLong: q.isLong,
    level: BigInt(q.level),
    payout: BigInt(q.payout),
    premium: BigInt(q.premium),
    expiry: BigInt(q.expiry),
    spotRef: BigInt(q.spotRef),
    deadline: BigInt(q.deadline),
    nonce: BigInt(q.nonce),
  };
}

// ---------------------------------------------------------------- EIP-712 (§4) — verify before sending

export const QUOTE_TYPES = {
  Quote: [
    { name: 'buyer', type: 'address' },
    { name: 'perpIndex', type: 'uint32' },
    { name: 'isLong', type: 'bool' },
    { name: 'level', type: 'uint64' },
    { name: 'payout', type: 'uint256' },
    { name: 'premium', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
    { name: 'spotRef', type: 'uint64' },
    { name: 'deadline', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

export const quoteDomain = (chainId: number, pool: Address) =>
  ({ name: 'Numera', version: '1', chainId, verifyingContract: pool }) as const;

/** Address that signed this quote for `pool` on `chainId` (compare with CoverPool.quoteSigner). */
export async function recoverQuoteSigner(q: QuoteJson, sig: Hex, chainId: number, pool: Address): Promise<Address | undefined> {
  try {
    return await recoverTypedDataAddress({
      domain: quoteDomain(chainId, pool),
      types: QUOTE_TYPES,
      primaryType: 'Quote',
      message: toContractQuote(q),
      signature: sig,
    });
  } catch {
    return undefined;
  }
}

export const quoteDigest = (q: QuoteJson, chainId: number, pool: Address): Hex =>
  hashTypedData({ domain: quoteDomain(chainId, pool), types: QUOTE_TYPES, primaryType: 'Quote', message: toContractQuote(q) });

/** Premium the §7 step 6 formula gives for this breakdown: ceil(payout × pricedProb × (1+θ)) + fee. */
export function expectedPremium(payout: number, b: Breakdown): number {
  const priced = b.pricedProb ?? Math.max(b.touchProb * (b.tailMultiplier ?? 1), b.tailFloor ?? 0);
  return Math.ceil(payout * priced * (1 + b.loading)) + (b.fee ?? 0);
}

// ---------------------------------------------------------------- request building

export interface QuoteForm {
  buyer: Address | undefined;
  perpIndex: number;
  isLong: boolean;
  level: string; // USD, user-typed
  payout: string; // USDC, user-typed
  durationSec: number;
  pool: Address;
  spotPx6: bigint | undefined; // current oracle px6 (pool's price source)
  capUsdc: bigint | undefined; // max payout = entryNtl / leverage
}

export type Built = { ok: true; body: QuoteRequest; level: bigint; payout: bigint } | { ok: false; error: string };

/** Validate the Protect form and build the §6 body. Pure; unit-tested. */
export function buildQuoteRequest(f: QuoteForm): Built {
  if (!f.buyer) return { ok: false, error: 'Connect a wallet to get a quote (the quote is signed for your address).' };
  let level: bigint, payout: bigint;
  try {
    level = parseDecimal(f.level, PX_DECIMALS);
  } catch (e) {
    return { ok: false, error: `Level: ${(e as Error).message}` };
  }
  try {
    payout = parseDecimal(f.payout, USDC_DECIMALS);
  } catch (e) {
    return { ok: false, error: `Payout: ${(e as Error).message}` };
  }
  if (level <= 0n) return { ok: false, error: 'Level must be above zero.' };
  if (payout <= 0n) return { ok: false, error: 'Payout must be above zero.' };
  if (f.spotPx6 !== undefined) {
    if (f.isLong && level >= f.spotPx6)
      return { ok: false, error: 'A long is covered against a fall: the level must be below the current oracle price.' };
    if (!f.isLong && level <= f.spotPx6)
      return { ok: false, error: 'A short is covered against a rise: the level must be above the current oracle price.' };
  }
  if (f.capUsdc !== undefined && payout > f.capUsdc)
    return { ok: false, error: 'Payout is above the cap (the margin at stake = entry notional ÷ leverage).' };
  if (level > BigInt(Number.MAX_SAFE_INTEGER) || payout > BigInt(Number.MAX_SAFE_INTEGER))
    return { ok: false, error: 'Value too large.' };
  return {
    ok: true,
    level,
    payout,
    body: {
      buyer: f.buyer,
      perpIndex: f.perpIndex,
      isLong: f.isLong,
      level: Number(level),
      payout: Number(payout),
      durationSec: f.durationSec,
      pool: f.pool,
    },
  };
}

// ---------------------------------------------------------------- engine call

/**
 * POST /quote. Sends `pool` so the quote is signed for the selected pool; an older engine that rejects
 * the field (`invalid_request` naming `pool`) is retried once without it — its signature then only
 * works if that engine's configured pool is the selected one, which the UI checks by recovering the signer.
 */
export async function requestQuote(engineUrl: string, body: QuoteRequest, signal?: AbortSignal): Promise<QuoteResult> {
  const first = await postQuote(engineUrl, body, signal);
  if (!first.ok && body.pool && isPoolFieldRejected(first.error)) {
    const { pool: _drop, ...rest } = body;
    void _drop;
    return postQuote(engineUrl, rest, signal);
  }
  return first;
}

export const isPoolFieldRejected = (e: QuoteErr) => e.error === 'invalid_request' && /\bpool\b/.test(e.reason);

async function postQuote(engineUrl: string, body: QuoteRequest, signal?: AbortSignal): Promise<QuoteResult> {
  let r: Response;
  try {
    r = await fetch(`${engineUrl}/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    return { ok: false, error: { error: 'engine_unreachable', reason: `${engineUrl} did not answer (${(e as Error).message})` } };
  }
  let json: unknown;
  try {
    json = await r.json();
  } catch {
    return { ok: false, error: { error: 'bad_response', reason: `HTTP ${r.status}, body is not JSON` } };
  }
  return parseQuoteResponse(r.status, json);
}

export function parseQuoteResponse(status: number, json: unknown): QuoteResult {
  const j = json as Partial<QuoteOk & QuoteErr>;
  if (j && typeof j.error === 'string') return { ok: false, error: { error: j.error, reason: String(j.reason ?? '') } };
  if (status >= 200 && status < 300 && j?.quote && typeof j.signature === 'string' && j.breakdown) {
    return { ok: true, value: j as QuoteOk };
  }
  return { ok: false, error: { error: 'bad_response', reason: `HTTP ${status}, unexpected body` } };
}

export interface EngineHealth {
  ok: boolean;
  env: string;
  signer: string | null;
  chainId: number;
  pool: string;
  /** Pools the engine will sign for; absent on older engines. */
  pools?: string[];
}

/** Can this engine sign quotes for `pool`? */
export const engineServesPool = (h: EngineHealth, pool: string) =>
  [h.pool, ...(h.pools ?? [])].some((p) => p.toLowerCase() === pool.toLowerCase());

export async function fetchHealth(engineUrl: string, signal?: AbortSignal): Promise<EngineHealth> {
  const r = await fetch(`${engineUrl}/health`, { signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as EngineHealth;
}

// ---------------------------------------------------------------- fixture (VITE_USE_QUOTE_FIXTURE)

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 erf, |err| < 1.5e-7). */
export function ndtr(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Driftless-GBM one-touch probability, docs/how-it-works.md §7 step 3 (mirror of engine pricing.touch_prob). */
export function touchProb(S: number, H: number, sigma: number, T: number): number {
  if (H === S) return 1;
  if (sigma <= 0 || T <= 0) return 0;
  const s = sigma * Math.sqrt(T);
  const half = 0.5 * sigma * sigma * T;
  const b = Math.log(H / S);
  const p = H < S ? ndtr((b + half) / s) + (S / H) * ndtr((b - half) / s) : ndtr((-b - half) / s) + (S / H) * ndtr((-b + half) / s);
  return Math.min(1, Math.max(0, p));
}

const SECONDS_PER_YEAR = 365 * 24 * 3600;

/**
 * Local stand-in for POST /quote with the §6 shape. Sigma, k and q are fixed illustrative numbers; the
 * signature is a dummy, so the contract rejects it (InvalidSignature). Errors mirror engine codes.
 */
export function fixtureQuote(body: QuoteRequest, spotPx6: bigint, nowSec = Math.floor(Date.now() / 1000), coin = 'BTC'): QuoteResult {
  const spot = Number(spotPx6);
  if ((body.isLong && spot <= body.level) || (!body.isLong && spot >= body.level))
    return { ok: false, error: { error: 'level_already_breached', reason: `oracle ${spot} already ${body.isLong ? '<=' : '>='} level ${body.level}` } };
  if (body.durationSec < 600 || body.durationSec > 7 * 86400)
    return { ok: false, error: { error: 'duration_out_of_range', reason: 'durationSec must be in [600, 604800]' } };
  const sigma = 0.55;
  const k = 1.2;
  const q = 0.0005;
  const theta = 0.2;
  const fee = 0;
  const p = touchProb(spot / 1e6, body.level / 1e6, sigma, body.durationSec / SECONDS_PER_YEAR);
  const priced = Math.max(p * k, q);
  if (priced > 0.5)
    return { ok: false, error: { error: 'prob_too_high', reason: `priced touch probability ${priced.toFixed(4)} exceeds pMax 0.5` } };
  const premium = Math.ceil(body.payout * priced * (1 + theta)) + fee;
  return {
    ok: true,
    value: {
      fixture: true,
      quote: {
        buyer: body.buyer,
        perpIndex: body.perpIndex,
        isLong: body.isLong,
        level: body.level,
        payout: body.payout,
        premium,
        expiry: nowSec + body.durationSec,
        spotRef: spot,
        deadline: nowSec + 60,
        nonce: 1 + Math.floor(Math.random() * 1e15),
      },
      signature: ('0x' + '00'.repeat(65)) as Hex,
      breakdown: {
        sigma,
        touchProb: p,
        loading: theta,
        premium,
        model: 'fixture',
        tailMultiplier: k,
        tailFloor: q,
        pricedProb: priced,
        fee,
        coin,
        z: Math.log(body.level / spot) / (sigma * Math.sqrt(body.durationSec / SECONDS_PER_YEAR)),
        spotSource: 'pool',
        pool: body.pool,
      },
    },
  };
}
