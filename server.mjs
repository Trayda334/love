/** Paper research desk plus an explicitly enabled, separately authenticated
 * manual live-order gateway. Live execution is disabled unless privately configured.
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLiveHTTP } from './src/live/http.mjs';
import { classifyUSError } from './src/feeds/polymarket-us-errors.mjs';
import { createPublicUSResearch } from './src/feeds/polymarket-us.mjs';
import { Store } from './src/core/store.mjs';
import { MarketProvider } from './src/core/marketProvider.mjs';
import { evaluateSetup, evaluatePrediction, closePosition, checkAutoEntry } from './src/core/pipeline.mjs';
import { ingestClientSnapshot, manualSnapshot, demoSnapshot, searchMarkets, fetchPredictionMarkets, DATA_QUALITY } from './src/feeds/index.mjs';
import { AGENTS, derivePlan, scannerAgent, antiFomoAgent } from './src/agents/index.mjs';
import { HARD_RULES } from './src/config.mjs';
import { resolvePrediction } from './src/agents/logger.mjs';
import { PAPER_ONLY_NOTICE } from './src/shared/feedcore.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = process.env.DESK_DATA || path.join(__dirname, 'data', 'desk.json');

const liveHTTP = createLiveHTTP({ root: __dirname });
const publicUSResearch = createPublicUSResearch();
const store = new Store(DATA_FILE);
const provider = new MarketProvider(store, { ttlMs: 45000 });

/* first-run watchlist: nothing is auto-traded without an explicit opt-in */
if (store.state.watches.length === 0) {
  store.setWatches([
    { pair: 'BTC-USD', source: 'coinbase', auto: false, note: 'example watch (large cap)' },
    { pair: 'ETH-USD', source: 'coinbase', auto: false, note: 'example watch (large cap)' },
    { pair: 'SOL-USD', source: 'coinbase', auto: false, note: 'example watch (large cap)' },
  ]);
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function fail(res, status, message, extra = {}) {
  sendJson(res, status, { ok: false, error: message, ...extra });
}

async function readBody(req, limit = 12 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Body must be JSON.');
  }
}

/** Snapshots sent to the browser: metrics + recent candles for the chart. */
function forClient(snapshot, candleCount = 90) {
  if (!snapshot) return null;
  return {
    ...snapshot,
    candles: snapshot.candles.slice(-candleCount),
    candlesTruncated: snapshot.candles.length - Math.min(candleCount, snapshot.candles.length),
    totalCandles: snapshot.candles.length,
  };
}

/* ------------------------------------------------------------------ *
 * auto-scan loop (off by default, opt-in in the UI)
 * ------------------------------------------------------------------ */

let autoScanRunning = false;

async function runAutoScanCycle(trigger = 'timer') {
  const auto = store.getAutoScan();
  if (autoScanRunning) return { skipped: 'already running' };
  autoScanRunning = true;
  const results = [];
  try {
    const watches = store.state.watches.filter((w) => w.auto && w.pair);
    for (const w of watches) {
      const r = await provider.snapshot({ pair: w.pair, source: w.source || null, force: true });
      if (!r.ok) {
        results.push({ pair: w.pair, status: 'no-data', message: r.message, needBrowser: Boolean(r.needBrowser) });
        continue;
      }
      const snapshot = r.snapshot;
      if (snapshot.dataQuality === DATA_QUALITY.DEMO) {
        results.push({ pair: w.pair, status: 'demo-skipped', message: 'Demo data never opens a paper trade on the timer.' });
        continue;
      }
      const gate = checkAutoEntry({ store, snapshot });
      if (!gate.ok) {
        results.push({ pair: w.pair, status: 'no-setup', reason: gate.reason, snapshotId: snapshot.id, price: snapshot.metrics.price });
        continue;
      }
      const ev = await evaluateSetup({
        store,
        snapshot,
        mode: 'auto',
        writtenReason: 'Logged by the auto-scan timer: Scanner, Anti-FOMO and Sizer all approved on fresh data.',
      });
      results.push({
        pair: w.pair,
        status: ev.status,
        recordId: ev.record?.id || null,
        stage: ev.stage,
        snapshotId: snapshot.id,
        price: snapshot.metrics.price,
      });
    }
    store.pushAutoScanRun({ at: new Date().toISOString(), trigger, results });
    return { results };
  } finally {
    autoScanRunning = false;
  }
}

setInterval(() => {
  const auto = store.getAutoScan();
  if (!auto.enabled || autoScanRunning) return;
  runAutoScanCycle('timer').catch((err) => {
    store.auditEvent('AUTOSCAN_ERROR', String(err?.message || err));
  });
}, 15000).unref();

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

const API = {
  'GET /api/polymarket-us/search': async (_body, _req, url) => {
    try {
      const params = Object.fromEntries([...url.searchParams.keys()].map(key => [key, ['seriesIds', 'marketType'].includes(key) ? url.searchParams.getAll(key).flatMap(v => v.split(',')) : url.searchParams.get(key)]));
      return { payload: { ok: true, source: 'polymarket-us', data: await publicUSResearch.search(params), fetchedAt: new Date().toISOString() } };
    } catch (error) {
      const info = classifyUSError(error);
      return { status: info.status, payload: { ok: false, code: info.code, error: info.message } };
    }
  },
  'GET /api/polymarket-us/sports': async () => {
    try {
      return { payload: { ok: true, source: 'polymarket-us', data: await publicUSResearch.sports(), fetchedAt: new Date().toISOString() } };
    } catch (error) {
      const info = classifyUSError(error);
      return { status: info.status, payload: { ok: false, code: info.code, error: info.message } };
    }
  },
  'GET /api/polymarket-us/teams': async (_body, _req, url) => {
    try {
      const params = Object.fromEntries([...url.searchParams.keys()].map(key => [key, key === 'teamIds' ? url.searchParams.getAll(key).flatMap(v => v.split(',')) : url.searchParams.get(key)]));
      return { payload: { ok: true, source: 'polymarket-us', data: await publicUSResearch.teams(params), fetchedAt: new Date().toISOString() } };
    } catch (error) {
      const info = classifyUSError(error);
      return { status: info.status, payload: { ok: false, code: info.code, error: info.message } };
    }
  },
  'GET /api/polymarket-us/series': async (_body, _req, url) => {
    try {
      const params = Object.fromEntries([...url.searchParams.keys()].map(key => [key, key === 'slug' ? url.searchParams.getAll(key).flatMap(v => v.split(',')) : url.searchParams.get(key)]));
      return { payload: { ok: true, source: 'polymarket-us', data: await publicUSResearch.series(params), fetchedAt: new Date().toISOString() } };
    } catch (error) {
      const info = classifyUSError(error);
      return { status: info.status, payload: { ok: false, code: info.code, error: info.message } };
    }
  },
  'GET /api/polymarket-us/series-detail': async (_body, _req, url) => {
    try {
      return { payload: { ok: true, source: 'polymarket-us', data: await publicUSResearch.seriesById(url.searchParams.get('id')), fetchedAt: new Date().toISOString() } };
    } catch (error) {
      const info = classifyUSError(error);
      return { status: info.status, payload: { ok: false, code: info.code, error: info.message } };
    }
  },
  'GET /api/polymarket-us/events': async (_body, _req, url) => {
    try {
      return { payload: { ok: true, source: 'polymarket-us', data: await publicUSResearch.events(Object.fromEntries([...url.searchParams.keys()].map(key => [key, ['categories', 'seriesId'].includes(key) ? url.searchParams.getAll(key).flatMap(v => v.split(',')) : url.searchParams.get(key)]))), fetchedAt: new Date().toISOString() } };
    } catch (error) {
      const info = classifyUSError(error);
      return { status: info.status, payload: { ok: false, code: info.code, error: info.message } };
    }
  },
  'GET /api/polymarket-us/event': async (_body, _req, url) => {
    try {
      const params = Object.fromEntries(['id', 'slug'].filter(key => url.searchParams.has(key)).map(key => [key, url.searchParams.get(key)]));
      return { payload: { ok: true, source: 'polymarket-us', data: await publicUSResearch.event(params), fetchedAt: new Date().toISOString() } };
    } catch (error) {
      const info = classifyUSError(error);
      return { status: info.status, payload: { ok: false, code: info.code, error: info.message } };
    }
  },
  'GET /api/polymarket-us/markets': async (_body, _req, url) => {
    try {
      const params = Object.fromEntries([...url.searchParams.keys()].map(key => [key, ['categories', 'sportsMarketTypes'].includes(key) ? url.searchParams.getAll(key).flatMap(v => v.split(',')) : url.searchParams.get(key)]));
      return { payload: { ok: true, source: 'polymarket-us', data: await publicUSResearch.markets(params), fetchedAt: new Date().toISOString() } };
    } catch (error) {
      const info = classifyUSError(error);
      return { status: info.status, payload: { ok: false, code: info.code, error: info.message } };
    }
  },
  'GET /api/polymarket-us/market-read': async (_body, _req, url) => {
    try {
      const params = Object.fromEntries(['id', 'slug', 'kind'].filter(key => url.searchParams.has(key)).map(key => [key, url.searchParams.get(key)]));
      return { payload: { ok: true, source: 'polymarket-us', data: await publicUSResearch.marketRead(params), fetchedAt: new Date().toISOString() } };
    } catch (error) {
      const info = classifyUSError(error);
      return { status: info.status, payload: { ok: false, code: info.code, error: info.message } };
    }
  },
  'GET /api/polymarket-us/market': async (_body, _req, url) => {
    const slug = url.searchParams.get('slug') || '';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(slug)) return { status: 400, payload: { ok: false, error: 'Enter a valid market slug.' } };
    try {
      return { payload: { ok: true, source: 'polymarket-us', ...await publicUSResearch.market(slug), fetchedAt: new Date().toISOString() } };
    } catch (error) {
      const info = classifyUSError(error);
      return { status: info.status, payload: { ok: false, code: info.code, error: info.message } };
    }
  },
  'GET /api/health': async () => ({
    ok: true,
    paperOnly: !liveHTTP.enabled,
    manualLiveGateway: liveHTTP.enabled,
    notice: PAPER_ONLY_NOTICE,
    version: '1.0.0',
  }),

  'GET /api/state': async () => {
    const stats = store.stats();
    const auto = store.getAutoScan();
    return {
      ok: true,
      today: new Date().toISOString(),
      notice: PAPER_ONLY_NOTICE,
      hardRules: HARD_RULES,
      config: store.getConfig(),
      dataMode: store.getDataMode(),
      agents: AGENTS.map((a) => ({ id: a.id, n: a.n, name: a.name, job: a.job, pipelineRole: a.pipelineRole, prompt: a.prompt, kind: a.kind })),
      account: store.account(),
      stats,
      reviews: store.reviews(),
      records: store.listRecords(),
      blocked: store.listRecords({ kind: 'blocked' }).slice(0, 200),
      watches: store.state.watches,
      autoScan: { enabled: auto.enabled, intervalMs: auto.intervalMs, lastRunAt: auto.lastRunAt, lastRun: auto.lastRun, log: auto.log.slice(0, 30) },
      audit: store.state.audit.slice(-60).reverse(),
      cache: [...provider.cache.entries()].map(([key, v]) => ({ key, at: v.at, snapshotId: v.snapshot.id, quality: v.snapshot.dataQuality })),
    };
  },

  /* ---------------- market data ---------------- */

  'POST /api/snapshot': async (body) => {
    const { pair, source = null, force = true, demo = null } = body;
    if (!pair && !demo) return { status: 400, payload: { ok: false, error: 'A pair (e.g. BTC-USD) is required.' } };
    const r = await provider.snapshot({ pair: pair || 'DEMO', source, force, demo });
    if (!r.ok) {
      return {
        payload: {
          ok: false,
          needBrowser: true,
          attempts: r.attempts,
          message: r.message,
          hint: 'The browser can try the same public sources directly and POST the raw payload to /api/snapshot/ingest.',
        },
      };
    }
    return { payload: { ok: true, fromCache: r.fromCache, demo: Boolean(r.demo), snapshot: forClient(r.snapshot) } };
  },

  'POST /api/snapshot/ingest': async (body) => {
    const ingested = ingestClientSnapshot(body.payload || body);
    if (!ingested.ok) return { status: 400, payload: { ok: false, error: ingested.message, code: ingested.code } };
    provider.adopt(ingested.snapshot);
    return { payload: { ok: true, snapshot: forClient(ingested.snapshot) } };
  },

  'POST /api/snapshot/manual': async (body) => {
    const manual = manualSnapshot(body);
    if (!manual.ok) return { status: 400, payload: { ok: false, error: manual.message, code: manual.code } };
    provider.adopt(manual.snapshot);
    return { payload: { ok: true, snapshot: forClient(manual.snapshot) } };
  },

  'POST /api/snapshot/demo': async (body) => {
    const { snapshot, scenario } = demoSnapshot({ scenario: body.scenario || 'base', token: body.token || 'DEMO', seed: body.seed });
    provider.adopt(snapshot);
    return { payload: { ok: true, snapshot: forClient(snapshot), scenario } };
  },

  'GET /api/search': async (_body, _req, url) => {
    const q = url.searchParams.get('q') || '';
    const r = await searchMarkets(q, {});
    if (!r.ok && !r.results.length) {
      return { payload: { ok: false, needBrowser: true, attempts: r.attempts, results: [], message: 'Search needs the browser (server egress blocked).' } };
    }
    return { payload: { ok: true, results: r.results, attempts: r.attempts } };
  },

  'POST /api/search/ingest': async (body) => {
    // browser-fetched catalog rows, sanitised here
    const results = (Array.isArray(body.results) ? body.results : []).slice(0, 40).map((r) => ({
      source: String(r.source || 'unknown').slice(0, 20),
      pair: String(r.pair || '').slice(0, 40),
      token: String(r.token || '').slice(0, 20).toUpperCase(),
      quote: String(r.quote || 'USD').slice(0, 10),
      label: String(r.label || r.pair || '').slice(0, 80),
      kind: r.kind === 'aggregator' ? 'aggregator' : 'cex',
    }));
    return { payload: { ok: true, results, attempts: [{ source: 'browser', ok: true }] } };
  },

  /* ---------------- agents ---------------- */

  /* Plan preview: derives the structure-based plan and shows the Scanner's
     verdict WITHOUT writing anything to the ledger. */
  'POST /api/plan': async (body) => {
    const snapshot = body.snapshot ? ingestClientSnapshot(body.snapshot).snapshot : provider.getById(body.snapshotId);
    if (!snapshot) {
      return { status: 409, payload: { ok: false, error: 'Fetch fresh data first - that snapshot is missing or older than 30 minutes.' } };
    }
    const config = store.getConfig();
    const plan = derivePlan(snapshot.metrics, config, {
      token: snapshot.token,
      pair: snapshot.pair,
      ...(body.override || {}),
    });
    if (!plan.ok) return { payload: { ok: false, error: plan.notes.join(' ') } };
    const scanner = scannerAgent({ snapshot, plan, config });
    const preview = antiFomoAgent({ snapshot, plan, config, ideaText: body.writtenReason || '' });
    return { payload: { ok: true, plan, scanner, antiFomoPreview: preview, snapshot: forClient(snapshot) } };
  },

  'POST /api/evaluate': async (body) => {
    const snapshot = body.snapshot ? ingestClientSnapshot(body.snapshot).snapshot : provider.getById(body.snapshotId);
    if (!snapshot) {
      return { status: 409, payload: { ok: false, error: 'That snapshot is missing or older than 30 minutes. Fetch fresh data before evaluating.' } };
    }
    const mode = body.mode === 'auto' ? 'auto' : 'guided';
    const result = await evaluateSetup({
      store,
      snapshot,
      planOverride: body.planOverride || null,
      gates: body.gates || {},
      mode,
      writtenReason: body.writtenReason || '',
      ideaText: body.ideaText || '',
    });
    return { payload: { ok: true, ...result, snapshot: forClient(snapshot) } };
  },

  'POST /api/close': async (body) => {
    const record = closePosition({
      store,
      recordId: body.recordId,
      exitPrice: body.exitPrice,
      closeReason: body.closeReason,
      mistakes: body.mistakes,
      learned: body.learned,
    });
    return { payload: { ok: true, record } };
  },

  'POST /api/scan': async (body) => {
    const pairs = Array.isArray(body.pairs) && body.pairs.length ? body.pairs : store.state.watches.filter((w) => w.pair);
    const snapshots = await provider.snapshots(pairs.map((p) => (typeof p === 'string' ? { pair: p } : p)), { force: Boolean(body.force) });
    const results = snapshots.map((s) => {
      if (!s.ok) return { pair: s.watch.pair, ok: false, status: 'no-data', message: s.message, attempts: s.attempts, needBrowser: true };
      const check = checkAutoEntry({ store, snapshot: s.snapshot });
      return {
        pair: s.watch.pair,
        ok: true,
        snapshotId: s.snapshot.id,
        price: s.snapshot.metrics.price,
        dataQuality: s.snapshot.dataQuality,
        fromCache: Boolean(s.fromCache),
        scanner: { verdict: check.ok ? 'PASS' : 'SEE-DETAIL' },
        wouldEnter: Boolean(check.ok),
        reason: check.reason || 'All three gates would approve on this snapshot.',
      };
    });
    return { payload: { ok: true, results } };
  },

  'POST /api/autoscan': async (body) => {
    if (typeof body.enabled === 'boolean' || body.intervalMs) {
      store.setAutoScan({ enabled: body.enabled, intervalMs: body.intervalMs });
    }
    return { payload: { ok: true, autoScan: store.getAutoScan() } };
  },

  'POST /api/autoscan/run': async () => {
    const out = await runAutoScanCycle('manual');
    return { payload: { ok: true, ...out, autoScan: store.getAutoScan() } };
  },

  'GET /api/predictions': async (_body, _req, url) => {
    const r = await fetchPredictionMarkets({ limit: Number(url.searchParams.get('limit') || 25) });
    return { payload: { ok: r.ok, needBrowser: !r.ok, markets: r.markets || [], attempts: r.attempts, message: r.message || null } };
  },

  'POST /api/predictions/ingest': async (body) => {
    const markets = (Array.isArray(body.markets) ? body.markets : []).slice(0, 50).map((m) => ({
      id: String(m.id || '').slice(0, 80),
      question: String(m.question || '').slice(0, 300),
      slug: m.slug ? String(m.slug).slice(0, 200) : null,
      url: m.url ? String(m.url).slice(0, 300) : 'https://polymarket.com',
      yesPrice: m.yesPrice !== null && m.yesPrice !== undefined && m.yesPrice !== '' && Number.isFinite(Number(m.yesPrice)) ? Number(m.yesPrice) : null,
      bid: m.bid !== null && m.bid !== undefined && m.bid !== '' && Number.isFinite(Number(m.bid)) ? Number(m.bid) : null,
      ask: m.ask !== null && m.ask !== undefined && m.ask !== '' && Number.isFinite(Number(m.ask)) ? Number(m.ask) : null,
      spreadPoints: m.spreadPoints !== null && m.spreadPoints !== undefined && m.spreadPoints !== '' && Number.isFinite(Number(m.spreadPoints)) ? Number(m.spreadPoints) : null,
      liquidityUsd: m.liquidityUsd !== null && m.liquidityUsd !== undefined && m.liquidityUsd !== '' && Number.isFinite(Number(m.liquidityUsd)) ? Number(m.liquidityUsd) : null,
      volumeUsd: m.volumeUsd !== null && m.volumeUsd !== undefined && m.volumeUsd !== '' && Number.isFinite(Number(m.volumeUsd)) ? Number(m.volumeUsd) : null,
      endDate: m.endDate ? String(m.endDate).slice(0, 40) : null,
      source: 'polymarket',
    }));
    return { payload: { ok: true, markets } };
  },

  'POST /api/predictions/evaluate': async (body) => {
    if (!body.market || typeof body.market !== 'object') return { status: 400, payload: { ok: false, error: 'A market object is required.' } };
    const out = await evaluatePrediction({
      store,
      market: body.market,
      evidence: body.evidence || '',
      estimatedRange: body.estimatedRange || null,
      daysToResolve: Number.isFinite(Number(body.daysToResolve)) ? Number(body.daysToResolve) : null,
    });
    return { payload: { ok: true, ...out } };
  },

  'POST /api/predictions/resolve': async (body) => {
    const record = store.getRecord(body.recordId);
    if (!record) return { status: 404, payload: { ok: false, error: 'No such paper bet.' } };
    const resolved = resolvePrediction(record, { outcome: body.outcome });
    store.replaceRecord(resolved, { event: 'BET_RESOLVED', note: `${resolved.id} resolved ${resolved.resolution.outcome} ($${resolved.pnlUsd}).` });
    return { payload: { ok: true, record: resolved } };
  },

  'POST /api/watches': async (body) => {
    const watches = (Array.isArray(body.watches) ? body.watches : []).slice(0, 40).map((w) => ({
      pair: String(w.pair || '').slice(0, 40).toUpperCase(),
      source: w.source ? String(w.source).slice(0, 20) : null,
      auto: Boolean(w.auto),
      note: w.note ? String(w.note).slice(0, 120) : '',
    })).filter((w) => w.pair);
    store.setWatches(watches);
    return { payload: { ok: true, watches: store.state.watches } };
  },

  'POST /api/blocked-review': async (body) => {
    const outcome = String(body.reviewOutcome || '');
    if (!['would have won', 'would have lost', 'unknown'].includes(outcome)) {
      return { status: 400, payload: { ok: false, error: 'reviewOutcome must be "would have won", "would have lost" or "unknown".' } };
    }
    const record = store.setReviewOutcome(body.recordId, outcome);
    return { payload: { ok: true, record } };
  },

  'POST /api/selftest': async () => {
    // Runs the four demo scenarios against a THROWAWAY ledger so the rules can
    // be proven to fire without polluting the real record.
    const expectations = {
      base: { expect: 'opened', label: 'quiet range → Scanner PASS, Anti-FOMO APPROVE, Sizer APPROVE, ticket' },
      pump: { expect: 'blocked', stage: 'antiFomo', label: 'vertical pump → Anti-FOMO BLOCK, no ticket' },
      dump: { expect: 'blocked', stage: 'scanner', label: 'steady decline → Scanner SKIP' },
      volatile: { expect: 'blocked', stage: 'scanner', label: 'wild swings → Scanner SKIP (volatility)' },
    };
    const results = [];
    for (const scenario of ['base', 'pump', 'dump', 'volatile']) {
      const mem = new Store(path.join(DATA_FILE), { memory: true });
      const { snapshot } = demoSnapshot({ scenario, token: 'DEMO' });
      try {
        const out = await evaluateSetup({ store: mem, snapshot, mode: 'auto', writtenReason: 'Self-test run (throwaway ledger).' });
        const exp = expectations[scenario];
        results.push({
          scenario,
          status: out.status,
          stage: out.stage,
          expected: exp.label,
          pass: out.status === exp.expect && (!exp.stage || out.stage === exp.stage),
          verdicts: {
            scanner: out.results?.scanner?.verdict,
            antiFomo: out.results?.antiFomo?.verdict,
            sizer: out.results?.sizer?.verdict,
            buyer: out.results?.buyer?.verdict,
          },
          reason: out.record?.reasons?.[0] || out.results?.scanner?.summary || out.results?.antiFomo?.explanation || '',
        });
      } catch (err) {
        results.push({ scenario, status: 'error', error: err.message, pass: false });
      }
    }
    return {
      payload: {
        ok: true,
        results,
        passed: results.filter((r) => r.pass).length,
        note: 'Ran against a throwaway in-memory ledger with the same rules as the real desk. Your ledger was not touched.',
      },
    };
  },

  'POST /api/config': async (body) => {
    const { config, violations, changes } = store.updateConfig(body.patch || {}, body.note || '');
    return { payload: { ok: true, config, violations, changes } };
  },

  'POST /api/datamode': async (body) => ({ payload: { ok: true, dataMode: store.setDataMode(body.mode) } }),

  'GET /api/stats': async () => ({ payload: { ok: true, stats: store.stats(), reviews: store.reviews(), account: store.account() } }),

  'GET /api/export': async (_body, _req, url) => {
    const kind = url.searchParams.get('kind') === 'blocked' ? 'blocked' : 'trade';
    const csv = store.toCsv(kind);
    return { raw: { contentType: 'text/csv; charset=utf-8', body: csv, filename: `paper-desk-${kind}-${new Date().toISOString().slice(0, 10)}.csv` } };
  },

  'POST /api/import': async (body) => {
    if (!body || !Array.isArray(body.records)) return { status: 400, payload: { ok: false, error: 'Body must be a desk export with a records array.' } };
    store.replaceState(body, { note: `Imported ${body.records.length} record(s)` });
    return { payload: { ok: true, records: body.records.length } };
  },

  'POST /api/reset': async (body) => {
    if (body.confirm !== 'RESET PAPER DESK') return { status: 400, payload: { ok: false, error: 'Type RESET PAPER DESK to confirm.' } };
    const backup = `${DATA_FILE}.${Date.now()}.bak.json`;
    if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, backup);
    store.replaceState({ schema: 1, config: body.keepConfig ? store.getConfig() : undefined }, { note: `Desk reset (backup at ${path.basename(backup)})` });
    return { payload: { ok: true, backup: path.basename(backup) } };
  },
};

/* ------------------------------------------------------------------ *
 * static files
 * ------------------------------------------------------------------ */

const ROOTS = [
  { url: '/docs/', dir: path.join(__dirname, 'docs') },
  { url: '/shared/', dir: path.join(__dirname, 'src', 'shared') },
  { url: '/client/', dir: path.join(__dirname, 'public', 'client') },
  { url: '/', dir: path.join(__dirname, 'public') },
];

async function serveStatic(req, res, urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const root = ROOTS.find((r) => clean.startsWith(r.url));
  if (!root) return false;
  let rel = clean.slice(root.url.length);
  if (rel === 'index' || rel === 'index.html') rel = 'index.html';
  if (rel === '' || rel.endsWith('/')) {
    // the app is a single page with hash routes; only the shell is served here
    if (clean === '/' || clean === '/index.html' || clean === '/index') rel = 'index.html';
    else return false;
  }
  const target = path.join(root.dir, rel);
  if (!target.startsWith(root.dir)) return false;
  try {
    const stat = await fsp.stat(target);
    if (!stat.isFile()) return false;
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    fs.createReadStream(target).pipe(res);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * router
 * ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = `${req.method} ${url.pathname}`;

  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('x-content-type-options', 'nosniff');
  if (liveHTTP.enabled) {
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('strict-transport-security', 'max-age=31536000');
  }
  if (url.pathname.startsWith('/api/live/')) {
    const result = await liveHTTP.handle(req, url, readBody);
    for (const [key, value] of Object.entries(result.headers || {})) res.setHeader(key, value);
    return sendJson(res, result.status, result.payload);
  }

  // Paper/public API routes remain separate from authenticated live operations.
  if (route.startsWith('GET /api') || route.startsWith('POST /api')) {
    const handler = API[route];
    if (!handler) return fail(res, 404, `No API route ${route}.`);
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const out = (await handler(body, req, url)) || {};
      if (out.raw) {
        res.writeHead(200, {
          'content-type': out.raw.contentType,
          'content-disposition': `attachment; filename="${out.raw.filename}"`,
          'cache-control': 'no-store',
        });
        return res.end(out.raw.body);
      }
      return sendJson(res, out.status || 200, out.payload ?? out);
    } catch (err) {
      return fail(res, 400, err?.message || 'Request failed.');
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Method not allowed.');

  if (await serveStatic(req, res, url.pathname)) return;

  // friendly URLs point at the app's hash routes
  const hashRoutes = ['start', 'desk', 'log', 'review', 'research', 'guide', 'live'];
  const seg = url.pathname.replace(/^\/+|\/+$/g, '');
  if (hashRoutes.includes(seg)) {
    res.writeHead(302, { location: `/#/${seg}` });
    return res.end();
  }
  if (seg === 'agents' || seg === 'rules' || seg === 'about') {
    res.writeHead(302, { location: '/#/start' });
    return res.end();
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found. Try / (onboarding), /desk (trading desk) or /guide (the full guide).');
});

server.listen(PORT, HOST, () => {
  const rules = store.getConfig();
  console.log(`\n  POLYMARKET DESK  -  paper research + opt-in live gateway`);
  console.log(`  http://${HOST}:${PORT}`);
  console.log(`  data file: ${DATA_FILE}`);
  console.log(`  rules: ${rules.risk.riskPctPerTrade}% max risk | 1 open position | stop required | data mode: ${store.getDataMode()}`);
  console.log(`  live gateway: ${liveHTTP.enabled ? 'ENABLED — real money, authentication required' : 'DISABLED'}. Paper agents never place real orders.\n`);
});

function shutdown() {
  server.close();
  liveHTTP.close();
  console.log('\n  Shutting down. Reconcile any interrupted live submission before retrying.');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
