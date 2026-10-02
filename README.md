# Numera — liquidation cover for Hyperliquid perps

Numera sells a fixed cash payout that is paid if the oracle price touches a level just above your
liquidation price before expiry. The position stays open; the payout comes from a USDC pool on HyperEVM.

Status: **HyperEVM testnet only** (chain 998). No mainnet deployment, no real funds.

Security: see [`SECURITY.md`](SECURITY.md).

## Problem

Leveraged perp positions are closed by short, sharp wicks that touch the liquidation price and then
reverse. On 10 October 2025 more than $19B of crypto positions were liquidated in one day
([Coinglass 2025 annual report](https://www.coinglass.com/learn/2025-annual-report-en)); on Hyperliquid
about 6,300 wallets ended in loss and more than 1,000 were fully liquidated
([CoinDesk, 2025-10-11](https://www.coindesk.com/markets/2025/10/11/largest-ever-crypto-liquidation-event-wipes-out-6-300-wallets-on-hyperliquid)).
In September 2026 liquidations on Hyperliquid totalled about $1.76B
([compass.trade](https://compass.trade/liquidations), on-chain fills).

A trader has two defences today: lower leverage, or a stop-loss. A stop-loss closes the position at the
bottom of the wick and can slip in a gap. Neither keeps the trader in the trade.

## How it works

1. **Protect.** Pick an open perp position. The level defaults to just above the liquidation price; the
   payout is capped at the margin you would lose.
2. **Pay a premium.** The pricing engine computes the probability that the oracle touches the level before
   expiry, applies a tail floor fitted on Hyperliquid history, and signs an EIP-712 quote. The contract
   checks the signature, the price, your position and the pool's capacity, then locks the full payout.
3. **Get paid.** If the oracle price is at or past the level, anyone (the keeper, you, a bot) can call
   `trigger(coverId)` and the pool pays in the same transaction. Otherwise the cover expires and the premium
   stays with the underwriters.

Underwriters deposit USDC into the pool (an ERC-4626 vault) and earn premiums minus payouts. Every payout is
reserved when the cover is sold, so the pool can always pay what it owes.

Technical design: [`docs/how-it-works.md`](docs/how-it-works.md).

## Why Hyperliquid

The CoverPool contract on HyperEVM reads HyperCore state directly through read precompiles:

- **Oracle price** (precompile `0x…0807`): the trigger price. It is the validator median of 8 venues and is
  read on-chain, so settlement needs no outside oracle.
- **Position** (precompile `0x…0800`): size, entry notional and leverage of the buyer's position. A cover can
  only be bought against a real position in the same direction, and the payout is capped by its margin.

This makes the cover position-linked and settleable in one transaction, which is not possible on a chain
that cannot read the perp exchange's state.

## Live testnet deployment

HyperEVM testnet, chain 998, RPC `https://rpc.hyperliquid-testnet.xyz/evm`. Source of truth:
[`deployments/testnet.json`](deployments/testnet.json). All 7 contracts are verified on Sourcify
(exact runtime match).

| Contract | Address | Sourcify |
|---|---|---|
| MockUSDC (6 decimals, public mint, testnet only) | `0x8675c05f2403f220e19057f3f60c6c91bb14462a` | [link](https://repo.sourcify.dev/998/0x8675c05f2403f220e19057f3f60c6c91bb14462a) |
| CoverPool — real HyperCore sources (Demo A) | `0xda611e1a07260005ea5641e9fe633cd4d10c341e` | [link](https://repo.sourcify.dev/998/0xda611e1a07260005ea5641e9fe633cd4d10c341e) |
| HyperCorePriceSource | `0xf8323c267ef0516651c1cc2f94f984d50f597f44` | [link](https://repo.sourcify.dev/998/0xf8323c267ef0516651c1cc2f94f984d50f597f44) |
| HyperCorePositionSource | `0xcd44735b5640ab54777d31caf88d8ebb19730645` | [link](https://repo.sourcify.dev/998/0xcd44735b5640ab54777d31caf88d8ebb19730645) |
| CoverPool — **MOCK sources, staged demo only** (Demo B) | `0x1b1bfb83f2100c95a7460ed1a746170cbdeccbae` | [link](https://repo.sourcify.dev/998/0x1b1bfb83f2100c95a7460ed1a746170cbdeccbae) |
| MockPriceSource (**MOCK**: price set by the operator) | `0x08d24f21bcd9fdf690499456e90b9712b31bbc13` | [link](https://repo.sourcify.dev/998/0x08d24f21bcd9fdf690499456e90b9712b31bbc13) |
| MockPositionSource (**MOCK**: position set by the operator) | `0x728159ab10146beffdc15ec8fbb4ce4bb44a3425` | [link](https://repo.sourcify.dev/998/0x728159ab10146beffdc15ec8fbb4ce4bb44a3425) |

The MOCK pool exists so a trigger and payout can be shown on demand: its price and positions are set by the
operator, not read from HyperCore. Nothing it does is evidence of a real market event.

## Evidence

**Pricing calibration** ([`engine/reports/calibration.md`](engine/reports/calibration.md), pricing v4,
Hyperliquid mainnet candles for BTC, ETH, SOL, HYPE; 1h/4h from ~7 months of 1-hour candles, 1d/7d from
daily candles since 2023):

- In the far tail (|z| ≥ 4, where a 10× long's liquidation sits over a day) the plain GBM touch model
  expected 0.45 touches in 258,079 windows; there were 206. Numera's price is floored by the observed
  frequency (Wilson 95 % upper bound) instead of the model's ~0.
- Out of sample (tables fitted on the first half of the data, tested on the second): 15 of 256 buckets
  priced below the realized touch frequency; loss ratio (claims / premiums) 1h 0.43, 4h 0.41, 1d 0.66,
  7d 0.65.
- Example: a 1-day BTC cover 6 % below spot costs 3.24 % of the payout; BTC's daily low reached 6 % below
  the open on 2.46 % of days (Oct 2024 – Sep 2026).
- Failing buckets and limitations are listed in the report.

**End-to-end on testnet** (MOCK pool, 2026-10-01; engine quote → buy → staged price drop → keeper
trigger → payout, 5 s from price drop to trigger). No working HyperEVM testnet explorer exists as of
2026-10-02 (the hyperpc indexer is stale), so the hashes below are not links. Verify any of them with
`cast receipt <hash> --rpc-url https://rpcs.chain.link/hyperevm/testnet`. Inside the app, the transactions it
lists (My covers, Pool) open an in-app receipt view read from the RPC when you click their hash.

| Step | Transaction |
|---|---|
| Approve premium | `0x581d08d4b84bd30584bb1405346f1222958cb8ebd6df6d6dd42916ecc734accf` |
| `buyCover` (cover 1: BTC long, payout 20 mUSDC, premium 6.845262 mUSDC, 1 day) | `0xe94df21d42af54d1f25913a7692b860a5e9df26c7133046adfd53d608fcddf60` |
| MOCK price set below the level (staged) | `0xbb2dd023c05bcd2930b6b004d8382021df8a4424c1f3018243c05643f8e6bc88` |
| `trigger` by the keeper, 20 mUSDC paid to the buyer | `0x0791fb7d627b5218e6e786ba81a9484b2018fad48ddd9b38e57c8148f6bf8465` |

The full record (quote fields, events, balances after) is in `deployments/testnet.json` under `e2e`.

## Run it

Requirements: [Foundry](https://getfoundry.sh), Python ≥ 3.11, Node.js ≥ 20.

**Contracts** (`contracts/`, Solidity 0.8.28, Foundry):

```sh
git submodule update --init --recursive
cd contracts
forge build
forge test
```

**Engine** (`engine/`, Python: pricing, calibration backtest, quote API, keeper):

```sh
cd engine
python -m venv .venv
. .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
python -m pytest -q tests

# Quote API (signs quotes for one pool; use a fresh testnet-only key)
NUMERA_ENV=testnet NUMERA_CHAIN_ID=998 NUMERA_POOL=0xda611e1a07260005ea5641e9fe633cd4d10c341e \
QUOTE_SIGNER_KEY=<testnet key> uvicorn numera_engine.quote_api:app --port 8000

# Keeper (polls all pools in deployments/testnet.json every 3 s via one Multicall3 call and sends
# trigger/expire; --rpc is repeatable for failover, --poll sets the interval, --dry-run needs no key)
KEEPER_KEY=<testnet key> python -m numera_engine.keeper

# Re-run the calibration backtest (reads Hyperliquid mainnet candles, read-only)
python -m numera_engine.backtest --coins BTC ETH SOL HYPE
```

A deployed pool only accepts quotes signed by its configured quote signer, so a self-run engine can buy
cover only on a pool you deploy yourself (`contracts/script/Deploy.s.sol`; see `.env.example`).

**App** (`app/`, Vite + React + viem):

```sh
cd app
npm ci
npm test
npm run build      # or: npm run dev
```

Configuration: `app/.env.example` (engine URL, RPC, explorer). Without an engine the app can run with
`VITE_USE_QUOTE_FIXTURE=1` for UI work only (fixture quotes do not verify on-chain).

**Run locally (engine API + app in one command).** Same command in PowerShell, cmd and bash; needs
`engine/.venv`, `app/node_modules` and a `.env` copied from `.env.example` with `QUOTE_SIGNER_KEY` set:

```sh
node scripts/doctor.mjs      # read-only check: chain 998, contract code, pool quoteSigner, .env names, toolchain
node scripts/dev.mjs         # engine on http://localhost:8000, app on http://localhost:5173; Ctrl-C stops both
node scripts/dev.mjs --keeper       # engine + app + keeper (needs KEEPER_KEY in .env); Ctrl-C stops all three
node scripts/dev.mjs --keeper-only  # only the keeper; add --keeper-dry-run for a read-only run without sending txs
```

`dev.mjs` loads `.env`, refuses chain id 999, starts the Quote API (uvicorn) and the Vite dev server with
`VITE_ENGINE_URL` pointing at the local engine, and waits until both answer. Options: `--env <file>`,
`--engine-only`, `--app-only`, `--port <engine port>`, `--app-port <app port>`, `--keeper`, `--keeper-only`,
`--keeper-dry-run`.

## Limitations

- **Testnet only.** USDC is a mock token; mainnet is out of scope and deploy scripts refuse chain 999.
- **A touch counts only when observed on-chain.** A cover pays if a `trigger()` call before expiry sees the
  oracle at or past the level. The keeper checks every ~3 s (one Multicall3 call per poll); a wick shorter
  than that can be missed (pricing effect ≈ 0.007 % of the level at σ = 40 %). `trigger()` is
  permissionless, so anyone can call it.
- **Oracle vs mark basis.** Covers trigger on the oracle price; Hyperliquid liquidates on the mark price.
  They can differ, so the default level sits a buffer above the liquidation price, and a liquidation without
  an oracle touch does not pay.
- **The MOCK pool is staged.** Its price and positions are set by the operator for demos; it is labelled
  MOCK in the app and in this README.
- **Calibration uncertainty is understated.** The Wilson bounds assume independent windows; in reality the
  same window is counted at several distances, coins move together and volatility clusters, so the true
  uncertainty is wider. Touches are measured on trade-price candles, not on the oracle.
- **Quotes are signed off-chain.** Reserves, caps and position checks are enforced by the contract, so
  every sold cover is fully reserved and a buyer whose cover triggers is always paid. The contract does not
  enforce a minimum premium or level distance: a wrong quote misprices a premium, and a compromised quote
  signer (or owner) can sell money-losing covers whose losses the underwriters absorb.
- **Not independently audited.** The code had an internal security review (2026-10-02), not an independent
  audit. Trust model, known risks and mainnet blockers: [`SECURITY.md`](SECURITY.md).

## License

AGPL-3.0-only — see [`LICENSE`](LICENSE). Third-party dependencies and their licenses:
[`THIRD_PARTY.md`](THIRD_PARTY.md).

## Notes

Built with Claude Code (AI coding agents) under the founder's direction.

Numera's agricultural parametric product is under construction; it is a separate product and no code from
it is used here.

## Contact

- X: [@ggodsonits](https://x.com/ggodsonits)
- Telegram: [@godsonits](https://t.me/godsonits)
