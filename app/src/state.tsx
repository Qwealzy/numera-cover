import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { getAddress, isAddress, type Address } from 'viem';
import { DEFAULT_POOL_KEY, PERPS, POLL_MS, POOLS, resolvePoolKey, type PoolConfig, type PoolKind } from './config';
import { currentChainId, ensureTestnet, hasInjectedWallet, requestAccounts } from './lib/chain';
import { describeError } from './lib/errors';
import { fetchMarket, type Market } from './lib/info';
import { readSnapshot, type PoolStats, type PxResult } from './lib/pool';
import { cached, invalidate } from './lib/rpc';
import { usePoll, type Polled } from './hooks';

export type Tab = 'about' | 'buy' | 'covers' | 'pool' | 'model';
const TABS: Tab[] = ['about', 'buy', 'covers', 'pool', 'model'];

interface AppState {
  tab: Tab;
  setTab: (t: Tab) => void;
  /** 'hypercore' | 'mock' of the selected pool (v1 or v2). */
  poolKind: PoolKind;
  /** Selected entry of POOLS (e.g. 'mock' or 'mock-v2'). */
  poolKey: string;
  setPoolKey: (k: string) => void;
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

function readUrl(): { tab: Tab; pool: string; as: string } {
  const h = new URLSearchParams(window.location.hash.replace(/^#\/?/, '').replace(/^[^?]*\?/, ''));
  const path = window.location.hash.replace(/^#\/?/, '').split('?')[0] as Tab;
  let storedPool: string | null = null;
  try {
    storedPool = localStorage.getItem('numera.pool');
  } catch {
    /* storage blocked */
  }
  const pool = resolvePoolKey(h.get('pool'), storedPool);
  return { tab: TABS.includes(path) ? path : 'about', pool, as: h.get('as') ?? '' };
}

export function AppProvider({ children }: { children: ReactNode }) {
  const init = useMemo(readUrl, []);
  const [tab, setTabState] = useState<Tab>(init.tab);
  const [poolKey, setPoolKeyState] = useState<string>(init.pool);
  const [account, setAccount] = useState<Address>();
  const [chainId, setChainId] = useState<number>();
  const [connectError, setConnectError] = useState<string>();
  const [viewAsInput, setViewAsInput] = useState(init.as);
  const pool = POOLS[poolKey] ?? POOLS[DEFAULT_POOL_KEY];
  const poolKind = pool.kind;

  // keep URL in sync: #/<tab>?pool=<kind>&as=<addr>
  useEffect(() => {
    const q = new URLSearchParams();
    q.set('pool', poolKey);
    if (viewAsInput && !account) q.set('as', viewAsInput);
    const next = `#/${tab}?${q.toString()}`;
    if (window.location.hash !== next) window.history.replaceState(null, '', next);
    try {
      localStorage.setItem('numera.pool', poolKey);
    } catch {
      /* storage blocked */
    }
  }, [tab, poolKey, viewAsInput, account]);

  useEffect(() => {
    const onHash = () => {
      const u = readUrl();
      setTabState(u.tab);
      if (/[?&]pool=/.test(window.location.hash)) setPoolKeyState(u.pool);
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

  // Poll only what the visible screen shows (usePoll also pauses while the browser tab is hidden).
  // One snapshot = one Multicall3 eth_call: pool stats + user balances + oracle price of every perp.
  const needsChain = tab !== 'model';
  const needsMarket = tab === 'buy' || tab === 'covers' || tab === 'pool';
  const market = usePoll(() => cached('market', 10_000, () => fetchMarket()), [], POLL_MS, needsMarket);
  const perps = useMemo(() => PERPS.map((p) => p.index), []);
  const snap = usePoll(
    () => cached(`snap:${pool.pool}:${account ?? ''}`, 5_000, () => readSnapshot(pool, account, perps)),
    [pool.pool, account],
    POLL_MS,
    needsChain,
  );
  const stats: Polled<PoolStats> = useMemo(() => ({ ...snap, data: snap.data?.stats }), [snap]);
  const oracle: Polled<Map<number, PxResult>> = useMemo(() => ({ ...snap, data: snap.data?.oracle }), [snap]);

  /** After the user's own transaction: drop cached reads and re-read now. */
  const refreshAll = useCallback(() => {
    invalidate();
    snap.reload();
    market.reload();
  }, [snap.reload, market.reload]);

  const setTab = useCallback((t: Tab) => {
    setTabState(t);
    window.scrollTo({ top: 0 });
  }, []);

  const value: AppState = {
    tab,
    setTab,
    poolKind,
    poolKey,
    setPoolKey: setPoolKeyState,
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
