import { useState } from 'react';
import { coinOf, USDC } from '../config';
import { useApp } from '../state';
import { Status, type Cover } from '../lib/pool';
import { fmtBps, fmtDuration, fmtFixed, fmtPx6, fmtRatio, fmtShares, fmtTime, fmtUsdc, parseDecimal } from '../lib/format';
import { approveUsdc, deposit, readAllowance, withdraw } from '../lib/tx';
import { Addr, MockTag, Notice, Stat, TxLink, TxStatus, useTx } from '../components/ui';
import { Faucet } from '../components/Faucet';
import { useCovers } from '../components/useCovers';

export function Pool() {
  const { pool, poolKind, stats } = useApp();
  const s = stats.data;
  const util = s && s.totalAssets > 0n ? Number((s.lockedAssets * 10000n) / s.totalAssets) / 100 : 0;
  // the log scan is only needed for "paid" tx links in the recent list
  const { covers, events } = useCovers((list) => list.slice(0, RECENT).some((c) => c.status === Status.Paid));
  const all = covers.data ?? [];
  const sold = all.reduce((a, c) => a + c.premium, 0n);
  const paid = all.filter((c) => c.status === Status.Paid).reduce((a, c) => a + c.payout, 0n);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Underwriter pool {poolKind === 'mock' && <MockTag inline />}</h1>
          <p>
            LPs deposit mUSDC and earn every premium; payouts come out of the pool. Each cover’s payout is locked when it is sold, so the pool can always
            pay what it owes. Only free (unlocked) assets can be withdrawn.
          </p>
        </div>
        <span className="small soft">
          {pool.label} · <Addr a={pool.pool} />
        </span>
      </div>

      {stats.error && !s && !stats.busy && <Notice kind="error">Could not read the pool: {stats.error}</Notice>}
      <div className="stats">
        <Stat label="Total assets" value={s ? fmtUsdc(s.totalAssets) : '…'} sub="mUSDC held by the pool" />
        <Stat label="Locked for covers" value={s ? fmtUsdc(s.lockedAssets) : '…'} sub="sum of active payouts" />
        <Stat label="Free" value={s ? fmtUsdc(s.freeAssets) : '…'} sub="withdrawable by LPs" />
        <Stat label="Utilization" value={s ? fmtRatio(s.lockedAssets, s.totalAssets) : '…'} sub={s ? `max ${fmtBps(s.maxUtilizationBps, 0)}` : ''}>
          {s && (
            <div className="bar" aria-hidden>
              <div className="bar__fill" style={{ width: `${Math.min(100, util)}%` }} />
              <div className="bar__tick" style={{ left: `${s.maxUtilizationBps / 100}%` }} />
            </div>
          )}
        </Stat>
        <Stat label="Share price" value={s ? fmtFixed(s.sharePrice, 6, 6) : '…'} sub="mUSDC per pool share (nmUSDC)" />
        <Stat label="Covers sold" value={s ? s.coverCount.toString() : '…'} sub={covers.data ? `premiums ${fmtUsdc(sold)} · paid ${fmtUsdc(paid)}` : ''} />
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
  if (depAmt !== undefined && u && depAmt > u.usdc) depErr = 'More than your mUSDC balance.';
  if (wdAmt !== undefined && u && wdAmt > u.maxWithdraw) wdErr = `Above the max withdrawable ${fmtUsdc(u.maxWithdraw)} (your share, limited to free assets).`;

  async function doDeposit() {
    if (!account || !depAmt) return;
    const allowance = await readAllowance(account, pool.pool);
    if (allowance < depAmt) {
      const ok = await tx.run('Approve mUSDC', (h) => approveUsdc(account, pool.pool, depAmt!, h));
      if (!ok) return;
    }
    if (await tx.run('Deposit', (h) => deposit(account, pool.pool, depAmt!, h))) {
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
              <dt>Max withdraw now (maxWithdraw)</dt>
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
            <button className="btn btn--primary" disabled={!depAmt || !!depErr || tx.busy || stats.data?.paused} onClick={doDeposit}>
              Deposit
            </button>
          </div>
          {depErr && <p className="small soft">{depErr}</p>}
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
          {stats.data?.paused && <Notice>The pool is paused: deposits and new covers are off; withdrawals of free assets still work.</Notice>}
          <div style={{ marginTop: 10 }}>
            <TxStatus st={tx.st} />
          </div>
        </>
      )}
    </section>
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
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Market</th>
                <th>Buyer</th>
                <th className="r">Level</th>
                <th className="r">Premium</th>
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
                    <td className="small soft">{fmtTime(c.start)}</td>
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
            <dt>Max utilization (locked ÷ total)</dt>
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
              <Addr a={USDC} />
            </dd>
          </div>
          <div>
            <dt>Paused</dt>
            <dd>{s.paused ? 'yes' : 'no'}</dd>
          </div>
          <div>
            <dt>Deployed in</dt>
            <dd>
              <TxLink hash={pool.deployTx} />
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}
