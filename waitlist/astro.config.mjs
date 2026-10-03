import { defineConfig } from 'astro/config';
import { assertBuildEnv } from './src/lib/buildenv.mjs';

// SITE_ENV=production refuses to build while a /privacy placeholder or the Turnstile site key is missing.
// Without it (dev, local verification) the placeholders stay visible on the page.
assertBuildEnv();

// Static output, no adapter, no server runtime. The only server code is the Pages Function in functions/.
export default defineConfig({
  output: 'static',
  build: {
    inlineStylesheets: 'always',
    format: 'file', // /privacy -> privacy.html (Pages serves it at /privacy)
  },
  devToolbar: { enabled: false },
  server: { host: '127.0.0.1', port: 4471 },
  vite: {
    build: { assetsInlineLimit: 0 }, // fonts, images and scripts as files (CSP: no data: URLs, no inline scripts)
  },
});
