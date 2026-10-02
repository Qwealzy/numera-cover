// Every user-visible English string of the waitlist site (v2). Started from site/src/copy/en.ts: the strings
// that tests and legal meaning depend on are kept verbatim (status pill, hero limit, six steps, demo-pool
// notes, waitlist messages, privacy notice). Word rules are enforced by test/copy.test.ts and
// test/copyrules.test.ts: say "cover", "payout", "level", "premium", "underwriter", "pool".
// Sources of every figure are named in the comment next to it.

/** Version of the privacy notice a waitlist consent refers to. Bump it whenever the notice text changes;
 *  the server accepts only versions listed in CONSENT_VERSIONS. v2 changed one Recipients sentence
 *  (the BTC oracle price is now read too, besides the pool statistics), so the version moved on; `date` said 2026-10-02, the same
 *  day as the previous version, hence the -v2 suffix (build spec 2.1). */
export const CONSENT_VERSION = 'privacy-2026-10-02-v2';
/** The previous version stays accepted: both sites may write the same D1 database. */
export const CONSENT_VERSIONS: readonly string[] = [CONSENT_VERSION, 'privacy-2026-10-02'];

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
  motion: 'Motion',
  motionOn: 'on',
  motionOff: 'off',
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
  status: 'Testnet only · Not an offer · Not available to US or Ontario persons or sanctioned jurisdictions',
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
  // the underwriter face of the same scene: the tile becomes the pool (premium from the grid, rounded up)
  pool: 'Pool',
  poolSold: (prem: string) => `+${prem} premium · $100 reserved`,
  poolPaid: (prem: string) => `$100 paid out · ${prem} premium kept`,
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
    none: 'No touch. No payout; the premium stays with the pool.',
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
    uwNone: 'No touch. The $100 stays reserved; if expiry passes without a touch, the premium stays with the pool.',
    uwTouch: 'Touch. The pool pays the reserved $100 to the buyer and keeps the premium.',
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
  premium: 'Premium',
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
    text: 'You send the signed quote to the pool contract, which checks the signature, your open position and its limits, takes the premium and reserves the full payout.',
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
    text: 'Underwriters deposit USDC and earn the premiums; each payout is reserved at sale, so the pool cannot sell more cover than it can pay.',
  },
  {
    id: 'payout',
    label: 'Payout',
    text: 'The fixed USDC payout goes to your wallet in the trigger transaction; if the level is never touched before expiry, nothing is paid and the premium stays with the pool.',
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
      done: 'Premium taken; the full payout is reserved.',
      stopped: 'Stopped here. Nothing is sold and nothing is reserved.',
    },
    oracle: { title: 'Oracle price, read on-chain', note: 'Validator median of 8 venues, read through precompile 0x…0807.' },
    keeper: { title: 'Keeper sweep', note: 'Every ~3 s, every 1 s near a level. trigger() is permissionless.' },
    pool: { title: 'Payout locked at sale', note: 'The full payout is reserved in the pool when the cover is sold.' },
    payout: {
      title: 'Payout in the trigger transaction',
      note: 'No touch before expiry: no payout; the premium stays with the pool.',
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
      'A premium counts for underwriters only when its cover settles.',
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
    premium: 'premium',
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
    premium: (p: string) => `${p} premium, counted when the cover settles`,
    none: 'Not offered at these settings: nothing is reserved.',
  },
  // ARCHITECTURE §5.3 buyCover order; values from deployments/testnet-v2.json limits ("testnet settings")
  checks: {
    engine: 'Engine signs only if the priced touch chance is at most 50 %',
    sig: 'Signature, buyer, deadline, unused nonce',
    perp: 'Perp on the allowlist (BTC)',
    duration: 'Duration at most 7 days',
    payout: 'Payout at least 1 USDC ($100 here)',
    premium: 'Premium at least 0.20 % of the payout',
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
    'Underwriters deposit USDC into the pool, an ERC-4626 vault, and earn premiums minus payouts through the share price.',
    'A premium counts only when its cover settles.',
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
    premiums: 'settled premiums',
    status: (blocks: number) => `${blocks} ${blocks === 1 ? 'payout' : 'payouts'} locked · ${blocks * 10} % of capacity`,
    refused: 'Refused: one more payout would lock more than 80 % of capacity.',
    sold: 'Sold. The full payout is locked before the premium counts.',
    settledNone: 'Expired without a touch. The payout is unlocked; the premium now counts for the pool.',
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
      { t: 'Claim within 1 h', d: 'claimWindow' },
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
  quote: 'BTC long · level 1 % below spot · payout 10 mUSDC · premium 0.434298 mUSDC · 1h',
  track: 'Block track',
  playhead: 'Playhead block',
  replay: 'Replay',
  status: 'status 1',
  pending: 'not reached yet',
  copy: 'Copy cast command',
  copied: 'Copied',
  copyFailed: 'Copy failed; select the hash instead',
  verify: 'Verify any hash yourself:',
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
  intro: 'Leave a Telegram or X handle and we will message you when the next testnet round opens. No email, no wallet.',
  doors: {
    label: 'I would',
    trader: {
      tab: 'Buy cover',
      title: 'Waitlist · cover for traders',
      line: 'For Hyperliquid perp traders who want to stay in a leveraged trade through a wick.',
    },
    underwriter: {
      tab: 'Underwrite',
      title: 'Waitlist · underwriting the pool',
      line: 'For those who would supply USDC to the pool.',
    },
    note: 'Your choice only changes this wording; the form stores the same fields either way.',
  },
  handle: { label: 'Your handle', hint: 'Telegram (5-32 characters) or X (1-15 characters), with or without @' },
  channel: { label: 'Channel', options: [{ value: 'telegram', label: 'Telegram' }, { value: 'x', label: 'X' }] },
  terms: { prefix: 'stored as', empty: 'stored as —' },
  valid: { telegram: 'Looks valid for Telegram', x: 'Looks valid for X' },
  consent: {
    before: 'I agree that Numera stores my handle to contact me about the testnet, as described in the ',
    link: 'privacy notice',
    after: '.',
  },
  jurisdiction: 'I am not a resident of, located in, or a citizen of the US, Ontario (Canada) or a sanctioned jurisdiction.',
  submit: 'Join the waitlist',
  sending: 'Sending…',
  success: 'You are on the list. We will reach out on the channel you chose.',
  // the issued ticket after a 200 (shows only what the visitor typed; nothing is stored in the browser)
  issued: {
    stamp: 'ON THE LIST',
    handle: 'Handle',
    channel: 'Channel',
    door: 'Ticket',
    again: 'Use a different handle',
  },
  errors: {
    handle: 'That handle does not look valid for the chosen channel.',
    consent: 'Please agree to the privacy notice.',
    jurisdiction: 'Please confirm the jurisdiction statement.',
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
      a: 'Anyone who is not a resident of, located in, or a citizen of the US, Ontario (Canada) or a sanctioned jurisdiction. The form asks you to confirm this.',
    },
    {
      // privacy notice "What we store and why"
      q: 'What do you store?',
      a: 'Your handle, the channel, the notice version you agreed to, your jurisdiction confirmation and the time you joined. A salted IP hash is kept for 24 hours against spam. The privacy notice has the details.',
      link: 'Read the privacy notice',
    },
  ],
};

export const footer = {
  telegram: { label: 'Telegram', handle: '@godsonits', href: 'https://t.me/godsonits' },
  x: { label: 'X', handle: '@ggodsonits', href: 'https://x.com/ggodsonits' },
  license: 'AGPL-3.0',
  built: 'Built for Colosseum',
  privacy: 'Privacy notice',
  agri: 'Numera agri product under construction',
};

export const meta = {
  title: 'Numera · Liquidation Cover for Hyperliquid',
  description:
    'A fixed USDC payout if the Hyperliquid oracle touches your level; the position stays open. Testnet only; not an offer.',
};

export const privacy = {
  title: 'Privacy notice',
  pending: 'Pending legal review',
  updated: 'Version ' + CONSENT_VERSION,
  intro:
    'This notice explains what happens to the details you give when you join the Numera waitlist (GDPR Art. 13).',
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
        'Your handle, the channel you chose (Telegram or X), the version of this notice you agreed to, your jurisdiction confirmation and the time you joined.',
        'Purpose: to contact you about the Numera testnet and early access. Nothing else; no profiling, no advertising, no sale.',
        'To stop automated abuse, each request also stores a salted one-way hash of your IP address for 24 hours. The IP address itself is never stored.',
      ],
    },
    {
      h: 'Legal basis',
      p: [
        'Your consent (GDPR Art. 6(1)(a)) for the waitlist entry. The short-lived IP hash rests on our legitimate interest in keeping the form free of spam (Art. 6(1)(f)).',
      ],
    },
    {
      h: 'Recipients',
      p: [
        'Cloudflare, Inc. hosts this site and the waitlist database (Cloudflare Pages and D1) and runs the Turnstile spam check, which processes technical data from your browser when the form loads and is submitted.',
        'The pool statistics and the BTC oracle price on the home page are read by your browser directly from public HyperEVM testnet RPC endpoints (Chainlink and Hyperliquid), which see your IP address like any website does. Nothing you type is sent to them.',
      ],
    },
    {
      h: 'Transfer outside your country',
      p: [
        'Cloudflare may process data in the United States and other countries. Transfers rely on the EU-US Data Privacy Framework, to which Cloudflare is certified, and on the European Commission standard contractual clauses in its data processing terms.',
      ],
    },
    {
      h: 'How long',
      p: [
        'Waitlist entries are deleted by {{DELETE_BY}} at the latest, or earlier when you ask. IP hashes are deleted after 24 hours.',
      ],
    },
    {
      h: 'Your rights',
      p: [
        'You may ask for access, correction, deletion, restriction or a copy of your data, and object to processing. You may withdraw your consent at any time with a message to the contact above; withdrawal does not affect processing before it.',
        'You may complain to the data protection authority where you live or work.',
      ],
    },
    {
      h: 'Voluntary',
      p: [
        'Joining is voluntary and not needed to read this site or use the open-source code. Without a handle we simply cannot contact you.',
      ],
    },
    {
      h: 'KVKK',
      p: [
        'For persons covered by Law No. 6698 on the Protection of Personal Data (KVKK): the same controller, purposes, recipients and retention apply, and you may use the rights in its Article 11 through the contact above.',
      ],
    },
  ],
  back: 'Back to the home page',
};

export const notFound = {
  title: 'Page not found',
  lead: 'No touch here.',
  text: 'There is nothing at this address. The price never reached this level.',
  back: 'Back to the home page',
};
