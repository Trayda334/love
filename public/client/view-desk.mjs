/**
 * view-desk.mjs - the trading desk: data in, six agents, paper ticket out.
 *
 * PAPER MODE ONLY. There is no buy button that reaches a real market - the
 * "Buyer" only writes a simulated ticket into the local ledger.
 */

import {
  h, api, toast, fmtUsd, fmtNum, fmtPct, fmtPrice, fmtTime, ago,
  pill, badgeForQuality, verdictPill, card, kv, checksTable, modal,
} from './util.mjs';
import { browserChannel } from './browserFeed.mjs';
import { priceChart, volumeChart, noteIfMissing } from './chart.mjs';

/** Adopt a snapshot and drop anything that belonged to a different one. */
function adoptSnapshot(ctx, snapshot, channel) {
  ctx.app.snapshot = snapshot;
  ctx.app.snapshots.set(snapshot.id, snapshot);
  ctx.app.channel = channel;
  ctx.app.plan = null;
  ctx.app.planOverride = null;
  ctx.app.pipeline = null;
  ctx.app.scannerPreview = null;
  ctx.app.antiFomoPreview = null;
  ctx.app.gates = {};
  ctx.app.lastFetchError = null;
}

const SOURCES = ['auto', 'coinbase', 'kraken', 'binance', 'coingecko'];
const DEMO_SCENARIOS = [
  { id: 'base', label: 'base - a quiet, orderly range (should PASS the Scanner)', expected: 'PASS → APPROVE → APPROVE → paper ticket' },
  { id: 'pump', label: 'pump - a vertical move right now (should be BLOCKED by Anti-FOMO)', expected: 'BLOCK at the Anti-FOMO stage' },
  { id: 'dump', label: 'dump - steady decline (should be SKIPPED - no clean setup)', expected: 'SKIP at the Scanner' },
  { id: 'volatile', label: 'volatile - wild swings (should be SKIPPED - too wild)', expected: 'SKIP at the Scanner (volatility)' },
];

export function renderDesk(ctx) {
  const { state, app } = ctx;
  const wrap = h('div', { class: 'stack' });
  wrap.append(guardrailStrip(state, ctx));
  wrap.append(dataPanel(ctx));
  if (app.lastFetchError) wrap.append(errorPanel(ctx));
  if (app.snapshot) wrap.append(analysisPanel(ctx));
  wrap.append(positionPanel(ctx));
  wrap.append(autoscanPanel(ctx));
  wrap.append(deskStatsStrip(ctx));
  return wrap;
}

/* ------------------------------------------------------------------ *
 * guardrails
 * ------------------------------------------------------------------ */

function guardrailStrip(state, ctx) {
  const cfg = state.config;
  return h(
    'div',
    { class: 'strip strip-paper' },
    h('strong', { text: 'PAPER MODE.' }),
    h('span', {
      text: ` No wallet. No exchange keys. No live orders - this app has no code that can send one. Rules in force: max ${cfg.risk.riskPctPerTrade}% risk per trade, one open position, stop-loss required, every blocked setup logged.`,
    }),
    h('span', { class: 'strip-right' },
      pill(`data mode: ${state.dataMode}`, state.dataMode === 'live' ? 'good' : 'warn'),
      pill(`${state.stats.counts.blocked} blocked`, 'warn'),
      pill(`${state.stats.counts.openTrades ? 1 : 0}/1 position open`, state.stats.counts.openTrades ? 'warn' : 'good'),
    ),
  );
}

/* ------------------------------------------------------------------ *
 * 1. data in
 * ------------------------------------------------------------------ */

function dataPanel(ctx) {
  const { state, app } = ctx;
  const pairInput = h('input', { class: 'input', placeholder: 'e.g. BTC-USD, SOL-USD or a coingecko id like dogecoin', value: app.pair || '', list: 'pairs' });
  const sourceSelect = h('select', { class: 'input' }, ...SOURCES.map((s) => h('option', { value: s, text: s === 'auto' ? 'auto (try best source first)' : s, selected: (app.source || 'auto') === s })));
  const demoSelect = h('select', { class: 'input' }, ...DEMO_SCENARIOS.map((s) => h('option', { value: s.id, text: s.label })));

  const busy = (btn, on, label) => {
    btn.disabled = on;
    btn.textContent = on ? 'working…' : label;
  };

  const fetchBtn = h('button', {
    class: 'btn btn-primary',
    text: 'Fetch live data',
    onclick: async () => {
      const pair = pairInput.value.trim();
      if (!pair) return toast('Type a pair first, e.g. BTC-USD.', 'warn');
      app.pair = pair;
      app.source = sourceSelect.value === 'auto' ? null : sourceSelect.value;
      app.lastFetchError = null;
      busy(fetchBtn, true);
      try {
        const out = await browserChannel.market(pair, { preferredSource: app.source, onAttempt: (line) => { app.fetchLog = [...(app.fetchLog || []), line].slice(-20); } });
        adoptSnapshot(ctx, out.snapshot, out.channel);
        app.fetchLog = [...(app.fetchLog || []), `${new Date().toLocaleTimeString()} ${pair}: OK via ${out.channel}`].slice(-20);
        toast(`Live data: ${out.snapshot.sourceLabel} (${out.channel})`, 'good');
      } catch (err) {
        app.snapshot = null;
        app.lastFetchError = err.message;
        app.fetchLog = [...(app.fetchLog || []), `${new Date().toLocaleTimeString()} ${pair}: FAILED - ${err.message}`].slice(-20);
        toast('Live fetch failed - see the panel for what to do.', 'danger', 8000);
      } finally {
        busy(fetchBtn, false, 'Fetch live data');
        ctx.refresh({ keepScroll: true });
      }
    },
  });

  const manualBtn = h('button', { class: 'btn', text: 'Enter data by hand', onclick: () => manualDialog(ctx) });
  const demoBtn = h('button', {
    class: 'btn btn-ghost',
    text: 'Use demo data',
    title: 'Synthetic candles generated inside the app, watermarked DEMO everywhere. Only for testing the rules.',
    onclick: async () => {
      const scenario = demoSelect.value;
      try {
        const out = await api('/api/snapshot/demo', { method: 'POST', body: { scenario, token: 'DEMO' } });
        adoptSnapshot(ctx, out.snapshot, `demo:${scenario}`);
        toast(`Demo data loaded (${scenario}). It is marked DEMO everywhere - never mistake it for a market price.`, 'warn', 8000);
        ctx.refresh({ keepScroll: true });
      } catch (err) {
        toast(err.message, 'danger');
      }
    },
  });

  const datalist = h('datalist', { id: 'pairs' }, ...state.watches.map((w) => h('option', { value: w.pair })));

  const history = app.fetchLog?.length
    ? h('details', { class: 'details' }, h('summary', { text: `Fetch attempts (${app.fetchLog.length})` }),
        h('ul', { class: 'small mono' }, ...app.fetchLog.slice(-8).map((l) => h('li', { text: l }))))
    : null;

  return card(
    'Step 1 - market data in',
    h('p', { class: 'muted small', text: 'The agents are only allowed to reason about data that came from a real source or from you. The app will not invent a price: if every source fails it stops and tells you.' }),
    h('div', { class: 'row' }, pairInput, sourceSelect, fetchBtn),
    h('div', { class: 'row row-gap' }, manualBtn, demoSelect, demoBtn),
    datalist,
    history,
    app.snapshot ? snapshotHeadline(ctx) : null,
  );
}

function snapshotHeadline(ctx) {
  const { app } = ctx;
  const s = app.snapshot;
  const m = s.metrics || {};
  const canvas = h('canvas', { height: 180 });
  const volCanvas = h('canvas', { height: 90 });
  setTimeout(() => {
    if (!ctx.app.snapshot || ctx.app.snapshot.id !== s.id) return;
    try {
      priceChart(canvas, s.candles, { stop: app.plan?.stop, target: app.plan?.target1, entryArea: app.plan?.entryArea, token: s.token });
      volumeChart(volCanvas, s.candles);
    } catch (err) {
      toast(`Chart failed: ${err.message}`, 'warn');
    }
  });

  return h(
    'div',
    { class: 'snapshot' },
    h('div', { class: 'row row-between' },
      h('div', {},
        h('div', { class: 'row' }, h('strong', { class: 'big', text: `${s.token}/USD` }), badgeForQuality(s.dataQuality), pill(s.sourceLabel, 'neutral')),
        h('div', { class: 'muted small', text: `fetched ${ago(s.fetchedAt)} (${fmtTime(s.fetchedAt)}) · ${s.totalCandles ?? s.candles.length} closed 5-minute candles${s.candlesTruncated ? ` (${s.candlesTruncated} older ones not sent)` : ''}` }),
      ),
      h('div', { class: 'price-box' }, h('div', { class: 'big mono', text: fmtPrice(m.price) }), h('div', { class: m.change24h >= 0 ? 'up small' : 'down small', text: `24h ${fmtPct(m.change24h)}` })),
    ),
    h('div', { class: 'metrics-grid' },
      metric('5-minute move', fmtPct(m.r5), m.r5 >= 8 ? 'bad' : ''),
      metric('15-minute move', fmtPct(m.r15), m.r15 >= 15 ? 'bad' : ''),
      metric('1-hour move', fmtPct(m.r60)),
      metric('5m volatility (ATR)', m.atrPct === null ? 'unknown' : `${fmtNum(m.atrPct, 2)}%`, m.atrPct > 5 ? 'bad' : ''),
      metric('volume pace', m.volumeRatio === null ? 'unknown' : `${fmtNum(m.volumeRatio, 2)}x`, m.volumeRatio > 5 ? 'bad' : ''),
      metric('distance above 1h support', m.distToSupportPct === null ? 'unknown' : `${fmtNum(m.distToSupportPct, 2)}%`, m.distToSupportPct > 12 ? 'bad' : ''),
      metric('1h support / resistance', `${fmtPrice(m.support1h)} / ${fmtPrice(m.resistance1h)}`),
      metric('24h volume', m.volume24hUsd === null ? 'unknown' : fmtUsd(m.volume24hUsd, 0)),
      metric('pool depth', m.liquidityUsd === null ? 'not published' : fmtUsd(m.liquidityUsd, 0)),
      metric('looks extended?', m.extended === null || m.extended === undefined ? 'unknown' : m.extended ? 'YES' : 'no', m.extended ? 'bad' : ''),
    ),
    app.plan ? null : h('p', { class: 'muted small', text: 'Tip: press "Derive plan from structure" below to see what the Scanner would propose on this snapshot.' }),
    h('div', { class: 'chart-wrap' }, canvas),
    h('div', { class: 'chart-wrap chart-small' }, volCanvas),
    ...(s.warnings || []).map((w) => h('p', { class: 'muted small', text: `source note: ${w}` })),
    ...(s.notes || []).map((w) => h('p', { class: 'muted small', text: `data note: ${w}` })),
  );
}

function metric(label, value, cls = '') {
  return h('div', { class: `metric ${cls}` }, h('div', { class: 'metric-k', text: label }), h('div', { class: 'metric-v mono', text: value ?? 'n/a' }));
}

function errorPanel(ctx) {
  const { app } = ctx;
  return h(
    'div',
    { class: 'card card-danger' },
    h('h3', { class: 'card-title', text: 'Live data could not be fetched' }),
    h('p', { text: app.lastFetchError }),
    h('p', { class: 'muted small', text: 'The desk will NOT substitute a made-up price. Your options: (1) retry, (2) type the numbers in by hand from a chart you are looking at, or (3) load demo data - clearly labelled - to test that the rules fire.' }),
    h('div', { class: 'row' },
      h('button', { class: 'btn', text: 'Enter data by hand', onclick: () => manualDialog(ctx) }),
      h('button', { class: 'btn btn-ghost', text: 'Load demo data to test the rules', onclick: async () => {
        try {
          const out = await api('/api/snapshot/demo', { method: 'POST', body: { scenario: 'base', token: 'DEMO' } });
          adoptSnapshot(ctx, out.snapshot, 'demo:base');
          toast('Demo data loaded - it is marked DEMO everywhere.', 'warn', 7000);
          ctx.refresh({ keepScroll: true });
        } catch (err) { toast(err.message, 'danger'); }
      } })),
    h('p', { class: 'muted small', text: 'Note: your browser is usually less restricted than the server, so the page also tried the public APIs directly and would have handed the raw payload to the server for recomputation.' }),
  );
}

function manualDialog(ctx) {
  const f = (name, label, placeholder = '') => h('label', { class: 'field' }, h('span', { text: label }), h('input', { class: 'input', name, placeholder, value: '' }));
  const form = h(
    'div',
    { class: 'grid-2' },
    f('token', 'Token / asset name', 'e.g. WIF'),
    f('price', 'Current price (required)', '0.00'),
    f('change24hPct', '24-hour move %', 'e.g. -4.2'),
    f('change1hPct', '1-hour move %', 'e.g. 1.1'),
    f('r5', 'Move in the last 5 minutes %', 'e.g. 0.3'),
    f('r15', 'Move in the last 15 minutes %', 'e.g. 1.8'),
    f('support', 'Nearest support price', ''),
    f('resistance', 'Nearest resistance price', ''),
    f('volume24hUsd', '24-hour volume in USD', ''),
    f('liquidityUsd', 'Pool depth / book depth in USD (if known)', ''),
  );
  const { close } = modal('Enter market data by hand', h('div', {},
    h('p', { class: 'muted small', text: 'Numbers you type are labelled USER-PROVIDED. Checks that need candle history (volatility, volume pace, base structure) will honestly report "unknown" - and the Anti-FOMO agent will BLOCK if too many checks are unverifiable, because "if risk cannot be clearly defined, block it".' }),
    form,
  ), [
    { label: 'Cancel', onClick: (c) => c() },
    {
      label: 'Save snapshot',
      class: 'btn-primary',
      onClick: async (c) => {
        const data = {};
        for (const el of form.querySelectorAll('input')) if (el.value.trim() !== '') data[el.name] = el.value.trim();
        if (!data.price) return toast('Price is required.', 'warn');
        try {
          const out = await api('/api/snapshot/manual', { method: 'POST', body: data });
          adoptSnapshot(ctx, out.snapshot, 'manual');
          c();
          toast('Manual snapshot saved and labelled USER-PROVIDED.', 'good');
          ctx.refresh({ keepScroll: true });
        } catch (err) {
          toast(err.message, 'danger');
        }
      },
    },
  ]);
  void close;
}

/* ------------------------------------------------------------------ *
 * 2. plan + pipeline
 * ------------------------------------------------------------------ */

function analysisPanel(ctx) {
  const { state, app } = ctx;
  const s = app.snapshot;
  const cfg = state.config;
  const balance = state.account.balance;
  const maxLoss = balance * (cfg.risk.riskPctPerTrade / 100);

  const num = (name, label, value, step = 'any') =>
    h('label', { class: 'field' }, h('span', { text: label }), h('input', { class: 'input', type: 'number', step, name, value: value ?? '' }));

  const plan = app.plan || {};
  const planForm = h(
    'div',
    { class: 'grid-3' },
    num('entryLow', 'Entry area low', plan.entryArea?.low ?? s.metrics.price),
    num('entryHigh', 'Entry area high', plan.entryArea?.high ?? s.metrics.price),
    num('stop', 'Stop-loss (required)', plan.stop ?? ''),
    num('target1', 'Target', plan.target1 ?? ''),
  );

  const reasonInput = h('textarea', { class: 'input', rows: 3, placeholder: 'Written reason for this trade (required before the Buyer can act). Plain structural reasoning - not "it is pumping".' , value: app.writtenReason || ''});

  const deriveBtn = h('button', {
    class: 'btn',
    text: app.plan ? 'Re-derive plan from structure' : 'Derive plan from structure',
    onclick: async () => {
      try {
        const out = await api('/api/plan', { method: 'POST', body: { snapshotId: s.id } });
        app.plan = out.plan;
        app.scannerPreview = out.scanner;
        app.antiFomoPreview = out.antiFomoPreview;
        toast(`Plan derived: ${out.plan.setup}`, 'good');
        ctx.refresh({ keepScroll: true });
      } catch (err) {
        toast(err.message, 'danger');
      }
    },
  });

  const applyBtn = h('button', {
    class: 'btn',
    text: 'Preview with my numbers',
    onclick: async () => {
      const override = readPlanForm(planForm);
      if (override.error) return toast(override.error, 'warn');
      app.writtenReason = reasonInput.value;
      try {
        const out = await api('/api/plan', { method: 'POST', body: { snapshotId: s.id, override, writtenReason: reasonInput.value } });
        app.plan = out.plan;
        app.scannerPreview = out.scanner;
        app.antiFomoPreview = out.antiFomoPreview;
        ctx.refresh({ keepScroll: true });
      } catch (err) {
        toast(err.message, 'danger');
      }
    },
  });

  const modeToggle = h('div', { class: 'row row-gap' },
    h('label', { class: 'radio' },
      h('input', { type: 'radio', name: 'mode', value: 'guided', checked: (app.mode || 'guided') === 'guided', onchange: () => { app.mode = 'guided'; } }),
      ' Guided (a human approves each agent)'),
    h('label', { class: 'radio' },
      h('input', { type: 'radio', name: 'mode', value: 'auto', checked: app.mode === 'auto', onchange: () => { app.mode = 'auto'; } }),
      ' Auto (agents run straight through)'),
  );

  const runBtn = h('button', {
    class: 'btn btn-primary btn-lg',
    text: 'Run the 6-agent pipeline',
    onclick: async () => {
      const override = readPlanForm(planForm);
      if (override.error) return toast(override.error, 'warn');
      app.writtenReason = reasonInput.value;
      const mode = planForm.closest('.card').querySelector('input[name=mode]:checked')?.value || app.mode || 'guided';
      app.mode = mode;
      app.planOverride = override;
      app.gates = {};
      try {
        const out = await api('/api/evaluate', { method: 'POST', body: { snapshotId: s.id, mode, gates: {}, planOverride: override, writtenReason: reasonInput.value } });
        app.pipeline = out;
        app.plan = out.plan;
        if (out.status === 'awaiting') toast(out.prompt, 'info', 7000);
        else if (out.status === 'opened') toast(`Paper ticket ${out.record.id} created.`, 'good');
        else toast(`Blocked at the ${out.stage} stage - recorded, not deleted.`, 'warn');
        await ctx.reload();
        ctx.refresh({ keepScroll: true });
      } catch (err) {
        toast(err.message, 'danger');
      }
    },
  });

  return card(
    'Step 2 - plan, then the pipeline',
    h('p', { class: 'muted small', text: `Account: ${fmtUsd(balance)} paper · max risk this trade ${fmtUsd(maxLoss)} (${cfg.risk.riskPctPerTrade}% rule). Risk is the amount lost if the stop is hit - not the size of the position.` }),
    app.plan ? planSummary(ctx) : null,
    planForm,
    h('div', { class: 'row row-gap' }, deriveBtn, applyBtn),
    h('label', { class: 'field' }, h('span', { text: 'Written reason (required)' }), reasonInput),
    modeToggle,
    h('div', { class: 'row' }, runBtn, h('span', { class: 'muted small', text: 'Order: Scanner → Anti-FOMO → Sizer → Buyer → Logger.' })),
    app.antiFomoPreview && !app.pipeline ? antiFomoPreviewBox(ctx) : null,
    pipelinePanel(ctx),
  );
}

function planSummary(ctx) {
  const { app } = ctx;
  const p = app.plan;
  if (!p) return null;
  const qualityKind = p.setupQuality === 'clean' ? 'good' : p.setupQuality === 'acceptable' ? 'neutral' : 'warn';
  const scannerPreview = app.scannerPreview;
  return h('div', { class: 'agent-box agent-warn' },
    h('div', { class: 'row row-between' },
      h('strong', { text: `Proposed plan: ${p.setup}` }),
      h('div', { class: 'row' }, pill(`setup quality: ${p.setupQuality || 'n/a'}`, qualityKind), pill(`direction: long only (1x spot)`, 'neutral'), scannerPreview ? verdictPill(scannerPreview.verdict) : null),
    ),
    h('div', { class: 'metrics-grid' },
      metric('entry area', `${fmtPrice(p.entryArea?.low)} – ${fmtPrice(p.entryArea?.high)}`),
      metric('invalidation (stop)', fmtPrice(p.stop)),
      metric('stop distance', `${fmtNum(p.stopDistancePct, 2)}%`, p.stopDistancePct > ctx.state.config.risk.maxStopDistancePct ? 'bad' : ''),
      metric('target', fmtPrice(p.target1)),
      metric('reward / risk', `${fmtNum(p.rewardRisk, 2)}R`, p.rewardRisk < ctx.state.config.risk.minRiskReward ? 'bad' : ''),
      metric('derived from', p.derivedFrom || 'structure'),
    ),
    ...(p.notes || []).map((n) => h('p', { class: 'muted small', text: n })),
    scannerPreview ? h('p', { class: 'small', text: `Scanner preview: ${scannerPreview.summary}` }) : null,
    h('p', { class: 'muted small', text: 'Adjust any of the numbers below and press "Preview with my numbers" - your values are what the Sizer and the Buyer will use.' }),
    scannerPreview?.checks?.length ? h('details', { class: 'details' }, h('summary', { text: `Show the Scanner's ${scannerPreview.checks.length} checks` }), checksTable(scannerPreview.checks)) : null,
  );
}

function readPlanForm(planForm) {
  const get = (n) => planForm.querySelector(`[name=${n}]`).value.trim();
  const out = { entryArea: {}, error: null };
  const low = Number(get('entryLow'));
  const high = Number(get('entryHigh'));
  const stop = Number(get('stop'));
  const target = Number(get('target1'));
  if (![low, high, stop, target].every(Number.isFinite)) return { error: 'Entry area, stop and target must all be numbers.' };
  if (low >= high) return { error: 'Entry area low must be below the high.' };
  if (stop >= low) return { error: 'For a long, the stop must be below the entry area.' };
  if (target <= high) return { error: 'For a long, the target must be above the entry area.' };
  out.entryArea = { low, high };
  out.stop = stop;
  out.target1 = target;
  return out;
}

function antiFomoPreviewBox(ctx) {
  const p = ctx.app.antiFomoPreview;
  return h('div', { class: `agent-box ${p.verdict === 'APPROVE' ? 'agent-good' : 'agent-bad'}` },
    h('div', { class: 'row' }, h('strong', { text: 'Agent 5 - Anti-FOMO preview' }), verdictPill(p.verdict)),
    h('p', { class: 'small', text: p.explanation }),
    h('details', { class: 'details' }, h('summary', { text: 'Show the checks' }), checksTable(p.checks)),
  );
}

function pipelinePanel(ctx) {
  const { app } = ctx;
  const p = app.pipeline;
  if (!p) return null;
  const r = p.results || {};
  const wrap = h('div', { class: 'pipeline' });
  wrap.append(h('h4', { text: `Pipeline result: ${p.status.toUpperCase()} (stage: ${p.stage})` }));

  if (r.scanner) wrap.append(agentBox('Agent 1 - Scanner', r.scanner.verdict, r.scanner.summary, r.scanner.checks, [
    r.scanner.whyItMayBeInteresting?.length ? h('div', {}, h('strong', { class: 'small', text: 'Why it may be interesting: ' }), h('span', { class: 'small', text: r.scanner.whyItMayBeInteresting.join(' ') })) : null,
    r.scanner.mainRisks?.length ? h('div', {}, h('strong', { class: 'small', text: 'Main risks: ' }), h('span', { class: 'small', text: r.scanner.mainRisks.join(' ') })) : null,
  ]));
  if (r.antiFomo) wrap.append(agentBox('Agent 5 - Anti-FOMO', r.antiFomo.verdict, r.antiFomo.explanation, r.antiFomo.checks));
  if (r.sizer) wrap.append(sizerBox(r.sizer));
  if (r.buyer) wrap.append(buyerBox(r.buyer));

  if (p.status === 'awaiting') {
    const stageNames = { scanner: 'Scanner', antiFomo: 'Anti-FOMO', sizer: 'Sizer' };
    wrap.append(
      h('div', { class: 'gate' },
        h('strong', { text: `Waiting for your decision - ${stageNames[p.stage] || p.stage}` }),
        h('p', { class: 'small', text: p.prompt }),
        h('div', { class: 'row' },
          h('button', { class: 'btn btn-good', text: `I approve ${stageNames[p.stage] || ''} - continue`, onclick: () => continuePipeline(ctx) }),
          h('button', { class: 'btn btn-danger', text: 'Decline - record the block', onclick: () => declinePipeline(ctx) }),
        ),
        h('p', { class: 'muted small', text: r[p.stage]?.verdict === 'SKIP' || r[p.stage]?.verdict === 'BLOCK' || r[p.stage]?.verdict === 'REJECT'
          ? 'Heads up: this agent said no. Overriding it is allowed and it is recorded as an override - which is exactly what the review is for.'
          : 'Guided mode means the run pauses here rather than filling a ticket on its own.' }),
      ),
    );
  }

  if (p.status === 'blocked') {
    wrap.append(h('div', { class: 'gate gate-bad' },
      h('strong', { text: `Trade blocked at the ${p.stage} stage.` }),
      h('p', { class: 'small', text: `There is no ticket. The setup was written to the ledger as ${p.record?.id} with reason: ${(p.record?.reasons || []).join(' ')}` }),
      h('p', { class: 'muted small', text: `Filed under mistake category: "${p.record?.category}". Blocked setups are what prove whether Anti-FOMO earns its place.` }),
    ));
  }

  if (p.status === 'opened') {
    const t = p.record;
    wrap.append(h('div', { class: 'gate gate-good' },
      h('strong', { text: `Paper ticket ${t.id} created. STATUS: OPEN` }),
      h('div', { class: 'ticket mono' },
        kv('Token', `${t.token} (${t.pair})`),
        kv('Simulated entry', fmtPrice(t.entry.price)),
        kv('Position size', `${t.entry.units} units (${fmtUsd(t.entry.notionalUsd)})`),
        kv('Stop loss', fmtPrice(t.stopLoss)),
        kv('Target', fmtPrice(t.target)),
        kv('Max dollar risk', `${fmtUsd(t.maxDollarRisk)} (from the fill: ${fmtNum(t.fillStopDistancePct, 3)}% to the stop + estimated costs; the Sizer planned ${fmtUsd(t.maxDollarRiskPlanned)})`),
        kv('Time entered', fmtTime(t.entry.at)),
        kv('Execution', t.executionMode === 'auto' ? 'AUTO mode (agents ran straight through)' : 'GUIDED mode (you approved each stage)'),
      ),
      h('p', { class: 'muted small', text: 'Nothing was sent anywhere. Close it from the open-position panel or the log.' }),
    ));
  }
  return wrap;
}

function agentBox(title, verdict, summary, checks, extra = []) {
  return h('div', { class: `agent-box ${verdict === 'PASS' || verdict === 'APPROVE' || verdict === 'TICKET' ? 'agent-good' : verdict === 'SKIP' ? 'agent-warn' : 'agent-bad'}` },
    h('div', { class: 'row row-between' }, h('strong', { text: title }), verdictPill(verdict)),
    h('p', { class: 'small', text: summary }),
    ...extra.filter(Boolean),
    checks?.length ? h('details', { class: 'details' }, h('summary', { text: `Show ${checks.length} checks` }), checksTable(checks)) : null,
  );
}

function sizerBox(s) {
  return h('div', { class: `agent-box ${s.verdict === 'APPROVE' ? 'agent-good' : 'agent-bad'}` },
    h('div', { class: 'row row-between' }, h('strong', { text: 'Agent 2 - Sizer' }), verdictPill(s.verdict)),
    h('p', { class: 'small', text: s.summary }),
    s.plainEnglish?.length ? h('ul', { class: 'small' }, ...s.plainEnglish.map((l) => h('li', { text: l }))) : null,
    h('details', { class: 'details' }, h('summary', { text: 'Show the sizing checks' }), checksTable(s.checks)),
  );
}

function buyerBox(b) {
  const ok = b.verdict === 'TICKET';
  return h('div', { class: `agent-box ${ok ? 'agent-good' : 'agent-bad'}` },
    h('div', { class: 'row row-between' }, h('strong', { text: 'Agent 3 - Buyer (paper execution only)' }), verdictPill(b.verdict)),
    h('p', { class: 'small', text: b.summary }),
    h('table', { class: 'table' }, h('thead', {}, h('tr', {}, h('th', { text: 'Required approval' }), h('th', { text: 'Expected' }), h('th', { text: 'Actual' }))),
      h('tbody', {}, ...(b.approvals || []).map((a) => h('tr', { class: a.actual === a.required ? '' : 'row-bad' }, h('td', { text: a.agent }), h('td', { class: 'mono', text: a.required }), h('td', {}, verdictPill(a.actual)))))),
    (b.blockers || []).length ? h('ul', { class: 'small' }, ...b.blockers.map((x) => h('li', { text: x }))) : null,
    h('p', { class: 'muted small', text: (b.reminders || []).join(' ') }),
  );
}

async function continuePipeline(ctx) {
  const { app } = ctx;
  const stage = app.pipeline.stage;
  const gates = { ...(app.gates || {}), [stage]: 'approve' };
  app.gates = gates;
  try {
    const out = await api('/api/evaluate', {
      method: 'POST',
      body: { snapshotId: app.snapshot.id, mode: app.mode || 'guided', gates, planOverride: app.planOverride, writtenReason: app.writtenReason || '' },
    });
    app.pipeline = out;
    app.plan = out.plan;
    if (out.status === 'awaiting') toast(out.prompt, 'info', 7000);
    else if (out.status === 'opened') toast(`Paper ticket ${out.record.id} created.`, 'good');
    else toast(`Blocked at the ${out.stage} stage (recorded).`, 'warn');
    await ctx.reload();
    ctx.refresh({ keepScroll: true });
  } catch (err) {
    toast(err.message, 'danger');
  }
}

async function declinePipeline(ctx) {
  const { app } = ctx;
  const stage = app.pipeline.stage;
  const gates = { ...(app.gates || {}), [stage]: 'decline' };
  app.gates = gates;
  try {
    const out = await api('/api/evaluate', {
      method: 'POST',
      body: { snapshotId: app.snapshot.id, mode: app.mode || 'guided', gates, planOverride: app.planOverride, writtenReason: app.writtenReason || '' },
    });
    app.pipeline = out;
    toast('Declined and logged as a blocked setup.', 'warn');
    await ctx.reload();
    ctx.refresh({ keepScroll: true });
  } catch (err) {
    toast(err.message, 'danger');
  }
}

/* ------------------------------------------------------------------ *
 * 3. open position
 * ------------------------------------------------------------------ */

export function positionPanel(ctx, { compact = false } = {}) {
  const { state, app } = ctx;
  const open = state.records.filter((r) => r.kind === 'trade' && r.status === 'OPEN');
  if (!open.length) {
    return compact ? null : card('Open position', h('p', { class: 'muted', text: 'No position is open. The one-position rule means the desk is free to consider one new setup.' }));
  }
  const t = open[0];
  const snap = app.snapshot && app.snapshot.token === t.token ? app.snapshot : null;
  const price = snap?.metrics?.price ?? null;
  const mark = price === null || !Number.isFinite(price) ? null : (price - t.entry.price) * t.entry.units;
  const rNow = price === null ? null : (price - t.entry.price) / ((t.stopDistancePct / 100) * t.entry.price);

  return card(
    'Open position',
    h('div', { class: 'row row-between' },
      h('div', {}, h('strong', { class: 'big', text: `${t.token} · ${t.id}` }), h('p', { class: 'muted small', text: `opened ${fmtTime(t.entry.at)} · ${t.setup} · ${t.dataQuality}` })),
      h('div', { class: 'right' }, h('div', { class: 'mono big', text: mark === null ? 'no fresh price' : `${mark >= 0 ? '+' : ''}${fmtUsd(mark)}` }), h('div', { class: 'muted small', text: rNow === null ? 'mark-to-market needs fresh data' : `${fmtNum(rNow, 2)}R open` })),
    ),
    h('div', { class: 'metrics-grid' },
      metric('entry', fmtPrice(t.entry.price)),
      metric('units', t.entry.units),
      metric('notional', fmtUsd(t.entry.notionalUsd)),
      metric('stop', fmtPrice(t.stopLoss)),
      metric('target', fmtPrice(t.target)),
      metric('max risk', fmtUsd(t.maxDollarRisk)),
      metric('last price', price === null ? 'fetch this token for a live mark' : fmtPrice(price)),
      metric('distance to stop', price === null ? 'n/a' : fmtPct(((t.stopLoss - price) / price) * 100)),
    ),
    h('div', { class: 'row row-gap' },
      h('button', { class: 'btn btn-primary', text: 'Close this paper position', onclick: () => closeDialog(ctx, t, price) }),
      h('span', { class: 'muted small', text: 'Exit price: use the price you can actually see on your chart. The app does not pretend to know your fill.' }),
    ),
    h('details', { class: 'details' }, h('summary', { text: 'Why this trade was taken' }), h('ul', { class: 'small' }, ...(t.whyTaken || []).map((w) => h('li', { text: w })))),
  );
}

function closeDialog(ctx, t, lastPrice) {
  const exitInput = h('input', { class: 'input', type: 'number', step: 'any', value: lastPrice ?? t.entry.price });
  const reasonInput = h('input', { class: 'input', placeholder: 'e.g. stop hit / target reached / thesis invalidated on volume', value: '' });
  const preset = ['Stop was hit', 'Target reached', 'Manual close - thesis changed', 'Manual close - ran out of patience', 'Manual close - held too long'];
  const learningInput = h('textarea', { class: 'input', rows: 2, placeholder: 'What did you learn? (the Logger keeps this next to the result)' });
  const mistakeBoxes = ['Chased an extended move (Anti-FOMO)', 'Exited early', 'Held too long', 'Manual close judgement call', 'Data quality problem', 'None / unknown']
    .map((m) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: m }), ` ${m}`));

  modal(`Close ${t.id} (${t.token})`, h('div', {},
    h('p', { class: 'muted small', text: `Entry ${fmtPrice(t.entry.price)} · stop ${fmtPrice(t.stopLoss)} · target ${fmtPrice(t.target)}. The Logger computes the P&L including simulated fees and slippage.` }),
    h('label', { class: 'field' }, h('span', { text: 'Exit price' }), exitInput),
    h('label', { class: 'field' }, h('span', { text: 'Why it was closed' }), reasonInput),
    h('div', { class: 'row row-gap small' }, ...preset.map((p) => h('button', { class: 'btn btn-mini', text: p, onclick: () => { reasonInput.value = p; } }))),
    h('div', { class: 'field' }, h('span', { text: 'Mistakes to tag (never hidden - this is what the review uses)' }), h('div', { class: 'check-grid' }, ...mistakeBoxes)),
    h('label', { class: 'field' }, h('span', { text: 'What we learned' }), learningInput),
  ), [
    { label: 'Cancel', onClick: (c) => c() },
    {
      label: 'Record the close',
      class: 'btn-primary',
      onClick: async (c) => {
        const exitPrice = Number(exitInput.value);
        if (!Number.isFinite(exitPrice) || exitPrice <= 0) return toast('A positive exit price is needed.', 'warn');
        const mistakes = [...document.querySelectorAll('.overlay .check-grid input:checked')].map((el) => el.value);
        try {
          const out = await api('/api/close', { method: 'POST', body: { recordId: t.id, exitPrice, closeReason: reasonInput.value, mistakes, learned: learningInput.value } });
          const pnl = out.record.pnl;
          toast(`${t.id} closed: ${pnl.result} ${fmtUsd(pnl.netUsd)} (${fmtNum(pnl.netPct, 2)}%, ${fmtNum(pnl.rMultiple, 2)}R).`, pnl.result === 'LOSS' ? 'warn' : 'good', 8000);
          c();
          await ctx.reload();
          ctx.refresh({ keepScroll: true });
        } catch (err) {
          toast(err.message, 'danger');
        }
      },
    },
  ]);
}

/* ------------------------------------------------------------------ *
 * 4. auto-scan + stats
 * ------------------------------------------------------------------ */

function autoscanPanel(ctx) {
  const { state } = ctx;
  const a = state.autoScan;
  const cb = h('input', { type: 'checkbox', checked: a.enabled });
  const interval = h('select', { class: 'input' }, ...[60, 120, 300].map((s) => h('option', { value: s, text: `every ${s / 60} minute(s)`, selected: a.intervalMs === s * 1000 })));
  return card(
    'Optional - auto-scan timer',
    h('p', { class: 'muted small', text: 'Off by default. If you switch it on, the desk checks the watchlist tickers marked "auto" on a timer and creates paper tickets by itself when all three gates approve. Auto-created tickets are stamped "AUTO mode" so they can never be confused with your own decisions. Demo data never auto-trades.' }),
    h('div', { class: 'row' }, h('label', { class: 'check' }, cb, ' Enable auto-scan'), interval,
      h('button', { class: 'btn', text: 'Save', onclick: async () => {
        try {
          await api('/api/autoscan', { method: 'POST', body: { enabled: cb.checked, intervalMs: Number(interval.value) * 1000 } });
          toast('Auto-scan settings saved (recorded in the audit trail).', 'good');
          await ctx.reload(); ctx.refresh({ keepScroll: true });
        } catch (err) { toast(err.message, 'danger'); }
      } }),
      h('button', { class: 'btn btn-ghost', text: 'Run one cycle now', onclick: async () => {
        try {
          const out = await api('/api/autoscan/run', { method: 'POST' });
          const opened = out.results.filter((r) => r.status === 'opened').length;
          toast(`Cycle done: ${out.results.length} ticker(s) checked, ${opened} ticket(s) created.`, opened ? 'good' : 'info', 7000);
          await ctx.reload(); ctx.refresh({ keepScroll: true });
        } catch (err) { toast(err.message, 'danger'); }
      } }),
    ),
    a.lastRunAt ? h('p', { class: 'muted small', text: `Last run ${ago(a.lastRunAt)}: ${a.lastRun.map((r) => `${r.pair} ${r.status}${r.reason ? ` (${r.reason})` : ''}`).join(' · ') || 'no tickers marked auto'}` }) : null,
  );
}

function deskStatsStrip(ctx) {
  const { state } = ctx;
  const s = state.stats;
  return card('Where the experiment stands',
    h('div', { class: 'metrics-grid' },
      metric('paper balance', fmtUsd(state.account.balance)),
      metric('realized P&L', `${s.realizedPnlUsd >= 0 ? '+' : ''}${fmtUsd(s.realizedPnlUsd)}`),
      metric('closed trades', `${s.counts.closedTrades} / ${state.config.review.blockSize} toward the first review`),
      metric('win rate', s.winRate === null ? 'no closed trades yet' : `${fmtNum(s.winRate, 1)}%`),
      metric('blocked setups', s.counts.blocked),
      metric('most common mistake', s.mostCommonMistake || 'none logged yet'),
    ),
  );
}
