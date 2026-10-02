// Live HyperEVM testnet reads (build spec 2.6): the BTC oracle price from the HyperCore price source and the
// MOCK v2 pool ledger. On load, then every 25 s while the tab is visible. A failed read is a dash, never a number.
import { readLedger, readOraclePx6, formatUsdc, utcTime, type Ledger } from '../lib/chain.ts';
import { underwriters as U, stats } from '../copy/en.ts';
import { state, set, on } from './store.ts';

const EVERY_MS = 25_000;

export function startLive(cfg: { rpcs: string[]; chain: number; oracle: string; perp: number; pool: string }): void {
  let timer = 0;
  let busy = false;

  async function tick() {
    if (busy || document.visibilityState !== 'visible') return;
    busy = true;
    try {
      const [px, ledger] = await Promise.all([
        readOraclePx6(cfg.rpcs, cfg.chain, cfg.oracle, cfg.perp).catch(() => null),
        cfg.pool ? readLedger(cfg.rpcs, cfg.chain, cfg.pool).catch(() => null) : Promise.resolve(null),
      ]);
      const now = new Date();
      set('live', {
        oraclePx6: px,
        oracleAt: px === null ? state.live.oracleAt : now,
        oracleState: px === null ? 'failed' : 'ok',
        ledger: ledger,
        ledgerAt: ledger && Object.values(ledger).some((v) => v !== null) ? now : state.live.ledgerAt,
      });
    } finally {
      busy = false;
    }
  }
  function schedule() {
    clearInterval(timer);
    if (document.visibilityState === 'visible') timer = window.setInterval(tick, EVERY_MS);
  }
  document.addEventListener('visibilitychange', () => {
    schedule();
    if (document.visibilityState === 'visible') tick();
  });
  schedule();
  tick();
}

/** Renders the ledger tiles of the Underwriters section from the shared live state. */
export function mountLedger(root: HTMLElement): void {
  const field = (k: string) => root.querySelector<HTMLElement>(`[data-ledger="${k}"]`);
  const tag = root.querySelector<HTMLElement>('[data-ledger-tag]');
  const prev: Record<string, string> = {};

  const put = (k: string, v: string) => {
    const el = field(k);
    if (!el) return;
    if (prev[k] !== undefined && prev[k] !== v && v !== stats.failed) {
      el.classList.remove('changed');
      void el.offsetWidth;
      el.classList.add('changed');
    }
    prev[k] = v;
    el.textContent = v;
  };
  const usdc = (x: bigint | null) => (x === null ? stats.failed : formatUsdc(x));

  function render() {
    const l: Ledger | null = state.live.ledger;
    if (!l) return;
    put('total', usdc(l.totalAssets));
    put('free', usdc(l.freeAssets));
    put('locked', usdc(l.lockedAssets));
    put('covers', l.coverCount === null ? stats.failed : l.coverCount.toString());
    put('paused', l.paused === null ? stats.failed : l.paused ? U.ledger.yes : U.ledger.no);
    if (tag) {
      const ok = state.live.ledgerAt !== null && Object.values(l).some((v) => v !== null);
      tag.dataset.state = ok ? 'ok' : 'failed';
      tag.textContent = ok
        ? `${U.ledger.live} · ${U.ledger.pool} · HyperEVM testnet · ${U.ledger.readAt} ${utcTime(state.live.ledgerAt!)} UTC`
        : `${U.ledger.live} · ${U.ledger.pool} · read failed`;
    }
  }
  on('live', render);
}
