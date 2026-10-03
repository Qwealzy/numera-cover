# Numera waitlist v2

An interactive early-access page for Numera Liquidation Cover, with a waitlist for Hyperliquid traders and
USDC underwriters. Astro 5 builds it to static output. Cloudflare Pages serves it, with one Pages Function
(`functions/api/join.ts`) backed by a D1 table.

The waitlist backend started as a copy of `site/` and has diverged since 2026-10-03:

- `/api/join` takes a required `email` (trimmed and lowercased, at most 254 characters, a pragmatic syntax check,
  no MX lookup; dots and `+tags` are kept) and two optional fields, `telegram` and `x` (either, both or none),
  each validated with the original handle rules and stored as the bare lowercase name;
- the email is the unique key: a duplicate returns the same 200 and stores nothing new;
- migration `0002_email.sql` rebuilds the `waitlist` table (`email` unique, `telegram` and `x` nullable; the old
  `handle_norm`/`channel` pair is kept only for rows from `0001`, which keep no email). 0002 was revised in place on
  2026-10-03 before any deploy;
- the same JSON-only rule, size cap, rate limit (5 per salted IP hash per hour) and Turnstile order as before.

**Do not deploy this folder and `site/` against the same D1 database.** `site/`'s handler inserts with
`ON CONFLICT(handle_norm) DO NOTHING`; after `0002` `handle_norm` has no unique constraint, so every `site/` signup
would fail with a 500, and `site/`'s form sends no email, which this handler refuses with 400 `email`. Only one of
the two is meant to be deployed.

This folder is standalone. It is not merged into `site/` and does not replace it.

Testnet only. Not an offer. Nothing on the page is a quote.

## Run, build, test

```bash
npm ci
npm test               # node --test: waitlist handler, migrations on SQLite, chain reads, build env, copy rules, contrast, grid parity,
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

These variables are read by `src/lib/buildenv.mjs`, which started as a copy of `site/`'s.

| Variable | Effect |
|---|---|
| `SITE_ENV=production` | The build fails unless every value below is set |
| `SITE_CONTROLLER_NAME` | Fills `{{CONTROLLER_NAME}}` on `/privacy` |
| `SITE_DELETE_BY` | A `YYYY-MM-DD` date; fills `{{DELETE_BY}}` |
| `SITE_GOVERNING_LAW` | The law that governs the terms of use; fills `{{GOVERNING_LAW}}` on `/terms` |
| `SITE_SOURCE_URL` | The PUBLIC source repository (https URL); the footer "Source" link (AGPL-3.0 section 13). The deploy script refuses the private origin repository. |
| `PUBLIC_TURNSTILE_SITEKEY` | Required in production, and a Cloudflare test key is refused there. Dev builds fall back to the always-pass test key. |
| `SITE_LEGAL_REVIEWED=1` | Hides the "Pending legal review" badge |

- Pages secrets: `TURNSTILE_SECRET` and `IP_HASH_SALT`.
- D1 binding: `DB`, set in `wrangler.toml`. The database id is a placeholder.

**Deploying is founder-run.** `node scripts/deploy-site.mjs` (repo root) builds and deploys this folder and applies migrations 0001 + 0002 to the remote D1; it prints the plan first, `--yes` runs a preview deploy, `--prod --yes` production. No agent deploys this folder, and nothing here writes to any chain.

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
| Recorded run (S6) | Static record | `deployments/testnet-v2.json` `e2e_F9_2026-10-02_3`: a block track and three receipt cards (block, call, status 1). A playhead sweeps blocks 484-491, the three calls light up in turn, then the 3 s bracket draws; it holds and loops (`RUN_*` in `src/lib/timing.ts`), stops off screen, and shows the finished run with reduced motion. No hashes are shown. |
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
| `functions/api/join.ts`, `src/server/waitlist.ts`, `migrations/` | Started from `site/` (`/api/join`, D1, Turnstile); email required, Telegram and X each optional since `0002` |
| `src/lib/buildenv.mjs`, `src/lib/chain.ts` | Copied from `site/`. `chain.ts` adds the ledger and oracle reads below the original code. |
| `src/copy/en.ts` | Every visible string. Figures carry their source in a comment. |
| `src/lib/pricing.ts`, `geometry.ts`, `lanes.ts`, `cascade.ts` | Pure modules shared by the build (static SVG fallback) and the browser |
| `src/client/*.ts` | The browser code: one rAF scheduler (`motion.ts`), the instrument, lanes, the six parts, the price-table marker (`price.ts`), the toy, live reads and the form |
| `test/opacity.test.mjs` | Fails on any partial `opacity` in component or global CSS outside a short list of decorative selectors: a state is never shown by fading text |
| `src/pages/privacy.astro` | The notice from `site/`, restyled. Version `privacy-2026-10-03` adds the email (category, purpose: launch and testnet notices only, retention, how to unsubscribe) and the explicit e-message consent (Law No. 6563); `privacy-2026-10-02-v2` and `privacy-2026-10-02` are still accepted. |
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
- The intro holds the Numera mark still for `INTRO_HOLD_S` (0.9 s), then folds it into the liquidation line and the
  level over `INTRO_MORPH_S` (1.8 s); the path and the scripted wick follow. Every intro time is a named constant in
  `src/lib/timing.ts`.
- The intro starts only when what it carries is on screen: the level line (with the touch and the `trigger()`
  stamp) and the whole wallet tile. On phones that means scrolling the stage into view; until then it reads
  "Watching…".
- **Autoplay.** With nobody pulling, a scripted wick touches the level every `AUTO_PERIOD_S` (7 s): each run sells
  a new cover, shows "Watching…" for `AUTO_LEAD_S` (1 s), then the touch, the stamp and the payout, then calm. A drag
  or a key on the price head pauses it until `AUTO_RESUME_S` (9 s) without input. It also stops while the stage is
  off screen, the tab is hidden, motion is paused or the OS asks for reduced motion. Auto verdicts update the live
  region silently, so a screen reader is not interrupted every few seconds. Scheduler and constants:
  `src/lib/timing.ts` (`createAutoplay`), tested with fake timers in `test/autoplay.test.ts`.
- The price head keeps a column of its own left of the line labels at every leverage. A level label too close
  to entry moves to the far side of its line, labels never cover the LIVE/SIM tags, the wallet tile or the
  estimate strip, and each label has a flat ground-colour backing so no line runs through its text.

## Motion and accessibility

- **Scheduler.** One rAF scheduler runs every loop. A loop runs only while it is on screen, the tab is visible and
  motion is on. `<html data-loops>` shows how many loops are running.
- **Motion off.** Motion is on for everyone, except when the OS asks for reduced motion (also when that setting
  changes while the page is open) or when the hero **Pause motion** button is pressed (this page view only; the
  label says what a press does, "Pause motion" / "Resume motion"). There is no site-wide motion switch, and the
  page reads and writes no browser storage (no `localStorage`, no cookies of its own).
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
| `three` | 0.186.1 | MIT | The 3D Numera mark behind the join section. Self-bundled, loaded lazily (see below). |
| `@types/three` (dev) | 0.186.0 | MIT | Types for the above |
| `wrangler` (dev) | 4.147.0 | MIT OR Apache-2.0 | Local Pages and D1 server. Deploying stays founder-run. |

The page ships no UI framework, animation library or web3 library, and no 3D library in its first load. There is
no GSAP and no source-available package.

**The join-section mark.** The flat SVG mark sits behind the join section's headline and intro (the left column,
not the kicker or the form) at `--join-mark-opacity` (0.3, in `src/styles/tokens.css`); on narrow screens that
block sits above the form. When the section comes within `JOIN_MARK_ROOT_MARGIN` (600 px) of the viewport, motion
is on and WebGL works, `src/client/joinmark.ts` imports `src/client/mark3d.ts`, a separate chunk with three.js
(about 140 KB gz, same origin, so the CSP is unchanged), which extrudes the same two polygons and swings them gently
(`MARK_SWING_RAD` ±35°, `MARK_SWING_PERIOD_S` 9 s, `MARK_TILT_RAD` 0.12, device pixel ratio capped at `MARK_MAX_DPR`
2), so the mark is never seen edge-on; the camera keeps the whole mark inside its box. The box has a fixed height
(`--join-mark-h`, 18rem; 15rem on phones), so opening the Telegram/X block never resizes the mark. It renders through the page's rAF scheduler, so it stops off
screen, in a hidden tab and with motion off. Reduced motion or no WebGL keeps the flat mark.
`test/contrast.test.mjs` takes the mark's brightest pixel as white: at 0.3 the headline reads 6.17:1 (large text,
3:1 needed) and the intro 4.50:1 (4.5:1 needed).
The loader adds 0.7 KB gz to the first load (`npm run size`: 34.9 KB before, 35.6 KB after).

Transitive summary (`npm run licenses`, 318 packages):

| Count | License |
|---|---|
| 271 | MIT |
| 11 | ISC |
| 9 | BSD-2-Clause |
| 9 | Apache-2.0 |
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

1. **Role field.** The form no longer asks whether a visitor trades or underwrites (the "I would" toggle was
   removed), and the wire format carries no role. Storing a role would take five changes:
   - an optional request field `role`, one of `trader`, `underwriter` or `both`, validated after `channel`;
   - a new error, 400 `role`;
   - a migration, `0003_role.sql`:
     `ALTER TABLE waitlist ADD COLUMN role TEXT CHECK (role IS NULL OR role IN ('trader','underwriter','both'));`;
   - "What we store" in the notice gains the role;
   - a `CONSENT_VERSION` bump.

   Duplicates keep `DO NOTHING`.
2. **Pages project and D1 database.** `wrangler.toml` names `numera-cover` and `numera-waitlist`, as `site/` does.
   Since migration `0002` the two backends are not compatible on one database (see the top of this file).
3. **More perps.** The estimator is BTC-only (max leverage 40×, from `docs/research/hyperliquid.md`). ETH, SOL and
   HYPE would need their max leverage from a source the architect accepts, plus grid rows for each value. The
   page reads no perp metadata; the privacy notice's Recipients sentence says exactly what is read (the pool
   statistics and the BTC oracle price).
4. **Email delivery.** The page now collects email addresses for one launch email. Which service sends it is not
   decided; once it is, the privacy notice's Recipients section must name it (and the notice version moves on).

License: AGPL-3.0-only (repo). Fonts: SIL OFL 1.1.
