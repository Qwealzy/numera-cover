// Hero controls -> shared setup; the readout card (trader face / underwriter face) and the hidden summary.
// Every number comes from the precomputed grid (src/lib/pricing.ts); dollar levels only from a live read.
import {
  estimate,
  premiumDollars,
  fmtUsd,
  fmtPct,
  fmtProb,
  fmtPrice,
  liqPrice,
  defaultLevel,
  px6ToUsd,
} from '../lib/pricing.ts';
import { readout as R, controls as C } from '../copy/en.ts';
import { state, on, patchSetup, set, type Role } from './store.ts';
import { motionOn } from './motion.ts';

export function mountReadout(root: HTMLElement): void {
  const form = root.querySelector<HTMLFormElement>('[data-controls]')!;
  const lev = form.querySelector<HTMLInputElement>('input[name="lev"]')!;
  const levOut = form.querySelector<HTMLElement>('[data-lev-out]')!;
  const card = root.querySelector<HTMLElement>('[data-card]')!;
  const front = root.querySelector<HTMLElement>('[data-face-front]')!;
  const back = root.querySelector<HTMLElement>('[data-face-back]')!;
  const r = (k: string) => root.querySelector<HTMLElement>(`[data-r="${k}"]`)!;
  const summary = root.querySelector<HTMLElement>('[data-summary]')!;
  const roLive = root.querySelector<HTMLElement>('[data-ro-live]')!;
  const roles = root.querySelectorAll<HTMLInputElement>('input[name="role"]');

  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.name === 'side') patchSetup({ side: t.value === 'short' ? 'short' : 'long' });
    if (t.name === 'dur') patchSetup({ dur: Number(t.value) });
    if (t.name === 'vol') patchSetup({ sigma: Number(t.value) });
  });
  lev.addEventListener('input', () => {
    const v = Number(lev.value);
    levOut.textContent = `${v}×`;
    lev.setAttribute('aria-valuetext', `${v}×`);
    if (v !== state.setup.lev) patchSetup({ lev: v });
  });
  for (const el of roles)
    el.addEventListener('change', () => {
      if (el.checked) set('role', el.value as Role);
    });

  let lastPrem = r('prem').textContent ?? '';
  let sumTimer = 0;

  function rollDigits(el: HTMLElement, text: string) {
    if (text === lastPrem) return;
    lastPrem = text;
    if (!motionOn()) {
      el.textContent = text;
      return;
    }
    el.textContent = '';
    [...text].forEach((ch, k) => {
      const s = document.createElement('span');
      s.className = 'dg roll';
      s.style.setProperty('--k', String(k));
      s.textContent = ch;
      el.append(s);
    });
  }

  function render() {
    const s = state.setup;
    const e = estimate(s);
    const where = s.side === 'long' ? R.below : R.above;
    const px = state.live.oraclePx6;
    let liqTxt = `${fmtPct(e.liqDist)} ${where}`;
    let lvlTxt = `${fmtPct(e.lvlDist)} ${where}`;
    let liqUsd = '';
    let lvlUsd = '';
    if (px !== null) {
      const entry = px6ToUsd(px);
      const liq = liqPrice(entry, s.lev, s.maxLev, s.side);
      liqUsd = fmtPrice(liq);
      lvlUsd = fmtPrice(defaultLevel(liq, s.side));
    }
    r('liq').textContent = liqTxt;
    r('lvl').textContent = lvlTxt;
    r('liq-usd').textContent = liqUsd;
    r('lvl-usd').textContent = lvlUsd;
    const lv = state.live;
    roLive.textContent =
      lv.oracleState === 'ok' && lv.oracleAt
        ? R.liveOk(lv.oracleAt.toISOString().slice(11, 19))
        : lv.oracleState === 'failed'
          ? R.liveFailed
          : R.liveWaiting;
    if (liqUsd) {
      liqTxt += ` (${liqUsd} at the testnet oracle price)`;
      lvlTxt += ` (${lvlUsd})`;
    }
    r('p').textContent = e.refusal === 'level_too_close' ? '—' : fmtProb(e.p);
    const refused = e.refusal !== null;
    card.dataset.refused = e.refusal ?? '';
    let premTxt: string;
    if (refused) {
      premTxt = R.notOffered;
      r('refusal').textContent = e.refusal === 'prob_too_high' ? R.refusedProb : R.refusedLevel;
      r('floor').hidden = true;
    } else {
      premTxt = fmtUsd(premiumDollars(e.premium!));
      r('refusal').textContent = '';
      r('floor').hidden = !e.floorApplied;
    }
    rollDigits(r('prem'), premTxt);
    r('uw').textContent = refused ? R.uwRefused : R.uw(premTxt);

    const durLabel = C.durations.find((x) => x.sec === s.dur)?.label ?? '';
    const vol = C.vols.find((v) => Math.abs(v.sigma - s.sigma) < 1e-9)?.label ?? '';
    const premPart = refused
      ? e.refusal === 'prob_too_high'
        ? R.refusedProb
        : R.refusedLevel
      : `premium ${premTxt} ${R.perPayout}${e.floorApplied ? `, ${R.floor}` : ''}`;
    const text = `BTC ${s.side} ${s.lev}×, ${durLabel}, volatility ${vol}: liquidation ${liqTxt}, level ${lvlTxt}, ${premPart}. ${R.label}`;
    clearTimeout(sumTimer);
    sumTimer = window.setTimeout(() => (summary.textContent = text), 500);
  }

  function face() {
    const uw = state.role === 'underwriter';
    card.dataset.face = state.role;
    front.setAttribute('aria-hidden', String(uw));
    back.setAttribute('aria-hidden', String(!uw));
    for (const el of roles) el.checked = el.value === state.role;
  }

  on('setup', render);
  on('live', render);
  on('role', face);
  render();
  face();
}
