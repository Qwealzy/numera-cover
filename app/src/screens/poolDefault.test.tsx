import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_POOL_KEY, POOLS, SWITCH_POOL_KEYS, resolvePoolKey } from '../config';

const h = vi.hoisted(() => ({ key: '' }));
vi.mock('../state', async () => {
  const cfg = await import('../config');
  return {
    useApp: () => ({ setTab: () => {}, stats: { data: undefined }, pool: cfg.POOLS[h.key] }),
  };
});

describe('default pool is v2', () => {
  it('defaults to a v2 key and the switch offers only v2 pools', () => {
    expect(POOLS[DEFAULT_POOL_KEY].version).toBe('v2');
    expect(SWITCH_POOL_KEYS.length).toBe(2);
    for (const k of SWITCH_POOL_KEYS) expect(POOLS[k].version).toBe('v2');
    expect(POOLS.hypercore).toBeDefined();
    expect(POOLS.mock).toBeDefined();
  });
  it('ignores a stored v1 key without ?pool=', () => {
    expect(resolvePoolKey(null, 'hypercore')).toBe(DEFAULT_POOL_KEY);
    expect(resolvePoolKey(null, 'mock')).toBe(DEFAULT_POOL_KEY);
    expect(resolvePoolKey(null, 'mock-v2')).toBe('mock-v2');
    expect(resolvePoolKey(null, 'bogus')).toBe(DEFAULT_POOL_KEY);
  });
  it('?pool=<v1 key> still works, and wins over a stored key', () => {
    expect(resolvePoolKey('hypercore', null)).toBe('hypercore');
    expect(resolvePoolKey('mock', 'hypercore-v2')).toBe('mock');
    expect(resolvePoolKey('bogus', 'mock-v2')).toBe('mock-v2');
  });
});

describe('About shows the active pool address', () => {
  it('renders the active pool, not v1', async () => {
    const { About } = await import('./About');
    for (const k of SWITCH_POOL_KEYS) {
      h.key = k;
      const html = renderToStaticMarkup(<About />);
      const a = POOLS[k].pool;
      expect(html.toLowerCase()).toContain(a.slice(2, 8).toLowerCase());
      if (POOLS.hypercore.pool !== a) expect(html.toLowerCase()).not.toContain(POOLS.hypercore.pool.slice(2, 8).toLowerCase());
    }
  });
});
