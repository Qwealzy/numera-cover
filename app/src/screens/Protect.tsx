import { useEffect, useMemo, useRef, useState } from 'react';
import { DURATIONS, LEVEL_BUFFER, POLL_MS, USE_QUOTE_FIXTURE, hyperEvmTestnet } from '../config';
import { cached, invalidate } from '../lib/rpc';
import { useApp } from '../state';
import { useNow, usePoll } from '../hooks';
import { capView, loadPositions, type PositionRow } from '../lib/positions';
import { ACCOUNT_MODE_LABEL, defaultLevel, liqExplain } from '../lib/liq';
import { fmtBps, fmtDuration, fmtFixed, fmtPct, fmtProb, fmtPx6, fmtTime, fmtUsdc, px6ToNumber, shortAddr } from '../lib/format';
import {
  buildQuoteRequest,
  buyBlocker,
  engineServesPool,
  expectedPremium,
  fetchHealth,
  floorPremium,
  fixtureQuote,
  premiumMatches,
  recoverQuoteSigner,
  requestQuote,
  type QuoteOk,
} from '../lib/quote';
import { apiErrorMessage } from '../lib/errors';
import { approveUsdc, buyCover, readAllowance, waitReadHead } from '../lib/tx';
import { ensureAllowance } from '../lib/txflow';
import { Addr, MockTag, Notice, TxLink, TxStatus, useTx } from '../components/ui';
import { Faucet } from '../components/Faucet';
import { SubjectBar } from '../components/SubjectBar';

const fmtUsd = (x: number | undefined, dp = 2) =>
  x === undefined || !Number.isFinite(x) ? '—' : '$' + x.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

export function Protect() {
  const { pool, poolKind, subject, market, oracle } = useApp();
  // Aborted only when the user clicks "retry" (a fresh read replaces the pending one).
  const capCtrl = useRef(new AbortController());
  const positions = usePoll(
    () => (subject ? cached(`positions:${pool.pool}:${subject}:${!!market.data}`, 5_000, () => loadPositions(pool, subject, market.data, capCtrl.current.signal)) : Promise.resolve([])),
    [pool.pool, subject, !!market.data],
    POLL_MS,
    !!subject,
  );
  const [selected, setSelected] = useState<string>();
  const rows = positions.data ?? [];
  const sel = rows.find((r) => r.coin === selected);

  useEffect(() => {
    if (!selected && rows.length) {
      const first = rows.find((r) => r.perpIndex !== undefined);
      if (first) setSelected(first.coin);
    }
  }, [rows, selected]);
  useEffect(() => setSelected(undefined), [subject, poolKind]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Protect a position {poolKind === 'mock' && <MockTag inline />}</h1>
          <p>
            Pick a perp position and buy cover that pays a fixed amount if the oracle price touches your level before expiry. The
            position stays open; the payout is cash.
          </p>
        </div>
      </div>
      <SubjectBar />
      <div className="stack" style={{ marginTop: 16 }}>
          <section className="panel">
            <div className="panel__head">
              <h2>{poolKind === 'mock' ? 'Positions in the MOCK position source' : 'Hyperliquid testnet positions'}</h2>
              <span className="meta">
                {poolKind === 'mock' ? (
                  `source ${shortAddr(pool.positionSource)}`
                ) : (
                  <>
                    Info API clearinghouseState
                    {rows[0]?.accountMode && (
                      <>
                        {' · '}
                        <span
                          className="chip"
                          data-testid="account-mode"
                          title={
                            rows[0].accountMode === 'standard'
                              ? 'Perp balance is separate from spot: cross positions are backed by the perp account value'
                              : 'Spot USDC backs cross positions (Info API userAbstraction); liquidation uses the spot USDC total'
                          }
                        >
                          {ACCOUNT_MODE_LABEL[rows[0].accountMode]}
                        </span>
                      </>
                    )}
                  </>
                )}
              </span>
            </div>
            {!subject ? (
              <p className="empty">Connect a wallet or enter an address above to see positions.</p>
            ) : positions.error && !positions.data ? (
              <Notice kind="error">Could not load positions: {positions.error}</Notice>
            ) : !positions.data ? (
              <p className="empty">Loading positions…</p>
            ) : rows.length === 0 ? (
              <p className="empty">
                {poolKind === 'mock'
                  ? 'No MOCK position for this address. The operator sets one in the operator panel.'
                  : 'No open perp positions on Hyperliquid testnet for this address.'}
              </p>
            ) : (
              <PositionsTable
                rows={rows}
                selected={selected}
                onSelect={setSelected}
                oracle={oracle.data}
                onRetry={() => {
                  if (positions.loading) return; // in-flight guard: never two read chains at once
                  capCtrl.current.abort(); // stop a chain still waiting on a rate-limit retry
                  capCtrl.current = new AbortController();
                  invalidate('positions:');
                  positions.reload();
                }}
              />
            )}
          </section>
          <div className="grid grid--2">
            <div className="stack">{sel ? <ProtectPanel key={`${pool.pool}-${sel.coin}-${subject}`} row={sel} /> : <EmptyProtect />}</div>
            <div className="stack">
              {sel && <PositionDetail row={sel} />}
              <Faucet />
            </div>
          </div>
      </div>
    </>
  );
}

function EmptyProtect() {
  return (
    <section className="panel">
      <div className="panel__head">
        <h2>Cover</h2>
      </div>
      <p className="soft small">Select a position to configure cover: level, duration and payout, then get a signed quote.</p>
    </section>
  );
}

/** "Max payout" value: the cap, or "unavailable (retry)" with the read error in the tooltip (never a bare dash). */
function CapValue({ row, onRetry }: { row: PositionRow; onRetry?: () => void }) {
  const v = capView(row, fmtUsdc);
  if (!v.unavailable) return <span title={v.title}>{v.text}</span>;
  return onRetry ? (
    <button type="button" className="linkish cap-unavailable" title={`${v.title?.replace(/\.+$/, '')}. Click to read again.`} onClick={onRetry}>
      {v.text}
    </button>
  ) : (
    <span className="cap-unavailable" title={v.title}>
      {v.text}
    </span>
  );
}

function oraclePxOf(row: PositionRow, oracle: ReturnType<typeof useApp>['oracle']['data']) {
  if (row.perpIndex === undefined) return undefined;
  return oracle?.get(row.perpIndex);
}

function PositionsTable({
  rows,
  selected,
  onSelect,
  oracle,
  onRetry,
}: {
  rows: PositionRow[];
  selected: string | undefined;
  onSelect: (c: string) => void;
  oracle: ReturnType<typeof useApp>['oracle']['data'];
  onRetry: () => void;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Market</th>
            <th>Side</th>
            <th className="r">Size</th>
            <th className="r">Entry</th>
            <th className="r" title="Oracle price from the pool's price source (what trigger() reads)">Oracle</th>
            <th className="r">Liq. price</th>
            <th className="r" title="How far the oracle must move to reach the liquidation price">To liq.</th>
            <th className="r">Lev.</th>
            <th className="r" title="Max payout = entry notional ÷ leverage, from the pool's position source">Max payout</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const o = oraclePxOf(r, oracle);
            const spot = o?.ok ? px6ToNumber(o.px6) : undefined;
            const dist = spot && r.liq.px ? (r.liq.px - spot) / spot : undefined;
            const can = r.perpIndex !== undefined;
            return (
              <tr key={r.coin} className={selected === r.coin ? 'selected' : undefined}>
                <td className="strong">{r.coin}</td>
                <td>{r.side === 1 ? 'Long' : 'Short'}</td>
                <td className="r">{r.size.toLocaleString('en-US', { maximumFractionDigits: r.szDecimals })}</td>
                <td className="r">{fmtUsd(r.entryPx)}</td>
                <td className="r">{o ? (o.ok ? fmtPx6(o.px6) : <span title={o.error}>n/a</span>) : '—'}</td>
                <td className="r">
                  {r.liq.px ? fmtUsd(r.liq.px) : 'none'}{' '}
                  <span className="chip" data-testid="liq-chip" title={liqExplain(r.liq, r.accountMode)}>
                    {r.liq.source === 'api' ? 'api' : r.source === 'mock' ? 'est.' : 'calc'}
                  </span>
                </td>
                <td className="r">{dist !== undefined ? fmtPct(dist, 2) : '—'}</td>
                <td className="r">
                  {r.leverage}×<span className="faint small"> {r.levType}</span>
                </td>
                <td className="r">
                  <CapValue row={r} onRetry={onRetry} />
                </td>
                <td className="r">
                  <button className={`btn btn--small${selected === r.coin ? ' btn--primary' : ''}`} disabled={!can} onClick={() => onSelect(r.coin)} title={can ? '' : 'This perp is not configured for Numera'}>
                    {can ? 'Protect' : 'n/a'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PositionDetail({ row }: { row: PositionRow }) {
  const { oracle } = useApp();
  const o = oraclePxOf(row, oracle.data);
  const inp = row.liq.inputs;
  return (
    <section className="panel">
      <div className="panel__head">
        <h2>
          {row.coin} {row.side === 1 ? 'long' : 'short'} · where the numbers come from
        </h2>
      </div>
      <dl className="kv">
        <div>
          <dt>Oracle, pool price source (perp {row.perpIndex})</dt>
          <dd>{o ? (o.ok ? fmtPx6(o.px6) : o.error) : '—'}</dd>
        </div>
        <div>
          <dt>Oracle, Info API (cross-check)</dt>
          <dd>{fmtUsd(row.infoOraclePx)}</dd>
        </div>
        {row.markPx !== undefined && (
          <div>
            <dt>Mark (liquidations use mark)</dt>
            <dd>{fmtUsd(row.markPx)}</dd>
          </div>
        )}
        <div>
          <dt>Liquidation price ({row.liq.source === 'api' ? 'Info API' : 'computed'})</dt>
          <dd>{row.liq.px ? fmtUsd(row.liq.px) : 'none'}</dd>
        </div>
        {row.onchain && 'szi' in row.onchain && (
          <>
            <div>
              <dt>Position source: szi / entryNtl / leverage</dt>
              <dd className="mono">
                {row.onchain.szi.toString()} / {row.onchain.entryNtl.toString()} / {row.onchain.leverage}
              </dd>
            </div>
            <div>
              <dt>Max payout = entryNtl ÷ leverage</dt>
              <dd>{fmtUsdc(row.onchain.cap)} USDC</dd>
            </div>
          </>
        )}
        {row.onchain && 'error' in row.onchain && (
          <div>
            <dt>Position source</dt>
            <dd>{row.onchain.error}</dd>
          </div>
        )}
      </dl>
      {inp && (
        <details className="how" style={{ marginTop: 10 }}>
          <summary>How the liquidation price is computed</summary>
          <div className="formula">
            {`liq = price − side × margin_available / size / (1 − l × side)
l = 1 / (2 × maxLeverage) = 1 / ${2 * inp.maxLeverage}
price (mark) = ${inp.price}
side = ${inp.side}, size = ${inp.size}
margin_available = ${row.liq.marginNote ?? ''}
                 = ${inp.marginAvailable.toFixed(6)}
liq = ${row.liq.px?.toFixed(2) ?? 'none'}`}
          </div>
          {row.liq.caveat && (
            <p className="faint small" style={{ marginTop: 6 }}>
              Note: {row.liq.caveat}.
            </p>
          )}
          <p className="faint small" style={{ marginTop: 6 }}>
            Hyperliquid docs, trading/liquidations{row.liq.formula === 'unified-cross' ? ' and trading/account-abstraction-modes (unified account ratio)' : ''}. First margin
            tier assumed.
          </p>
        </details>
      )}
      {row.source === 'mock' && (
        <p className="faint small" style={{ marginTop: 8 }}>
          MOCK positions carry no account data; the liquidation price is an isolated-margin estimate at entry.
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- the protect panel

function ProtectPanel({ row }: { row: PositionRow }) {
  const { pool, poolKind, account, subject, oracle, stats, refreshAll } = useApp();
  const now = useNow(1000);
  const o = oraclePxOf(row, oracle.data);
  const spotPx6 = o?.ok ? o.px6 : undefined;
  const spot = spotPx6 !== undefined ? px6ToNumber(spotPx6) : undefined;
  const isLong = row.side === 1;

  const initialLevel = useMemo(() => {
    if (spot === undefined) return '';
    const d = row.liq.px ? defaultLevel(row.liq.px, spot, row.side, LEVEL_BUFFER) : null;
    const lvl = d ?? spot * (isLong ? 0.95 : 1.05);
    return lvl.toFixed(lvl >= 100 ? 1 : 4);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spot === undefined, row.coin]);
  const [level, setLevel] = useState(initialLevel);
  useEffect(() => {
    if (!level && initialLevel) setLevel(initialLevel);
  }, [initialLevel, level]);

  const [durationSec, setDurationSec] = useState(86400);
  const [payout, setPayout] = useState(row.cap !== undefined ? fmtFixed(row.cap, 6, 2, false) : '');
  // The cap can arrive on a later poll (first read rate-limited): prefill then, unless the user typed.
  useEffect(() => {
    if (row.cap !== undefined) setPayout((p) => (p === '' ? fmtFixed(row.cap!, 6, 2, false) : p));
  }, [row.cap]);
  const [quote, setQuote] = useState<QuoteOk>();
  const [quoteErr, setQuoteErr] = useState<string>();
  const [quoting, setQuoting] = useState(false);
  const [signerCheck, setSignerCheck] = useState<string | null>();
  const [allowance, setAllowance] = useState<bigint>();
  const [boughtId, setBoughtId] = useState<bigint>();
  const approveTx = useTx();
  const buyTx = useTx();
  /** Allowance set by an approve mined in this view and not yet spent by a purchase (receipt-trusted). */
  const approvedRef = useRef<{ key: string; amount: bigint }>({ key: '', amount: 0n });
  const approveKey = `${account ?? ''}:${pool.pool}`.toLowerCase();
  const approvedNow = () => (approvedRef.current.key === approveKey ? approvedRef.current.amount : 0n);

  const health = usePoll((s) => fetchHealth(pool.engineUrl, s), [pool.engineUrl], 0, !USE_QUOTE_FIXTURE);

  // Without a wallet, quote for the viewed address: a price preview anyone can see; only that wallet can buy.
  const buyer = account ?? subject;
  const built = buildQuoteRequest({
    buyer,
    perpIndex: row.perpIndex ?? 0,
    isLong,
    level,
    payout,
    durationSec,
    pool: pool.pool,
    spotPx6,
    capUsdc: row.cap,
  });
  const levelNum = Number(level.replace(/,/g, ''));
  const levelDist = spot && levelNum > 0 ? (levelNum - spot) / spot : undefined;
  const levelVsLiq = row.liq.px && levelNum > 0 ? (isLong ? levelNum - row.liq.px : row.liq.px - levelNum) : undefined;

  // inputs changed → quote is stale
  useEffect(() => {
    setQuote(undefined);
    setQuoteErr(undefined);
    setBoughtId(undefined);
    approveTx.reset();
    buyTx.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, payout, durationSec]);

  async function getQuote() {
    if (!built.ok) return;
    setQuoting(true);
    setQuoteErr(undefined);
    setQuote(undefined);
    setSignerCheck(undefined);
    setBoughtId(undefined);
    approveTx.reset();
    buyTx.reset();
    try {
      const res = USE_QUOTE_FIXTURE ? fixtureQuote(built.body, spotPx6 ?? 0n, undefined, row.coin) : await requestQuote(pool.engineUrl, built.body);
      if (!res.ok) {
        setQuoteErr(apiErrorMessage(res.error.error, res.error.reason));
        return;
      }
      setQuote(res.value);
      const signer = await recoverQuoteSigner(res.value.quote, res.value.signature, hyperEvmTestnet.id, pool.pool);
      setSignerCheck(signer ?? null);
      if (account) {
        await waitReadHead();
        const read = await readAllowance(account, pool.pool, pool.usdc);
        // an approve mined in this view and not yet spent counts even if the read RPC still lags behind it
        const mine = approvedNow();
        setAllowance(read > mine ? read : mine);
      }
    } finally {
      setQuoting(false);
    }
  }

  const premium = quote ? BigInt(quote.quote.premium) : undefined;
  const canBuy = !!account && !!quote && account.toLowerCase() === quote.quote.buyer.toLowerCase();
  const needsApprove = premium !== undefined && allowance !== undefined && allowance < premium;
  const secondsLeft = quote ? quote.quote.deadline - now : 0;
  const expired = quote ? secondsLeft <= 0 : false;
  const poolSigner = stats.data?.quoteSigner;
  const signerOk = signerCheck && poolSigner && signerCheck.toLowerCase() === poolSigner.toLowerCase();
  const balance = stats.data?.user?.usdc;
  const lowBalance = premium !== undefined && balance !== undefined && balance < premium;

  /**
   * At most one approve per click; the mined receipt is trusted (the allowance is set to the premium, not
   * re-read: a lagging read would show 0 and invite a second approve). A fresh read first skips the approve
   * when an earlier one already covers the premium.
   */
  async function approve() {
    if (!account || premium === undefined) return;
    const r = await approveTx.flow('Approve mUSDC', (step) =>
      ensureAllowance(premium, {
        readAllowance: async () => (await waitReadHead(), readAllowance(account, pool.pool, pool.usdc)),
        approve: () => step('Approve mUSDC', (h) => approveUsdc(account, pool.pool, premium, h, pool.usdc)),
      }),
    );
    if (r) {
      if (r.approved) approvedRef.current = { key: approveKey, amount: premium };
      setAllowance((a) => (a !== undefined && a > premium ? a : premium));
    }
  }
  async function buy() {
    if (!account || !quote) return;
    const afterApprove = approvedNow() > 0n;
    const r = await buyTx.run('Buy cover', (h) => buyCover(account, pool.pool, quote.quote, quote.signature, h, afterApprove));
    if (r) {
      approvedRef.current = { key: '', amount: 0n }; // the purchase spent it
      setBoughtId(r.coverId);
      refreshAll();
    }
  }

  const b = quote?.breakdown;
  const minPremiumBps = stats.data?.v2?.limits.minPremiumBps;
  const premOk = quote && b ? premiumMatches(quote.quote, b, minPremiumBps) : false;
  // audit L3: never send a quote the app could not verify (signature -> pool signer, premium -> breakdown)
  const blocked = quote ? buyBlocker({ signerCheck, poolSigner, premOk }) : undefined;

  return (
    <section className="panel">
      <div className="panel__head">
        <h2>
          Cover {row.coin} {isLong ? 'long' : 'short'} {poolKind === 'mock' && <MockTag inline />}
        </h2>
        <span className="meta">perp {row.perpIndex}</span>
      </div>

      <div className="stack" style={{ gap: 12 }}>
        <div className="field">
          <label htmlFor="lvl">Trigger level (oracle {isLong ? '≤' : '≥'} level pays)</label>
          <input id="lvl" type="text" inputMode="decimal" value={level} onChange={(e) => setLevel(e.target.value)} />
          <span className="hint">
            {levelDist !== undefined ? `${fmtPct(levelDist)} from oracle` : 'oracle unavailable'}
            {row.liq.px ? ` · liq. ${fmtUsd(row.liq.px)}` : ''}
            {levelVsLiq !== undefined && levelVsLiq < 0 ? ' · beyond your liquidation price' : ''}
            {row.liq.px && spot ? (
              <>
                {' · '}
                <button
                  className="btn btn--small"
                  style={{ padding: '0 6px' }}
                  onClick={() => {
                    const d = defaultLevel(row.liq.px!, spot, row.side, LEVEL_BUFFER);
                    if (d) setLevel(d.toFixed(d >= 100 ? 1 : 4));
                  }}
                >
                  reset to liq. + {LEVEL_BUFFER * 100}%
                </button>
              </>
            ) : null}
          </span>
        </div>
        <div className="field">
          <span className="label">Duration</span>
          <div className="seg" role="group" aria-label="Duration">
            {DURATIONS.map((d) => (
              <button key={d.sec} aria-pressed={durationSec === d.sec} onClick={() => setDurationSec(d.sec)}>
                {d.label}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label htmlFor="pay">Payout (mUSDC)</label>
          <div className="input-suffix">
            <input id="pay" type="text" inputMode="decimal" value={payout} onChange={(e) => setPayout(e.target.value)} />
            {row.cap !== undefined && (
              <button className="btn btn--small suffix" onClick={() => setPayout(fmtFixed(row.cap!, 6, 2, false))}>
                max
              </button>
            )}
          </div>
          <span className="hint">
            Cap <CapValue row={row} /> = entry notional ÷ leverage (the margin you would lose).
          </span>
        </div>

        {!built.ok && buyer && <p className="small soft">{built.error}</p>}
        {!account && (
          <p className="small soft">Read-only: you can get a price preview for the viewed address; buying needs that wallet connected (quotes are signed for the buyer).</p>
        )}
        <button className="btn btn--primary" disabled={!built.ok || quoting || row.perpIndex === undefined} onClick={getQuote}>
          {quoting ? 'Pricing…' : quote ? 'Re-quote' : 'Get quote'}
        </button>
        {USE_QUOTE_FIXTURE && <p className="faint small">Quote FIXTURE mode: numbers are illustrative and the signature is fake; buying will fail.</p>}
        {quoteErr && <Notice kind="error">{quoteErr}</Notice>}
      </div>

      {quote && b && (
        <div style={{ marginTop: 14 }}>
          <dl className="kv">
            <div>
              <dt>
                Oracle the engine priced against (spotRef)
                {b.spotSource && <span className="faint"> · {b.spotSource === 'pool' ? 'read from this pool’s price source' : 'Info API fallback'}</span>}
              </dt>
              <dd>{fmtPx6(BigInt(quote.quote.spotRef))}</dd>
            </div>
            <div>
              <dt>Level · distance</dt>
              <dd>
                {fmtPx6(BigInt(quote.quote.level))} · {fmtPct(quote.quote.level / quote.quote.spotRef - 1)}
              </dd>
            </div>
            <div>
              <dt>Volatility σ (annualized, EWMA 1h, 30d floor)</dt>
              <dd>{fmtPct(b.sigma, 1)}</dd>
            </div>
            {b.z !== undefined && Number.isFinite(b.z) && (
              <div>
                <dt>Distance in σ, z = ln(L/S) ÷ σ√T</dt>
                <dd>{b.z.toFixed(2)} σ</dd>
              </div>
            )}
            <div>
              <dt>Model touch probability p ({b.model})</dt>
              <dd>{fmtProb(b.touchProb)}</dd>
            </div>
            {b.tailMultiplier !== undefined && (
              <div>
                <dt>Tail multiplier k · empirical floor q</dt>
                <dd>
                  ×{b.tailMultiplier.toFixed(2)} · {fmtProb(b.tailFloor ?? 0)}
                </dd>
              </div>
            )}
            <div>
              <dt>Priced probability max(p·k, q)</dt>
              <dd>{fmtProb(b.pricedProb ?? b.touchProb)}</dd>
            </div>
            <div>
              <dt>Loading θ</dt>
              <dd>{fmtPct(b.loading, 0)}</dd>
            </div>
            <div>
              <dt>Fee</dt>
              <dd>{fmtUsdc(BigInt(b.fee ?? 0))}</dd>
            </div>
            <div>
              <dt>Payout if triggered</dt>
              <dd>{fmtUsdc(BigInt(quote.quote.payout))} mUSDC</dd>
            </div>
            {b.floorApplied !== undefined && (
              <div>
                <dt>On-chain premium floor{minPremiumBps !== undefined ? ` (${fmtBps(minPremiumBps)} of payout)` : ''}</dt>
                <dd>
                  {b.floorApplied ? (
                    <>
                      <span className="chip chip--alert">applied</span> model premium {fmtUsdc(BigInt(expectedPremium(quote.quote.payout, b)), 6)} raised to the floor
                    </>
                  ) : (
                    'not needed (model premium is above it)'
                  )}
                </dd>
              </div>
            )}
            <div className="total">
              <dt>Premium</dt>
              <dd>
                {fmtUsdc(BigInt(quote.quote.premium), 6)} mUSDC
                <div className="small soft">{fmtPct(quote.quote.premium / quote.quote.payout, 2)} of payout</div>
              </dd>
            </div>
          </dl>
          <details className="how" style={{ marginTop: 8 }}>
            <summary>Check the arithmetic and the signature</summary>
            <div className="formula">
              {`premium = ceil(payout × max(p·k, q) × (1 + θ)) + fee
        = ceil(${quote.quote.payout} × ${(b.pricedProb ?? b.touchProb).toPrecision(6)} × ${1 + b.loading}) + ${b.fee ?? 0}
        = ${expectedPremium(quote.quote.payout, b)}  (engine: ${quote.quote.premium}) ${b.floorApplied ? '' : premOk ? '✓' : '✗ mismatch'}${
          b.floorApplied
            ? `
floor   = ceil(payout × minPremiumBps / 10000) = ceil(${quote.quote.payout} × ${minPremiumBps ?? '…'} / 10000) = ${minPremiumBps !== undefined ? floorPremium(quote.quote.payout, minPremiumBps) : '…'}  (engine: ${quote.quote.premium}) ${premOk ? '✓' : '✗ mismatch'}`
            : ''
        }
signer  = ${signerCheck ?? 'unrecoverable'}
pool.quoteSigner = ${poolSigner ?? '…'} ${signerOk ? '✓' : '✗'}
nonce   = ${quote.quote.nonce}`}
            </div>
          </details>
          {!signerOk && signerCheck !== undefined && !USE_QUOTE_FIXTURE && (
            <Notice kind="error">
              This quote’s signature does not recover to this pool’s quote signer ({poolSigner ? shortAddr(poolSigner) : '…'}) for pool{' '}
              {shortAddr(pool.pool)}, so buyCover would revert with InvalidSignature. The engine at {pool.engineUrl} likely signs for another pool
              {health.data ? <> (it serves {[health.data.pool, ...(health.data.pools ?? [])].filter((x, i, a) => a.indexOf(x) === i).map(shortAddr).join(', ')})</> : ''}.
            </Notice>
          )}
          <p className="semantics">
            Pays {fmtUsdc(BigInt(quote.quote.payout))} mUSDC if a <span className="mono">trigger()</span> call before {fmtTime(quote.quote.expiry)} sees the{' '}
            {row.coin} <strong>oracle</strong> price {isLong ? 'at or below' : 'at or above'} {fmtPx6(BigInt(quote.quote.level))}. Liquidation uses the mark
            price, so the level sits a little before your liquidation price; a sub-second wick between keeper checks (~1 s) can be missed. Anyone can call
            trigger.
          </p>

          <div className="steps">
            <div className="step">
              <span>
                <span className="step__n">1</span>Approve {fmtUsdc(premium!, 6)} mUSDC
              </span>
              {needsApprove ? (
                <button className="btn btn--small btn--primary" disabled={approveTx.busy || expired || !canBuy || !!blocked} title={blocked ?? ''} onClick={approve}>
                  Approve
                </button>
              ) : (
                <span className={`chip${canBuy ? ' chip--green' : ''}`}>{!canBuy ? 'wallet needed' : allowance === undefined ? '…' : 'approved'}</span>
              )}
            </div>
            <div className="step">
              <span>
                <span className="step__n">2</span>Buy cover · quote valid {expired ? '' : 'for '}
                <span className="tnum">{expired ? 'expired' : fmtDuration(secondsLeft)}</span>
              </span>
              <button
                className="btn btn--small btn--primary"
                disabled={needsApprove || allowance === undefined || buyTx.busy || expired || !!boughtId || !canBuy || !!blocked}
                title={blocked ?? ''}
                onClick={buy}
              >
                Buy cover
              </button>
            </div>
          </div>
          {blocked && !boughtId && (
            <p className="small soft" role="status">
              {blocked}
            </p>
          )}
          {lowBalance && <Notice>Your mUSDC balance ({fmtUsdc(balance!)}) is below the premium. Use the faucet below.</Notice>}
          {expired && !boughtId && <Notice>The quote expired (deadline {fmtTime(quote.quote.deadline)}). Re-quote to get a fresh price.</Notice>}
          <div style={{ marginTop: 10 }}>
            <TxStatus st={approveTx.st} />
            <TxStatus st={buyTx.st} />
          </div>
          {boughtId !== undefined && (
            <Notice kind="ok">
              <span className="mark" aria-hidden />
              Cover #{boughtId.toString()} is active. Watch it under <a href="#/covers">My covers</a>.{' '}
              {buyTx.st.hash && <TxLink hash={buyTx.st.hash} label="Purchase tx" />}
            </Notice>
          )}
        </div>
      )}

      <p className="faint small" style={{ marginTop: 12 }}>
        Engine {USE_QUOTE_FIXTURE ? 'FIXTURE (local)' : pool.engineUrl}
        {health.data && (
          <>
            {' '}
            · env {health.data.env} · chain {health.data.chainId} · signer <Addr a={health.data.signer ?? ''} />
            {engineServesPool(health.data, pool.pool) ? ' · serves this pool' : <strong> · does not serve this pool</strong>}
          </>
        )}
        {health.error && !USE_QUOTE_FIXTURE && <> · unreachable ({health.error})</>}
      </p>
    </section>
  );
}
