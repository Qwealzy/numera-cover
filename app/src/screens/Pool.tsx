import { useState } from 'react';
import { coinOf } from '../config';
import { useApp } from '../state';
import { useNow } from '../hooks';
import { exitView, pauseCause, saleWindow } from '../lib/v2';
import { Status, type Cover } from '../lib/pool';
import { SHARE_DECIMALS, fmtBps, fmtDuration, fmtFixed, fmtPx6, fmtRatio, fmtShares, fmtTime, fmtUsdc, parseDecimal } from '../lib/format';
import { approveUsdc, cancelRedeem, claimAssets, claimShares, deposit, readAllowance, readBalance, requestRedeem, waitReadHead, withdraw } from '../lib/tx';
import { depositBlocker, depositFlow } from '../lib/txflow';
import { Addr, MockTag, Notice, Stat, TxLink, TxStatus, useTx } from '../components/ui';
import { Faucet } from '../components/Faucet';
import { useCovers } from '../components/useCovers';

export function Pool() {
  const { pool, poolKind, stats } = useApp();
  const now = useNow(1000);
  const s = stats.data;
  const v2 = s?.v2;
  // v2 sizes covers on the capacity base B (totalAssets minus requested exits, §5.3); v1 on totalAssets
  const base = s ? (v2 ? v2.capacityBase : s.totalAssets) : 0n;
  const util = s && base > 0n ? Number((s.lockedAssets * 10000n) / base) / 100 : 0;
  // the log scan is only needed for "paid" tx links in the recent list
  const { covers, events } = useCovers((list) => list.slice(0, RECENT).some((c) => c.status === Status.Paid));
  const all = covers.data ?? [];
  const sold = all.reduce((a, c) => a + c.premium, 0n);
  const paid = all.filter((c) => c.status === Status.Paid).reduce((a, c) => a + c.payout, 0n);
  const win = v2 ? saleWindow(v2, now) : undefined;
  const cause = s ? pauseCause(s.paused, v2) : 'running';

  return (
    <>
      <div className="page-head">
        <div>
          <p className="kicker">Underwriters</p>
          <h1>
            Underwriter pool {poolKind === 'mock' && <MockTag inline />} {s && <span className="chip">{s.version}</span>}
          </h1>
          <p>
            LPs deposit mUSDC and earn every cover price; payouts come out of the pool. Each cover’s payout is locked when it is sold, so the pool can always
            pay what it owes.{' '}
            {v2
              ? 'Exits are queued: request, wait the withdraw delay, then withdraw inside the withdraw window. A cover price counts for LPs once its cover settles.'
              : 'Only free (unlocked) assets can be withdrawn.'}
          </p>
        </div>
        <span className="small soft">
          {pool.label} · <Addr a={pool.pool} />
        </span>
      </div>

      {stats.error && !s && !stats.busy && <Notice kind="error">Could not read the pool: {stats.error}</Notice>}
      {cause === 'breaker' && v2 && (
        <Notice kind="error">
          Paused by the payout breaker (LossBreakerTripped): {fmtUsdc(v2.paidInWindow)} mUSDC paid in this window, above the{' '}
          {fmtBps(v2.limits.maxPaidPerWindowBps, 0)} cap of {fmtUsdc((v2.paidWindowAssets * BigInt(v2.limits.maxPaidPerWindowBps)) / 10000n)}. New covers and
          deposits are off until the owner unpauses; payouts, payout collection and LP exits still work.
        </Notice>
      )}
      {cause === 'owner' && (
        <Notice>
          The pool is paused{v2 ? ' (by the owner or the guardian)' : ''}: new covers and deposits are off; {v2 ? 'payouts, payout collection and LP exits' : 'withdrawals of free assets'}{' '}
          still work.
        </Notice>
      )}
      <div className="stats">
        <Stat
          label="Total assets"
          value={s ? fmtUsdc(s.totalAssets) : '…'}
          sub={v2 ? 'pool money: mUSDC balance − owed payouts − unearned cover prices' : 'mUSDC held by the pool'}
        />
        <Stat label="Locked for covers" value={s ? fmtUsdc(s.lockedAssets) : '…'} sub="sum of active payouts" />
        <Stat label="Free" value={s ? fmtUsdc(s.freeAssets) : '…'} sub={v2 ? 'what ready exits can take' : 'withdrawable by LPs'} />
        <Stat
          label="Utilization"
          value={s ? fmtRatio(s.lockedAssets, base) : '…'}
          sub={s ? `${v2 ? 'locked ÷ capacity base · ' : ''}max ${fmtBps(s.maxUtilizationBps, 0)}` : ''}
        >
          {s && (
            <div className="bar" aria-hidden>
              <div className="bar__fill" style={{ width: `${Math.min(100, util)}%` }} />
              <div className="bar__tick" style={{ left: `${s.maxUtilizationBps / 100}%` }} />
            </div>
          )}
        </Stat>
        <Stat label="Share price" value={s ? fmtFixed(s.sharePrice, 6, 6) : '…'} sub="mUSDC per pool share (nmUSDC)" />
        <Stat label="Covers sold" value={s ? s.coverCount.toString() : '…'} sub={covers.data ? `cover prices ${fmtUsdc(sold)} · paid ${fmtUsdc(paid)}` : ''} />
        {v2 && (
          <>
            <Stat label="Capacity base" value={fmtUsdc(v2.capacityBase)} sub="total assets − assets of requested exits" />
            <Stat label="Unearned cover price" value={fmtUsdc(v2.unearnedPremium)} sub="cover prices of active covers; pool money once they settle" />
            <Stat label="Owed payouts" value={fmtUsdc(v2.owedAssets)} sub="triggered payouts the token refused; buyers collect them" />
            {win && (
              <Stat
                label="Sale window"
                value={`${fmtUsdc(win.sold)} / ${fmtUsdc(win.cap)}`}
                sub={win.reset ? `window ${fmtDuration(v2.limits.saleWindow)}; the next sale opens a new one` : `sold / cap · resets in ${fmtDuration(win.resetsIn ?? 0)}`}
              >
                <div className="bar" aria-hidden>
                  <div className="bar__fill" style={{ width: `${win.cap > 0n ? Math.min(100, Number((win.sold * 10000n) / win.cap) / 100) : 0}%` }} />
                </div>
              </Stat>
            )}
          </>
        )}
      </div>

      <div className="grid grid--2" style={{ marginTop: 16 }}>
        <div className="stack">
          <RecentCovers covers={covers} events={events.data} count={s?.coverCount} />
          <Limits />
        </div>
        <div className="stack">
          <LpPanel />
          <Faucet />
        </div>
      </div>
    </>
  );
}

function LpPanel() {
  const { account, pool, stats, refreshAll } = useApp();
  const u = stats.data?.user;
  const v2 = stats.data?.v2;
  const [dep, setDep] = useState('');
  const [wd, setWd] = useState('');
  const tx = useTx();

  let depAmt: bigint | undefined, wdAmt: bigint | undefined, depErr: string | undefined, wdErr: string | undefined;
  try {
    if (dep) depAmt = parseDecimal(dep, 6);
  } catch (e) {
    depErr = (e as Error).message;
  }
  try {
    if (wd) wdAmt = parseDecimal(wd, 6);
  } catch (e) {
    wdErr = (e as Error).message;
  }
  if (wdAmt !== undefined && u && wdAmt > u.maxWithdraw) wdErr = `Above the max withdrawable ${fmtUsdc(u.maxWithdraw)} (your share, limited to free assets).`;
  // Why Deposit is disabled (amount, balance, paused, a pending tx); the flow re-checks the balance fresh.
  const depBlock = depositBlocker({ input: dep, amount: depAmt, parseError: depErr, balance: u?.usdc, paused: stats.data?.paused, busy: tx.busy });

  /** One click: at most one approve (receipt trusted, never re-approved on a stale read) and one deposit. */
  async function doDeposit() {
    if (!account || !depAmt || depBlock) return;
    const amount = depAmt;
    const ok = await tx.flow('Deposit', (step) =>
      depositFlow({
        amount,
        waitHead: (min) => waitReadHead(min),
        readBalance: () => readBalance(account, pool.usdc),
        readAllowance: () => readAllowance(account, pool.pool, pool.usdc),
        approve: () => step('Approve mUSDC', (h) => approveUsdc(account, pool.pool, amount, h, pool.usdc)),
        deposit: (afterApprove) => step('Deposit', (h) => deposit(account, pool.pool, amount, h, afterApprove)),
      }),
    );
    if (ok) {
      setDep('');
      refreshAll();
    }
  }
  async function doWithdraw() {
    if (!account || !wdAmt) return;
    if (await tx.run('Withdraw', (h) => withdraw(account, pool.pool, wdAmt!, h))) {
      setWd('');
      refreshAll();
    }
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <h2>Your LP position</h2>
        <span className="meta">ERC-4626 · shares have 12 decimals</span>
      </div>
      {!account ? (
        <p className="soft small">Connect a wallet to deposit or withdraw.</p>
      ) : (
        <>
          <dl className="kv">
            <div>
              <dt>Shares</dt>
              <dd>{u ? fmtShares(u.shares) : '…'}</dd>
            </div>
            <div>
              <dt>Value (convertToAssets)</dt>
              <dd>{u ? fmtUsdc(u.assets) : '…'} mUSDC</dd>
            </div>
            <div>
              <dt>{v2 ? 'Withdrawable now (maxWithdraw)' : 'Max withdraw now (maxWithdraw)'}</dt>
              <dd>{u ? fmtUsdc(u.maxWithdraw) : '…'} mUSDC</dd>
            </div>
            <div>
              <dt>Wallet mUSDC</dt>
              <dd>{u ? fmtUsdc(u.usdc) : '…'}</dd>
            </div>
          </dl>
          <div className="row" style={{ marginTop: 14 }}>
            <div className="field">
              <label htmlFor="dep">Deposit (mUSDC)</label>
              <input id="dep" type="text" inputMode="decimal" value={dep} onChange={(e) => setDep(e.target.value)} placeholder="100" />
            </div>
            <button className="btn btn--primary" disabled={!!depBlock} title={depBlock ?? ''} onClick={doDeposit}>
              Deposit
            </button>
          </div>
          {depBlock && dep.trim() !== '' && (
            <p className="small soft" role="status">
              {depBlock}
            </p>
          )}
          {v2 ? (
            <ExitPanel tx={tx} />
          ) : (
            <>
              <div className="row" style={{ marginTop: 10 }}>
                <div className="field">
                  <label htmlFor="wd">Withdraw (mUSDC)</label>
                  <div className="input-suffix">
                    <input id="wd" type="text" inputMode="decimal" value={wd} onChange={(e) => setWd(e.target.value)} placeholder="0" />
                    {u && (
                      <button className="btn btn--small suffix" onClick={() => setWd(fmtFixed(u.maxWithdraw, 6, 6, false))}>
                        max
                      </button>
                    )}
                  </div>
                </div>
                <button className="btn" disabled={!wdAmt || !!wdErr || tx.busy} onClick={doWithdraw}>
                  Withdraw
                </button>
              </div>
              {wdErr && <p className="small soft">{wdErr}</p>}
            </>
          )}
          <div style={{ marginTop: 10 }}>
            <TxStatus st={tx.st} />
          </div>
        </>
      )}
    </section>
  );
}

/**
 * v2 LP exit (ARCHITECTURE §5.4): request -> pending countdown -> claimable window -> claim (all or part) ->
 * lapsed -> re-queue; cancel at any time. State from redeemRequestOf, recomputed every second (lib/v2.exitView).
 * Shares the LP panel's tx guard: while a deposit, request, claim or cancel is open in the wallet, every LP
 * button is disabled and a second click is dropped.
 */
function ExitPanel({ tx }: { tx: ReturnType<typeof useTx> }) {
  const { account, pool, stats, refreshAll } = useApp();
  const now = useNow(1000);
  const s = stats.data;
  const u = s?.user;
  const v2 = s?.v2;
  const req = u?.v2?.request;
  const view = exitView(req, now, u?.v2?.maxRedeem ?? 0n, u?.shares ?? 0n);
  const [amt, setAmt] = useState('');
  const [claim, setClaim] = useState('');
  if (!account || !u || !v2) return null;

  let reqShares: bigint | undefined, reqErr: string | undefined;
  try {
    if (amt) reqShares = parseDecimal(amt, SHARE_DECIMALS);
  } catch (e) {
    reqErr = (e as Error).message;
  }
  if (reqShares !== undefined && reqShares > u.shares) reqErr = 'More than the shares in your wallet.';
  let claimAmt: bigint | undefined, claimErr: string | undefined;
  try {
    if (claim) claimAmt = parseDecimal(claim, 6);
  } catch (e) {
    claimErr = (e as Error).message;
  }
  const maxW = u.v2?.maxWithdraw ?? 0n;
  if (claimAmt !== undefined && claimAmt > maxW) claimErr = `Above what can be withdrawn now (${fmtUsdc(maxW)} mUSDC, limited to free assets).`;
  const reqValue = s && reqShares ? (reqShares * s.sharePrice) / 10n ** 12n : undefined;
  const slotValue = s ? (view.shares * s.sharePrice) / 10n ** 12n : 0n;

  const done = (ok: unknown) => {
    if (ok) {
      setAmt('');
      setClaim('');
      refreshAll();
    }
  };
  const request = async (shares: bigint) => done(await tx.run(shares === 0n ? 'Re-queue request' : 'Request exit', (h) => requestRedeem(account, pool.pool, shares, h)));
  const cancel = async () => done(await tx.run('Cancel request', (h) => cancelRedeem(account, pool.pool, h)));
  const claimMax = async () => done(await tx.run('Withdraw', (h) => claimShares(account, pool.pool, u.v2!.maxRedeem, h)));
  const claimPart = async () => claimAmt && done(await tx.run('Withdraw', (h) => claimAssets(account, pool.pool, claimAmt!, h)));

  const phaseChip = {
    none: <span className="chip">no request</span>,
    pending: <span className="chip">pending</span>,
    claimable: <span className="chip chip--green">ready</span>,
    lapsed: <span className="chip chip--alert">lapsed</span>,
  }[view.phase];

  return (
    <div style={{ marginTop: 14 }}>
      <div className="panel__head" style={{ padding: 0 }}>
        <h3 className="small">Exit (queued redeem) {phaseChip}</h3>
        <span className="meta">
          delay {fmtDuration(Number(v2.withdrawDelay))} · withdraw window {fmtDuration(Number(v2.claimWindow))}
        </span>
      </div>
      {view.phase !== 'none' && (
        <dl className="kv">
          <div>
            <dt>Requested</dt>
            <dd>
              {fmtShares(view.shares)} shares ≈ {fmtUsdc(slotValue)} mUSDC <span className="faint small">(priced at withdraw time)</span>
            </dd>
          </div>
          {view.phase === 'pending' && (
            <div>
              <dt>Ready to withdraw in</dt>
              <dd className="tnum">
                {fmtDuration(view.secondsLeft)} <span className="faint small">at {fmtTime(view.claimableAt)}</span>
              </dd>
            </div>
          )}
          {view.phase === 'claimable' && (
            <div>
              <dt>Withdraw window closes in</dt>
              <dd className="tnum">
                {fmtDuration(view.secondsLeft)} <span className="faint small">at {fmtTime(view.claimDeadline)}</span>
              </dd>
            </div>
          )}
          {view.phase === 'lapsed' && (
            <div>
              <dt>Withdraw window closed</dt>
              <dd>{fmtTime(view.claimDeadline)}: re-queue to wait the delay again, or cancel to get the shares back.</dd>
            </div>
          )}
        </dl>
      )}
      {view.phase === 'claimable' && (
        <>
          {view.partialOnly && (
            <Notice>
              Free assets cover only part of your request now ({fmtUsdc(maxW)} mUSDC). Withdraw that part; the rest stays ready until the window closes
              while covers settle.
            </Notice>
          )}
          {!view.canClaim && <Notice>Nothing can be withdrawn right now (no free assets, or the slot matured after the last read). It refreshes shortly.</Notice>}
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn btn--primary" disabled={!view.canClaim || tx.busy} onClick={claimMax}>
              Withdraw {view.partialOnly ? 'available' : 'all'} ({fmtUsdc(maxW)} mUSDC)
            </button>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <div className="field">
              <label htmlFor="part">Withdraw part (mUSDC)</label>
              <input id="part" type="text" inputMode="decimal" value={claim} onChange={(e) => setClaim(e.target.value)} placeholder="0" />
            </div>
            <button className="btn" disabled={!claimAmt || !!claimErr || tx.busy} onClick={claimPart}>
              Withdraw part
            </button>
          </div>
          {claimErr && <p className="small soft">{claimErr}</p>}
        </>
      )}
      {(view.phase === 'none' || view.phase === 'pending' || view.phase === 'lapsed') && (
        <div className="row" style={{ marginTop: 10 }}>
          <div className="field">
            <label htmlFor="req">{view.phase === 'none' ? 'Request exit (shares)' : 'Add shares to the request'}</label>
            <div className="input-suffix">
              <input id="req" type="text" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="0" />
              <button className="btn btn--small suffix" onClick={() => setAmt(fmtFixed(u.shares, SHARE_DECIMALS, SHARE_DECIMALS, false))}>
                max
              </button>
            </div>
            {reqValue !== undefined && <span className="hint">≈ {fmtUsdc(reqValue)} mUSDC at today’s share price</span>}
          </div>
          <button className="btn" disabled={!reqShares || !!reqErr || tx.busy || !view.canRequest} onClick={() => reqShares && request(reqShares)}>
            Request
          </button>
        </div>
      )}
      {reqErr && <p className="small soft">{reqErr}</p>}
      {view.phase === 'pending' && amt && <p className="small soft">Adding shares restarts the delay for the whole request.</p>}
      <div className="row" style={{ marginTop: 10 }}>
        {view.canRequeue && (
          <button className="btn btn--primary" disabled={tx.busy} onClick={() => request(0n)}>
            Re-queue request
          </button>
        )}
        {view.canCancel && (
          <button className="btn" disabled={tx.busy} onClick={cancel}>
            Cancel request
          </button>
        )}
      </div>
      <p className="faint small" style={{ marginTop: 8 }}>
        Requested shares keep bearing payouts until withdrawn and no longer back new covers. Requests, withdrawals and cancels work while the pool is paused.
      </p>
    </div>
  );
}

const RECENT = 15;

function RecentCovers({
  covers,
  events,
  count,
}: {
  covers: ReturnType<typeof useCovers>['covers'];
  events: ReturnType<typeof useCovers>['events']['data'];
  count: bigint | undefined;
}) {
  const recent: Cover[] = (covers.data ?? []).slice(0, RECENT);
  return (
    <section className="panel">
      <div className="panel__head">
        <h2>Recent covers</h2>
        <span className="meta">newest first</span>
      </div>
      {count === 0n ? (
        <p className="empty">No covers sold yet.</p>
      ) : !covers.data ? (
        covers.error && !covers.busy ? (
          <Notice kind="error">Could not read covers: {covers.error}</Notice>
        ) : (
          <p className="empty">{covers.busy ? 'RPC busy, retrying…' : 'Loading covers…'}</p>
        )
      ) : (
        <div className="table-wrap">
          <table className="covers">
            <thead>
              <tr>
                <th>#</th>
                <th>Market</th>
                <th>Buyer</th>
                <th className="r">Level</th>
                <th className="r">Price</th>
                <th className="r">Payout</th>
                <th>Status</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((c) => {
                const ev = events?.get(c.id.toString());
                return (
                  <tr key={c.id.toString()}>
                    <td className="mono">{c.id.toString()}</td>
                    <td>
                      {coinOf(c.perpIndex)} <span className="faint small">{c.isLong ? 'long' : 'short'}</span>
                    </td>
                    <td>
                      <Addr a={c.buyer} />
                    </td>
                    <td className="r">{fmtPx6(c.level)}</td>
                    <td className="r">{fmtUsdc(c.premium, 4)}</td>
                    <td className="r">{fmtUsdc(c.payout)}</td>
                    <td>
                      {c.status === Status.Paid ? (
                        ev?.triggered ? (
                          <TxLink hash={ev.triggered.tx} label="paid" />
                        ) : (
                          <span className="chip chip--green">paid</span>
                        )
                      ) : c.status === Status.Expired ? (
                        <span className="chip">expired</span>
                      ) : (
                        <span className="chip chip--green">active</span>
                      )}
                    </td>
                    <td className="small soft started">{fmtTime(c.start).split(/ (.+)/).filter(Boolean).map((part, k) => <div key={k}>{part}</div>)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Limits() {
  const { stats, pool } = useApp();
  const s = stats.data;
  return (
    <section className="panel">
      <div className="panel__head">
        <h2>Pool rules (on-chain)</h2>
        <span className="meta">{s ? `block ${s.block}` : ''}</span>
      </div>
      {!s ? (
        <p className="empty">…</p>
      ) : (
        <dl className="kv">
          <div>
            <dt>Max utilization (locked ÷ {s.v2 ? 'capacity base' : 'total'})</dt>
            <dd>{fmtBps(s.maxUtilizationBps, 0)}</dd>
          </div>
          <div>
            <dt>Max locked on one perp</dt>
            <dd>{fmtBps(s.perPerpCapBps, 0)}</dd>
          </div>
          <div>
            <dt>Max cover duration</dt>
            <dd>{fmtDuration(Number(s.maxDuration))}</dd>
          </div>
          <div>
            <dt>Max oracle move between quote and buy</dt>
            <dd>{fmtBps(s.maxSpotDeviationBps)}</dd>
          </div>
          <div>
            <dt>Min payout</dt>
            <dd>{fmtUsdc(s.minPayout)} mUSDC</dd>
          </div>
          <div>
            <dt>Quote signer (engine key)</dt>
            <dd>
              <Addr a={s.quoteSigner} />
            </dd>
          </div>
          <div>
            <dt>Price source {pool.kind === 'mock' ? '(MOCK)' : '(HyperCore 0x…0807)'}</dt>
            <dd>
              <Addr a={s.priceSource} />
            </dd>
          </div>
          <div>
            <dt>Position source {pool.kind === 'mock' ? '(MOCK)' : '(HyperCore 0x…0800)'}</dt>
            <dd>
              <Addr a={s.positionSource} />
            </dd>
          </div>
          <div>
            <dt>Asset</dt>
            <dd>
              <Addr a={pool.usdc} />
            </dd>
          </div>
          <div>
            <dt>Paused</dt>
            <dd>{s.paused ? (pauseCause(true, s.v2) === 'breaker' ? 'yes, by the payout breaker' : 'yes') : 'no'}</dd>
          </div>
          {s.v2 && (
            <>
              <div>
                <dt>Min price (on-chain floor)</dt>
                <dd>{fmtBps(s.v2.limits.minPremiumBps)} of payout</dd>
              </div>
              <div>
                <dt>Min level distance from the oracle</dt>
                <dd>{fmtBps(s.v2.limits.minLevelDistanceBps)}</dd>
              </div>
              <div>
                <dt>Sale window · max sold per window · one buyer’s share</dt>
                <dd>
                  {fmtDuration(s.v2.limits.saleWindow)} · {fmtBps(s.v2.limits.maxSoldPerWindowBps, 0)} of capacity · {fmtBps(s.v2.limits.maxBuyerWindowShareBps, 0)}
                </dd>
              </div>
              <div>
                <dt>Payout breaker (pauses above, per window)</dt>
                <dd>{fmtBps(s.v2.limits.maxPaidPerWindowBps, 0)} of capacity</dd>
              </div>
              <div>
                <dt>Exit delay · withdraw window · config timelock</dt>
                <dd>
                  {fmtDuration(Number(s.v2.withdrawDelay))} · {fmtDuration(Number(s.v2.claimWindow))} · {fmtDuration(Number(s.v2.configDelay))}
                  {s.v2.strict ? ' (strict)' : ' (testnet, non-strict)'}
                </dd>
              </div>
              <div>
                <dt>Guardian (can pause, never unpause)</dt>
                <dd>{/^0x0+$/.test(s.v2.guardian) ? 'none' : <Addr a={s.v2.guardian} />}</dd>
              </div>
            </>
          )}
          {pool.deployTx && (
            <div>
              <dt>Deployed in</dt>
              <dd>
                <TxLink hash={pool.deployTx} />
              </dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}
