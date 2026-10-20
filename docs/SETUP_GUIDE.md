# 6 AI Bot Trading Team: Setup Guide (Paper Mode)

**A beginner-friendly 6-agent trading experiment — PAPER MODE ONLY**

---

## Before You Start

This setup is inspired by a viral claim where six Grok bots supposedly turned $89 into $55,698. **That result is unverified.** This guide is not about trying to copy that return. The goal is to build the same *type* of 6-agent system and test it using paper trading only.

No real money. No real orders. You are testing whether the system can follow rules consistently.

### What You Need

- A free Grok or ChatGPT account
- A free paper-trading or demo account
- Google Sheets or Excel
- A place to view crypto prices and charts
- Optional: prediction-market data for research

> **Important:** keep everything in PAPER MODE. Do not connect a real wallet or live brokerage account while learning.

In this build, the paper account, the spreadsheet and the price feed are all inside the app itself: the "paper account" is internal, the ledger exports to CSV for Google Sheets or Excel, and prices come from public read-only market-data APIs. The free Grok/ChatGPT account is still useful — every agent's copy-paste prompt is in this guide and on the **Setup guide** page, so you can ask a model for a second opinion on the numbers the desk computed.

### How the 6-Agent Team Works

- **Agent 1 — Scanner:** finds possible trade setups.
- **Agent 2 — Sizer:** decides how much the simulated trade can risk.
- **Agent 3 — Buyer:** creates the paper trade only after approvals.
- **Agent 4 — Prediction-Market Agent:** tracks small side-bet ideas separately.
- **Agent 5 — Anti-FOMO Agent:** blocks entries that chase a move already pumping.
- **Agent 6 — Logger:** records every trade, win, loss, and blocked setup.

Think of it like a tiny trading desk. Every AI has one job.

---

## Step 1 — Set the Fixed Rules

- PAPER TRADING ONLY.
- Maximum one open position at a time.
- Risk no more than 1% of the paper account per trade.
- Every trade needs a predetermined stop-loss.
- Never increase risk after a loss.
- Never chase a token that is already rapidly pumping.
- Never hide losing trades.
- Every trade needs a written reason.
- If the agents disagree, skip the trade.

Example: on a $1,000 paper account, a 1% max-risk rule means the most you can lose if the stop is hit is $10. That does **not** necessarily mean the position itself is only $10.

**How this build enforces it.** Five of these rules are *hard rules* in code, not settings: paper-only, the 1% ceiling, stop required, one position at a time, and append-only records. You can make risk *smaller* (0.5%, 0.25%) but the app refuses to let you raise it above 1%. Thresholds that are genuinely a matter of taste (volatility limits, volume floors, Anti-FOMO percentages) are configurable — and every change is written to an audit trail with the old and new value.

---

## Step 2 — Agent #1: Scanner

The Scanner finds possible setups. It does not size or place trades.

### Copy-Paste Scanner Prompt

```text
You are the Scanner in a six-agent paper-trading team.

Your job is ONLY to identify potential crypto meme-coin trade setups.
PAPER TRADING ONLY. Do not tell me to buy anything with real money.

For every token I give you, analyze:
- current price action
- recent volume
- liquidity
- recent percentage move
- whether price looks extended
- major support and resistance
- whether the move appears orderly or extremely volatile

Return:
TOKEN:
SETUP:
ENTRY AREA:
INVALIDATION LEVEL:
WHY IT MAY BE INTERESTING:
MAIN RISKS:
PASS OR SKIP:

Never choose position size. Never execute a trade. Never chase a token simply
because it is already pumping. If the setup is unclear, say SKIP.
```

**What the code does.** The Scanner measures 5-minute moves, ATR-based volatility, volume pace, distance from support, base/consolidation structure and a proposed invalidation level, then prints PASS or SKIP with the numbers that produced the verdict. It refuses to pass a setup when the stop is not below the entry, when reward/risk is below the minimum, when volume is unverifiable, or when the move is already spent. On hand-typed data it marks candle-dependent checks **unknown** rather than guessing.

---

## Step 3 — Agent #2: Sizer

The Sizer controls risk. It only evaluates setups that already passed the Scanner.

### Copy-Paste Sizer Prompt

```text
You are the Risk and Position Sizing Agent in a six-agent PAPER trading team.

You do not place trades. Your job is to calculate a conservative simulated position size.

Rules:
- PAPER TRADING ONLY
- Maximum account risk per trade: 1%
- Only one open position at a time
- Never increase risk after losing trades
- Never recommend leverage
- If the stop-loss distance makes the trade too risky, reject it

I will provide:
ACCOUNT SIZE:
ENTRY:
STOP LOSS:
TARGET:

Calculate:
1. Maximum dollars allowed to be lost
2. Percentage distance between entry and stop
3. Suggested PAPER position size
4. Estimated risk/reward ratio
5. APPROVE or REJECT

Explain everything in simple language.
```

**What the code does.** The Sizer reads your paper balance, converts the risk percentage into dollars, divides by the stop distance to get a notional position size, subtracts simulated fees and slippage so that the *worst case including costs* still fits inside 1%, caps the notional as a share of the account, and rejects the trade outright when the stop is too tight (inside the noise), too wide (the level is not a real invalidation), the reward/risk is below the minimum, or a position is already open. If the previous closed trade was a loss, it will not raise risk back up.

---

## Step 4 — Agent #3: Buyer

This agent never sends a live order. It creates a simulated trade ticket.

### Copy-Paste Paper Buyer Prompt

```text
You are the execution agent for a six-agent PAPER trading system.

You NEVER place real trades.

Only proceed if:
- Scanner = PASS
- Sizer = APPROVE
- Anti-FOMO Agent = APPROVE
- No other position is currently open

Output:
PAPER TRADE ID:
TOKEN:
SIMULATED ENTRY:
SIMULATED POSITION SIZE:
STOP LOSS:
TARGET:
MAX DOLLAR RISK:
TIME ENTERED:
STATUS: OPEN

If any required approval is missing, respond: TRADE BLOCKED.

Never suggest connecting a wallet or sending a live order.
```

**What the code does.** The Buyer checks the three approvals and the one-position rule, then adds two guards of its own: it refuses to fill if the live price has already run above your planned entry area (that would be a chase), and it refuses if price has already broken through the invalidation level. Otherwise it writes a paper ticket with a signed-off maximum dollar risk. There is no broker client, no API key field and no order endpoint anywhere in this codebase — a live order is not something the app is *prevented* from doing, it is something it cannot do.

---

## Step 5 — Agent #4: Prediction-Market Agent

Keep prediction-market research separate from meme-coin trades. The goal is to compare probabilities, not gamble blindly.

### Copy-Paste Prediction-Market Prompt

```text
You are the Prediction Market Research Agent in a six-agent PAPER trading team.

PAPER MODE ONLY.

For each market, evaluate:
- what event is being predicted
- current market probability
- available evidence
- major arguments for YES
- major arguments for NO
- uncertainty
- important dates
- what information could change the probability

Return:
MARKET:
CURRENT IMPLIED PROBABILITY:
YOUR ESTIMATED RANGE:
WHY:
MAIN UNCERTAINTIES:
PAPER BET: YES / NO / SKIP
MAX PAPER RISK:
CONFIDENCE: LOW / MEDIUM / HIGH

Never claim certainty. If reliable information is missing, choose SKIP.
```

**What the code does.** The agent pulls live market probabilities and spreads, then requires *your* honest probability range and written evidence. It computes the edge (your midpoint versus the market price) and skips when the edge is inside a few points, the spread is wide, liquidity is thin, the market resolves almost immediately, or you supplied almost no reasoning. It keeps its own 1% risk cap and its own ledger, and the skip decisions are logged too.

---

## Step 6 — Agent #5: Anti-FOMO

This agent has one job: say NO when the system starts chasing.

### Copy-Paste Anti-FOMO Prompt

```text
You are the Anti-FOMO Risk Agent.

Your job is to BLOCK bad entries caused by chasing pumps. PAPER TRADING ONLY.

For every proposed trade, check:
- How much has price moved in the last 5 minutes?
- How much has price moved in the last 15 minutes?
- Is volume suddenly exploding?
- Is price far above recent support?
- Is the proposed entry happening after a large green candle?
- Would the trader be entering mainly because they are afraid of missing the move?

If the token has just made an extreme move and there is no clean pullback or base, BLOCK IT.
If risk cannot be clearly defined, BLOCK IT.
If the entry is based mostly on hype, BLOCK IT.

Return only APPROVE or BLOCK, then give a maximum 3-sentence explanation.

Your default should be cautious. Missing a trade is better than chasing one.
```

**What the code does.** Each check above is computed from real candles (5-minute and 15-minute moves, volume pace versus the prior hour, distance above the 1-hour support, the size of the last closed candle versus its average). It also scans your written reason for hype language. If two or more checks cannot be evaluated — which is what happens when you type numbers in by hand — it blocks, because "if risk cannot be clearly defined, BLOCK IT". The explanation is capped at three sentences, and every block is logged with the signals that triggered it.

---

## Step 7 — Agent #6: Logger

The Logger keeps the experiment honest. Do not delete losses. Do not only screenshot winners.

### Copy-Paste Logger Prompt

```text
You are the Logger for a six-agent PAPER TRADING team.

Record EVERY trade and EVERY rejected trade.

For each trade, record:
- Date and time
- Asset
- Setup
- Paper entry and exit
- Position size
- Stop and target
- Profit/loss in dollars and percent
- Scanner decision
- Sizer decision
- Anti-FOMO decision
- Why the trade was taken
- Why it was closed
- Mistakes
- What we learned

At the end of every 20 trades, calculate:
- Total trades
- Wins and losses
- Win rate
- Average win and average loss
- Biggest win and biggest loss
- Total simulated P&L
- Number of blocked trades
- Most common mistake

Never change old results to make performance look better.
```

**What the code does.** Every ticket and every block is appended to `data/desk.json`; records can only be *closed*, never edited or deleted, and the audit trail records each state change. The review page computes exactly the list above, every 20 closed trades, plus drawdown, profit factor, expectancy, per-setup performance and a rule-following audit that flags any trade that ever exceeded the 1% risk rule or lacked a stop. Losses are also tagged with a mistake category — including a button to mark blocked setups later as *would have lost* or *would have won*, which is the only honest way to judge the Anti-FOMO agent.

---

## Step 8 — Run the Workflow

1. Scanner finds the setup.
2. Anti-FOMO checks whether the entry is chasing.
3. Sizer calculates simulated risk.
4. Buyer creates the paper trade.
5. Logger records the decision and result.

Prediction-market ideas go through their own research agent and should also be logged.

**In the app:** the desk runs the same order, and in **Guided** mode it pauses after each approving agent so a human has to click *approve* — a silent onlooker cannot let a trade through. **Auto** mode runs straight through, and every ticket it creates is stamped `AUTO` so it can never be confused with your own decisions. If an agent says no, you may still override it — but the override is written into the record, which is exactly what the review is for.

---

## Step 9 — Track Results in a Simple Spreadsheet

Create these columns in Google Sheets or Excel:

- Date
- Asset
- Entry
- Exit
- Stop
- Position size
- P&L
- Result: WIN / LOSS / BREAKEVEN / BLOCKED
- Setup
- FOMO check
- Notes

At the top, track starting paper balance, current paper balance, total trades, win rate, total P&L, biggest win, and biggest loss.

**In the app:** the ledger page exports both a trades CSV and a blocked-setups CSV in this column order (with the Logger's extra fields appended, because a spreadsheet that drops the decisions is a spreadsheet that cannot answer *why*). The review page shows the same headline figures. To get them into Google Sheets: open the CSV, or paste the export into a sheet.

---

## Step 10 — Test Before You Judge It

Do not judge the system after five trades. Run it for several weeks and aim for **at least 50–100 simulated trades** before drawing conclusions.

- Does it actually follow the rules?
- Does the Anti-FOMO Agent prevent bad entries?
- Are losses controlled?
- Are winners larger than losers?
- What setups fail most often?
- What market conditions produce the best results?

**Before that**, prove the rules fire at all: the **Start here** page has a four-scenario self-test that pushes a quiet base, a vertical pump, a steady dump and a volatile mess through the real pipeline against a throwaway ledger. The base should produce a ticket; the pump should be blocked by Anti-FOMO; the dump and the volatile mess should be skipped by the Scanner. If one of those misbehaves, the problem is the rules, not your discipline.

---

## Common Mistakes

**Changing rules after every loss.** One bad trade does not mean the system is broken. Test enough trades before changing the framework. The app fingerprints rule changes in the audit trail, so you cannot quietly rewrite history.

**Increasing risk because you are winning.** A winning streak does not make the next trade safer. Keep risk consistent. The 1% ceiling is enforced by code.

**Chasing huge green candles.** This is exactly why the Anti-FOMO Agent exists.

**Only tracking winners.** If you hide losses, your data becomes useless.

**Letting AI invent market data.** Always provide or verify current market data. Do not assume an AI automatically knows the latest price. This app never substitutes a made-up price: if every data source fails it shows an error and you can type verified numbers in yourself (labelled USER-PROVIDED) or load demo data (labelled DEMO everywhere it appears).

**Going live too quickly.** A handful of winning paper trades proves very little. Stay in paper mode and collect enough data.

---

## Final Checklist

- Paper-trading account created
- Six AI roles created
- 1% max-risk rule added
- Stop-loss required
- One-position rule enabled
- Anti-FOMO check enabled
- Spreadsheet created
- Wins AND losses are logged
- Real-money trading disabled
- Ready to collect at least 50–100 paper trades

The **Start here** page tracks this list and marks what it can verify from the ledger's own state — including being honest about the two items it cannot verify for you: that you logged your losses, and that you collected enough trades.

---

## Important Disclaimer

This guide is for education and experimentation only. It is not financial advice. Crypto, meme coins, and prediction markets can be extremely risky and volatile.

The viral $89 → $55,698 result that inspired this guide has not been independently verified and should not be treated as a realistic or guaranteed outcome.

Never trade money you cannot afford to lose. Do not assume AI can predict markets reliably. Stay in PAPER MODE until you have tested the system for weeks, reviewed its losses, and understand exactly how it behaves.

The goal is not to get rich overnight. The goal is to learn how a multi-agent system can make structured decisions, follow risk rules, and keep an honest record of its results.
