import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Hex } from 'viem';
import { addrUrl, txUrl } from '../config';
import { describeError } from '../lib/errors';
import { shortAddr } from '../lib/format';
import { fetchReceipt, type ReceiptView } from '../lib/receipt';
import { isRateLimited } from '../lib/rpc';

export function Stat({ label, value, sub, children }: { label: ReactNode; value: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div className="stat__value">{value}</div>
      {sub !== undefined && <div className="stat__sub">{sub}</div>}
      {children}
    </div>
  );
}

/** Copy `text` to the clipboard; the button says "copied" for a moment. */
export function CopyButton({ text, what = 'value' }: { text: string; what?: string }) {
  const [done, setDone] = useState<'ok' | 'fail'>();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone('ok');
    } catch (e) {
      console.error('[numera] clipboard write failed', e);
      setDone('fail');
    }
    setTimeout(() => setDone(undefined), 1200);
  };
  return (
    <button type="button" className="copy-btn" onClick={copy} title={`Copy ${what}: ${text}`} aria-label={`Copy ${what}`}>
      {done === 'ok' ? 'copied' : done === 'fail' ? 'failed' : 'copy'}
    </button>
  );
}

/** Address: short form + copy; an explorer link only when VITE_EXPLORER_URL is set. */
export function Addr({ a, full = false }: { a: string; full?: boolean }) {
  const href = addrUrl(a);
  const text = full ? a : shortAddr(a);
  return (
    <span className="ref">
      {href ? (
        <a className="mono" href={href} target="_blank" rel="noreferrer" title={a}>
          {text}
        </a>
      ) : (
        <span className="mono" title={a}>
          {text}
        </span>
      )}
      <CopyButton text={a} what="address" />
    </span>
  );
}

/**
 * Transaction reference: optional label, the short hash (opens the in-app receipt read over the RPC) and
 * a copy button. An external explorer link is added only when VITE_EXPLORER_URL is set (no working chain-998
 * explorer as of 2026-10-02).
 */
export function TxLink({ hash, label }: { hash: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const href = txUrl(hash);
  return (
    <span className="ref">
      {label && <span>{label}</span>}
      <button type="button" className="linkish mono" title={`Show the receipt of ${hash} (read from the RPC)`} onClick={() => setOpen(true)}>
        {shortAddr(hash)}
      </button>
      <CopyButton text={hash} what="tx hash" />
      {href && (
        <a className="small" href={href} target="_blank" rel="noreferrer" title={`Open ${hash} in the explorer`}>
          explorer
        </a>
      )}
      {open && <ReceiptDialog hash={hash as Hex} onClose={() => setOpen(false)} />}
    </span>
  );
}

/** Modal with the decoded receipt, read when opened. */
export function ReceiptDialog({ hash, onClose }: { hash: Hex; onClose: () => void }) {
  const [st, setSt] = useState<{ data?: ReceiptView; error?: string }>({});
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setSt({});
    fetchReceipt(hash).then(
      (data) => {
        if (alive) setSt({ data });
      },
      (e) => {
        console.error('[numera] receipt read failed', hash, e);
        if (alive)
          setSt({ error: isRateLimited(e) ? 'The public testnet RPC is rate-limiting requests (-32005); try again in a minute.' : describeError(e) });
      },
    );
    return () => {
      alive = false;
    };
  }, [hash, tick]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const r = st.data;
  return createPortal(
    <div className="receipt-backdrop" onClick={onClose}>
      <div className="receipt" role="dialog" aria-modal="true" aria-label="Transaction receipt" onClick={(e) => e.stopPropagation()}>
        <div className="receipt__head">
          <h2>Transaction receipt</h2>
          <button type="button" className="btn btn--small" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
        <p className="mono small receipt__hash">
          {hash} <CopyButton text={hash} what="tx hash" />
        </p>
        <p className="faint small">Read with eth_getTransactionReceipt from the testnet RPC (chain 998); events decoded with the app's contract ABIs.</p>
        {st.error ? (
          <Notice kind="error">
            Could not read the receipt: {st.error}{' '}
            <button type="button" className="linkish" onClick={() => setTick((x) => x + 1)}>
              retry
            </button>
          </Notice>
        ) : !r ? (
          <p className="empty">Reading receipt…</p>
        ) : (
          <>
            <dl className="kv">
              <div>
                <dt>Status</dt>
                <dd>{r.status === 'success' ? 'success (1)' : 'reverted (0)'}</dd>
              </div>
              <div>
                <dt>Block</dt>
                <dd className="mono">{r.blockNumber.toString()}</dd>
              </div>
              <div>
                <dt>From</dt>
                <dd>
                  <Addr a={r.from} full />
                </dd>
              </div>
              <div>
                <dt>To</dt>
                <dd>
                  {r.to ? (
                    <Addr a={r.to} full />
                  ) : r.contractAddress ? (
                    <>
                      contract creation <Addr a={r.contractAddress} full />
                    </>
                  ) : (
                    '—'
                  )}
                </dd>
              </div>
              <div>
                <dt>Gas used</dt>
                <dd className="mono">{r.gasUsed.toString()}</dd>
              </div>
            </dl>
            <h3 style={{ marginTop: 14 }}>Events ({r.events.length})</h3>
            <ol className="receipt__events">
              {r.events.map((ev) => (
                <li key={ev.logIndex}>
                  <strong>{ev.name}</strong>{' '}
                  <span className="faint small">
                    · {ev.contract} · log {ev.logIndex}
                  </span>
                  <dl className="receipt__args">
                    {ev.args.map((a) => (
                      <Fragment key={a.name}>
                        <dt>{a.name}</dt>
                        <dd className="mono">
                          {a.pretty ? (
                            <>
                              {a.pretty} <span className="faint">[{a.raw}]</span>
                            </>
                          ) : (
                            a.raw
                          )}
                        </dd>
                      </Fragment>
                    ))}
                  </dl>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function MockTag({ inline = false }: { inline?: boolean }) {
  return <span className={`mock-tag${inline ? ' mock-tag--inline' : ''}`}>MOCK</span>;
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'ok' | 'error'; children: ReactNode }) {
  return (
    <div className={`notice${kind === 'ok' ? ' notice--ok' : kind === 'error' ? ' notice--error' : ''}`} role={kind === 'error' ? 'alert' : undefined}>
      {kind === 'error' && <span className="mark mark--ring" aria-hidden />}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- transaction state

export type TxPhase = 'idle' | 'wallet' | 'pending' | 'done' | 'error';
export interface TxState {
  phase: TxPhase;
  label?: string;
  hash?: Hex;
  error?: string;
}

/** Run one write at a time; tracks wallet → pending → done/error with the tx hash. */
export function useTx() {
  const [st, setSt] = useState<TxState>({ phase: 'idle' });
  const run = useCallback(async <T,>(label: string, fn: (onHash: (h: Hex) => void) => Promise<T>): Promise<T | undefined> => {
    setSt({ phase: 'wallet', label });
    try {
      const r = await fn((hash) => setSt({ phase: 'pending', label, hash }));
      setSt((s) => ({ phase: 'done', label, hash: (r as { hash?: Hex })?.hash ?? s.hash }));
      return r;
    } catch (e) {
      setSt((s) => ({ phase: 'error', label, hash: s.hash, error: describeError(e) }));
      return undefined;
    }
  }, []);
  const reset = useCallback(() => setSt({ phase: 'idle' }), []);
  return { st, run, reset, busy: st.phase === 'wallet' || st.phase === 'pending' };
}

export function TxStatus({ st }: { st: TxState }) {
  if (st.phase === 'idle') return null;
  if (st.phase === 'wallet') return <Notice>{st.label}: confirm in your wallet…</Notice>;
  if (st.phase === 'pending')
    return (
      <Notice>
        {st.label}: waiting for the block… {st.hash && <TxLink hash={st.hash} />}
      </Notice>
    );
  if (st.phase === 'done')
    return (
      <Notice kind="ok">
        <span className="mark" aria-hidden />
        {st.label}: confirmed. {st.hash && <TxLink hash={st.hash} label="Transaction" />}
      </Notice>
    );
  return (
    <Notice kind="error">
      {st.label} failed: {st.error} {st.hash && <TxLink hash={st.hash} />}
    </Notice>
  );
}
