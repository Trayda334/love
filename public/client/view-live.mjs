import { h, card, fmtUsd, fmtTime, pill } from './util.mjs';

/** No keys in browser, no storage of passwords/CSRF/account data, no auto-submit. */
export async function renderLive(ctx) {
  let csrf, preview, dead = false, expiryTimer;
  const root = h('div', { class: 'stack live-app' });
  const message = h('div', { class: 'live-message', role: 'status', 'aria-live': 'polite' });
  const body = h('div', { class: 'stack' });
  root.append(h('section', { class: 'live-hero' },
    h('div', { class: 'row row-gap' }, pill('MANUAL EXECUTION', 'warn'), pill('$10 hard order cap', 'accent')),
    h('h1', { text: 'Your decisions. Real stakes.' }),
    h('p', { class: 'muted', text: 'A private Polymarket US order ticket. Review the contract, preview the cost, then explicitly confirm. Research agents never submit real orders.' }),
  ), message, body);
  ctx.app.liveCleanup = () => { dead = true; csrf = undefined; preview = undefined; clearTimeout(expiryTimer); body.replaceChildren(); };
  const say = (text, danger = false) => {
    if (dead) return;
    message.className = `live-message ${danger ? 'live-message-danger' : ''}`;
    message.textContent = text;
  };
  const request = async (path, payload) => {
    const res = await fetch(`/api/live/${path}`, { method: payload === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: payload === undefined ? {} : { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: payload === undefined ? undefined : JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      if (res.status === 401 && !dead) { csrf = undefined; showLogin(); }
      throw new Error(data.error || 'The request failed.');
    }
    return data;
  };
  const field = (label, input, note) => h('label', { class: 'field' }, h('span', { text: label }), input, note ? h('span', { class: 'muted small', text: note }) : null);
  const money = cents => fmtUsd(cents / 100);
  const details = (label, value) => h('div', { class: 'live-detail' }, h('span', { class: 'muted small', text: label }), h('strong', { text: value ?? 'Not reported' }));
  const expire = expiresAt => {
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => { if (!dead) { csrf = undefined; preview = undefined; showLogin(); say('Session expired. Private account data cleared. Sign in again.', true); } }, Math.max(0, expiresAt - Date.now()));
  };

  function showLogin() {
    preview = undefined;
    const password = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true, 'aria-label': 'Private app password' });
    const submit = h('button', { class: 'btn btn-primary', type: 'submit', text: 'Unlock private trading' });
    const form = h('form', { class: 'stack', onsubmit: async event => {
      event.preventDefault(); submit.disabled = true;
      const value = password.value; password.value = '';
      try {
        const result = await request('login', { password: value });
        if (dead) return;
        csrf = result.csrf; expire(result.expiresAt); showTrading(); say('Signed in. No order is sent until you preview and confirm.');
      } catch (err) { say(err.message, true); }
      finally { submit.disabled = false; }
    } }, field('Private deployment password', password, 'This is your app password—not a Polymarket API secret.'), submit);
    body.replaceChildren(card('Private access', h('p', { class: 'muted', text: 'Sign in on your configured private HTTPS deployment. The session expires after 15 minutes; account data is not stored in your browser.' }), form));
  }

  function showTrading() {
    const accountBox = h('div', { class: 'stack' }, h('p', { class: 'muted small', text: 'No real-account data loaded yet. Use Refresh real account.' }));
    const refresh = h('button', { class: 'btn', text: 'Refresh real account', onclick: async () => {
      refresh.disabled = true;
      try { const data = await request('account'); if (!dead && csrf) renderAccount(accountBox, data); }
      catch (err) { say(err.message, true); } finally { refresh.disabled = false; }
    } });
    const logout = h('button', { class: 'btn', text: 'Lock & sign out', onclick: async () => {
      try { await request('logout', {}); } catch (err) { say(err.message, true); }
      finally { csrf = undefined; preview = undefined; clearTimeout(expiryTimer); if (!dead) showLogin(); }
    } });
    const slug = h('input', { class: 'input', required: true, placeholder: 'Exact Polymarket US market slug', autocomplete: 'off' });
    const price = h('input', { class: 'input', type: 'number', min: '0.0001', max: '0.9999', step: '0.0001', required: true, placeholder: '0.55' });
    const quantity = h('input', { class: 'input', type: 'number', min: '0.001', max: '1000', step: '0.001', required: true, placeholder: 'e.g. 10' });
    const previewBox = h('div', { class: 'stack' });
    let ticketVersion = 0;
    const submit = h('button', { class: 'btn btn-primary', type: 'submit', text: 'Preview order — no submission' });
    const form = h('form', { class: 'stack', onsubmit: async event => {
      event.preventDefault(); submit.disabled = true; preview = undefined; previewBox.replaceChildren();
      const version = ticketVersion;
      try {
        const out = await request('preview', { marketSlug: slug.value.trim(), price: price.value, quantity: quantity.value });
        if (dead) return;
        if (version !== ticketVersion) { say('Ticket changed during preview. Request a new preview.', true); return; }
        preview = out.preview; showPreview(previewBox, preview);
        say('Preview ready. Verify the exact outcome and cost below. Expires in 60 seconds.');
      } catch (err) { say(err.message, true); }
      finally { submit.disabled = false; }
    } }, field('US market slug', slug, 'Use the US contract, not an unverified example slug.'),
    h('div', { class: 'grid-2' }, field('Limit price · USD per long contract', price), field('Contracts', quantity)),
    h('div', { class: 'strip strip-paper', text: 'BUY LONG ONLY · LIMIT · IMMEDIATE OR CANCEL. Up to the requested quantity may fill; any remainder is canceled. No sell, short, modify, market order or full-position exit controls.' }),
    h('p', { class: 'muted small', text: 'The $10 cap includes a reserve calculated from the preview’s reported maker/taker fee rates. Missing or mismatched fee data blocks submission. This is a per-order limit, not a daily loss cap. Multiple orders can lose more than $10.' }), submit);
    for (const input of [slug, price, quantity]) input.addEventListener('input', () => { ticketVersion++; preview = undefined; previewBox.replaceChildren(h('p', { class: 'muted small', text: 'Ticket changed. Get a new preview.' })); });
    const recoveryId = h('input', { class: 'input', placeholder: 'Operation ID from the submit screen' });
    const recoveryResult = h('div');
    const check = h('button', { class: 'btn', text: 'Check saved submission status', onclick: async () => {
      check.disabled = true;
      try {
        const result = await request(`operation?id=${encodeURIComponent(recoveryId.value.trim())}`);
        if (!dead) recoveryResult.replaceChildren(h('pre', { class: 'live-json', text: JSON.stringify(result.operation, null, 2) }));
      } catch (err) { say(err.message, true); } finally { check.disabled = false; }
    } });
    body.replaceChildren(
      h('div', { class: 'row row-between row-gap' }, pill('PRIVATE SESSION · REAL MONEY', 'warn'), h('div', { class: 'row row-gap' }, refresh, logout)),
      h('div', { class: 'live-columns' }, card('Manual order ticket', form, previewBox), card('Real account', accountBox)),
      card('Submission recovery', h('p', { class: 'muted small', text: 'If a submit request times out, do not retry. Save the operation ID, check its status here, then verify orders and activity in the official Polymarket US app. Unknown submissions block further trading across server restarts. Recovery is not a retry or cancellation.' }), field('Operation ID', recoveryId), check, recoveryResult),
    );
    function showPreview(host, draft) {
      const acknowledged = h('input', { type: 'checkbox', required: true });
      const confirmation = h('input', { class: 'input', autocomplete: 'off', placeholder: draft.confirmation, required: true });
      const send = h('button', { class: 'btn btn-danger', type: 'submit', text: `Submit REAL order · up to ${money(draft.totalCents)}`, disabled: true });
      const valid = () => { send.disabled = !acknowledged.checked || confirmation.value !== draft.confirmation || Date.now() >= draft.expiresAt; };
      acknowledged.addEventListener('change', valid); confirmation.addEventListener('input', valid);
      const finalForm = h('form', { class: 'stack', onsubmit: async event => {
        event.preventDefault();
        if (send.disabled || preview?.id !== draft.id) return;
        // Remove confirmation controls immediately; never offer retry after dispatch.
        preview = undefined;
        host.replaceChildren(h('p', { class: 'mono', text: `Operation ID: ${draft.id}` }), h('p', { text: 'Submitting once. Do not close or retry this request.' }));
        try {
          const result = await request('submit', { previewId: draft.id, confirmation: confirmation.value, acknowledged: acknowledged.checked });
          if (!dead) host.append(h('p', { text: result.operation.message }), details('Order ID', result.operation.orderId), h('p', { class: 'muted small', text: 'An order ID is not proof of execution. Verify fills in your official account. Refresh real account for updated positions and orders.' }));
        } catch (err) {
          say(err.message, true);
          if (!dead) host.append(h('p', { class: 'live-message-danger', text: 'Do not resubmit on a connection error. Use the operation ID to check status and reconcile in Polymarket US. The ticket may have reached the exchange.' }));
        }
      } }, h('label', { class: 'live-check' }, acknowledged, h('span', { text: 'I verified the resolution rules and long outcome, meet Polymarket US eligibility requirements, and accept the possibility of losing this entire stake.' })),
      field(`Type exactly: ${draft.confirmation}`, confirmation), send);
      host.replaceChildren(h('section', { class: 'live-preview stack' },
        h('h3', { text: 'Review before real submission' }),
        h('h4', { text: draft.market.title }), details('Long contract outcome', draft.market.outcome), details('Exact US market', draft.market.slug),
        h('p', { class: 'muted small', text: draft.market.description || 'No resolution description returned. Verify the full contract rules in Polymarket US.' }),
        h('div', { class: 'grid-3' }, details('Maximum notional', money(draft.notionalCents)), details('Fee reserve', money(draft.feeReserveCents)), details('Maximum modeled spend', money(draft.totalCents))),
        details('Quantity × limit price', `${draft.request.quantity} × $${draft.request.price.value}`),
        details('Preview expires', fmtTime(draft.expiresAt)),
        h('p', { class: 'muted small', text: 'The server rechecks market identity, status, buying power and fees before dispatch. A preview does not guarantee a fill. The long outcome is shown explicitly; never assume it is the first team or favorite.' }), finalForm));
    }
  }

  function renderAccount(host, result) {
    const raw = result.balances;
    const usd = Array.isArray(raw?.balances) ? raw.balances.filter(b => b.currency === 'USD') : raw?.currency === 'USD' ? [raw] : [];
    const balance = usd.length === 1 ? usd[0] : null;
    const amount = value => value === null || value === undefined ? 'Not reported' : String(value);
    const positions = result.positions?.positions;
    const rows = positions && typeof positions === 'object' ? Object.entries(positions) : [];
    const orders = Array.isArray(result.orders?.orders) ? result.orders.orders : [];
    host.replaceChildren(
      h('p', { class: 'muted small', text: `Fetched ${fmtTime(result.fetchedAt)} · manual refresh · not a live stream` }),
      h('div', { class: 'grid-2' }, details('USD balance', amount(balance?.currentBalance)), details('USD buying power', amount(balance?.buyingPower)), details('USD reserved by orders', amount(balance?.openOrders)), details('Pending withdrawals', Array.isArray(balance?.pendingWithdrawals) ? String(balance.pendingWithdrawals.length) : 'Not reported')),
      h('h4', { text: 'Positions · first page only' }),
      ...(rows.length ? rows.map(([slug, pos]) => h('div', { class: 'live-position' }, details('Market', pos.marketMetadata?.title || slug), details('Net contracts (decimal field)', amount(pos.netPositionDecimal)), details('Cash value', pos.cashValue ? `${pos.cashValue.value} ${pos.cashValue.currency}` : 'Not reported'))) : [h('p', { class: 'muted small', text: positions ? 'No positions on this page.' : 'Position response unavailable or unrecognized.' })]),
      result.positions?.nextCursor ? h('p', { class: 'muted small', text: 'Additional position pages exist. Use the official account for the complete portfolio.' }) : null,
      h('h4', { text: 'Open orders · returned snapshot' }),
      ...(orders.length ? orders.map(order => h('div', { class: 'live-position' }, details(order.marketSlug || 'Market not reported', order.state), details('Order ID', order.id), details('Price', order.price ? `${order.price.value} ${order.price.currency}` : 'Not reported'))) : [h('p', { class: 'muted small', text: Array.isArray(result.orders?.orders) ? 'No open orders returned.' : 'Order response unavailable or unrecognized.' })]),
      h('p', { class: 'muted small', text: 'Manage cancellations, sells and existing exposure in the official Polymarket US app. This initial ticket does not provide those actions. No account data is added to the paper ledger.' }),
    );
  }

  try {
    const status = await request('status');
    if (dead) return root;
    if (!status.enabled) {
      body.replaceChildren(card('Live trading is locked',
        h('p', { text: status.message }),
        h('ul', { class: 'small' }, h('li', { text: 'Private HTTPS deployment with a dedicated operator password.' }), h('li', { text: 'Server-side Polymarket US credentials and an eligible account.' }), h('li', { text: '$10 server-enforced cap, exact fee verification, preview and confirmation.' })),
        h('p', { class: 'muted small', text: 'No sign-in or order request is sent from this screen while disabled. See docs/LIVE_TRADING.md for deployment and limitations. Do not paste API secrets into this app or chat.' }),
      ));
    } else if (status.authenticated) { csrf = status.csrf; expire(status.expiresAt); showTrading(); if (status.uncertain) say('An earlier submission has an unknown outcome. New orders are blocked until private reconciliation.', true); }
    else showLogin();
  } catch (err) { say(err.message, true); }
  return root;
}
