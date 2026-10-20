# Testing the paper desk

Two layers: an automated suite you can run in a few seconds, and a manual plan that checks the things code cannot (whether *you* are following the rules).

```bash
npm ci
npm test                                  # includes jsdom UI tests
```

The app uses `polymarket-us` at runtime and `jsdom` for UI tests. SDK/live trading tests use mocked clients only. The paper smoke server explicitly disables live trading even if the parent environment contains live settings. No automated test accesses a real account or submits a real order.

## What the automated tests cover

### `test/feedcore.test.mjs` — the market math
- Candle normalisation across array/object shapes, timestamp sorting, seconds → milliseconds.
- The still-forming candle is dropped, so "last 5 minute move" cannot flicker.
- Too little history returns `ok: false` with a reason instead of silent nonsense.
- 5-minute / 15-minute moves are measured from **closed** candles.
- Missing context stays `null` (`volume24hUsd`, `liquidityUsd`, `change24h`) — never `0`, never a guess.
- A vertical pump is flagged as extended; a tight coil is detected as a base.
- The mistake taxonomy and block categorisation map to the right agent.

### `test/agents.test.mjs` — the rules
- **The 1% ceiling cannot be raised** (config patch is clamped and a violation is reported); it can be lowered.
- Rule changes produce a diff (old → new) so the audit trail can show them.
- Scanner: passes a clean coil; skips wild volatility and falling structures; refuses a stop that is not below entry; refuses a poor reward/risk; marks candle-dependent checks *unknown* on hand-typed data.
- Anti-FOMO: blocks a vertical pump on several independent checks; approves an orderly coil; blocks on hype language; **blocks when too many checks cannot be evaluated** ("if risk cannot be clearly defined, BLOCK IT"); keeps its explanation to three sentences.
- Sizer: sizes to the risk budget with fees subtracted so the *worst case including costs* stays inside 1%; rejects stops that are too tight, too wide, or offer poor reward; enforces the one-position rule; never increases risk after a loss; cannot be pushed over 1% even by a tampered config object.
- Buyer: refuses without every approval, refuses a fill above the planned entry area (a chase), refuses when price is already through the invalidation level, respects the one-position rule, and emits the guide's ticket fields.
- Prediction agent: SKIPs on thin evidence, wide spreads, thin liquidity and edge-less estimates; bets only on a genuine edge with its own 1% cap.
- Logger: P&L is net of simulated costs, the result is tagged correctly, a closed record **cannot be closed twice**, and the 20-trade review reports exactly the guide's figures (win rate, average win/loss, biggest win/loss, total P&L, blocked count, most common mistake). The rule audit catches a trade that exceeded 1% risk or was entered without a stop.

### `test/pipeline.test.mjs` — the workflow
- A clean coil opens a paper ticket through Scanner → Anti-FOMO → Sizer → Buyer → Logger.
- A pump is blocked by Anti-FOMO **and the block is written to the ledger** with its reasons and category.
- Dump and volatile scenarios are blocked at the Scanner (nothing is even sized).
- The one-position rule blocks a second entry before anything else runs.
- Guided mode pauses at each gate and **writes nothing** until the operator approves.
- Declining a gate records the block; overriding an agent stamps the record with `OVERRIDDEN BY OPERATOR` and keeps the original verdict.
- Closing a position updates the account, the audit trail and the stats.
- The ledger is append-only (duplicate ids throw); refused rule changes are audited too.
- State survives a real file round-trip (the ledger is on disk, not just in memory).
- Worst-case risk is recorded from the **actual simulated fill**, and a stop-out loses roughly that amount and never more than 1% of the account.

### `test/sources.test.mjs` — the data layer
- Coinbase rows are mapped in the correct order (low/high are not swapped), and statistics are derived correctly.
- The source chain falls through Coinbase → Kraken → Binance when earlier sources fail.
- When nothing is reachable, the feed **says so** rather than substituting a number.
- Client-fetched payloads are recomputed server-side: a payload claiming `r5: 999` is ignored and the real value is derived.
- Empty client payloads are refused.
- Manual snapshots keep unknown fields unknown, are labelled `USER-PROVIDED`, and compute distance-to-support from the numbers the operator supplied.
- Demo data is watermarked and shaped to trip (or pass) the intended rules.
- Search normalises different catalog shapes and filters offline products.

### `test/ui.smoke.test.mjs` — the real interface
Boots the actual server, builds the actual DOM, imports the actual client modules, and drives them:

1. Every route renders (desk, ledger, review, research, onboarding, guide).
2. The guide renders from `docs/SETUP_GUIDE.md`, including the disclaimer.
3. The four-scenario self-test reports 4/4.
4. Demo data loads and is visibly watermarked.
5. A plan is derived, then the pipeline is run in Guided mode and approved at all three gates, producing a paper ticket.
6. The ticket appears in the ledger and the status bar.
7. The position is closed **at its stop**, and the realised loss is asserted to be inside the 1% rule.
8. A pump is loaded and the Anti-FOMO block appears in the UI and in the ledger.
9. The blocked setup is marked "would have lost" and the review page reports it.

Any uncaught error or unhandled promise rejection in the page fails the test.

## Manual test plan

The automated tests prove the *rules* behave. They cannot prove you will follow them. Work through this once, on purpose, and note anything confusing.

| # | Do this | You should see |
| --- | --- | --- |
| 1 | Run the self-test on **Start here**. | Four scenarios, 4/4 as designed, and an explicit note that your ledger was not touched. |
| 2 | Load demo data (`pump`) and force the trade through by overriding Anti-FOMO. | A ticket exists, and the record says `OVERRIDDEN BY OPERATOR` with the original BLOCK preserved. |
| 3 | On the desk, type a written reason like "to the moon, 100x". | Anti-FOMO blocks on hype language even if the numbers look fine. |
| 4 | Lower `risk.riskPctPerTrade` to 0.25 and check the audit trail. | The change is recorded with old and new values. |
| 5 | Try to raise it to 5%. | Refused, explained, and the refusal is itself audited (`RULE_CHANGE_REFUSED`). |
| 6 | Open a position, then try to open another. | Blocked at the one-position rule before anything is evaluated. |
| 7 | Close a position below the stop on purpose. | The loss is logged, the mistake is tagged, and the review page's rule audit shows it. |
| 8 | Stop the server, delete `data/desk.json` after making a copy, restart. | A fresh desk. Restore the copy and everything comes back — nothing is stored anywhere else. |
| 9 | Turn on the auto-scan timer with a ticker and no live data access. | Each cycle reports `no-data` honestly; no ticket is invented. |
| 10 | After 20 closed trades, open **Review**. | The first 20-trade block appears with the guide's figures. |

### What "good" looks like after a month

- 50–100 closed trades, at least 20 of them live-data (not demo).
- No rule violations in the rule-following audit.
- A mistake tally that names your own behaviour, not just the bot's.
- Blocked setups reviewed honestly: some marked "would have won" (the agent is not omniscient) and some "would have lost".
- A result you would be comfortable showing someone else in full — including the losers.


## Manual live-order gateway coverage

See `docs/LIVE_TRADING.md` for deployment, scope, limitations and recovery.
`live-trading.test.mjs` verifies decimal cap/fee arithmetic, exact preview echo,
server-side owner/expiry/confirmation checks, fresh revalidation, once-only
submission, durable dispatch-before-create, failure/unknown-state blocking and
restart recovery. `live-http.test.mjs` checks disabled defaults, session cookies,
host/origin restrictions, CSRF, logout/expiry, login rate limiting and recovery.
`live-ui.test.mjs` runs a completely mocked private login, preview and exact-phrase
confirmation flow. The normal UI smoke test checks the disabled live screen.
These passing tests are not live integration certification; the SDK response shapes
and IOC/fee semantics must be verified privately without automatic test trades.
