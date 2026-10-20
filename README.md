# Polymarket Desk

Polymarket research and paper tracking, plus a separate opt-in **manual real-money order ticket**. Run `npm start` and open **Polymarket research** to load public markets, inspect YES probabilities, and record your evidence and estimated probability range. The deterministic research checker logs a simulated YES / NO position or SKIP. It is not an AI probability forecaster.

**Positions & results** opens the prediction ledger by default. Review open bets and manually record verified YES/NO settlement. The status bar tracks prediction positions; the home page shows resolved P&L and skips. Market-question filtering applies to the loaded market list only.

NFL, tennis and BTC Up/Down research checklists are available on the home page. Use the manual worksheet for an exact contract link: enter an explicit YES proposition, verified quote and resolution time, and confirm the outcome mapping. Manual records are labelled USER-PROVIDED; no live scores, injury feed or automatic picks are supplied. Named-outcome API markets without an explicit YES label are not automatically mapped to a team.

The research workflow has no live execution or automatic settlement. Each paper bet risks its entire stake (capped at 1%); crypto stop-loss rules do not apply to these bets. Public data availability depends on API/browser access. Quotes are snapshots, not guaranteed fills. Respect platform eligibility and local restrictions.

The original crypto tools and guide remain available as secondary tools; their review statistics are labelled **Crypto review** and are not prediction-market performance. Historical records are preserved.


## Manual real-money app — disabled by default

Open **Real-money trading** in the navigation. The shared preview is intentionally
locked: no real credentials are configured and no live order is sent during testing.
To deploy privately, follow **[docs/LIVE_TRADING.md](docs/LIVE_TRADING.md)**.

The initial gateway supports BUY LONG limit IOC orders only, with a server-enforced
**$10 modeled maximum spend per order including the reported fee reserve**.
Private sessions, exact host/origin checks, CSRF, short-lived previews, fresh
revalidation, and durable dispatch journaling protect the submission path.
Missing fees, unverified identities and ambiguous submissions fail closed.
There is no automated trading, sell/short/modify/cancel/close workflow, daily loss
cap, or guarantee against an exchange reporting incorrect fees. Multiple orders
can lose more than $10. Live API shapes/behavior remain **unverified** in this
network environment; this is an integration prototype, not a production certification.

---

# Six-Agent Paper Trading Desk

A local implementation of the **6 AI Bot Trading Team** setup — the Scanner / Sizer / Buyer / Prediction-Market / Anti-FOMO / Logger idea — built to be run in **PAPER MODE ONLY**.

It is not a bot that trades. It is a **desk that refuses to trade badly**, records everything honestly, and tells you when it cannot know something.

```
npm start          # → http://localhost:8787
npm test           # unit tests for the rules and the market math
```

Node 20+. Run `npm ci` before starting; the Polymarket US SDK is a runtime dependency.

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

- **Paper agents only.** These rules apply to simulated agents and the paper ledger. They cannot invoke the separate manual live gateway. That gateway has its own sign-in, $10 spending cap and preview/confirmation requirements.
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
npm ci
npm test                                  # includes SDK mocks, security checks and UI tests
```

Covers the market math (moves, ATR, base detection, in-progress candle handling), the rules (1% ceiling, stop-distance bands, reward/risk, one-position rule, no-risk-increase-after-a-loss), the Anti-FOMO thresholds, the Buyer's chase guard, the Logger's P&L accounting and review maths, the sources' payload parsing, and an end-to-end pipeline run against an in-memory ledger. See `docs/TESTING.md` for the manual test plan.

## Disclaimer

Education and experimentation only. **Not financial advice.** Crypto, meme coins and prediction markets are extremely risky and volatile. The viral "$89 → $55,698" claim that inspired this build is unverified and must not be treated as a realistic or guaranteed outcome. Do not assume an AI can predict markets reliably. Never trade money you cannot afford to lose, and stay in paper mode until you have reviewed your own losses and understand exactly how the system behaves.

## Optional Polymarket US SDK initialization

`polymarket-us` is installed. The server-only helper in
`src/feeds/polymarket-us.mjs` initializes the SDK with `POLYMARKET_KEY_ID` and
`POLYMARKET_SECRET_KEY` from the server environment. Set both or neither;
public market data does not require credentials. Do not put secrets in chat,
browser code, or Git. `.env` is ignored, but `npm start` does not load it automatically;
inject variables through your host's secret settings or use Node's
`node --env-file=.env server.mjs` locally.

This helper is not yet wired into the app's market feed or any HTTP route.
The app still uses the existing public market feed and paper ledger. Installing
and initializing the SDK alone does not enable real trading. Do not expose its order
methods through the paper desk.

### Public US market explorer

On the Polymarket page, **Polymarket US · public market explorer** can load
10 active events or retrieve a market and order book by US slug. This uses a
separate, credential-free SDK instance through GET-only server routes
(`/api/polymarket-us/events` and `/api/polymarket-us/market?slug=…`).
Results are displayed as raw JSON with a fetch timestamp; they are not normalized
into paper positions or streamed. US slugs may differ from the existing feed.
`chiefs-super-bowl` is an example, not a verified current market. Upstream failures
are shown honestly; this environment cannot reach the US API host, so live
responses have not been verified here.

### Private account reads (server only)

`readUSAccountSnapshot()` in `src/feeds/polymarket-us.mjs` reads authenticated
`account.balances()`, `portfolio.positions()` and `orders.list()` concurrently.
It requires both server environment credentials. It returns the raw SDK responses
with timestamps; these reads are not atomic and do not promise exhaustive pagination.
It does not place/cancel orders, log account data or write it into the paper ledger.
There is deliberately no HTTP route or public UI for this private snapshot: the
shared preview has no account authentication/access-control layer. Only use the
helper in trusted server code. Real order submission is available only through the separately configured manual live gateway; see `docs/LIVE_TRADING.md`.

US SDK failures are classified as authentication, invalid request, not found,
rate limit, or unavailable. Public explorer routes return fixed safe messages and
error codes; private snapshot errors carry the same classification without raw
SDK messages or account payloads. Upstream authentication failures use HTTP 502
(they are not authentication challenges for the preview visitor). No automatic
retry is performed, including on rate limits. This error handler does not submit orders; the separately enabled live gateway is described above.

The US event explorer now supports limit/offset, category and series filters,
and active/closed/archived/featured/live/ended selectors. Event lookup uses
`/api/polymarket-us/event?id=123` or `?slug=example-event`; the JS SDK method is
`retrieveBySlug`, not Python's `retrieve_by_slug`. Event responses remain raw so
sports scores/participants are visible only when actually returned by the API.
The supplied documentation lists `live`; SDK 0.1.1 types omit it, though the runtime
forwards query fields. Its upstream behavior remains unverified. The documentation
index at docs.polymarket.us/llms.txt cannot be accessed under this environment's
network allowlist; implementation was checked against the installed SDK and the
user-supplied reference, not a live documentation fetch.

### US market lists and individual reads

The explorer supports filtered market lists (`GET /api/polymarket-us/markets`),
plus individual details by numeric ID or slug, book, BBO, and settlement via
`GET /api/polymarket-us/market-read?kind=details|book|bbo|settlement&slug=…`
(use `?id=123` for details by ID). The existing combined market/book route remains.
Pagination, category/status filters, sports market type and minimum volume/liquidity
have input validation. `sportsMarketTypes`, `volumeNumMin` and `liquidityNumMin`
follow the supplied reference but differ from/are absent in SDK 0.1.1 types;
the runtime forwards them unchanged, and upstream behavior remains unverified.
Responses are raw timestamped snapshots. Missing or unresolved settlement values
are not interpreted, and no read automatically changes a paper bet or places an order.

### Private portfolio pagination and activity

`createPrivateUSPortfolio()` in `src/feeds/polymarket-us-portfolio.mjs` exposes
only `positions({ limit, cursor })` and
`activities({ limit, cursor, types, marketSlug, sortOrder })` to trusted server code.
Each call reads one page and preserves the raw SDK response, including decimal
quantity strings, `nextCursor`, and `eof`; no rounded legacy fields are substituted.
Limits are bounded locally to 1–100. Pass the returned cursor explicitly for another
page. No automatic polling, full-history claim, order mutation, public route, logging,
or storage is added. Credentials remain in the server environment.

The supplied reference includes rebate/liquidity activity types and decimal fields
missing from installed SDK 0.1.1 types. These values are accepted/preserved without
conversion; upstream support has not been live-verified. Documentation-host access
is still blocked by this environment's network allowlist.

### Private balance-only read

`readUSAccountBalances()` in `src/feeds/polymarket-us.mjs` reads only
`account.balances()` with server environment credentials. It returns
`{ source, fetchedAt, data }`, preserving the raw response without logging or
persisting balances or pending withdrawals. There is no public route.

The supplied Account reference describes top-level `currentBalance`, `buyingPower`,
`openOrders`, collateral, margin and withdrawal fields. SDK 0.1.1 instead declares
`{ balances: UserBalance[] }`. Both shapes are preserved; neither is guessed or
flattened. The formula in the reference is explanatory, not a replacement for
reported buying power. Missing fields are not treated as zero, paper equity is
not replaced with real funds, and no trading authorization is inferred from
this read. No live account request or WebSocket subscription has been verified.

### Public US series browser

The public explorer includes series lists with validated limit/offset, slug lists,
active/closed/archived and recurrence filters, plus numeric-ID lookup. Routes are
`GET /api/polymarket-us/series` and
`GET /api/polymarket-us/series-detail?id=123`. List defaults are limit 10 and
active true; the UI shares pagination and status fields with event lists. Responses
are raw timestamped SDK data; copy a returned series ID into the event Series IDs
filter. SDK 0.1.1 list/retrieve signatures match the supplied Series reference.
Live upstream responses and the documentation index remain inaccessible in this
network environment; tests use mocked SDK responses. No account access or trading
methods are added by the series browser.

### Public US sports and teams

The explorer now offers sports configuration and provider team lookups through
`GET /api/polymarket-us/sports` and `GET /api/polymarket-us/teams`.
Team filters accept provider (`PROVIDER_SPORTRADAR` or `PROVIDER_SPORTSDATAIO`),
league, and up to 50 numeric team IDs (comma-separated or repeated query fields).
IDs are passed as strings as expected by SDK 0.1.1, preserving precision rather
than converting long identifiers to JavaScript numbers. The supplied reference
lists integer IDs and team arrays, while the installed SDK declares string IDs
and a team map. Raw responses are preserved, not reshaped. Sports configuration
flags do not establish a market's tradability or settlement. This is not a live
score/injury feed. Live upstream behavior remains unverified under the network
allowlist; tests use mocked SDK responses. No credentials or orders are involved.

### Public US search

The explorer's **Search US events & markets** form calls
`GET /api/polymarket-us/search?query=bitcoin&limit=10` through the SDK's
`search.query`. It is full-text upstream search, not the loaded-market filter.
Optional inputs are page, seriesIds, marketType and status (active/closed/upcoming).
Array filters accept comma-separated or repeated query parameters. Text, numeric
bounds and filters are validated before requesting upstream data. Results preserve
raw events and nested markets, including empty results, with a fetch timestamp.
Search is explicitly submitted (including Enter); it is not sent on every keystroke.

The supplied documentation includes `marketType`, which SDK 0.1.1 types omit;
the runtime forwards it unchanged. Page base and valid upstream market-type values
are not established by the supplied reference. Leave those fields blank for API
defaults. Live API behavior and the documentation index remain unverified because
those hosts are outside this environment's network allowlist. No private account
access, order mutation, automatic market selection or trading is added.

### Opt-in server-only WebSocket helper

`createUSStream` in `src/feeds/polymarket-us-stream.mjs` supports market events
(`marketData`, `marketDataLite`, `trade`) or private events (`orderSnapshot`,
`orderUpdate`, `positionSnapshot`, `positionUpdate`, `accountBalanceSnapshot`,
`accountBalanceUpdate`). These are JavaScript SDK names, not Python's snake_case.
Installed SDK 0.1.1 signs **both** WebSocket handshakes and requires server
credentials even for market streams. No secrets or private streams are sent to
browser code. The helper is not started automatically and has no HTTP/UI bridge.

```js
import { createUSStream } from './src/feeds/polymarket-us-stream.mjs';

const stream = createUSStream({
  marketSlugs: ['your-verified-market-slug'],
  events: ['marketDataLite', 'trade'],
  onData: async ({ event, data, receivedAt, generation }) => {
    // Consume in trusted server code; do not log private payloads.
    // Validate source timestamps and rebuild state after reconnects.
  },
  onStatus: ({ state, stale }) => {
    // 'subscribed' confirms transport subscription, NOT fresh/complete data.
  },
});
stream.start();
// Call stream.stop() when finished, including during application shutdown.
```

Limits: ten explicit market slugs, unique request IDs, five reconnect attempts
per start by default, exponential backoff from 1s capped at 30s, and a 10s
connection timeout. Reconnects resubscribe; they do not guarantee replay or
continuity. Status notifications conservatively retain `stale: true`; consumers
must establish freshness and complete snapshots themselves. No heartbeat-liveness
monitor or automatic REST reconciliation is provided. Messages are consumed
serially with a 100-item pending limit; consumer failure/overflow stops the stream.
Queued data from a closed connection is discarded. Payloads preserve decimal
strings and are not written into the paper ledger. Live WebSocket connectivity
is unverified under the network allowlist; lifecycle tests use fake sockets.
The supplied documentation index remains inaccessible. This stream helper does not perform order actions.
