import { useEffect, useState } from 'react';
import { getAddress, isAddress } from 'viem';
import { PERPS } from '../config';
import { usePoll } from '../hooks';
import { fetchAccount } from '../lib/info';
import { fmtPx6, parseDecimal } from '../lib/format';
import { readMockOwners } from '../lib/pool';
import { setMockPosition, setMockPrice } from '../lib/tx';
import { useApp } from '../state';
import { MockTag, Notice, TxStatus, useTx } from './ui';

/**
 * MOCK pool operator controls (Demo B, ARCHITECTURE §8): shown only when the connected account owns the
 * mock sources. Moves the mock oracle and sets mock positions; every value is shown in raw units first.
 */
export function Operator() {
  const { pool, account, subject, market, oracle, refreshAll } = useApp();
  const owners = usePoll(() => readMockOwners(pool), [pool.pool], 0, pool.kind === 'mock');
  const isOwner =
    !!account && !!owners.data && [owners.data.price, owners.data.position].some((o) => o.toLowerCase() === account.toLowerCase());

  const [perp, setPerp] = useState(PERPS[0].index);
  const [px, setPx] = useState('');
  const [user, setUser] = useState('');
  const [side, setSide] = useState<1 | -1>(1);
  const [size, setSize] = useState('');
  const [entry, setEntry] = useState('');
  const [lev, setLev] = useState('10');
  const [note, setNote] = useState<string>();
  const tx = useTx();

  useEffect(() => {
    if (!user && subject) setUser(subject);
  }, [subject, user]);

  if (pool.kind !== 'mock' || !isOwner || !account) return null;

  const coin = PERPS.find((p) => p.index === perp)?.coin ?? '';
  const meta = market.data?.byName.get(coin);
  const szDec = meta?.meta.szDecimals;
  const live = meta ? Number(meta.ctx.oraclePx) : undefined;
  const cur = oracle.data?.get(perp);

  let px6: bigint | undefined, pxErr: string | undefined;
  try {
    if (px) px6 = parseDecimal(px, 6);
  } catch (e) {
    pxErr = (e as Error).message;
  }
  let szi: bigint | undefined, entryNtl: bigint | undefined, posErr: string | undefined;
  try {
    if (size && entry && szDec !== undefined) {
      const sizeRaw = parseDecimal(size, szDec); // size × 10^szDecimals = HyperCore szi units
      const entry6 = parseDecimal(entry, 6);
      szi = BigInt(side) * sizeRaw;
      entryNtl = (sizeRaw * entry6) / 10n ** BigInt(szDec); // USD × 1e6
    }
  } catch (e) {
    posErr = (e as Error).message;
  }
  const levN = Number(lev);
  const userOk = isAddress(user.trim());

  async function prefillFromInfo() {
    setNote(undefined);
    if (!userOk) return setNote('Enter a valid address first.');
    try {
      const a = await fetchAccount(getAddress(user.trim()));
      const p = a.assetPositions.map((x) => x.position).find((x) => x.coin === coin);
      if (!p) return setNote(`No ${coin} position on Hyperliquid testnet for this address.`);
      const sz = Number(p.szi);
      setSide(sz >= 0 ? 1 : -1);
      setSize(String(Math.abs(sz)));
      setEntry(p.entryPx);
      setLev(String(p.leverage.value));
      setNote(`Copied the real ${coin} position (Info API) into the form.`);
    } catch (e) {
      setNote((e as Error).message);
    }
  }

  return (
    <section className="panel" style={{ marginTop: 16, borderColor: 'var(--paper)' }}>
      <div className="panel__head">
        <h2>
          Operator <MockTag inline />
        </h2>
        <span className="meta">you own the mock sources · staged demo only</span>
      </div>
      <div className="grid grid--2">
        <div className="stack" style={{ gap: 10 }}>
          <h3>Set mock oracle price</h3>
          <div className="row">
            <div className="field" style={{ flex: '0 1 110px' }}>
              <label htmlFor="op-perp">Perp</label>
              <select id="op-perp" value={perp} onChange={(e) => setPerp(Number(e.target.value))}>
                {PERPS.map((p) => (
                  <option key={p.index} value={p.index}>
                    {p.coin} ({p.index})
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="op-px">Price (USD)</label>
              <input id="op-px" type="text" inputMode="decimal" value={px} onChange={(e) => setPx(e.target.value)} />
            </div>
          </div>
          <p className="small soft">
            Now: {cur?.ok ? fmtPx6(cur.px6) : 'not set'} · live testnet oracle {live !== undefined ? `$${live}` : '…'}{' '}
            {live !== undefined && (
              <button className="btn btn--small" onClick={() => setPx(String(live))}>
                use live
              </button>
            )}{' '}
            {cur?.ok && (
              <button className="btn btn--small" onClick={() => setPx((Number(cur.px6) / 1e6 * 0.9).toFixed(2))}>
                −10 % crash
              </button>
            )}
          </p>
          <p className="faint small mono">setPrice({perp}, {px6?.toString() ?? '…'})</p>
          {pxErr && <p className="small soft">{pxErr}</p>}
          <button
            className="btn btn--primary"
            disabled={!px6 || tx.busy}
            onClick={async () => (await tx.run('Set mock price', (h) => setMockPrice(account, pool.priceSource, perp, px6!, h))) && refreshAll()}
          >
            Set price
          </button>
          <p className="faint small">The engine quotes against the pool’s price source, so set the mock price before quoting (use live for a realistic start).</p>
        </div>

        <div className="stack" style={{ gap: 10 }}>
          <h3>Set mock position ({coin})</h3>
          <div className="field">
            <label htmlFor="op-user">Trader address</label>
            <input id="op-user" className="mono" type="text" value={user} onChange={(e) => setUser(e.target.value)} spellCheck={false} />
          </div>
          <div className="row">
            <div className="field" style={{ flex: '0 1 110px' }}>
              <span className="label">Side</span>
              <div className="seg">
                <button aria-pressed={side === 1} onClick={() => setSide(1)}>
                  Long
                </button>
                <button aria-pressed={side === -1} onClick={() => setSide(-1)}>
                  Short
                </button>
              </div>
            </div>
            <div className="field">
              <label htmlFor="op-size">Size ({coin})</label>
              <input id="op-size" type="text" inputMode="decimal" value={size} onChange={(e) => setSize(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="op-entry">Entry px (USD)</label>
              <input id="op-entry" type="text" inputMode="decimal" value={entry} onChange={(e) => setEntry(e.target.value)} />
            </div>
            <div className="field" style={{ flex: '0 1 80px' }}>
              <label htmlFor="op-lev">Leverage</label>
              <input id="op-lev" type="number" min={1} value={lev} onChange={(e) => setLev(e.target.value)} />
            </div>
          </div>
          <p className="faint small mono">
            setPosition({userOk ? getAddress(user.trim()).slice(0, 8) + '…' : '…'}, {perp}, szi={szi?.toString() ?? '…'}, entryNtl={entryNtl?.toString() ?? '…'},
            lev={levN || '…'})
          </p>
          {posErr && <p className="small soft">{posErr}</p>}
          <div className="row">
            <button className="btn btn--small" onClick={prefillFromInfo}>
              Copy real position (Info API)
            </button>
            <button
              className="btn btn--primary"
              disabled={!userOk || szi === undefined || entryNtl === undefined || !(levN >= 1) || tx.busy}
              onClick={async () =>
                (await tx.run('Set mock position', (h) =>
                  setMockPosition(account, pool.positionSource, getAddress(user.trim()), perp, szi!, entryNtl!, Math.floor(levN), h),
                )) && refreshAll()
              }
            >
              Set position
            </button>
          </div>
          {note && <p className="small soft">{note}</p>}
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        <TxStatus st={tx.st} />
        {owners.error && <Notice kind="error">{owners.error}</Notice>}
      </div>
    </section>
  );
}
