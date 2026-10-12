/**
 * app.mjs - router and shared state for the six-agent paper desk.
 * PAPER MODE ONLY: the entire client can talk to exactly one server (this one),
 * and that server has no way to reach a real market.
 */

import { h, $, api, toast, fmtUsd, pill } from './util.mjs';
import { renderDesk } from './view-desk.mjs';
import { renderLog } from './view-log.mjs';
import { renderReview } from './view-review.mjs';
import { renderResearch } from './view-research.mjs';
import { renderSetup } from './view-setup.mjs';
import { renderGuide } from './view-guide.mjs';

export const app = {
  state: null,
  route: 'start',
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
  logTab: 'trades',
  setupTab: 'start',
  markets: null,
  marketChannel: null,
};

const ROUTES = {
  start: { label: 'Start here', render: renderSetup },
  desk: { label: 'Trading desk', render: renderDesk },
  log: { label: 'Ledger', render: renderLog },
  review: { label: 'Review', render: renderReview },
  research: { label: 'Prediction markets', render: renderResearch },
  guide: { label: 'Setup guide', render: renderGuide },
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
    h('div', { class: 'brand' }, h('span', { class: 'brand-dot' }), h('strong', { text: 'Six-Agent Paper Desk' })),
    h('div', { class: 'navlinks' }, ...Object.entries(ROUTES).map(([id, r]) =>
      h('a', { class: `navlink ${app.route === id ? 'navlink-active' : ''}`, href: `#/${id}`, text: r.label }))),
  );
}

function renderStatusBar() {
  const bar = $('#statusbar');
  const s = app.state;
  if (!s) return;
  bar.replaceChildren(
    h('span', { class: 'paper-tag', text: 'PAPER MODE' }),
    pill(`${fmtUsd(s.account.balance)} paper`, 'good'),
    pill(`${s.stats.counts.openTrades}/1 position`, s.stats.counts.openTrades ? 'warn' : 'neutral'),
    pill(`${s.stats.counts.closedTrades} closed · ${s.stats.counts.blocked} blocked`, 'neutral'),
    pill(s.dataMode === 'demo' ? 'data mode: DEMO' : 'data mode: live', s.dataMode === 'demo' ? 'warn' : 'neutral'),
    app.channel ? pill(`feed: ${app.channel}`, 'accent') : null,
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
  const fresh = app.state.records.length === 0;
  app.route = fromHash || (fresh ? 'start' : 'desk');

  window.addEventListener('hashchange', async () => {
    const r = routeFromHash() || 'desk';
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
