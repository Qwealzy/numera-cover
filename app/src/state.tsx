import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { getAddress, isAddress, type Address } from 'viem';
import { PERPS, POOLS, type PoolConfig, type PoolKind } from './config';
import { currentChainId, ensureTestnet, hasInjectedWallet, requestAccounts } from './lib/chain';
import { describeError } from './lib/errors';
import { fetchMarket, type Market } from './lib/info';
import { readOraclePxs, readPoolStats, type PoolStats, type PxResult } from './lib/pool';
import { usePoll, type Polled } from './hooks';

export type Tab = 'about' | 'protect' | 'covers' | 'pool' | 'model';
const TABS: Tab[] = ['about', 'protect', 'covers', 'pool', 'model'];

interface AppState {
  tab: Tab;
  setTab: (t: Tab) => void;
  poolKind: PoolKind;
  setPoolKind: (k: PoolKind) => void;
  pool: PoolConfig;
  account: Address | undefined;
  chainId: number | undefined;
  connect: () => Promise<void>;
  connectError: string | undefined;
  viewAsInput: string;
  setViewAsInput: (s: string) => void;
  /** Address whose positions/covers are shown: connected account, else the "view as" address. */
  subject: Address | undefined;
  readOnly: boolean;
  market: Polled<Market>;
  stats: Polled<PoolStats>;
  oracle: Polled<Map<number, PxResult>>;
  refreshAll: () => void;
}

const Ctx = createContext<AppState | null>(null);

function readUrl(): { tab: Tab; pool: PoolKind; as: string } {
  const h = new URLSearchParams(window.location.hash.replace(/^#\/?/, '').replace(/^[^?]*\?/, ''));
  const path = window.location.hash.replace(/^#\/?/, '').split('?')[0] as Tab;
  let storedPool: string | null = null;
  try {
    storedPool = localStorage.getItem('numera.pool');
  } catch {
    /* storage blocked */
  }
  const pool = (h.get('pool') ?? storedPool) === 'mock' ? 'mock' : 'hypercore';
  return { tab: TABS.includes(path) ? path : 'about', pool, as: h.get('as') ?? '' };
}

export function AppProvider({ children }: { children: ReactNode }) {
  const init = useMemo(readUrl, []);
  const [tab, setTabState] = useState<Tab>(init.tab);
  const [poolKind, setPoolKindState] = useState<PoolKind>(init.pool);
  const [account, setAccount] = useState<Address>();
  const [chainId, setChainId] = useState<number>();
  const [connectError, setConnectError] = useState<string>();
  const [viewAsInput, setViewAsInput] = useState(init.as);
  const pool = POOLS[poolKind];

  // keep URL in sync: #/<tab>?pool=<kind>&as=<addr>
  useEffect(() => {
    const q = new URLSearchParams();
    q.set('pool', poolKind);
    if (viewAsInput && !account) q.set('as', viewAsInput);
    const next = `#/${tab}?${q.toString()}`;
    if (window.location.hash !== next) window.history.replaceState(null, '', next);
    try {
      localStorage.setItem('numera.pool', poolKind);
    } catch {
      /* storage blocked */
    }
  }, [tab, poolKind, viewAsInput, account]);

  useEffect(() => {
    const onHash = () => {
      const u = readUrl();
      setTabState(u.tab);
      if (/[?&]pool=/.test(window.location.hash)) setPoolKindState(u.pool);
      if (u.as) setViewAsInput(u.as);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // wallet events; restore an already-authorized account without prompting
  useEffect(() => {
    const eth = window.ethereum;
    if (!eth) return;
    eth.request({ method: 'eth_accounts' }).then((a) => {
      const list = a as string[];
      if (list[0]) setAccount(getAddress(list[0]));
    });
    currentChainId().then(setChainId);
    const onAcc = (a: unknown) => setAccount((a as string[])[0] ? getAddress((a as string[])[0]) : undefined);
    const onChain = (c: unknown) => setChainId(parseInt(String(c), 16));
    eth.on?.('accountsChanged', onAcc);
    eth.on?.('chainChanged', onChain);
    return () => {
      eth.removeListener?.('accountsChanged', onAcc);
      eth.removeListener?.('chainChanged', onChain);
    };
  }, []);

  const connect = useCallback(async () => {
    setConnectError(undefined);
    try {
      if (!hasInjectedWallet()) throw new Error('No browser wallet found. Install MetaMask or Rabby, or use “view as address”.');
      const [a] = await requestAccounts();
      setAccount(getAddress(a));
      await ensureTestnet();
      setChainId(await currentChainId());
    } catch (e) {
      setConnectError(describeError(e));
    }
  }, []);

  const viewAs = isAddress(viewAsInput.trim()) ? getAddress(viewAsInput.trim()) : undefined;
  const subject = account ?? viewAs;

  const market = usePoll((s) => fetchMarket(s), [], 5000);
  const stats = usePoll(() => readPoolStats(pool, account), [pool.pool, account], 6000);
  const oracle = usePoll(
    () => readOraclePxs(pool.priceSource, PERPS.map((p) => p.index)),
    [pool.priceSource],
    3000,
  );

  const refreshAll = useCallback(() => {
    stats.reload();
    oracle.reload();
    market.reload();
  }, [stats.reload, oracle.reload, market.reload]);

  const setTab = useCallback((t: Tab) => {
    setTabState(t);
    window.scrollTo({ top: 0 });
  }, []);

  const value: AppState = {
    tab,
    setTab,
    poolKind,
    setPoolKind: setPoolKindState,
    pool,
    account,
    chainId,
    connect,
    connectError,
    viewAsInput,
    setViewAsInput,
    subject,
    readOnly: !account,
    market,
    stats,
    oracle,
    refreshAll,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}
