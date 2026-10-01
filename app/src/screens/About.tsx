import { POOLS, WAITLIST_URL } from '../config';
import { useApp } from '../state';
import { fmtUsdc } from '../lib/format';
import { Addr } from '../components/ui';

export function About() {
  const { setTab, stats, pool } = useApp();
  const s = stats.data;
  return (
    <div className="about">
      <section className="about__hero">
        <div>
          <p className="eyebrow">Liquidation cover for Hyperliquid perps</p>
          <h1 className="about__title">Keep the position. Get paid if the wick comes.</h1>
          <p className="about__lede">
            Leveraged perp traders lose their margin to short, sharp wicks that touch the liquidation price and reverse. A stop-loss doesn’t solve it: it
            closes the position at the worst price of the move, and slips in a gap. Numera sells cover tied to your actual position: if the oracle price
            touches your level before expiry, the pool pays you a fixed amount in the same transaction. No claim, no assessor, no trade to execute.
          </p>
          <div className="row" style={{ marginTop: 18 }}>
            <button className="btn btn--primary" onClick={() => setTab('protect')}>
              Try it on testnet
            </button>
            {WAITLIST_URL && (
              <a className="btn" href={WAITLIST_URL} target="_blank" rel="noreferrer">
                Join the waitlist
              </a>
            )}
          </div>
        </div>

        <ol className="register" aria-label="How it works">
          <li className="register__entry">
            <span className="register__n">1</span>
            <div>
              <p className="register__act">Protect</p>
              <p className="register__detail">
                Connect, pick an open perp position. The level defaults to just above your liquidation price; the payout is capped at the margin you would
                lose.
              </p>
            </div>
          </li>
          <li className="register__entry">
            <span className="register__n">2</span>
            <div>
              <p className="register__act">Pay a premium</p>
              <p className="register__detail">
                The engine prices the touch probability from live volatility, floored by what history shows, and signs the quote. You see every input.
              </p>
            </div>
          </li>
          <li className="register__entry">
            <span className="register__n">3</span>
            <div>
              <p className="register__act">Paid automatically</p>
              <p className="register__detail">
                If the oracle touches your level before expiry, anyone (our keeper, you, a bot) calls <span className="mono">trigger()</span> and the pool
                pays at once. Otherwise the cover expires and the premium stays with the underwriters.
              </p>
            </div>
          </li>
        </ol>
      </section>

      <section className="grid about__cols">
        <div className="panel">
          <div className="panel__head">
            <h2>Built on Hyperliquid</h2>
          </div>
          <dl className="kv kv--stack">
            <div>
              <dt>HyperCore oracle precompile (0x…0807)</dt>
              <dd>the trigger price: validator median of 8 venues</dd>
            </div>
            <div>
              <dt>HyperCore position precompile (0x…0800)</dt>
              <dd>proof you hold the position; payout cap = margin</dd>
            </div>
            <div>
              <dt>HyperEVM CoverPool</dt>
              <dd>
                ERC-4626 USDC vault + cover book · <Addr a={POOLS.hypercore.pool} />
              </dd>
            </div>
            <div>
              <dt>Hyperliquid Info API</dt>
              <dd>positions and liquidation price in the app</dd>
            </div>
          </dl>
          <p className="faint small" style={{ marginTop: 10 }}>
            The pool reads the oracle and your position straight from HyperCore state, so a cover can only be bought against a real position and only
            pays on a real oracle touch.
          </p>
        </div>
        <div className="panel">
          <div className="panel__head">
            <h2>Underwriters</h2>
            <span className="meta">{pool.short}</span>
          </div>
          <p className="small soft">
            LPs deposit USDC and earn the premiums. Every payout is reserved when a cover is sold, so the pool can always pay what it owes; only free
            capital can be withdrawn.
          </p>
          <dl className="kv" style={{ marginTop: 10 }}>
            <div>
              <dt>Pool assets now (on-chain)</dt>
              <dd>{s ? `${fmtUsdc(s.totalAssets)} mUSDC` : '…'}</dd>
            </div>
            <div>
              <dt>Locked for active covers</dt>
              <dd>{s ? `${fmtUsdc(s.lockedAssets)} mUSDC` : '…'}</dd>
            </div>
            <div>
              <dt>Covers sold</dt>
              <dd>{s ? s.coverCount.toString() : '…'}</dd>
            </div>
          </dl>
        </div>
        <div className="panel">
          <div className="panel__head">
            <h2>What to know</h2>
          </div>
          <ul className="plain small">
            <li>
              <span className="mark mark--ring" aria-hidden />
              <strong>Testnet only.</strong> Mock USDC with no value; nothing here touches mainnet.
            </li>
            <li>
              <span className="mark" aria-hidden />
              Triggers on the <strong>oracle</strong> price; liquidation uses mark, so the level sits a buffer above your liquidation price.
            </li>
            <li>
              <span className="mark" aria-hidden />A payout needs a <span className="mono">trigger()</span> call that sees the breach on-chain; the keeper
              checks every block (~1 s).
            </li>
            <li>
              <span className="mark" aria-hidden />
              Parametric cover, not insurance: a fixed payout on a price event, priced by a published model (see Model).
            </li>
          </ul>
        </div>
      </section>
    </div>
  );
}
