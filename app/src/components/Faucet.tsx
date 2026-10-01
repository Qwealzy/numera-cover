import { FAUCET_AMOUNT, USDC } from '../config';
import { fmtUsdc } from '../lib/format';
import { faucet } from '../lib/tx';
import { useApp } from '../state';
import { Addr, TxStatus, useTx } from './ui';

/** MockUSDC has a public mint: let judges get test dollars in one click. Worthless by design. */
export function Faucet() {
  const { account, stats, refreshAll } = useApp();
  const tx = useTx();
  const bal = stats.data?.user?.usdc;
  return (
    <section className="panel">
      <div className="panel__head">
        <h2>Test dollars</h2>
        <span className="meta">
          mUSDC <Addr a={USDC} />
        </span>
      </div>
      <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="small">
          Balance <strong className="tnum">{account ? (bal !== undefined ? fmtUsdc(bal) : '…') : '—'}</strong> mUSDC
        </span>
        <button
          className="btn btn--small"
          disabled={!account || tx.busy}
          onClick={async () => {
            if (!account) return;
            if (await tx.run('Faucet', (h) => faucet(account, h))) refreshAll();
          }}
        >
          Get {fmtUsdc(FAUCET_AMOUNT, 0)} mUSDC
        </button>
      </div>
      <p className="faint small" style={{ marginTop: 6 }}>
        Testnet mock USDC with a public mint; it has no value. You also need a little testnet HYPE for gas.
      </p>
      <div style={{ marginTop: 8 }}>
        <TxStatus st={tx.st} />
      </div>
    </section>
  );
}
