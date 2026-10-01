// usePurchaseTx without a DOM: React's hooks are replaced by a minimal single-component hook runner
// (state slots, effects run after render when their deps change), enough for this hook's logic.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cover } from '../lib/pool';

const h = vi.hoisted(() => {
  type Slot = { v?: unknown; deps?: unknown[]; cleanup?: (() => void) | void };
  let slots: Slot[] = [];
  let idx = 0;
  let effects: (() => void)[] = [];
  const same = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const react = {
    useState(init: unknown) {
      const i = idx++;
      if (!(i in slots)) slots[i] = { v: typeof init === 'function' ? (init as () => unknown)() : init };
      const set = (v: unknown) => {
        slots[i].v = typeof v === 'function' ? (v as (p: unknown) => unknown)(slots[i].v) : v;
      };
      return [slots[i].v, set];
    },
    useMemo(fn: () => unknown, deps: unknown[]) {
      const i = idx++;
      if (slots[i] && same(slots[i].deps, deps)) return slots[i].v;
      slots[i] = { v: fn(), deps };
      return slots[i].v;
    },
    useCallback(fn: unknown, deps: unknown[]) {
      return react.useMemo(() => fn, deps);
    },
    useRef(v: unknown) {
      const i = idx++;
      slots[i] ??= { v: { current: v } };
      return slots[i].v;
    },
    useEffect(fn: () => (() => void) | void, deps: unknown[]) {
      const i = idx++;
      const prev = slots[i];
      if (prev && same(prev.deps, deps)) return;
      slots[i] = { deps, cleanup: prev?.cleanup };
      effects.push(() => {
        if (typeof prev?.cleanup === 'function') prev.cleanup();
        slots[i].cleanup = fn();
      });
    },
  };
  return {
    react,
    find: (() => Promise.resolve(undefined)) as (...a: unknown[]) => Promise<unknown>,
    render<T>(hook: () => T): T {
      idx = 0;
      const r = hook();
      const fx = effects;
      effects = [];
      fx.forEach((f) => f());
      return r;
    },
    reset() {
      slots = [];
      effects = [];
    },
  };
});

vi.mock('react', () => h.react);
vi.mock('../hooks', () => ({ usePoll: vi.fn() }));
vi.mock('../state', () => ({ useApp: vi.fn() }));
vi.mock('../lib/covers', async (orig) => {
  const m = await orig<typeof import('../lib/covers')>();
  return { ...m, lookupPurchase: (p: `0x${string}`, c: Cover, o: object) => m.lookupPurchase(p, c, { ...o, find: (...a) => h.find(...a) as never }) };
});

const { usePurchaseTx } = await import('./useCovers');
const { resetPurchaseLookups } = await import('../lib/covers');

const POOL = '0xDa611E1a07260005ea5641e9Fe633CD4d10C341e' as const;
const cover = { id: 1n, start: 1790890665n } as Cover;
const TX = { tx: '0x3fb5c7073c2b9add2005ac541ac6626bb8b147c68c9ef1e0a35739df86166d44' as const, block: 65774354n };
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('usePurchaseTx: auto vs idle / locate', () => {
  beforeEach(() => {
    h.reset();
    resetPurchaseLookups();
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  it('auto = false: idle, no lookup; retry() ("locate") starts it, then pending, then the hash', async () => {
    const find = vi.fn(async () => TX);
    h.find = find;
    let r = h.render(() => usePurchaseTx(POOL, cover, undefined, false));
    expect(r).toMatchObject({ idle: true, pending: false, tx: undefined });
    r = h.render(() => usePurchaseTx(POOL, cover, undefined, false));
    expect(find).not.toHaveBeenCalled();
    r.retry();
    r = h.render(() => usePurchaseTx(POOL, cover, undefined, false)); // effect runs: lookup starts
    r = h.render(() => usePurchaseTx(POOL, cover, undefined, false));
    expect(r).toMatchObject({ idle: false, pending: true });
    await flush();
    r = h.render(() => usePurchaseTx(POOL, cover, undefined, false));
    expect(find).toHaveBeenCalledOnce();
    expect(r).toMatchObject({ idle: false, pending: false, tx: TX });
  });

  it('auto = true: the lookup starts on mount', async () => {
    const find = vi.fn(async () => TX);
    h.find = find;
    h.render(() => usePurchaseTx(POOL, cover, undefined, true));
    expect(h.render(() => usePurchaseTx(POOL, cover, undefined, true))).toMatchObject({ pending: true, idle: false });
    await flush();
    expect(h.render(() => usePurchaseTx(POOL, cover, undefined, true))).toMatchObject({ pending: false, tx: TX });
    expect(find).toHaveBeenCalledOnce();
  });

  it('a hash known from the recent-events scan is used as is: no lookup', () => {
    const find = vi.fn(async () => TX);
    h.find = find;
    const r = h.render(() => usePurchaseTx(POOL, cover, TX, true));
    expect(r).toMatchObject({ tx: TX, pending: false, idle: false });
    expect(find).not.toHaveBeenCalled();
  });
});
