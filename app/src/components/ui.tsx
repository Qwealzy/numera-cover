import { useCallback, useState, type ReactNode } from 'react';
import type { Hex } from 'viem';
import { addrUrl, txUrl } from '../config';
import { describeError } from '../lib/errors';
import { shortAddr } from '../lib/format';

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

export function Addr({ a, full = false }: { a: string; full?: boolean }) {
  return (
    <a className="mono" href={addrUrl(a)} target="_blank" rel="noreferrer" title={a}>
      {full ? a : shortAddr(a)}
    </a>
  );
}

export function TxLink({ hash, label }: { hash: string; label?: string }) {
  return (
    <a className="mono" href={txUrl(hash)} target="_blank" rel="noreferrer" title={hash}>
      {label ?? shortAddr(hash)}
    </a>
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
        {st.label}: confirmed. {st.hash && <TxLink hash={st.hash} label="View transaction" />}
      </Notice>
    );
  return (
    <Notice kind="error">
      {st.label} failed: {st.error} {st.hash && <TxLink hash={st.hash} />}
    </Notice>
  );
}
