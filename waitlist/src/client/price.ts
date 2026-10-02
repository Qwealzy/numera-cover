// S4: places the visitor's hero setup on the sourced table. Same grid and rounding as the readout; the marker
// says "sits here" only when the setup's level is that row (within 0.6 points) and its premium lies inside
// the cell's printed range, so the table never appears to confirm a number it does not show.
import { estimate, premiumDollars, fmtUsd, fmtPct } from '../lib/pricing.ts';
import { price as Pr } from '../copy/en.ts';
import { state, on } from './store.ts';

function range(text: string): [number, number] | null {
  const m = text.match(/\$([\d.]+)(?:-([\d.]+))?/);
  if (!m) return null;
  const a = Number(m[1]);
  return [a, m[2] ? Number(m[2]) : a];
}

export function mountPriceYou(section: HTMLElement): void {
  const table = section.querySelector<HTMLTableElement>('[data-table]');
  const note = section.querySelector<HTMLElement>('[data-you]');
  if (!table || !note) return;
  const rows = [...table.querySelectorAll<HTMLTableRowElement>('tbody tr')];
  const heads = [...table.querySelectorAll<HTMLElement>('thead th')];
  const Y = Pr.you;

  function render() {
    const s = state.setup;
    const e = estimate(s);
    for (const el of table!.querySelectorAll('.you-col, .you-row, .you-cell')) el.classList.remove('you-col', 'you-row', 'you-cell');
    const lvl = e.lvlDist * 100;
    const lvlTxt = fmtPct(e.lvlDist);
    let text = '';
    let state_ = 'off';
    if (s.side !== 'long') text = Y.short;
    else if (e.refusal !== null) text = Y.refused;
    else if (s.dur !== 86400 && s.dur !== 604800) text = Y.other;
    else {
      const col = String(s.dur);
      for (const th of heads) if (th.dataset.col === col) th.classList.add('you-col');
      for (const td of table!.querySelectorAll<HTMLElement>(`td[data-dur="${col}"]`)) td.classList.add('you-col');
      const prem = premiumDollars(e.premium!);
      const row = rows.find((r) => Math.abs(Number(r.dataset.row) - lvl) <= 0.6);
      const cell = row?.querySelector<HTMLElement>(`td[data-dur="${col}"]`);
      const rg = cell ? range(cell.dataset.range ?? '') : null;
      if (row && cell && rg && prem >= rg[0] - 0.005 && prem <= rg[1] + 0.005) {
        row.classList.add('you-row');
        cell.classList.add('you-cell');
        text = Y.here(fmtUsd(prem), lvlTxt);
        state_ = 'here';
      } else {
        const first = Number(rows[0]?.dataset.row);
        const last = Number(rows[rows.length - 1]?.dataset.row);
        text = lvl > first && lvl < last ? Y.between(lvlTxt) : Y.notRow(lvlTxt);
      }
    }
    note!.textContent = text;
    note!.dataset.state = state_;
  }
  on('setup', render);
  render();
}
