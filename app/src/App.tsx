import { AppProvider, useApp } from './state';
import { Header } from './components/Header';
import { Operator } from './components/Operator';
import { About } from './screens/About';
import { BuyCover } from './screens/BuyCover';
import { Covers } from './screens/Covers';
import { Pool } from './screens/Pool';
import { Model } from './screens/Model';
import { Addr, Disclaimer } from './components/ui';
import { hyperEvmTestnet, USE_QUOTE_FIXTURE } from './config';

function Shell() {
  const { tab, pool, poolKind } = useApp();
  return (
    <>
      <Header />
      <Disclaimer />
      <main>
        <div className="wrap">
          {tab === 'about' && <About />}
          {tab === 'buy' && <BuyCover />}
          {tab === 'covers' && <Covers />}
          {tab === 'pool' && <Pool />}
          {tab === 'model' && <Model />}
          {tab !== 'about' && tab !== 'model' && <Operator />}
        </div>
      </main>
      <footer>
        <div className="wrap">
          <span>
            {hyperEvmTestnet.name} ({hyperEvmTestnet.id}) · testnet only, no real funds
          </span>
          <span>
            {poolKind === 'mock' ? 'MOCK demo pool' : 'Real pool'} <Addr a={pool.pool} />
          </span>
          {USE_QUOTE_FIXTURE && <span>quote FIXTURE mode</span>}
          <span>Cover: a fixed payout on an oracle price event.</span>
        </div>
      </footer>
    </>
  );
}

export function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
