// Every user-visible English string of the waitlist site (v2). Started from site/src/copy/en.ts: the strings
// that tests and legal meaning depend on are kept verbatim (status pill, hero limit, six steps, demo-pool
// notes, waitlist messages, privacy notice). Word rules are enforced by test/copy.test.ts and
// test/copyrules.test.ts: say "cover", "payout", "level", "price" (what the trader pays), "underwriter", "pool".
// The banned-wording list lives in test/copyrules.test.ts (founder decision 2026-10-03).
// Sources of every figure are named in the comment next to it.

/** Version of the privacy notice a waitlist consent refers to. Bump it whenever the notice text changes;
 *  the server accepts only versions listed in CONSENT_VERSIONS. 2026-10-03 (`date`): the waitlist now takes an
 *  email address (required) and the consent names the launch email explicitly (Law No. 6563 on
 *  commercial electronic messages needs explicit consent). privacy-2026-10-02-v2 changed one Recipients sentence. */
export const CONSENT_VERSION = 'privacy-2026-10-03-v5';
/** Earlier versions stay accepted server-side (founder instruction 2026-10-03). Same day (`date` 2026-10-03):
 *  -v2 shortened the form's consent and jurisdiction statements (same meaning); -v3: a signup may give both a
 *  Telegram username and an X handle (notice and consent wording); -v4: the jurisdiction statement's
 *  wording (same meaning); -v5: the checkbox adds 18+ and the UK, the notice gains its KVKK section,
 *  GDPR Art. 13 items, cookies and the country check. */
export const CONSENT_VERSIONS: readonly string[] = [
  CONSENT_VERSION,
  'privacy-2026-10-03-v4',
  'privacy-2026-10-03-v3',
  'privacy-2026-10-03-v2',
  'privacy-2026-10-03',
  'privacy-2026-10-02-v2',
  'privacy-2026-10-02',
];

export const brand = {
  name: 'NUMERA',
  product: 'Liquidation Cover',
  markAlt: 'Numera mark',
};

export const nav = {
  label: 'Primary',
  skip: 'Skip to content',
  how: 'How it works',
  price: 'Price',
  underwriters: 'Underwriters',
  proof: 'Proof',
  join: 'Join the waitlist',
  joinShort: 'Join',
  joined: 'On the list',
};

export const hero = {
  eyebrow: 'Hyperliquid perps · HyperEVM testnet',
  // docs/pitch/submission-answers.md, consistency anchors
  titleLines: ['Keep the position.', 'Get paid if the', 'wick comes.'],
  title: 'Keep the position. Get paid if the wick comes.',
  // README one-liner + the test-enforced limit (content brief §1, §7)
  lead:
    'A fixed USDC payout if the oracle price touches a level just above your liquidation price before expiry. ' +
    'Your position stays open; the payout comes from a USDC pool on HyperEVM. It does not stop a liquidation ' +
    'and does not cover your full loss.',
  primary: 'Join the waitlist',
  secondary: 'How it works ↓',
  // the disclaimer on every page: this pill (hero, footer) is the one text; test/disclaimer.test.mjs
  status:
    'Testnet only · Mock funds, no real payout · Not insurance · Not an offer · Not available to US, UK or Ontario persons or sanctioned jurisdictions',
};

/** The instrument in the hero (build spec 2.3). */
export const instrument = {
  label: 'Liquidation cover instrument',
  liquidation: 'Liquidation',
  level: 'Your level',
  price: 'Price',
  entry: 'Entry',
  expiry: 'Expiry',
  wallet: 'Wallet',
  walletEmpty: 'no payout yet',
  walletNoCover: 'no cover at these settings',
  payoutChip: '+$100 payout (illustrative)',
  walletPaid: '+$100 (illustrative)',
  // the underwriter face of the same scene: the tile becomes the pool (the price from the grid, rounded up)
  pool: 'Pool',
  poolSold: (prem: string) => `+${prem} cover price · $100 reserved`,
  poolPaid: (prem: string) => `$100 paid out · ${prem} cover price kept`,
  poolNoSale: 'nothing sold, nothing reserved',
  poolChip: '−$100 to the buyer (illustrative)',
  positionOpen: 'Position: open',
  positionClosed: 'Position: closed',
  trigger: 'trigger()',
  sim: 'SIM · random path drawn in your browser. Not market data, not a quote.',
  simShort: 'SIM',
  liveShort: 'LIVE',
  livePrefix: 'LIVE · BTC · HyperEVM testnet oracle · read',
  liveWaiting: 'LIVE · BTC · HyperEVM testnet oracle · reading…',
  liveFailed: 'LIVE · BTC · testnet oracle read failed · levels shown in % of entry',
  keeper: 'Keeper check every ~3 s; every 1 s near the level',
  handle: 'Price. Drag it, or use the arrow keys, to pull a wick.',
  hint: 'Drag the price head down to the level, or focus it and press the arrow keys.',
  pullHint: 'pull the wick ↓',
  pause: 'Pause motion',
  resume: 'Resume motion',
  replay: 'Replay',
  verdicts: {
    none: 'No touch. No payout; the cover price stays with the pool.',
    touch: 'Touch. The pool pays; your position stays open.',
    liquidated: 'Touch and liquidation. The payout lands; the position is closed. Cover does not stop a liquidation.',
    // one setup is one cover, and a cover pays once (it becomes Paid in the trigger transaction)
    paid: 'Touch again. Already paid: a cover pays once. Replay or change the setup for a new cover.',
    paidLiquidated: 'Already paid: a cover pays once. The position is now closed; cover does not stop a liquidation.',
    refused: (reason: string) => `Not offered at these settings: no cover, so no payout. ${reason}`,
    reasonLevel: 'The level is too close to spot (testnet minimum 0.56 %).',
    reasonProb: 'The touch chance is too high.',
    newCover: 'New setup, new cover from now. Pull the wick to test it.',
    // the same events seen from the pool (I underwrite)
    uwNone: 'No touch. The $100 stays reserved; if expiry passes without a touch, the cover price stays with the pool.',
    uwTouch: 'Touch. The pool pays the reserved $100 to the buyer and keeps the cover price.',
    uwLiquidated: "Touch and liquidation. The pool pays the reserved $100; the buyer's position is closed.",
    uwPaid: 'Touch again. Already paid: the pool pays a cover once.',
  },
  watching: 'Watching the oracle price against your level…',
  introVerdict: 'The wick touched the level. The pool paid; the position stayed open.',
  strip: 'per $100 payout',
};

export const controls = {
  legend: 'Your setup',
  side: 'Side',
  long: 'Long',
  short: 'Short',
  leverage: 'Leverage',
  duration: 'Duration',
  volatility: 'Volatility',
  volatilityNote: 'a preset, not live',
  // docs/pitch/business-plan.md volatility range 32-50 %
  vols: [
    { id: 'calm', label: 'calm 32 %', sigma: 0.32 },
    { id: 'normal', label: 'normal 40 %', sigma: 0.4 },
    { id: 'wild', label: 'wild 50 %', sigma: 0.5 },
  ],
  // app/src/config.ts DURATIONS
  durations: [
    { label: '1h', sec: 3600 },
    { label: '4h', sec: 14400 },
    { label: '1d', sec: 86400 },
    { label: '3d', sec: 259200 },
    { label: '7d', sec: 604800 },
  ],
  perp: 'Perp',
  perpNote: 'BTC only in this estimate (max leverage 40×)',
  role: 'I am here to',
  trade: 'I trade',
  underwrite: 'I underwrite',
};

export const readout = {
  heading: 'Estimate',
  liquidation: 'Liquidation',
  level: 'Level',
  premium: 'Cover price',
  perPayout: 'per $100 payout',
  touch: 'Touch chance',
  touchNote: 'model, before tail adjustment',
  // engine/numera_engine/pricing.py priced_prob: max(p·k, q); q is the empirical floor fitted on Hyperliquid history
  priced: 'Priced chance',
  pricedFloor: 'tail floor from Hyperliquid history',
  pricedTail: 'model × tail multiplier from Hyperliquid history',
  pricedWhy: 'Why higher than the model',
  // src/lib/pricing.ts liqPrice: isolated position, entry = spot, first margin tier (mm = 1/(2·maxLev))
  isolated: 'Liquidation modelled for an isolated position opened at this price (first margin tier); yours may differ.',
  cap: "Payout cap: your position's margin",
  below: 'below entry',
  above: 'above entry',
  floor: 'raised to the testnet minimum (0.20 % of payout)',
  notOffered: 'Not offered',
  refusedLevel: 'Not offered: level too close to spot (testnet minimum 0.56 %)',
  refusedProb: 'Not offered: touch chance too high',
  stripRefusedLevel: 'Not offered (level too close)',
  stripRefusedProb: 'Not offered (touch chance too high)',
  label: 'Illustrative estimate, not a quote. Volatility is a preset, not live.',
  uwHeading: 'The pool side',
  liveWaiting: 'LIVE · testnet oracle · reading…',
  liveOk: (t: string) => `LIVE · $ at the BTC testnet oracle price · read ${t} UTC`,
  liveFailed: 'LIVE · testnet oracle read failed · % of entry only',
  uw: (premium: string) =>
    `The pool takes ${premium}. No touch: it stays with the pool. Touch: the pool pays $100, reserved in full when the cover was sold.`,
  uwRefused: 'Not offered at these settings, so the pool takes nothing and reserves nothing.',
};

/** S2, the problem. Sources: README "Problem"; docs/how-it-works.md §1. */
export const wick = {
  kicker: '01 · The wick',
  heading: 'A wick touches the liquidation price, then reverses.',
  body: [
    'The two defences today are lower leverage and a stop-loss.',
    'A stop closes the position, often at the bottom of a wick, and slips in a gap. Cover keeps the position open and pays cash.',
  ],
  end: 'Neither defence keeps the trader in the trade.',
  scripted: 'Scripted path, not market data.',
  scrubber: 'Wick timeline',
  replay: 'Replay',
  lanes: [
    { id: 'lev', title: 'Lower leverage', end: 'The position survives, but it is smaller.' },
    { id: 'stop', title: 'Stop-loss', fill: 'stop filled at the bottom', end: 'Price came back. The position did not.' },
    { id: 'cover', title: 'Cover', end: 'The level is touched, the payout lands and the position stays open.' },
  ],
  marks: { liq: 'liquidation', level: 'level', stop: 'stop', payout: '+payout', small: 'smaller position', open: 'open', closed: 'closed' },
  // README "Problem"; every figure keeps its source next to it (content brief §4a)
  figures: [
    { value: '>$19B', text: 'liquidated across crypto on 10 Oct 2025', source: 'Coinglass 2025 annual report' },
    {
      value: '≈6,300',
      text: 'Hyperliquid wallets in loss, >1,000 fully liquidated, 10 Oct 2025',
      source: 'CoinDesk, 2025-10-11',
    },
    { value: '≈$1.76B', text: 'liquidated on Hyperliquid in Sept 2026', source: 'compass.trade, on-chain fills' },
  ],
};

/** The six steps, verbatim from site/src/copy/en.ts (copy test: this order, one sentence each). */
export const steps = [
  {
    id: 'quote',
    label: 'Quote',
    text: 'The pricing engine estimates the chance that the oracle touches your level within the duration and signs a quote that is valid for about 30 seconds.',
  },
  {
    id: 'buy',
    label: 'Buy cover',
    text: 'You send the signed quote to the pool contract, which checks the signature, your open position and its limits, takes the cover price and reserves the full payout.',
  },
  {
    id: 'oracle',
    label: 'Oracle',
    text: 'The contract reads the Hyperliquid perp oracle price on-chain through a HyperEVM precompile, so no outside price feed is involved.',
  },
  {
    id: 'keeper',
    label: 'Keeper',
    text: 'A keeper watches every active cover and calls trigger when the oracle price reaches the level; anyone else may call it too.',
  },
  {
    id: 'pool',
    label: 'Pool',
    text: 'Underwriters deposit USDC and earn the cover prices; each payout is reserved at sale, so the pool cannot sell more cover than it can pay.',
  },
  {
    id: 'payout',
    label: 'Payout',
    text: 'The fixed USDC payout goes to your wallet in the trigger transaction; if the level is never touched before expiry, nothing is paid and the cover price stays with the pool.',
  },
] as const;

export const how = {
  kicker: '02 · How it works',
  heading: 'Six parts. One trigger rule.',
  intro: 'Select a part to watch it work. The stage runs on your setup from the instrument above.',
  tablist: 'The six parts',
  // docs/how-it-works.md §6 (quote TTL), §8 + backlog F18 (keeper cadence), README, en.ts step 6
  station: {
    quote: { title: 'Quote valid for about 30 seconds', note: 'Signed with EIP-712 by the engine; the contract recovers the signer.' },
    buy: {
      title: 'Purchase checks, in contract order, for your setup',
      note: 'testnet settings',
      pass: 'passes',
      fail: 'fails',
      chain: 'checked on chain at purchase',
      chainShort: 'on chain',
      skip: 'not reached',
      legend: [
        ['pass', 'passes'],
        ['fail', 'fails'],
        ['chain', 'on chain: checked on chain at purchase'],
        ['skip', 'not reached'],
      ],
      done: 'Cover price taken; the full payout is reserved.',
      stopped: 'Stopped here. Nothing is sold and nothing is reserved.',
    },
    oracle: { title: 'Oracle price, read on-chain', note: 'Validator median of 8 venues, read through precompile 0x…0807.' },
    keeper: { title: 'Keeper sweep', note: 'Every ~3 s, every 1 s near a level. trigger() is permissionless.' },
    pool: { title: 'Payout locked at sale', note: 'The full payout is reserved in the pool when the cover is sold.' },
    payout: {
      title: 'Payout in the trigger transaction',
      note: 'No touch before expiry: no payout; the cover price stays with the pool.',
    },
  },
  // More about each part; every line repeats a sourced statement made elsewhere on the page or in the docs.
  facts: {
    // docs/how-it-works.md §6; ARCHITECTURE §4 (Quote struct, deadline ~30 s after issue, nonce marked used)
    quote: [
      'The contract rejects a quote after its deadline, about 30 seconds after it was issued.',
      'Each quote carries a one-time nonce; the contract marks it used.',
    ],
    // docs/how-it-works.md §8, D5 (FAQ "mark or oracle")
    oracle: [
      'Hyperliquid liquidates on the mark price; cover triggers on the oracle price.',
      'So the default level sits 1 % above the liquidation price, toward spot.',
    ],
    // docs/how-it-works.md §8, D4; README Limitations (FAQ)
    keeper: [
      'Anyone may call trigger(); it pays only if a call before expiry sees the oracle at or past the level.',
      'A wick shorter than the poll can be missed; the pricing effect is about 0.007 % of the level at σ 40 %.',
    ],
    // README; docs/how-it-works.md §5.3-5.4; deployments/testnet-v2.json limits (testnet settings)
    pool: [
      'Locked payouts stay at or below 80 % of capacity and 50 % per perp (testnet settings).',
      'A cover price counts for underwriters only when its cover settles.',
    ],
    // en.ts step 6; README one-liner; docs/how-it-works.md §8
    payout: [
      'The payout is capped by your position\'s margin.',
      'A liquidation without an oracle touch does not pay.',
    ],
  },
  // ARCHITECTURE §4 Quote fields, filled from the hero setup (illustrative; nothing is signed)
  quoteCard: {
    tag: 'SIM · your setup as a quote, not a signed quote',
    buyer: ['buyer', 'your wallet'],
    perp: ['perp', 'BTC'],
    side: 'side',
    level: 'level',
    payout: ['payout', '$100'],
    premium: 'price',
    expiry: 'expiry',
    deadline: ['deadline', 'about 30 s after issue'],
    nonce: ['nonce', 'one-time'],
    refused: 'No quote: the engine does not sign this setup.',
    fromNow: (d: string) => `${d} after purchase`,
    below: 'below spot',
    above: 'above spot',
  },
  // the pool station for the hero setup (illustrative)
  poolCard: {
    tag: 'SIM · your setup',
    reserved: '$100 payout reserved at sale',
    premium: (p: string) => `${p} cover price, counted when the cover settles`,
    none: 'Not offered at these settings: nothing is reserved.',
  },
  // ARCHITECTURE §5.3 buyCover order; values from deployments/testnet-v2.json limits ("testnet settings")
  checks: {
    engine: 'Engine signs only if the priced touch chance is at most 50 %',
    sig: 'Signature, buyer, deadline, unused nonce',
    perp: 'Perp on the allowlist (BTC)',
    duration: 'Duration at most 7 days',
    payout: 'Payout at least 1 USDC ($100 here)',
    premium: 'Cover price at least 0.20 % of the payout',
    spot: 'Oracle within 0.30 % of the quoted spot',
    breached: 'Level not already breached',
    distance: 'Level at least 0.56 % from spot (0.25 % on chain, plus room for 0.30 % oracle drift)',
    position: 'Position exists, same side, payout at most its margin',
    capacity: 'Locked payouts at most 80 % of capacity, 50 % per perp',
    throttle: 'Sales at most 25 % of assets per hour; one buyer at most 25 % of that',
  },
  // engine/numera_engine/quote_api.py: check_v2_sale runs the pool's level and capacity floors before signing
  engineFoot: 'The engine runs the same level and capacity floors before it signs, so a refused setup never gets a quote.',
  // docs/how-it-works.md §3, §8; D5
  rule: 'A long cover pays when the oracle price is at or below the level; a short cover when it is at or above.',
  caveat: 'A liquidation without an oracle touch does not pay.',
  // README "Why Hyperliquid"; D3
  only: {
    heading: 'Only on Hyperliquid',
    items: [
      "At purchase the contract reads the buyer's real perp position through precompile 0x…0800.",
      "Cover can only be bought against a real position in the same direction, and the payout is capped by that position's margin.",
      'The oracle is read on-chain through precompile 0x…0807, so settlement needs no outside oracle.',
    ],
  },
};

/** S4. Sources: docs/how-it-works.md §7; business-plan "Level below spot" table (computed 2026-10-02 with
 *  engine/numera_engine/pricing.py); README Evidence; engine/reports/calibration.md. */
export const price = {
  kicker: '03 · The price',
  heading: "Priced from Hyperliquid's own tail.",
  method:
    'σ = max(EWMA, 30-day realized) from Hyperliquid mainnet hourly candles → GBM touch probability → tail floor fitted on Hyperliquid history → × 1.2. The math runs off-chain; solvency is enforced on-chain.',
  readoutNote: 'The instrument above is the estimator. This table adds the wider grid.',
  table: {
    caption: 'BTC long, $100 payout, volatility 32-50 %, illustrative, not a quote',
    cols: ['Level below spot', '1 day', '7 days'],
    // business-plan table, 1h and 4h columns left out on purpose (content brief §0)
    rows: [
      ['5 %', '$3.73-9.61', '$33.07-56.48'],
      ['8 %', '$1.14-3.29', '$15.51-32.28'],
      ['12 %', '$0.49-1.17', '$9.64-16.12'],
      ['20 %', '$0.43', '$6.12-8.60'],
    ],
  },
  footnote: 'Long durations close to liquidation are expensive by design.',
  evidenceHeading: 'Evidence',
  // README Evidence; calibration.md Findings (|z| >= 4: 206 touches in 258079 windows, model 0.45)
  evidence: [
    { fig: '206 vs 0.45', text: 'In the far tail the plain model expected 0.45 touches in 258,079 windows; there were 206.' },
    { fig: '15 of 256', text: 'Out of sample, 15 of 256 buckets priced below realized frequency.' },
    { fig: '2.46 %', text: "BTC's daily low reached 6 % below the open on 2.46 % of days (Oct 2024-Sep 2026)." },
  ],
  evidenceSource: 'Source: Numera calibration report (Hyperliquid mainnet candles: BTC, ETH, SOL, HYPE).',
  // the visitor's hero setup placed on the table (same grid, same rounding; illustrative)
  you: {
    here: (prem: string, lvl: string) => `Your ${prem} (level ${lvl} below) sits here.`,
    between: (lvl: string) => `Your level (${lvl} below) sits between two rows.`,
    notRow: (lvl: string) => `Your level (${lvl} below) is outside these rows.`,
    short: 'The table is for longs; your setup is short.',
    other: 'The table shows 1 day and 7 days; your duration is not in it.',
    refused: 'Your setup is not offered, so it has no cell here.',
  },
  // evidence pair drawn to scale: 0.45 expected vs 206 observed (README Evidence; calibration report)
  bars: { model: 'model expected', seen: 'observed' },
};

/** S5. Sources: README "How it works", Limitations; docs/how-it-works.md §5.3-5.4; testnet-v2.json limits. */
export const underwriters = {
  kicker: '04 · Underwriters',
  heading: 'The other side of every cover.',
  points: [
    'Underwriters deposit USDC into the pool, an ERC-4626 vault, and earn cover prices minus payouts through the share price.',
    'A cover price counts only when its cover settles.',
    'Each payout is reserved in full when the cover is sold.',
    'Caps (testnet settings): locked payouts stay at or below 80 % of capacity and 50 % per perp. New sales pause if payouts in one window exceed 15 % of assets.',
    'Underwriters bear the payouts, including any from a wrong or compromised quote.',
    'Testnet only, mock USDC, no independent audit. We publish no yield or return figures; testnet results are not returns.',
  ],
  toy: {
    heading: 'Reservation toy',
    tag: 'SIM',
    label: 'toy pool, not the live pool',
    sell: 'Sell a cover',
    settleNone: 'Settle: no touch',
    settleTouch: 'Settle: touch',
    reset: 'Reset',
    capLine: '80 % cap',
    premiums: 'settled cover prices',
    status: (blocks: number) => `${blocks} ${blocks === 1 ? 'payout' : 'payouts'} locked · ${blocks * 10} % of capacity`,
    refused: 'Refused: one more payout would lock more than 80 % of capacity.',
    sold: 'Sold. The full payout is locked before the cover price counts.',
    settledNone: 'Expired without a touch. The payout is unlocked; the cover price now counts for the pool.',
    settledTouch: 'Touched. The pool paid the locked payout to the buyer.',
    empty: 'Nothing is locked. Sell a cover first.',
  },
  ledger: {
    heading: 'Live ledger',
    badge: 'TESTNET DEMO POOL',
    live: 'LIVE',
    pool: 'MOCK v2 pool',
    unit: 'USDC (test tokens)',
    total: 'Total assets',
    free: 'Free',
    locked: 'Locked',
    covers: 'Covers',
    coversUnit: 'team test runs',
    paused: 'Paused',
    yes: 'yes',
    no: 'no',
    readAt: 'read',
    waiting: 'reading…',
    noscript: 'The live ledger is read by your browser and needs JavaScript; without it no number is shown.',
  },
  exit: {
    heading: 'Exits are queued (testnet settings)',
    stops: [
      { t: 'Request', d: 'requestRedeem' },
      { t: 'Wait 10 min', d: 'withdrawDelay' },
      { t: 'Withdraw within 1 h', d: 'redeem window' },
    ],
  },
};

/** Live-data labels kept verbatim from site/src/copy/en.ts (test-enforced). */
export const stats = {
  heading: 'Live from the testnet demo pool',
  demoBadge: 'TESTNET DEMO POOL',
  demoNote:
    'The demo pool runs on team-set prices; every cover in it was bought by the team in test runs. These are not user purchases.',
  note: 'Read in your browser from HyperEVM testnet (chain 998). A dash means the read failed; no number is ever filled in.',
  tvl: { label: 'Assets', unit: 'USDC (test tokens)' },
  covers: { label: 'Covers', unit: 'team test runs' },
  failed: '—',
  loading: '…',
};

/** S6. Source: deployments/testnet-v2.json e2e_F9_2026-10-02_3 (receipts re-confirmed in backlog.md). */
export const proof = {
  kicker: '05 · Proof',
  heading: 'One staged run, on the record.',
  bracket: '3 s by block timestamps · one staged run on the MOCK pool, 2026-10-02',
  quote: 'BTC long · level 1 % below spot · payout 10 mUSDC · price 0.434298 mUSDC · 1h',
  track: 'Block track',
  status: 'status 1',
  pending: 'not reached yet',
  notYetHeading: 'Not yet',
  notYet: [
    'No mainnet, no real USDC, no real funds.',
    'No independent audit; an internal security review only.',
    'A keeper trigger on a real oracle touch with the HyperCore-source pool is not yet proven; it is proven on the MOCK pool only.',
    'No public testnet app yet.',
  ],
};

export const waitlist = {
  kicker: '06 · Early access',
  heading: 'Join the waitlist',
  intro:
    'Leave your email and we will write when the next testnet round opens. A Telegram or X handle is optional. No wallet, no keys.',
  ticketTitle: 'Waitlist · HyperEVM testnet',
  email: { label: 'Your email', placeholder: 'Your email', hint: 'Used only to tell you when the next testnet round opens.' },
  more: 'Add Telegram or X (optional)',
  telegram: { label: 'Telegram username (optional)', placeholder: 'Telegram username' },
  x: { label: 'X handle (optional)', placeholder: 'X handle' },
  handlesHint: 'Either, both or none. Telegram: 5-32 characters; X: 1-15 characters; with or without @.',
  // explicit consent to a commercial electronic message (Law No. 6563), named as such
  consent: {
    before: 'Email me when the next testnet round opens, and store my email (and handles, if given) as the ',
    link: 'privacy notice',
    after: ' describes. I can unsubscribe any time. This site is used under the ',
    // the terms of use (src/pages/terms.astro), linked next to the privacy notice
    termsLink: 'terms of use',
    end: '.',
  },
  // founder wording 2026-10-03: age, residence, citizenship and location; the US, the UK, Ontario and sanctioned jurisdictions (one checkbox)
  jurisdiction:
    'I am 18 or older, and I am not a resident or citizen of, or located in, the US, the UK, Ontario (Canada) or a sanctioned jurisdiction.',
  submit: 'Join the waitlist',
  sending: 'Sending…',
  success: 'You are on the list. We will email you when the next testnet round opens.',
  // the issued ticket after a 200 (shows only what the visitor typed; nothing is stored in the browser)
  issued: {
    stamp: 'ON THE LIST',
    email: 'Email',
    telegram: 'Telegram',
    x: 'X',
    none: '—',
    channel: 'Channel',
    again: 'Use a different handle',
    // what happens next, in the space the folded form keeps (nothing below moves). Sources: this section's
    // intro ("message you when the next testnet round opens"); the privacy notice "What we store and why"
    // and "Your rights" (withdraw at any time with a message to the contact).
    next: {
      heading: 'What happens next',
      when: ['Next', 'One email when the next testnet round opens.'],
      stored: [
        'Stored',
        'Your email, your Telegram and X handles if you gave them, the notice version, your jurisdiction confirmation and the time you joined.',
      ],
      // the two handles go between these parts (footer.telegram, footer.x)
      leave: ['Leave', 'Any time: reply to our email, or message ', ' on Telegram or ', ' on X, to unsubscribe or be deleted.'],
    },
  },
  errors: {
    emailEmpty: 'Enter your email.',
    email: 'Please enter a valid email address.',
    telegram: 'That does not look like a Telegram username (5-32 characters, starting with a letter). Leave it empty if you prefer.',
    x: 'That does not look like an X handle (1-15 characters). Leave it empty if you prefer.',
    consent: 'Please agree to the privacy notice.',
    jurisdiction: 'Please confirm that you are 18 or older and not in a restricted jurisdiction.',
    region: 'This early-access list is not open to visitors from your region, so we cannot take your details.',
    captcha: 'The spam check did not pass. Please try again.',
    rate: 'Too many attempts from this network. Please try again in an hour.',
    generic: 'Something went wrong; nothing was saved. Please try again later.',
  },
  noscript: 'The waitlist form needs JavaScript for its spam check. You can also message @godsonits on Telegram.',
};

/** S8. Each answer names its source in the comment. */
export const faq = {
  kicker: '07 · Questions',
  heading: 'Questions',
  items: [
    {
      // docs/how-it-works.md §8; D5
      q: 'Does cover trigger on the mark price or the oracle price?',
      a: 'On the oracle price. Hyperliquid liquidates on the mark price, so the default level sits 1 % above the liquidation price, toward spot. A liquidation without an oracle touch does not pay.',
    },
    {
      // README Limitations
      q: "What if a wick is shorter than the keeper's poll?",
      a: 'The keeper checks every ~3 s, and every 1 s near a level. A wick shorter than that can be missed; the pricing effect is about 0.007 % of the level at σ 40 %.',
    },
    {
      // docs/how-it-works.md §8; D4
      q: 'Who can call trigger()?',
      a: 'Anyone. A cover pays only if a trigger() call before expiry sees the oracle at or past the level on-chain.',
    },
    {
      // backlog.md checkpoint 2026-10-02; README; SECURITY.md
      q: 'Is this live?',
      a: 'Testnet only, mock USDC, not audited, no public app yet.',
    },
    {
      // docs/how-it-works.md §5.5
      q: 'Who controls the pool?',
      a: 'Changes to the signer, limits, allowlist and guardian are timelocked: 10 min on testnet; the mainnet target is at least 48 h. The guardian can pause sales at once but can never unpause.',
    },
    {
      // Hyperliquid Terms §1.6 Restricted Persons (docs/research/hyperliquid.md)
      q: 'Who can join?',
      a: 'Anyone aged 18 or older who is not a resident of, located in, or a citizen of the US, the UK, Ontario (Canada) or a sanctioned jurisdiction. The form asks you to confirm this, and requests that arrive from the US, the UK or a comprehensively sanctioned country are refused.',
    },
    {
      // privacy notice "What we store and why"
      q: 'What do you store?',
      a: 'Your email address, your Telegram username and X handle if you gave them, the notice version you agreed to, your jurisdiction confirmation and the time you joined. A salted IP hash is kept for 24 hours against spam. The privacy notice has the details.',
      link: 'Read the privacy notice',
    },
  ],
};

export const footer = {
  // the footer shows these as icon-only links; `aria` is their accessible name
  telegram: { label: 'Telegram', handle: '@godsonits', href: 'https://t.me/godsonits', aria: 'Numera on Telegram' },
  x: { label: 'X', handle: '@ggodsonits', href: 'https://x.com/ggodsonits', aria: 'Numera on X' },
  license: 'AGPL-3.0',
  source: 'Source',
  fonts: 'Fonts under the SIL Open Font License:',
  // the licence texts ship with the build (src/pages/licenses/)
  fontLicenses: [
    { label: 'Instrument Sans', href: '/licenses/instrument-sans-OFL.txt' },
    { label: 'JetBrains Mono', href: '/licenses/jetbrains-mono-OFL.txt' },
  ],
  built: 'Built for Colosseum',
  privacy: 'Privacy notice',
  terms: 'Terms of use',
  agri: 'Numera agri product under construction',
  affiliation: 'Not affiliated with or endorsed by Hyperliquid.',
};

export const meta = {
  title: 'Numera · Liquidation Cover for Hyperliquid',
  description:
    'A fixed USDC payout if the Hyperliquid oracle touches your level; the position stays open. Testnet only, mock funds; not insurance, not an offer.',
};

export type NoticeLink = { label: string; href: string };
export type NoticeSection = { h: string; p: string[]; links?: NoticeLink[] };

/** Cloudflare pages the notice links to (check-dist allows exactly these two Cloudflare URLs). */
export const CF_TURNSTILE_NOTICE: NoticeLink = {
  label: 'Cloudflare Turnstile privacy notice',
  href: 'https://www.cloudflare.com/turnstile-privacy-policy/',
};
export const CF_DPA: NoticeLink = { label: 'Cloudflare customer data processing addendum', href: 'https://www.cloudflare.com/cloudflare-customer-dpa/' };

export const privacy = {
  title: 'Privacy notice',
  pending: 'Pending legal review',
  updated: 'Version ' + CONSENT_VERSION,
  intro:
    'This notice explains what happens to the details you give when you join the Numera waitlist (GDPR Art. 13 and KVKK Art. 10).',
  sections: [
    {
      h: 'Who is responsible',
      p: [
        'Controller: {{CONTROLLER_NAME}}, operating the Numera project.',
        'Contact: Telegram @godsonits or X @ggodsonits. Write to either for any request below.',
      ],
    },
    {
      h: 'What we store and why',
      p: [
        'Your email address (stored as typed, trimmed and in lower case), and, only if you gave them, your Telegram username and your X handle (either or both). Also the version of this notice you agreed to, your jurisdiction confirmation and the time you joined.',
        'Purpose: to email you when the next Numera testnet round opens and about its launch, and, if you gave a handle, to contact you there about the same. Launch and testnet notices only; no newsletter, no profiling, no advertising, no sale.',
        'To stop automated abuse, each request also stores a salted one-way hash of your IP address for 24 hours. The IP address itself is never stored.',
        'Cloudflare tells our server the country your request comes from. We use it only to refuse requests from the US, the UK and comprehensively sanctioned countries, and we do not store it.',
      ],
    },
    {
      h: 'Legal basis',
      p: [
        'Your consent (GDPR Art. 6(1)(a)) for the waitlist entry and the launch email. The short-lived IP hash and the country check rest on our legitimate interest in keeping the form free of spam and within the eligibility limits (Art. 6(1)(f)).',
        'Under Law No. 6563 on the Regulation of Electronic Commerce, we send these emails only with the explicit consent you give in the form.',
      ],
    },
    {
      h: 'Recipients',
      p: [
        'Cloudflare, Inc. is our processor: it hosts this site (Cloudflare Pages), stores the waitlist in its D1 database and runs the Turnstile spam check, which processes technical data from your browser when the form loads and is submitted. Its customer data processing addendum governs this.',
        'The pool statistics and the BTC oracle price on the home page are read by your browser directly from public HyperEVM testnet RPC endpoints (Chainlink and Hyperliquid), which see your IP address like any website does. Nothing you type is sent to them.',
        'For Turnstile, Cloudflare is also an independent controller: it uses the bot-detection signals it receives to improve its own bot detection, as its Turnstile notice describes.',
      ],
      links: [CF_DPA, CF_TURNSTILE_NOTICE],
    },
    {
      h: 'Transfer outside your country',
      p: [
        'The waitlist database is created in Cloudflare\'s EU jurisdiction, so your stored entry is kept in the European Union. Cloudflare may still process technical data, such as the request itself and the Turnstile signals, at its locations in other countries.',
        'For visitors in the EEA, the UK and Switzerland, the Cloudflare addendum includes standard contractual clauses. For persons covered by KVKK, the transfer basis under KVKK Art. 9 is under legal review; see the KVKK section below.',
      ],
    },
    {
      h: 'How long',
      p: [
        'Waitlist entries, including your email address, are deleted by {{DELETE_BY}} at the latest, or earlier when you ask or unsubscribe. IP hashes are deleted after 24 hours.',
      ],
    },
    {
      h: 'Cookies',
      p: [
        'This site sets no cookies of its own and runs no analytics or tracking. Cloudflare may set strictly necessary security cookies (__cf_bm, cf_clearance), and Turnstile processes bot-detection signals when you use the form. Nothing else is set or read on your device.',
      ],
    },
    {
      h: 'Your rights',
      p: [
        'You may ask for access, correction, deletion, restriction or a copy of your data, and object to processing. You may withdraw your consent at any time with a message to the contact above; withdrawal does not affect processing before it.',
        'To unsubscribe from the launch email, or to have your entry deleted, reply to any email we send you, or message the contact above. We then delete your entry and send you nothing more.',
        'You may complain to a supervisory authority: the KVKK Board (Kişisel Verileri Koruma Kurulu), or the data authority where you live or work in the EU or the UK.',
      ],
    },
    {
      h: 'Voluntary',
      p: [
        'Giving us your details is voluntary, but needed to join: without an email address we cannot add you to the list or tell you when the testnet opens. The handles are optional. Reading this site and using the open-source code need none of it.',
      ],
    },
    {
      h: 'KVKK (Law No. 6698)',
      p: [
        'For persons covered by Law No. 6698 on personal data (KVKK), these are the items of its Article 10.',
        'Controller: {{CONTROLLER_NAME}}; contact as above.',
        'Purposes: to email you when the next testnet round opens and about its launch, to contact you on a handle you gave, and to keep the form free of spam and within its eligibility limits.',
        'Recipients and purpose of transfer: Cloudflare, Inc., as our processor, for hosting, storing the waitlist in D1 and the Turnstile spam check; for Turnstile it is also an independent controller, to improve its bot detection. We pass your data to no one else.',
        'Transfer abroad: Cloudflare stores the waitlist in its EU jurisdiction. The transfer basis under Art. 9 of the law is under legal review.',
        'Method and legal basis: collected electronically, through the form on this site and your browser. Your explicit consent (Art. 5(1)) for the waitlist entry and the email; our legitimate interest (Art. 5(2)(f)) for the IP hash and the country check.',
        'Your rights under Art. 11: to learn whether your data is processed and ask for information; to learn the purpose and whether it is used accordingly; to know the recipients in the country or abroad; to ask for correction; to ask for deletion or destruction (Art. 7) and for that to be notified to recipients; to object to a result against you from exclusively automated analysis (we do none); and to ask for compensation for damage from unlawful processing.',
        'How to use them: write to the contact above, with the email address you gave. We reply within the 30 days the law allows.',
      ],
    },
  ] as NoticeSection[],
  back: 'Back to the home page',
};

export const terms = {
  title: 'Terms of use',
  pending: 'Pending legal review',
  updated: 'Version 2026-10-03',
  intro: 'Plain terms for using this early-access site and the Numera testnet. Please read them before you join the waitlist.',
  sections: [
    {
      h: 'What this is',
      p: [
        'Numera Liquidation Cover is a testnet experiment. It runs on HyperEVM testnet with mock USDC. Nothing on this site uses real funds.',
      ],
    },
    {
      h: 'Not insurance, not an offer, not advice',
      p: [
        'It is not insurance. Nothing here is an offer or a solicitation to buy or sell anything, and nothing here is financial, investment, legal or tax advice. Figures on the site are illustrative estimates, not quotes.',
      ],
    },
    {
      h: 'Mock funds, no real payout',
      p: [
        'Testnet covers pay mock funds that have no value. No real payout is made or promised. A future mainnet product, if there is one, would come with its own terms.',
      ],
    },
    {
      h: 'Who may use it',
      p: [
        'You must be 18 or older, and not a resident or citizen of, or located in, the US, the UK, Ontario (Canada) or a sanctioned jurisdiction. Do not hide your location to get around this. We may refuse requests from those regions.',
        'This follows the restrictions that apply to Hyperliquid, to which the product is linked. We are not affiliated with or endorsed by Hyperliquid.',
      ],
    },
    {
      h: 'The waitlist',
      p: ['Joining the waitlist is free and gives you no right to access, to a payout or to any product. How we handle your details is in the privacy notice.'],
    },
    {
      h: 'No warranty',
      p: [
        'The site, the testnet contracts and the estimates are provided as they are, without warranty of any kind, express or implied. The contracts have had no independent audit and may contain bugs, the testnet can be reset, and the figures may be wrong or out of date.',
      ],
    },
    {
      h: 'Limit of liability',
      p: [
        'To the extent the law allows, the operator is not liable for any loss or damage, including indirect or consequential loss, that arises from your use of this site or the testnet. This does not limit any liability that the law does not allow us to limit.',
      ],
    },
    {
      h: 'Changes to these terms',
      p: ['We may change these terms. The version at the top shows the current text; a change applies from when it is published and only to later use.'],
    },
    {
      h: 'Governing law',
      p: ['These terms are governed by the law of {{GOVERNING_LAW}}.'],
    },
    {
      h: 'Contact',
      p: ['Operator: {{CONTROLLER_NAME}}.', 'Telegram @godsonits or X @ggodsonits, the same channels as in the privacy notice.'],
    },
  ] as NoticeSection[],
  back: 'Back to the home page',
};

export const notFound = {
  title: 'Page not found',
  lead: 'No touch here.',
  text: 'There is nothing at this address. The price never reached this level.',
  back: 'Back to the home page',
};
