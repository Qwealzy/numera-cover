# Numera waitlist v2

An interactive early-access page for Numera Liquidation Cover, with a waitlist for Hyperliquid traders and
USDC underwriters. Astro 5 builds it to static output. Cloudflare Pages serves it, with one Pages Function
(`functions/api/join.ts`) backed by a D1 table.

The waitlist backend is copied from `site/` and stays drop-in compatible:

- the same `/api/join` request and response;
- the same Turnstile check, D1 binding `DB` and migration `0001`;
- the same build-env guard.

This folder is standalone. It is not merged into `site/` and does not replace it.

Testnet only. Not an offer. Nothing on the page is a quote.

## Run, build, test

```bash
npm ci
npm test               # node --test: waitlist handler, chain reads, build env, copy rules, contrast, grid parity,
                       # tail-table hash guard, personal-data scan (src, public and dist), no faded text (opacity lint)
npm run build          # dist/ (a dev build leaves the /privacy placeholders visible)
npm run check:dist     # no inline scripts, no data:/blob:, only allowed origins, no explorer links,
                       # no uncompiled :global( selector
npm run size           # gzipped JS loaded before interaction (budget: target 60 KB, cap 200 KB)
npm run licenses       # direct and transitive license report
npm run local:db       # apply migrations/ to the local D1
npm run local:serve    # wrangler pages dev on http://127.0.0.1:4471 with Turnstile TEST keys
npm run grid           # regenerate src/data/grid.json with the repo's engine (needs engine/.venv)
```

The dev and local servers bind to `127.0.0.1:4471`.

### Build environment

These variables are read by `src/lib/buildenv.mjs`, which is copied unchanged from `site/`.

| Variable | Effect |
|---|---|
| `SITE_ENV=production` | The build fails unless every value below is set |
| `SITE_CONTROLLER_NAME` | Fills `{{CONTROLLER_NAME}}` on `/privacy` |
| `SITE_DELETE_BY` | A `YYYY-MM-DD` date; fills `{{DELETE_BY}}` |
| `PUBLIC_TURNSTILE_SITEKEY` | Required in production, and a Cloudflare test key is refused there. Dev builds fall back to the always-pass test key. |
| `SITE_LEGAL_REVIEWED=1` | Hides the "Pending legal review" badge |

- Pages secrets: `TURNSTILE_SECRET` and `IP_HASH_SALT`.
- D1 binding: `DB`, set in `wrangler.toml`. The database id is a placeholder.

**Deploying is founder-run.** No agent deploys this folder, and nothing here writes to any chain.

## What is live, what is static, what is illustrative

| On the page | Kind | Source |
|---|---|---|
| BTC oracle price (hero entry, $ levels, Oracle panel) | LIVE, read in the browser | `oraclePx6(perp)` on the HyperCore price source in `deployments/testnet-v2.json` (`pools.hypercore.priceSource`; the BTC index comes from the same file). The MOCK price source is never read. |
| Ledger: total, free, locked, covers, paused | LIVE, read in the browser | The MOCK v2 pool (`pools.mock.pool`), labelled "TESTNET DEMO POOL", "USDC (test tokens)" and "team test runs" |
| Premium, touch chance, priced chance, refusals in the hero | Illustrative: precomputed by the repo's own pricing code | `src/data/grid.json`, written by `scripts/gen-grid.py` with `engine/numera_engine/pricing.py` and `poolv2.py`. Volatility is a preset (32 / 40 / 50 %), not live. The same numbers appear in the estimate strip on the stage, the quote card in S3 and the "your setup sits here" marker on the S4 table. |
| Liquidation and level distances | Formula | Isolated position, entry = spot, first margin tier, `mm = 1/(2·maxLev)`; the level sits 1 % of liq toward spot (`app/src/config.ts LEVEL_BUFFER`). The page says so next to the readout, and shows the modelled $ levels in whole dollars. |
| Hero price path | SIM | A random path drawn in the browser, labelled SIM. It is not market data. |
| Wick lanes (S2) | Scripted | One scripted wick, labelled "Scripted path, not market data." |
| Reservation toy (S5) | SIM | A toy pool, not the live pool. It shows % and blocks only. |
| Recorded run (S6) | Static record | `deployments/testnet-v2.json` `e2e_F9_2026-10-02_3`. Verify any hash with `cast receipt`. |
| Figures (">$19B", "≈6,300", "≈$1.76B", the grid table, the evidence lines) | Static, with the source named on the page | README Problem and Evidence; `docs/pitch/business-plan.md`; `engine/reports/calibration.md` |

- Live reads run on load, then every 25 s, and only while the tab is visible. The endpoint that answered is
  remembered for the page view, so a periodic read is just its `eth_call`s (no chain re-check each time); after
  a failure there the endpoints are re-picked with the chain check, the failed one last.
- A failed read shows "—". No number is ever filled in.
- The page uses only the two testnet RPC origins and Turnstile; the CSP in `public/_headers` is unchanged from `site/`.

### The premium grid

`scripts/gen-grid.py` runs the repo's own `pricing.py` and `poolv2.py` for every cell, so no pricing formula is
re-implemented in the browser. A cell is one combination of:

- BTC with max leverage 40;
- long or short;
- leverage from 2× to 40×;
- duration 1h, 4h, 1d, 3d or 7d;
- σ of 0.32, 0.40 or 0.50.

Each cell also stores the priced probability `max(p·k, q)` (`pricing.priced_prob`) and whether the
empirical tail floor `q` set it, so the readout can show why the premium is far above the raw model chance
(10× long, 1d: model below 0.01 %, priced 2.03 % by the tail floor, $2.44 per $100 payout).

The generator follows the order of `quote_api.quote()`:

1. the σ level floor;
2. the v2 level floor of 56 bps;
3. the GBM touch probability;
4. the tail table;
5. `prob_too_high` above 0.5;
6. the v2 premium floor of 0.20 %.

`test/grid.test.ts` checks the grid against the content brief's samples (§4b), to within $0.01. Examples:

- 10× long, 1d: $2.43 per $100 payout;
- 10× long, 7d: $25.11;
- 20× long, 7d: refused;
- 40×: refused as `level_too_close`.

The readout rounds premiums **up** to the cent, so the default scene shows $2.44.

The tail table is copied into `src/data/` and a test guards it against drift. The test requires its sha256 to match all
three of:

- `engine/reports/tail_multipliers.json`;
- the copy in `src/data/`;
- the hash recorded in `grid.json`.

## Files

| Path | What |
|---|---|
| `functions/api/join.ts`, `src/server/waitlist.ts`, `migrations/` | Copied from `site/` (`/api/join`, D1, Turnstile) |
| `src/lib/buildenv.mjs`, `src/lib/chain.ts` | Copied from `site/`. `chain.ts` adds the ledger and oracle reads below the original code. |
| `src/copy/en.ts` | Every visible string. Figures carry their source in a comment. |
| `src/lib/pricing.ts`, `geometry.ts`, `lanes.ts`, `cascade.ts` | Pure modules shared by the build (static SVG fallback) and the browser |
| `src/client/*.ts` | The browser code: one rAF scheduler (`motion.ts`), the instrument, lanes, the six parts, the price-table marker (`price.ts`), the toy, live reads, the recorded run and the form |
| `test/opacity.test.mjs` | Fails on any partial `opacity` in component or global CSS outside a short list of decorative selectors: a state is never shown by fading text |
| `src/pages/privacy.astro` | The notice from `site/`, restyled. Only the Recipients sentence changed, so the version is now `privacy-2026-10-02-v2`, and `privacy-2026-10-02` is still accepted. |
| `public/_headers`, `robots.txt`, `favicon-32.png`, `numera-mark-60.png` | Copied from `site/` (the CSP is unchanged) |
| `public/boot.js` | Runs before paint. It sets the motion state and is an external file, because the CSP has no inline scripts. |
| `public/grain.png` | Film grain in the paper colour, written by `scripts/gen-grain.mjs` |

## The hero instrument in short

- One setup is one cover, and a cover pays once (on chain it becomes Paid in the trigger transaction). A new
  cover starts on Replay or on a control change. Touching again says "Already paid".
- A setup the engine refuses (40×; 20× for 7 days) has no cover: the level is drawn dashed, the wallet tile
  reads "no cover at these settings", and a pull pays nothing.
- The verdict line describes what has happened, when it happens ("Watching…" until the scripted touch).
- "I underwrite" turns the wallet tile into the pool tile: premium in, $100 reserved, $100 paid out on a touch.
- Hovering a readout row lights its line or tile on the stage, and a pointer near a line lights its row.
- The intro starts only when what it carries is on screen: the level line (with the touch and the `trigger()`
  stamp) and the whole wallet tile. On phones that means scrolling the stage into view; until then it reads
  "Watching…".
- The price head keeps a column of its own left of the line labels at every leverage. A level label too close
  to entry moves to the far side of its line, labels never cover the LIVE/SIM tags, the wallet tile or the
  estimate strip, and each label has a flat ground-colour backing so no line runs through its text.

## Motion and accessibility

- **Scheduler.** One rAF scheduler runs every loop. A loop runs only while it is on screen, the tab is visible and
  motion is on. `<html data-loops>` shows how many loops are running.
- **Motion off.** Motion turns off when the OS asks for reduced motion (also when that setting changes while the
  page is open), when the nav **Motion** switch is turned off (saved in `localStorage`, every access wrapped in
  try/catch) or when the hero **Pause motion** button is pressed. The switch has the fixed name "Motion" and
  `aria-pressed`; the hero button's label says what a press does ("Pause motion" / "Resume motion").
- **Reveals fail open.** Section blocks are hidden for their entry reveal only after the page module has attached
  its observers (`html.reveals`). If it never does, `boot.js` adds `html.reveal-fail` after 3.5 s and everything
  shows. A block reveals at 12 % visible or when a quarter of the viewport shows it, so blocks taller than the
  viewport (400 % zoom) still appear.
- **The reduced path.** It has the same text, and every state shows at once:
  - the hero shows the end frame of the staged wick;
  - pulling the wick redraws instantly;
  - the lanes show their end frames.
- **Canvas.** The canvas is `aria-hidden`; every meaning is also in DOM text. The price head is a real
  `role="slider"`. Arrow keys pull the wick and stop exactly on the level, then just past liquidation.
- **Without JS:**
  - the static SVG hero and its readout show;
  - the six parts are plain sections, each with its own heading (the tablist roles are added by script);
  - the form is replaced by the noscript line.
- **Without a 2D canvas** the SVG redraws itself for every setup from the same geometry module, the pull hints
  are hidden, and S3 drops its empty stage.

## Dependencies

Direct dependencies (the license is the field npm reports):

| Package | Version | License | Use |
|---|---|---|---|
| `astro` | 5.18.2 | MIT | Build |
| `@fontsource-variable/instrument-sans` | 5.3.0 | OFL-1.1 | Display and body font. Only the Latin width-axis file is used, and it is self-hosted. |
| `@fontsource-variable/jetbrains-mono` | 5.3.0 | OFL-1.1 | Mono font for machine numbers. Only the Latin file is used, and it is self-hosted. |
| `wrangler` (dev) | 4.147.0 | MIT OR Apache-2.0 | Local Pages and D1 server. Deploying stays founder-run. |

The page ships no UI framework, animation library, 3D library or web3 library. There is no GSAP and no
source-available package.

Transitive summary (`npm run licenses`, 310 packages):

| Count | License |
|---|---|
| 264 | MIT |
| 11 | ISC |
| 9 | BSD-2-Clause |
| 8 | Apache-2.0 |
| 3 | MIT OR Apache-2.0 |
| 3 | CC0-1.0 |
| 3 | BSD-3-Clause |
| 2 | OFL-1.1 |
| 2 | Apache-2.0 AND LGPL-3.0-or-later |
| 2 | BlueOak-1.0.0 |
| 1 | Python-2.0 |
| 1 | MIT OR CC0-1.0 |
| 1 | no license field |

### `npm audit`

`npm audit` reports astro (critical), sharp (high) and esbuild (low). The only fix it offers is astro 7, a
breaking upgrade; 5.18.2 is the newest astro 5 release, and `site/` uses the same line. None of the advisories
reaches this build:

- **astro** (XSS through `define:vars`, spread attributes, slot names and view-transition values; server-island
  replay; a prerendered error-page SSRF; AVIF optimisation; base-path stripping): the site is static output with
  no server islands, no SSR adapter, no `define:vars`, no view transitions, no image optimisation and no
  configured base. Every value rendered at build time comes from this repository, never from a visitor.
- **sharp / libvips / libheif**: sharp is an optional install of astro and wrangler; this build processes no
  images, and nothing from sharp ships.
- **esbuild** (a file read through the dev server on Windows): the dev and local servers bind to `127.0.0.1`
  only, and production serves static files.

These packages fall outside the MIT / ISC / Apache-2.0 / BSD / 0BSD / OFL / BlueOak / Unlicense / CC0 allowlist,
for the architect to see:

- `@img/sharp-win32-x64@0.34.5` and `@0.35.4`: Apache-2.0 AND LGPL-3.0-or-later. These are the prebuilt libvips
  binaries of `sharp`, an optional image tool that `astro` and `wrangler`/`miniflare` pull in. They run only at
  build or dev time, and nothing from them is shipped.
- `argparse@2.0.1`: Python-2.0, the OSI-approved PSF license. It comes from `astro` through `js-yaml` and runs at
  build time only.
- `zod-to-ts@1.2.0`: no license field in `package.json`; its LICENSE file is MIT. It comes from `astro` and runs
  at build time only.

`site/` has the same tree, because it uses the same `astro` and `wrangler`.

## Open decisions (for the architect or founder; not acted on here)

1. **Role field.** The trader/underwriter "doors" change wording only, and the wire format is identical to
   `site/`. Storing a role would take five changes:
   - an optional request field `role`, one of `trader`, `underwriter` or `both`, validated after `channel`;
   - a new error, 400 `role`;
   - a migration, `0002_role.sql`:
     `ALTER TABLE waitlist ADD COLUMN role TEXT CHECK (role IS NULL OR role IN ('trader','underwriter','both'));`;
   - "What we store" in the notice gains the role;
   - a `CONSENT_VERSION` bump.

   Duplicates keep `DO NOTHING`.
2. **Pages project and D1 database.** `wrangler.toml` names `numera-cover` and `numera-waitlist`, as `site/` does.
   If both sites write the same database, `CONSENT_VERSIONS` already lists both notice versions.
3. **More perps.** The estimator is BTC-only (max leverage 40×, from `docs/research/hyperliquid.md`). ETH, SOL and
   HYPE would need their max leverage from a source the architect accepts, plus grid rows for each value. The
   page reads no perp metadata; the privacy notice's Recipients sentence says exactly what is read (the pool
   statistics and the BTC oracle price).

License: AGPL-3.0-only (repo). Fonts: SIL OFL 1.1.
