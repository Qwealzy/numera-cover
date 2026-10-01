import { isAddress } from 'viem';
import { useApp } from '../state';
import { Addr } from './ui';

/** "Whose positions/covers": the connected wallet, or a read-only "view as" address. */
export function SubjectBar() {
  const { account, viewAsInput, setViewAsInput, connect } = useApp();
  if (account)
    return (
      <p className="small soft">
        Showing the connected wallet <Addr a={account} full />.
      </p>
    );
  const bad = viewAsInput.trim() !== '' && !isAddress(viewAsInput.trim());
  return (
    <div className="panel" style={{ padding: 12 }}>
      <div className="row">
        <div className="field" style={{ flex: '3 1 260px' }}>
          <label htmlFor="viewas">View as address (read-only, no wallet needed)</label>
          <input
            id="viewas"
            type="text"
            className="mono"
            placeholder="0x…"
            spellCheck={false}
            value={viewAsInput}
            onChange={(e) => setViewAsInput(e.target.value)}
          />
          {bad && <span className="hint">Not a valid address.</span>}
        </div>
        <button className="btn btn--primary" onClick={connect}>
          Connect wallet
        </button>
      </div>
    </div>
  );
}
