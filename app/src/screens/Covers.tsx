import { useState } from 'react';
import { coinOf } from '../config';
import { useApp } from '../state';
import { useNow } from '../hooks';
import { Status, type Cover, type CoverEvents } from '../lib/pool';
import { fmtDuration, fmtPct, fmtPx6, fmtTime, fmtUsdc } from '../lib/format';
import { expireCover, triggerCover } from '../lib/tx';
import { Addr, MockTag, Notice, TxLink, TxStatus, useTx } from '../components/ui';
import { SubjectBar } from '../components/SubjectBar';
import { useCovers, usePurchaseTx } from '../components/useCovers';

export function Covers() {
  const { poolKind, subject, oracle, pool } = useApp();
  const { covers, events } = useCovers();
  const [all, setAll] = useState(false);
  const list = (covers.data ?? []).filter((c) => all || (subject && c.buyer.toLowerCase() === subject.toLowerCase()));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>My covers {poolKind === 'mock' && <MockTag inline />}</h1>
          <p>
            Each cover is a record on the pool: level, payout, expiry. When the oracle crosses the level before expiry, anyone can call trigger and the
            payout goes to the buyer in the same transaction. The keeper does this automatically; the button is here so you never depend on it.
          </p>
        </div>
        <div className="seg" role="group" aria-label="Filter">
          <button aria-pressed={!all} onClick={() => setAll(false)}>
            Mine
          </button>
          <button aria-pressed={all} onClick={() => setAll(true)}>
            All in pool
          </button>
        </div>
      </div>
      {!all && <SubjectBar />}
      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel__head">
          <h2>{all ? 'All covers' : 'Covers bought by this address'}</h2>
          <span className="meta">
            pool <Addr a={pool.pool} /> · oracle refresh 3 s
          </span>
        </div>
        {covers.error && !covers.data && <Notice kind="error">Could not read covers: {covers.error}</Notice>}
        {!covers.data ? (
          <p className="empty">Loading covers…</p>
        ) : list.length === 0 ? (
          <p className="empty">{!all && !subject ? 'Connect a wallet or enter an address.' : 'No covers yet.'}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Market</th>
                  <th className="r">Level</th>
                  <th className="r">Oracle now</th>
                  <th className="r" title="Oracle distance to the level (negative = breached for a long)">To level</th>
                  <th className="r">Payout</th>
                  <th className="r">Premium</th>
                  <th>Status</th>
                  <th className="r">Time left</th>
                  <th>Action</th>
                  <th>Tx</th>
                </tr>
              </thead>
              <tbody>
                {list.map((c) => (
                  <CoverRow key={c.id.toString()} c={c} ev={events.data?.get(c.id.toString())} oraclePx={oracle.data?.get(c.perpIndex)} findTx={!all} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="faint small" style={{ marginTop: 10 }}>
          Status and amounts come from <span className="mono">getCover(id)</span>; tx links from <span className="mono">CoverPurchased / CoverTriggered /
          CoverExpired</span> events (the testnet RPC serves logs in 1000-block windows, so older events are located from the cover’s start time).
        </p>
      </section>
    </>
  );
}

function CoverRow({
  c,
  ev,
  oraclePx,
  findTx,
}: {
  c: Cover;
  ev: CoverEvents | undefined;
  oraclePx: { ok: true; px6: bigint } | { ok: false; error: string } | undefined;
  findTx: boolean;
}) {
  const { account, pool, refreshAll } = useApp();
  const now = useNow(1000);
  const tx = useTx();
  const purchase = usePurchaseTx(pool.pool, c, ev?.purchased, findTx);
  const px = oraclePx?.ok ? oraclePx.px6 : undefined;
  const breached = px !== undefined && (c.isLong ? px <= c.level : px >= c.level);
  const left = Number(c.expiry) - now;
  const active = c.status === Status.Active;
  const canTrigger = active && breached && left >= 0;
  const canExpire = active && left < 0;
  const dist = px !== undefined ? Number(px - c.level) / Number(px) : undefined;

  let status: React.ReactNode;
  if (c.status === Status.Paid) status = <span className="chip chip--green">Paid</span>;
  else if (c.status === Status.Expired) status = <span className="chip">Expired</span>;
  else if (canTrigger)
    status = (
      <span className="chip chip--alert">
        <span className="mark mark--ring" style={{ width: 8, height: 8, borderWidth: 2 }} aria-hidden />
        Breached
      </span>
    );
  else if (canExpire) status = <span className="chip">Ended</span>;
  else status = <span className="chip chip--green">Active</span>;

  return (
    <>
      <tr className={canTrigger ? 'breached' : undefined}>
        <td className="mono">{c.id.toString()}</td>
        <td>
          {coinOf(c.perpIndex)} <span className="faint small">{c.isLong ? 'long' : 'short'}</span>
        </td>
        <td className="r">
          {c.isLong ? '≤ ' : '≥ '}
          {fmtPx6(c.level)}
        </td>
        <td className="r">{px !== undefined ? fmtPx6(px) : oraclePx && !oraclePx.ok ? <span title={oraclePx.error}>n/a</span> : '—'}</td>
        <td className="r">{active && dist !== undefined ? fmtPct(c.isLong ? dist : -dist) : '—'}</td>
        <td className="r">{fmtUsdc(c.payout)}</td>
        <td className="r">{fmtUsdc(c.premium, 4)}</td>
        <td>{status}</td>
        <td className="r" title={`ends ${fmtTime(c.expiry)}`}>
          {active ? fmtDuration(left) : '—'}
        </td>
        <td>
          {canTrigger && (
            <button
              className="btn btn--small btn--primary"
              disabled={!account || tx.busy}
              title={account ? 'Permissionless: anyone can trigger a breached cover' : 'Connect a wallet to send the transaction'}
              onClick={async () => account && (await tx.run(`Trigger #${c.id}`, (h) => triggerCover(account, pool.pool, c.id, h))) && refreshAll()}
            >
              Trigger
            </button>
          )}
          {canExpire && (
            <button
              className="btn btn--small"
              disabled={!account || tx.busy}
              onClick={async () => account && (await tx.run(`Expire #${c.id}`, (h) => expireCover(account, pool.pool, c.id, h))) && refreshAll()}
            >
              Expire
            </button>
          )}
        </td>
        <td className="small">
          {purchase ? <TxLink hash={purchase.tx} label="buy" /> : <span className="faint">buy</span>}
          {ev?.triggered && (
            <>
              {' · '}
              <TxLink hash={ev.triggered.tx} label={`paid @ ${fmtPx6(ev.triggered.oraclePx)}`} />
            </>
          )}
          {ev?.expired && (
            <>
              {' · '}
              <TxLink hash={ev.expired.tx} label="expired" />
            </>
          )}
        </td>
      </tr>
      {tx.st.phase !== 'idle' && (
        <tr>
          <td colSpan={11} style={{ whiteSpace: 'normal' }}>
            <TxStatus st={tx.st} />
          </td>
        </tr>
      )}
    </>
  );
}
