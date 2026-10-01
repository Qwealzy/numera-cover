import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// VITE_EXPLORER_URL is read at module load, so each case imports config/ui fresh with its own env.
async function load(explorer: string | undefined) {
  vi.resetModules();
  vi.unstubAllEnvs();
  if (explorer !== undefined) vi.stubEnv('VITE_EXPLORER_URL', explorer);
  const config = await import('../config');
  const ui = await import('./ui');
  return { config, ui };
}
const HASH = '0x3fb5c7073c2b9add2005ac541ac6626bb8b147c68c9ef1e0a35739df86166d44';
const ADDR = '0x66DDA666bf32Cae48cf190bbAd04Effc90b7d5e7';

afterEach(() => vi.unstubAllEnvs());

describe('no explorer configured (default)', () => {
  it('builds no URL, no viem blockExplorers, and renders no external link', async () => {
    const { config, ui } = await load(undefined);
    expect(config.EXPLORER_URL).toBe('');
    expect(config.txUrl(HASH)).toBeUndefined();
    expect(config.addrUrl(ADDR)).toBeUndefined();
    expect(config.hyperEvmTestnet.blockExplorers).toBeUndefined();
    const html = renderToStaticMarkup(
      createElement('div', null, createElement(ui.TxLink, { hash: HASH, label: 'buy' }), createElement(ui.Addr, { a: ADDR })),
    );
    expect(html).not.toMatch(/<a\b/);
    expect(html).not.toMatch(/href=/);
    expect(html).not.toMatch(/hyperpc|purrsec|hypurrscan/);
    expect(html).toContain('0x3fb5…6d44'); // short hash shown
    expect(html).toContain('0x66DD…d5e7'); // short address shown
    expect(html.match(/class="copy-btn"/g)).toHaveLength(2); // a copy button for each
  });

  it('a blank or whitespace value also means "no explorer"', async () => {
    const { config } = await load('  ');
    expect(config.EXPLORER_URL).toBe('');
    expect(config.txUrl(HASH)).toBeUndefined();
  });
});

describe('explorer configured', () => {
  it('keeps the explorer link path working (trailing slash trimmed)', async () => {
    const { config, ui } = await load('https://explorer.example/');
    expect(config.txUrl(HASH)).toBe(`https://explorer.example/tx/${HASH}`);
    expect(config.addrUrl(ADDR)).toBe(`https://explorer.example/address/${ADDR}`);
    expect(config.hyperEvmTestnet.blockExplorers?.default.url).toBe('https://explorer.example');
    const html = renderToStaticMarkup(createElement('div', null, createElement(ui.TxLink, { hash: HASH }), createElement(ui.Addr, { a: ADDR })));
    expect(html).toContain(`href="https://explorer.example/tx/${HASH}"`);
    expect(html).toContain(`href="https://explorer.example/address/${ADDR}"`);
  });
});
