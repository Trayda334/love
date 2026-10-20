/** Router for paper research and a separate, authenticated manual live ticket. */

import { h, $, api, toast, fmtUsd, pill } from './util.mjs';
import { renderLive } from './view-live.mjs';
import { renderDesk } from './view-desk.mjs';
import { renderLog } from './view-log.mjs';
import { renderReview } from './view-review.mjs';
import { renderResearch } from './view-research.mjs';
import { renderSetup } from './view-setup.mjs';
import { renderGuide } from './view-guide.mjs';

export const app = {
  state: null,
  route: 'live',
  snapshot: null,
  snapshots: new Map(),
  plan: null,
  planOverride: null,
  pipeline: null,
  gates: {},
  mode: 'guided',
  writtenReason: '',
  pair: '',
  source: null,
  channel: null,
  lastFetchError: null,
  fetchLog: [],
  logTab: 'predictions',
  setupTab: 'start',
  markets: null,
  marketChannel: null,
};

const ROUTES = {
  live: { label: 'Real-money trading', render: renderLive },
  research: { label: 'Polymarket research', render: renderResearch },
  log: { label: 'Positions & results', render: renderLog },
  guide: { label: 'Setup guide', render: renderGuide },
  start: { label: 'Checks & settings', render: renderSetup },
  desk: { label: 'Crypto tools', render: renderDesk },
  review: { label: 'Crypto review', render: renderReview },
};

let refreshing = false;
let refreshQueued = false;

export async function reload() {
  app.state = await api('/api/state');
  return app.state;
}

export async function refresh({ keepScroll = false } = {}) {
  // A refresh requested while another is in flight must not be dropped - the
  // state may already have moved on (e.g. a new snapshot arrived). Queue one.
  if (refreshing) {
    refreshQueued = true;
    return;
  }
  refreshing = true;
  try {
    const y = keepScroll ? window.scrollY : 0;
    app.liveCleanup?.();
    app.liveCleanup = null;
    const view = $('#view');
    const route = ROUTES[app.route] || ROUTES.desk;
    const ctx = context();
    const out = route.render(ctx);
    view.replaceChildren(out instanceof Promise ? await out : out);
    renderNav();
    renderStatusBar();
    if (keepScroll) window.scrollTo({ top: y });
  } catch (err) {
    console.error(err);
    $('#view').replaceChildren(h('div', { class: 'card card-danger' }, h('h3', { text: 'Something broke in the page' }), h('p', { text: err.message }), h('p', { class: 'muted small', text: 'The ledger and the server are fine - this is a display error. Reload the page.' })));
  } finally {
    refreshing = false;
    if (refreshQueued) {
      refreshQueued = false;
      await refresh({ keepScroll });
    }
  }
}

function context() {
  return {
    app,
    get state() {
      return app.state;
    },
    reload,
    refresh,
    go: (route) => {
      location.hash = `#/${route}`;
    },
  };
}

function renderNav() {
  const nav = $('#nav');
  nav.replaceChildren(
    h('div', { class: 'brand' }, h('span', { class: 'brand-dot' }), h('strong', { text: 'Polymarket Desk' })),
    h('div', { class: 'navlinks' }, ...Object.entries(ROUTES).map(([id, r]) =>
      h('a', { class: `navlink ${app.route === id ? 'navlink-active' : ''}`, href: `#/${id}`, text: r.label }))),
  );
}

function renderStatusBar() {
  const bar = $('#statusbar');
  const s = app.state;
  if (!s) return;
  if (app.route === 'live') {
    bar.replaceChildren(pill('REAL-MONEY TICKET', 'warn'), pill('$10 per order · private sign-in required', 'accent'), h('span', { class: 'muted small', text: 'Paper balances and agents do not authorize live trades.' }));
    return;
  }
  bar.replaceChildren(
    h('span', { class: 'paper-tag', text: app.route === 'live' ? 'REAL-MONEY TICKET · $10 CAP' : 'PAPER MODE' }),
    pill(`${fmtUsd(s.account.balance)} paper`, 'good'),
    pill(`${s.records.filter(r => r.kind === 'prediction' && r.status === 'OPEN_BET').length}/${s.config.prediction.maxOpenBets} paper bets open`, 'neutral'),
    pill(`${s.records.filter(r => r.kind === 'prediction' && r.status === 'RESOLVED').length} resolved`, 'neutral'),
    pill(app.route === 'live' ? 'Private sign-in required · no auto-trading' : 'Paper research · no live execution', 'accent'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn btn-mini', text: 'Refresh data', onclick: async () => { await reload(); await refresh({ keepScroll: true }); toast('State refreshed.', 'info'); } }),
  );
}

function routeFromHash() {
  const hash = (location.hash || '').replace(/^#\/?/, '');
  return ROUTES[hash] ? hash : null;
}

async function boot() {
  try {
    await reload();
  } catch (err) {
    document.body.innerHTML = '';
    document.body.append(h('div', { class: 'card card-danger', style: 'margin:2rem' },
      h('h3', { text: 'The desk server is not answering' }),
      h('p', { text: err.message }),
      h('p', { class: 'muted small', text: 'Start it with: npm start (then open http://localhost:8787).' })));
    return;
  }

  const fromHash = routeFromHash();
  app.route = fromHash || 'live';

  window.addEventListener('hashchange', async () => {
    const r = routeFromHash() || 'live';
    if (r === app.route) return;
    app.route = r;
    await refresh();
  });

  await refresh();

  // keep the counters honest without hammering the server
  setInterval(async () => {
    if (document.hidden) return;
    const wasAuto = app.state?.autoScan?.enabled;
    try {
      await reload();
      renderStatusBar();
      if (wasAuto && (app.route === 'desk' || app.route === 'review')) await refresh({ keepScroll: true });
    } catch {
      /* ignore transient errors */
    }
  }, 25000);
}

boot();
