import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAddress, type Hex } from 'viem';
import {
  buildQuoteRequest,
  buyBlocker,
  expectedPremium,
  fixtureQuote,
  isPoolFieldRejected,
  parseQuoteResponse,
  premiumMatches,
  QUOTE_TTL_S,
  quoteDigest,
  recoverQuoteSigner,
  touchProb,
  type QuoteForm,
} from './quote';

const buyer = getAddress('0x66DDA666bf32Cae48cf190bbAd04Effc90b7d5e7');
const pool = getAddress('0xd9e3b5fa578883f66438f3e3be05db420b94fd54');
const base: QuoteForm = {
  buyer,
  perpIndex: 3,
  isLong: true,
  level: '78294',
  payout: '9.95',
  durationSec: 86400,
  pool,
  spotPx6: 84_847_000_000n,
  capUsdc: 9_952_605n,
};

describe('buildQuoteRequest (§6 body)', () => {
  it('builds px6 level and 6-dec payout as JSON integers, with the selected pool', () => {
    const r = buildQuoteRequest(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body).toEqual({ buyer, perpIndex: 3, isLong: true, level: 78_294_000_000, payout: 9_950_000, durationSec: 86400, pool });
    expect(JSON.parse(JSON.stringify(r.body)).level).toBe(78294000000);
  });
  it('requires a wallet', () => {
    expect(buildQuoteRequest({ ...base, buyer: undefined }).ok).toBe(false);
  });
  it('long level must be below the oracle, short above', () => {
    const a = buildQuoteRequest({ ...base, level: '90000' });
    expect(a.ok).toBe(false);
    const b = buildQuoteRequest({ ...base, isLong: false, level: '80000' });
    expect(b.ok).toBe(false);
    expect(buildQuoteRequest({ ...base, isLong: false, level: '90000' }).ok).toBe(true);
  });
  it('payout must be positive and within the margin cap', () => {
    expect(buildQuoteRequest({ ...base, payout: '0' }).ok).toBe(false);
    const r = buildQuoteRequest({ ...base, payout: '9.952606' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cap/);
    expect(buildQuoteRequest({ ...base, payout: '9.952605' }).ok).toBe(true);
  });
  it('rejects malformed numbers with the field name', () => {
    const r = buildQuoteRequest({ ...base, level: '78k' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^Level/);
  });
});

describe('quote response parsing', () => {
  it('maps {error, reason}', () => {
    expect(parseQuoteResponse(422, { error: 'prob_too_high', reason: 'x' })).toEqual({ ok: false, error: { error: 'prob_too_high', reason: 'x' } });
  });
  it('rejects malformed success bodies', () => {
    expect(parseQuoteResponse(200, { foo: 1 }).ok).toBe(false);
  });
  it('detects an engine that does not accept the pool field', () => {
    expect(isPoolFieldRejected({ error: 'invalid_request', reason: 'pool: Extra inputs are not permitted' })).toBe(true);
    expect(isPoolFieldRejected({ error: 'unknown_pool', reason: 'pool 0x.. is not in the allowlist' })).toBe(false);
  });
});

describe('pricing mirror (fixture + verification)', () => {
  it('touch probability matches the closed form at the barrier and is monotone', () => {
    expect(touchProb(100, 100, 0.5, 0.01)).toBe(1);
    const near = touchProb(100, 95, 0.5, 1 / 365);
    const far = touchProb(100, 80, 0.5, 1 / 365);
    expect(near).toBeGreaterThan(far);
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(1);
  });
  it('expectedPremium = ceil(payout × max(p·k, q) × (1+θ)) + fee', () => {
    const b = { sigma: 0.5, touchProb: 0.01, loading: 0.2, premium: 0, model: 'm', tailMultiplier: 1.5, tailFloor: 0.02, fee: 7 };
    // max(0.015, 0.02) = 0.02 → 100e6 × 0.02 × 1.2 = 2.4e6, + 7
    expect(expectedPremium(100_000_000, b)).toBe(2_400_007);
    expect(expectedPremium(100_000_000, { ...b, pricedProb: 0.03 })).toBe(3_600_007);
  });
  it('fixture has the §6 shape and engine error codes', () => {
    const r = buildQuoteRequest(base);
    if (!r.ok) throw new Error(r.error);
    const q = fixtureQuote(r.body, 84_847_000_000n, 1_790_000_000);
    expect(q.ok).toBe(true);
    if (q.ok) {
      expect(q.value.quote.deadline).toBe(1_790_000_030);
      expect(q.value.quote.expiry).toBe(1_790_086_400);
      expect(q.value.breakdown.premium).toBe(q.value.quote.premium);
      expect(expectedPremium(q.value.quote.payout, q.value.breakdown)).toBe(q.value.quote.premium);
      expect(q.value.breakdown.z).toBeLessThan(0);
    }
    const breached = fixtureQuote({ ...r.body, level: 85_000_000_000 }, 84_847_000_000n);
    expect(!breached.ok && breached.error.error).toBe('level_already_breached');
    const tooClose = fixtureQuote({ ...r.body, level: 84_800_000_000 }, 84_847_000_000n);
    expect(!tooClose.ok && tooClose.error.error).toBe('prob_too_high');
  });
});

describe('EIP-712 (§4) agrees with the engine test vector', () => {
  const vecPath = path.resolve(__dirname, '../../../engine/tests/vectors/quote_vector.json');
  const vec = JSON.parse(readFileSync(vecPath, 'utf8'));
  it('digest matches and the signature recovers to the vector signer', async () => {
    const d = vec.domain;
    expect(quoteDigest(vec.quote, d.chainId, d.verifyingContract)).toBe(vec.digest);
    const signer = await recoverQuoteSigner(vec.quote, vec.signature as Hex, d.chainId, d.verifyingContract);
    expect(signer).toBe(getAddress(vec.signer));
  });
  it('a different pool (verifyingContract) recovers to someone else', async () => {
    const signer = await recoverQuoteSigner(vec.quote, vec.signature as Hex, vec.domain.chainId, pool);
    expect(signer).not.toBe(getAddress(vec.signer));
  });
});

describe('Buy gate (audit L3): only a verified quote can be bought', () => {
  const signer = '0x2d6154D11190E900B99e1EE164fF0a176b19532c';
  it('blocks while the signature is being checked or the pool signer is unknown', () => {
    expect(buyBlocker({ signerCheck: undefined, poolSigner: signer, premOk: true })).toMatch(/Checking/);
    expect(buyBlocker({ signerCheck: signer, poolSigner: undefined, premOk: true })).toMatch(/Checking/);
  });
  it('blocks a signature that does not recover to the pool signer, with the reason', () => {
    expect(buyBlocker({ signerCheck: null, poolSigner: signer, premOk: true })).toMatch(/does not recover to this pool’s quote signer/);
    expect(buyBlocker({ signerCheck: buyer, poolSigner: signer, premOk: true })).toMatch(/buyCover would revert/);
  });
  it('blocks a premium that does not match the breakdown', () => {
    expect(buyBlocker({ signerCheck: signer.toLowerCase(), poolSigner: signer, premOk: false })).toMatch(/price does not match/);
  });
  it('allows a verified quote (signer match is case-insensitive)', () => {
    expect(buyBlocker({ signerCheck: signer.toLowerCase(), poolSigner: signer, premOk: true })).toBeUndefined();
  });
  it('premiumMatches tolerates one base unit of rounding only', () => {
    const b = { sigma: 0.5, touchProb: 0.01, loading: 0.2, premium: 0, model: 'm', pricedProb: 0.02, fee: 0 };
    const q = { payout: 100_000_000, premium: 2_400_000 } as Parameters<typeof premiumMatches>[0];
    expect(premiumMatches(q, b)).toBe(true);
    expect(premiumMatches({ ...q, premium: 2_400_001 }, b)).toBe(true);
    expect(premiumMatches({ ...q, premium: 2_400_002 }, b)).toBe(false);
    expect(QUOTE_TTL_S).toBe(30);
  });
});
