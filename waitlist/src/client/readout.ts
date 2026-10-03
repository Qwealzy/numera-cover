// Hero controls -> shared setup; the readout card (trader face / underwriter face), the estimate strip on the
// stage and the hidden summary. Every number comes from the precomputed grid (src/lib/pricing.ts); dollar
// levels only from a live read.
import {
  estimate,
  premiumDollars,
  fmtUsd,
  fmtPct,
  fmtProb,
  fmtLevelPrice,
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
  const strip = root.querySelector<HTMLElement>('[data-strip]');
  const stripSetup = root.querySelector<HTMLElement>('[data-strip-setup]');
  const stripPrem = root.querySelector<HTMLElement>('[data-strip-prem]');

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

  /** Rolls the digits of a dollar figure (30 ms stagger); words such as "Not offered" are set as they are. */
  function rollDigits(el: HTMLElement, text: string) {
    if (text === lastPrem) return;
    lastPrem = text;
    if (!motionOn() || !/^\$[\d.,]+$/.test(text)) {
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

  /** Card, strip and $ levels: on every setup change and every live read. */
  function render() {
    const s = state.setup;
    const e = estimate(s);
    const where = s.side === 'long' ? R.below : R.above;
    const px = state.live.oraclePx6;
    let liqUsd = '';
    let lvlUsd = '';
    if (px !== null) {
      const entry = px6ToUsd(px);
      const liq = liqPrice(entry, s.lev, s.maxLev, s.side);
      liqUsd = fmtLevelPrice(liq);
      lvlUsd = fmtLevelPrice(defaultLevel(liq, s.side));
    }
    r('liq').textContent = `${fmtPct(e.liqDist)} ${where}`;
    r('lvl').textContent = `${fmtPct(e.lvlDist)} ${where}`;
    r('liq-usd').textContent = liqUsd;
    r('lvl-usd').textContent = lvlUsd;
    const lv = state.live;
    roLive.textContent =
      lv.oracleState === 'ok' && lv.oracleAt
        ? R.liveOk(lv.oracleAt.toISOString().slice(11, 19))
        : lv.oracleState === 'failed'
          ? R.liveFailed
          : R.liveWaiting;
    const closeRefusal = e.refusal === 'level_too_close';
    r('p').textContent = closeRefusal ? '—' : fmtProb(e.p);
    r('pp').textContent = closeRefusal ? '—' : fmtProb(e.priced);
    r('pp-note').textContent = `(${e.pricedByFloor ? R.pricedFloor : R.pricedTail})`;
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
    if (strip && stripSetup && stripPrem) {
      strip.dataset.refused = refused ? '1' : '';
      stripSetup.textContent = `BTC ${s.side} ${s.lev}× · ${durLabel} · ${vol}`;
      stripPrem.textContent = refused ? (e.refusal === 'prob_too_high' ? R.stripRefusedProb : R.stripRefusedLevel) : premTxt;
    }
  }

  /** The hidden summary (a polite live region): only on a change the visitor made, never on a live read,
   *  and without the live $ values, so nothing is announced while the visitor is elsewhere on the page. */
  function announce() {
    const s = state.setup;
    const e = estimate(s);
    const where = s.side === 'long' ? R.below : R.above;
    const durLabel = C.durations.find((x) => x.sec === s.dur)?.label ?? '';
    const vol = C.vols.find((v) => Math.abs(v.sigma - s.sigma) < 1e-9)?.label ?? '';
    const premPart =
      e.refusal === 'prob_too_high'
        ? R.refusedProb
        : e.refusal === 'level_too_close'
          ? R.refusedLevel
          : `cover price ${fmtUsd(premiumDollars(e.premium!))} ${R.perPayout}${e.floorApplied ? `, ${R.floor}` : ''}`;
    const text = `BTC ${s.side} ${s.lev}×, ${durLabel}, volatility ${vol}: liquidation ${fmtPct(e.liqDist)} ${where}, level ${fmtPct(e.lvlDist)} ${where}, ${premPart}. ${R.label}`;
    clearTimeout(sumTimer);
    sumTimer = window.setTimeout(() => {
      if (summary.textContent !== text) summary.textContent = text;
    }, 500);
  }

  function face() {
    const uw = state.role === 'underwriter';
    card.dataset.face = state.role;
    front.setAttribute('aria-hidden', String(uw));
    back.setAttribute('aria-hidden', String(!uw));
    // the face turned away is out of the tab order too
    front.inert = uw;
    back.inert = !uw;
    for (const el of roles) el.checked = el.value === state.role;
  }

  on('setup', () => {
    render();
    announce();
  });
  on('live', render);
  on('role', face);
  render();
  face();
}
