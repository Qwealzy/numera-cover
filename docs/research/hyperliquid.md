# Hyperliquid / HyperEVM facts (researched 2026-10-01 and 2026-10-02)

Verified facts the build depends on. Each line carries its source. `[RUN]` = observed by a live
call on 2026-10-01. Anything marked **VERIFY** must be confirmed in code/tests before relying on it.
Docs root: https://hyperliquid.gitbook.io/hyperliquid-docs/ (index: `/llms.txt`).

## Networks

| | Testnet | Mainnet (BLOCKED for writes) |
|---|---|---|
| EVM chain id | 998 (`0x3e6`) [RUN] | 999 (`0x3e7`) [RUN] |
| EVM RPC | `https://rpc.hyperliquid-testnet.xyz/evm` | `https://rpc.hyperliquid.xyz/evm` |
| Info API | `https://api.hyperliquid-testnet.xyz/info` | `https://api.hyperliquid.xyz/info` (read-only use OK) |
| USDC (EVM) | `0x2B3370eE501B4a559b57D449569354196457D8Ab` (from hyper-evm-lib HLConstants; proxy, 6 dec [RUN]; mintability unknown) | `0xb88339CB7199b77E23DB6E890353E22632Ba630f` (Circle, 6 dec) [docs hypercore/usdc] |
| Block explorer | **none working for 998** (see note below) | not used; receipts are read over RPC |

- Testnet block explorers, checked 2026-10-02 [RUN]: the community Blockscout instance for 998 is STALE. Its API
  latest block was 60,609,357 (timestamp 2026-08-03) while the RPC head was about 65.77M, and it returned
  "Not found" for a known testnet `buyCover` transaction. No working 998 explorer was found on 2026-10-02: the
  other candidate explorers did not find that transaction, Etherscan V2 rejects chainid 998, and chainid.network
  lists no explorers for 998. Numera therefore links no explorer. Use
  `cast receipt <hash> --rpc-url https://rpcs.chain.link/hyperevm/testnet` or the app's receipt view.
- Gas token HYPE. Testnet HYPE faucets: https://faucet.chainstack.com/hyperliquid-testnet-faucet (1/24h),
  https://faucet.quicknode.com/hyperliquid [docs builder-tools/hyperevm-tools].
- Testnet mock USDC (on **Core**, not EVM): https://app.hyperliquid-testnet.xyz/drip — 1,000 USDC,
  **requires a prior mainnet deposit from the same address** [docs onboarding/testnet-faucet].
- HyperEVM and HyperCore share addresses (same key).
- Blocks: small 1 s / 3M gas; big 1 min / 30M gas. Big blocks per deployer via Core action
  `evmUserModify{usingBigBlocks:true}`; deployer must exist on Core [docs hyperevm/dual-block-architecture].
  Our contracts should fit small blocks — **VERIFY** at deploy.
- `eth_call` supports latest block only; precompile reads are not reliable for historical blocks [docs hyperevm/json-rpc].

## Read precompiles (HyperEVM → HyperCore state)

Source: docs `for-developers/hyperevm/interacting-with-hypercore`, hyper-evm-lib `L1Read.sol`, `PrecompileLib.sol`.
Raw `staticcall(abi.encode(args))`, no selector. Values = HyperCore state when the EVM block is built.

| Address | Call | Returns |
|---|---|---|
| `0x…0800` | `position(address user, uint16 perp)` | `(int64 szi, uint64 entryNtl, int64 isolatedRawUsd, uint32 leverage, bool isIsolated)` |
| `0x…0806` | `markPx(uint32 perp)` | `uint64` |
| `0x…0807` | `oraclePx(uint32 perp)` | `uint64` |
| `0x…080a` | `perpAssetInfo(uint32 perp)` | `(string coin, uint32 marginTableId, uint8 szDecimals, uint8 maxLeverage, bool onlyIsolated)` |
| `0x…080F` | `accountMarginSummary(uint32 dex, address user)` | `(int64 accountValue, uint64 marginUsed, uint64 ntlPos, int64 rawUsd)` |

- Price scaling: `USD = raw / 10^(6 - szDecimals)`. Our canonical form is **USD × 1e6** = `raw × 10^szDecimals`.
  [RUN] testnet BTC (perp 3, szDecimals 5) oraclePx raw 842456 → 84245.6 USD.
- Invalid index → `PrecompileError`, **burns all forwarded gas** [RUN]. Cap gas on the staticcall and
  validate the index at cover creation.
- Gas: `2000 + 65 × (input_len + output_len)`.
- Position scaling **verified** [RUN 2026-10-01, testnet, founder wallet, BTC perp 3, 10× cross]:
  precompile `szi=117`, `entryNtl=99526050`, `leverage=10`, `isIsolated=false` vs Info API
  `szi="0.00117"`, `entryPx="85065.0"` → `szi = size × 10^szDecimals`, `entryNtl = USD × 1e6`
  (0.00117 × 85065 = 99.526). `entryNtl/leverage = 9952605` ≈ API `marginUsed` 9.956 USDC.
  `accountMarginSummary(0, user)` = (9996012, 9955892, 99558927, −89562915) = API
  (accountValue, marginUsed, totalNtlPos, totalRawUsd) × 1e6. Info API `liquidationPx` was `null` for this
  cross position — compute liq price ourselves, don't rely on the field.
- Local tests: a plain Foundry fork does **not** execute precompiles. hyper-evm-lib's simulator has no
  `setOraclePx`; use our own mock etched at `0x…0807` / `0x…0800`.
- CoreWriter `0x3333…3333` (`sendRawAction`) exists (orders, transfers, outcome ops). Not needed for v1.

## Perp indices [RUN, info `{"type":"meta"}`] — never hardcode, validate on-chain

| Coin | Mainnet idx | Testnet idx | szDecimals |
|---|---|---|---|
| BTC | 0 | 3 | 5 |
| ETH | 1 | 4 | 4 |
| SOL | 5 | 0 | 2 |
| HYPE | 159 | 135 (onlyIsolated) | 2 |

## Prices and liquidation [docs trading/robust-price-indices, trading/liquidations]

- **Oracle price**: stake-weighted median of validator submissions; each validator takes the weighted
  median of Binance, OKX, Bybit, Kraken, Kucoin, Gate, MEXC, HL spot (weights 3,2,2,1,1,1,1,1).
  Updated ~every 3 s. Used for funding.
- **Mark price**: median of (oracle + 150 s EMA of HL mid − oracle), (median of HL bid/ask/last),
  (weighted median of CEX perp mids). Used for margining, **liquidations**, TP/SL.
- Liquidation when account equity < maintenance margin. Maintenance margin = half of initial margin at
  max leverage (1.25% at 40× … 16.7% at 3×).
  `liq_price = price − side × margin_available / position_size / (1 − l × side)`, `l = 1/MAINTENANCE_LEVERAGE`.
- Testnet oracle mirrors real markets for majors ([RUN] BTC/ETH identical to mainnet); HYPE differs.
  Testnet book is thin (mark deviates). **We cannot crash testnet prices** → demo plan in `docs/ARCHITECTURE.md` §8.

## Info API (data for pricing/backtest)

- `candleSnapshot`: `{"type":"candleSnapshot","req":{"coin":"BTC","interval":"1h","startTime":ms,"endTime":ms}}`.
  Fields `t,T,s,i,o,c,h,l,v,n`. **Trade-price candles**, not oracle/mark. Only ~5000 most recent candles
  per interval: 1h ≈ 7 months (from 2026-03-07); 1d BTC/ETH real HL data from 2023-02-26
  (earlier rows have `v=0`, ignore). Time-range responses cap at 500 items → paginate.
- `metaAndAssetCtxs`: per-asset `oraclePx, markPx, midPx, funding, openInterest, premium, …`.
- `fundingHistory`, `clearinghouseState` (user positions, liq prices) also available.
- Rate limit: 1200 weight/min/IP; candleSnapshot weight 20 + per 60 items.
- Oracle/mark minute history only in requester-pays S3 `s3://hyperliquid-archive/asset_ctxs/` (from 2023-05).

## Competitive landscape (secondary sources unless noted)

- **HIP-4 outcome markets** (official docs): fully collateralized binary/bucket contracts on HyperCore;
  recurring BTC binary settles at expiry to interpolated **mark**. That is a European digital, not a touch.
  Secondary sources claim permissionless "touches $X by date" templates exist (500k HYPE deployer stake) —
  **not confirmed in official docs**. Either way: CLOB, speculator-facing, not linked to a position.
- Options on HyperEVM: Rysk, Derive (HYPE), opt.fun (1-min binaries), D2 vaults. Vanilla/short-dated.
- Nexus Mutual Leveraged Liquidation Cover (Ethereum): discretionary, lending positions, depeg/oracle risk.
- DeFi Saver / LiquidationProof / hackathon project "Offset": react by trading (slippage, gap risk).
- No found product: **position-linked, parametric, pool-underwritten** cover for Hyperliquid perps.
- Regulatory: oracle-triggered fixed payout is functionally a derivative/event contract; "insurance"
  framing does not remove that. Product copy says "cover", not "insurance".

## Terms of Use (read 2026-10-02 in a browser, last updated 2026-06-15)

Source: https://app.hyperliquid.xyz/terms. Paraphrased; section numbers as in the Terms.

- §1.6 Restricted Persons: the interface is not offered to (a) persons or entities that reside in, are
  located in, are incorporated in, or have a registered office in the USA or Ontario, Canada; (b) the same
  for jurisdictions subject to sanctions or export controls ("Restricted Territories"); (c) citizens of a
  Restricted Territory, wherever they are located.
- §1.7-1.8: outcome markets carry a separate "Excluded Persons" list, which can change.
- §1.9 and §3.1.5: using a VPN or otherwise concealing location is prohibited.
- §1.3: the operator states it is not licensed or registered in any jurisdiction.
- §11.4: governed by the law of England and Wales; disputes go to LCIA arbitration seated in London.
- Implication for Numera: the same restriction applies to our audience (Numera cover is linked to a
  Hyperliquid position). The early-access waitlist asks for a self-declaration that the person is not a
  Restricted Person.
