import { POOLS, SWITCH_POOL_KEYS, hyperEvmTestnet } from '../config';
import { shortAddr } from '../lib/format';
import { ensureTestnet } from '../lib/chain';
import { useApp, type Tab } from '../state';
import { MockTag } from './ui';
import { useNow, useRpcBusy } from '../hooks';

const NAV: { tab: Tab; label: string }[] = [
  { tab: 'about', label: 'About' },
  { tab: 'buy', label: 'Buy cover' },
  { tab: 'covers', label: 'My covers' },
  { tab: 'pool', label: 'Pool' },
  { tab: 'model', label: 'Model' },
];

export function Header() {
  const { tab, setTab, poolKind, poolKey, setPoolKey, account, chainId, connect, connectError } = useApp();
  const wrongChain = account && chainId !== undefined && chainId !== hyperEvmTestnet.id;
  return (
    <>
      {poolKind === 'mock' && (
        <div className="mock-banner" role="status">
          <div className="wrap">
            <MockTag />
            <span>Demo pool with operator-set prices and positions. Not market data — every number on this pool is staged.</span>
          </div>
        </div>
      )}
      <header className="header">
        <div className="wrap header__inner">
          <a className="brand" href="#/about" onClick={(e) => (e.preventDefault(), setTab('about'))}>
            <img src="/numera-mark-60.png" alt="" width={28} height={28} />
            <span>Numera</span>
            <small>liquidation cover · testnet</small>
          </a>
          <nav className="nav" aria-label="Main">
            {NAV.map((n) => (
              <button key={n.tab} aria-current={tab === n.tab ? 'page' : undefined} onClick={() => setTab(n.tab)}>
                {n.label}
              </button>
            ))}
          </nav>
          <div className="header__end">
            <div className="seg" role="group" aria-label="Pool">
              {SWITCH_POOL_KEYS.map((k) => (
                <button key={k} aria-pressed={poolKey === k} onClick={() => setPoolKey(k)} title={POOLS[k].label}>
                  {POOLS[k].short}
                </button>
              ))}
            </div>
            {account ? (
              <span className="chip chip--green mono" title={account}>
                {shortAddr(account)}
              </span>
            ) : (
              <button className="btn btn--primary btn--small" onClick={connect}>
                Connect wallet
              </button>
            )}
          </div>
        </div>
      </header>
      <RpcBusy />
      {(wrongChain || connectError) && (
        <div className="wrap" style={{ marginTop: 12 }}>
          {wrongChain && (
            <div className="notice notice--error">
              <span className="mark mark--ring" aria-hidden />
              Your wallet is on chain {chainId}. Numera runs on {hyperEvmTestnet.name} ({hyperEvmTestnet.id}).{' '}
              <button className="btn btn--small" onClick={() => ensureTestnet().catch(() => undefined)}>
                Switch network
              </button>
            </div>
          )}
          {connectError && <div className="notice notice--error">{connectError}</div>}
        </div>
      )}
    </>
  );
}

/** Shown while any poll is backing off after a -32005 from the public RPC. */
function RpcBusy() {
  const until = useRpcBusy();
  if (until === undefined) return null;
  return <RpcBusyNotice until={until} />;
}

function RpcBusyNotice({ until }: { until: number }) {
  const now = useNow(1000);
  const left = Math.max(0, until / 1000 - now);
  return (
    <div className="wrap" style={{ marginTop: 12 }}>
      <div className="notice" role="status">
        RPC busy, retrying{left >= 1 ? ` in ${Math.ceil(left)} s` : ' now'}. The public testnet RPC is rate-limiting requests. Numbers on screen are the
        last confirmed reads for this pool; “…” means not read yet.
      </div>
    </div>
  );
}
