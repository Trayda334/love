# Manual live trading — private integration prototype

This is a different workflow from paper research. It can submit actual orders
when explicitly enabled. Development tests use mocked clients only. No live
account was accessed, order submitted, or live API response verified here.
Upstream hosts are outside the development environment's network allowlist.
**Do not treat passing mocked tests as a production-readiness certification.**

## Supported initial scope

- One private operator, one Node process, one Polymarket US account.
- BUY LONG limit orders only, `TIME_IN_FORCE_IMMEDIATE_OR_CANCEL`.
- The long contract's title, slug, outcome and description are shown for review.
  Long does not automatically mean the favorite, first-listed team, or a literal
  Yes label. Verify the exact resolution rules in the official US app.
- Price precision up to 4 decimal places; quantity precision up to 3 places.
  Exchange minimum quantity and price rules must also pass its preview.
- The hard cap is **$10 per order including a modeled fee reserve**. Notional is
  rounded up to cents; fees are separately rounded up using the greater of the
  preview's reported maker/taker basis-point rates. The limit cannot be raised
  through request fields, the UI, or configuration.
- Missing fees, mismatched preview/order fields, unknown USD buying power,
  inactive/closed markets and unverified identity block execution.
- The preview must report a new/pending-new order state, exact IOC/limit/long
  fields, quantity, price, currency and both fee rates. Unrecognized live response
  shapes deliberately fail closed; inspect the current official API contract
  privately before adapting them. Do not remove checks just to get a fill.
- No sells, buy-short, modify, cancel, resting orders, market orders, full-position
  close, automated strategies or daily spending cap. Manage existing exposure and
  cancellations in the official app. Repeated orders can lose more than $10.
- The cap relies on accurate upstream price/fee reports; it is not a guarantee
  against incorrect exchange reporting, extra charges outside those rates or
  subsequent market losses. No leverage/margin intent is offered by this ticket.

## Private deployment

1. Install Node 20+ and run `npm ci`. Keep the deployment private and restrict
   network access to the intended operator (VPN/access gateway recommended).
2. Serve behind HTTPS, preserve the original `Host` header, and firewall the
   backend HTTP port from public/direct access. The live API deliberately does
   not trust `X-Forwarded-Host` or `X-Forwarded-Proto`.
3. Configure secrets through the hosting provider's server secret settings:

   ```text
   LIVE_TRADING_ENABLED=true
   LIVE_APP_ORIGIN=https://your-private-domain.example
   LIVE_ADMIN_PASSWORD=<a unique random secret of at least 32 characters>
   POLYMARKET_KEY_ID=<your US API key ID>
   POLYMARKET_SECRET_KEY=<your US API secret>
   ```

   These placeholders are NOT valid credentials. Never paste actual keys into
   chat, browser fields, Git or logs. The browser login accepts only your private
   app password, not a Polymarket API secret. Use least-privilege credentials
   where available, and respect platform eligibility and local restrictions.
4. Persist the `data/` directory on a local, durable filesystem. The default
   journal is `data/live-dispatch.jsonl`; optional `LIVE_JOURNAL` selects a private
   path. It has mode 0600 and contains dispatch IDs, market slugs, modeled spend,
   timestamps and returned order IDs—not credentials or complete account payloads.
   Do not put it in a public directory or Git. Back it up privately.
5. Run exactly **one server instance** for this account/journal. An exclusive `.lock` file rejects a second process using that journal. There is no
   distributed session, cross-filesystem lock, exchange idempotency or shared-budget service. Do not run
   multiple workers or replicas. Losing the dispatch journal loses local
   duplicate-submission protection. Never recreate it to bypass an unknown order.
   A crash can leave the `.jsonl.lock` file behind. First verify that no process
   uses the journal, inspect/reconcile any DISPATCHING entry, and only then remove
   the **lock file alone** to permit startup. Do not remove the journal.
6. Run `npm start`, open the site in a top-level browser window and choose
   **Real-money trading**. When enabled, framing is blocked and the CSP limits
   browser connections to this origin. Embedded Arena preview is intentionally
   not a deployment target for live trading. Paper browser-direct feeds are also
   restricted by that CSP; server-side public reads remain available.
7. Before enabling actual use, verify the installed SDK's current live request
   and response schemas, preview fees, intent semantics and IOC behavior against
   current official documentation in an environment that can reach the API.
   Mock tests cannot establish these facts. Any real-money validation must be
   deliberately authorized by the account holder; do not automate test trades.

Leave `LIVE_TRADING_ENABLED` unset or `false` for research-only use. A missing
origin, password, keys or valid journal keeps the live gateway disabled. `npm start`
does not automatically load `.env`; use hosting secrets or Node's
`node --env-file=.env server.mjs` locally, with the same private HTTPS setup.
`.env` and `.env.*` are ignored, except the placeholder-only `.env.example`.

## Sign-in and submission flow

- Exact host/origin allowlisting, JSON-only mutations and CSRF are enforced by the
  server. There are no CORS permissions for private data.
- Sign-in creates a random HttpOnly, Secure, SameSite=Strict cookie scoped to
  `/api/live`, plus a CSRF token held only in page memory. Sessions expire after
  15 minutes. A new sign-in invalidates the previous session; sign-out revokes it.
- Login has a global five-failure/15-minute limit. An upstream private access
  gateway should provide additional brute-force and traffic protections. The app
  uses a shared operator secret, not multi-user accounts, MFA or password recovery.
- Balances, positions (first 20 results) and open orders load only when requested.
  They remain separate from the paper balance/ledger, are not stored in browser
  storage, and are removed from the screen on route exit or session expiry.
  Position pagination is explicitly labelled; the official app is authoritative.
- Enter a US market slug, limit price and quantity. Preview calls the authenticated
  SDK as `orders.preview({ request })`, matching installed JavaScript SDK 0.1.1,
  not the Python flat preview example. It also reads market identity and balance.
- A preview is bound to the authenticated session and expires after 60 seconds.
  Editing the ticket requires another preview. A new completed preview replaces
  that session's prior preview.
- Read the long outcome and costs, acknowledge eligibility/risk/rules, and type
  the exact displayed `BUY <quantity> LONG <slug>` phrase. Only then is the real
  submit control enabled. The server enforces the same confirmation independently.
- Submission consumes the preview, rechecks identity/rules, active status,
  buying power and preview cost, and refuses an expired or more expensive order.
- A durable DISPATCHING record is written and fsynced before the one and only
  `orders.create()` call. No network retry is attempted. A returned order ID is
  recorded as ACCEPTED; that means exchange acknowledgement, **not a fill**.

## Interrupted or uncertain submissions

Save the operation ID shown before dispatch. If the browser request fails, do NOT
click another order to try to recreate it. Use **Submission recovery** to inspect
that operation, and verify orders **and activity/fills** in the official app.
Absence from open orders alone does not establish that nothing executed.

An exception after dispatch, a missing exchange order ID or a crash between
DISPATCHING and durable ACCEPTED is considered unknown. Such a record blocks all
new previews/submissions, including after restart. The implementation intentionally
has **no automatic unlock or retry endpoint**. Reconciliation requires a private
operator/developer review of exchange records and the preserved journal. Keep the
service disabled until that review is complete. Do not delete or overwrite the
journal; a reviewed reconciliation/migration tool is outside this initial scope.

If the operator loses a response but the service recorded ACCEPTED, recovery can
show the order ID. Inspect actual execution state in the official app before
making any further decision. The service does not automatically replay missed
WebSocket events or infer fills from account balance changes.

To revoke access, disable the live gateway, stop the process and revoke/rotate
credentials as appropriate. Stopping the app does not cancel orders already
accepted by the exchange. The IOC restriction does not eliminate the need to
verify execution. A restarted process invalidates browser sessions and previews.

## API surface and tests

Public configuration: `GET /api/live/status` (no financial data before sign-in).
Sign-in: `POST /api/live/login` (same-origin JSON). Authenticated routes:

- `GET /api/live/account`
- `POST /api/live/preview`
- `POST /api/live/submit`
- `GET /api/live/operation?id=...`
- `POST /api/live/logout`

Mutations after sign-in require `X-CSRF-Token`. There are no general-purpose SDK
proxy endpoints. Unknown paths/methods do not execute an order.

`npm test` covers exact cap arithmetic and fees, forbidden intent/type/TIF
injection, preview ownership/expiry/replacement, identity/balance checks, concurrent
submits, journal write failures, ambiguous outcomes and restart locking. HTTP tests
cover disabled/misconfigured deployments, secure sessions, origin/host/CSRF checks,
expiration, logout, rate limiting and recovery. A jsdom UI test exercises the manual
confirmation flow with mocked fetch only; the existing smoke test verifies the
shared preview's disabled screen. **None of these tests submits real orders.**
