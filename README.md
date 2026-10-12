# Six-Agent Paper Trading Desk

A local, dependency-free implementation of the **6 AI Bot Trading Team** setup — the Scanner / Sizer / Buyer / Prediction-Market / Anti-FOMO / Logger idea — built to be run in **PAPER MODE ONLY**.

It is not a bot that trades. It is a **desk that refuses to trade badly**, records everything honestly, and tells you when it cannot know something.

```
npm start          # → http://localhost:8787
npm test           # unit tests for the rules and the market math
```

Node 20+ and nothing else. No npm dependencies to install.

---

## What you get

| Page | What it is for |
| --- | --- |
| **Start here** | The guide's final checklist, verified from the ledger's own state — plus a four-scenario self-test that proves the rules actually fire. |
| **Trading desk** | Fetch live market data, derive a plan, run the six agents in order, approve them one at a time (Guided) or let them run (Auto), get a paper ticket. |
| **Ledger** | Every trade *and* every blocked setup, append-only. Close trades, tag mistakes, mark what blocked setups would have done. CSV export in the guide's column order. |
| **Review** | The numbers the guide asks for: win rate, average win/loss, biggest win/loss, total simulated P&L, blocked count, most common mistake — every 20 trades — plus drawdown, profit factor, expectancy, per-setup performance and a rule-following audit. |
| **Prediction markets** | Agent 4's separate research ledger with its own 1% cap. SKIP is a normal outcome and it is logged. |
| **Setup guide** | The full guide and all six copy-paste prompts, rendered from `docs/SETUP_GUIDE.md`. |

## The six agents, and what each one is allowed to do

| # | Agent | Job | Cannot do |
| --- | --- | --- | --- |
| 1 | Scanner | Measures the setup (moves, volatility, volume pace, support/resistance, base structure) and returns PASS or SKIP with the numbers | Size a position, execute anything |
| 2 | Sizer | Converts the 1% risk budget into a conservative simulated size, or rejects | Exceed 1%, use leverage, allow two positions |
| 3 | Buyer | Writes the paper ticket once every approval exists | Send a real order, suggest a wallet or keys |
| 4 | Prediction-Market | Researches prediction markets on a separate ledger | Mix bets into the coin book |
| 5 | Anti-FOMO | Blocks entries that are chasing a move; defaults to cautious | Approve when risk cannot be defined |
| 6 | Logger | Records every trade and every block, append-only | Edit or delete a past result |

Order of operations is the guide's order: **Scanner → Anti-FOMO → Sizer → Buyer → Logger**.

## Hard rules (not settings)

Enforced in `src/config.mjs` and checked again in `src/agents/*`:

- **Paper mode only.** There is no wallet code, no key handling, no broker client and no order endpoint in this repository. A live order is not disabled — it is impossible to express.
- **Risk per trade can never exceed 1%** of the paper account. You may lower it; raising it is rejected with an explanation.
- **Every ticket requires a stop-loss**, and the Sizer rejects stops that are too tight (inside normal noise) or too wide (not a real invalidation).
- **One open position at a time.**
- **Records are append-only.** Trades can be closed, never rewritten; the audit trail logs every state change, so "I changed the rules after that loss" leaves fingerprints.
- **Never increase risk after a loss** — the Sizer caps the next trade at the previous trade's risk percentage.
- **If the agents disagree, skip.** An operator can override, but the override is stamped on the record.

## Where the data comes from

The app **never invents market data**. Three honest channels:

1. **Server live fetch** — Coinbase Exchange → Kraken → Binance → CoinGecko, walked in order until one answers. Public read-only endpoints; no keys.
2. **Browser live fetch** — when the machine running the server is on a locked-down network, your browser fetches the same public endpoints and posts the raw payload back. The server re-derives **every** metric from the raw candles and ignores anything it cannot validate.
3. **Manual entry** — numbers you verify yourself. Labelled `USER-PROVIDED`; checks that need candle history report *unknown* instead of guessing, and Anti-FOMO blocks when too many checks are unverifiable.

There is also **demo data**: a random walk generated locally, watermarked `DEMO` on every panel, record and CSV row. It exists for one reason — testing whether the rules fire — and it never auto-trades.

## Layout

```
server.mjs                 HTTP server, API routes, static files, opt-in auto-scan timer
public/
  index.html style.css     the UI (no build step, no framework)
  client/*.mjs             views, browser data channel, markdown renderer, chart wrapper
  vendor/chart.umd.min.js  Chart.js 4.5.1 (MIT), vendored so the app works offline
src/
  config.mjs               the rulebook + hard limits + audit diffing
  agents/                  one file per agent: deterministic logic + the copy-paste prompt
  core/pipeline.mjs        the only place the agents are wired together (guided/auto, gates)
  core/store.mjs           append-only ledger, audit trail, CSV export
  core/marketProvider.mjs  cache, live/browser/demo channel selection
  feeds/index.mjs          snapshot building, manual + demo data, validation of client payloads
  shared/feedcore.mjs      isomorphic market math (runs on the server AND in the browser)
  shared/livesources.mjs   public market-data adapters (isomorphic)
data/desk.json             your ledger (gitignored; created on first run)
docs/                      the guide, the prompts, the test plan
test/                      node --test suites
```

## Configuration worth knowing

Everything lives in **Start here → The rulebook**, with the hard rules displayed separately:

- `risk.riskPctPerTrade` — 1% ceiling (lower it to test a slower, safer desk)
- `antiFomo.max5mPct` / `max15mPct` / `maxVolumeSpikeRatio` / `maxAboveSupportPct` — how strict the Anti-FOMO agent is
- `scanner.maxAtrPct` / `minVolume24hUsd` / `entryChaseTolerancePct` — what the Scanner is willing to look at
- `fees.takerBps` / `slippageBps` — simulated costs, subtracted from every paper P&L so the results are not flattering
- `review.blockSize` — trades per review block (20 by default)

Rule changes are permitted and audited. Nothing is hidden: if you loosen a threshold after a loss, the review page and the audit trail say so.

## Testing

```bash
npm test                                  # 52 tests, no dependencies to install
npm install --no-save jsdom && npm test    # + the browser UI smoke test (53)
```

Covers the market math (moves, ATR, base detection, in-progress candle handling), the rules (1% ceiling, stop-distance bands, reward/risk, one-position rule, no-risk-increase-after-a-loss), the Anti-FOMO thresholds, the Buyer's chase guard, the Logger's P&L accounting and review maths, the sources' payload parsing, and an end-to-end pipeline run against an in-memory ledger. See `docs/TESTING.md` for the manual test plan.

## Disclaimer

Education and experimentation only. **Not financial advice.** Crypto, meme coins and prediction markets are extremely risky and volatile. The viral "$89 → $55,698" claim that inspired this build is unverified and must not be treated as a realistic or guaranteed outcome. Do not assume an AI can predict markets reliably. Never trade money you cannot afford to lose, and stay in paper mode until you have reviewed your own losses and understand exactly how the system behaves.
