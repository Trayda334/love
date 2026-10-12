/**
 * view-research.mjs - Agent 4's page: prediction markets, kept strictly
 * separate from the meme-coin book. Research, not gambling: when there is no
 * honest edge the agent is required to say SKIP.
 */

import { h, api, toast, fmtUsd, fmtNum, fmtTime, pill, card, kv } from './util.mjs';
import { browserChannel } from './browserFeed.mjs';

export function renderResearch(ctx) {
  const { state, app } = ctx;
  const wrap = h('div', { class: 'stack' });

  wrap.append(
    card('Agent 4 - Prediction-Market research',
      h('p', { class: 'muted small', text: 'Separate ledger, separate 1% cap. The agent must SKIP if evidence is thin, if the spread eats the edge, or if your own estimate is within a few points of the market price. Its output format matches the guide exactly.' }),
      h('div', { class: 'row row-gap' },
        h('button', { class: 'btn btn-primary', text: app.markets ? 'Refresh markets' : 'Fetch prediction markets', onclick: () => fetchMarkets(ctx) }),
        h('span', { class: 'muted small', text: app.marketChannel ? `source: ${app.marketChannel} · ${app.markets?.length || 0} markets loaded` : 'data comes from Polymarket\'s public API (read-only)' }),
      ),
      h('div', { class: 'tiles' },
        tileMini('paper bets open', String(state.records.filter((r) => r.kind === 'prediction' && r.status === 'OPEN_BET').length), `cap: ${state.config.prediction.maxOpenBets}`),
        tileMini('bets resolved', String(state.records.filter((r) => r.kind === 'prediction' && r.status === 'RESOLVED').length), ''),
        tileMini('markets skipped', String(state.records.filter((r) => r.kind === 'prediction' && r.status === 'SKIPPED').length), 'skips are logged too'),
        tileMini('realized bet P&L', fmtUsd(state.records.filter((r) => r.kind === 'prediction' && r.pnlUsd !== null).reduce((a, r) => a + r.pnlUsd, 0)), 'included in the balance'),
      ),
    ),
  );

  if (!app.markets?.length) {
    wrap.append(card('No markets loaded yet', h('p', { class: 'muted', text: 'Press "Fetch prediction markets" to pull open markets with their implied probabilities. Nothing is bet automatically - every market goes through the agent, and SKIP is a perfectly normal outcome.' })));
    return wrap;
  }

  wrap.append(
    card('Open markets',
      h('table', { class: 'table table-tight' },
        h('thead', {}, h('tr', {}, h('th', { text: 'Market' }), h('th', { text: 'Implied YES' }), h('th', { text: 'Spread' }), h('th', { text: 'Liquidity' }), h('th', { text: 'Resolves' }), h('th', { text: '' }))),
        h('tbody', {}, ...app.markets.map((m) => h('tr', {},
          h('td', { class: 'small' }, h('a', { href: m.url, target: '_blank', rel: 'noreferrer', text: m.question })),
          h('td', { class: 'mono', text: m.yesPrice === null ? '—' : `${fmtNum(m.yesPrice * 100, 1)}%` }),
          h('td', { class: 'mono', text: m.spreadPoints === null ? '—' : `${fmtNum(m.spreadPoints, 1)} pts` }),
          h('td', { class: 'mono', text: m.liquidityUsd === null ? '—' : fmtUsd(m.liquidityUsd, 0) }),
          h('td', { class: 'small', text: m.endDate ? fmtTime(m.endDate) : '—' }),
          h('td', {}, h('button', { class: 'btn btn-mini', text: 'Research with Agent 4', onclick: () => researchDialog(ctx, m) })),
        ))),
      ),
      h('p', { class: 'muted small', text: 'Lower liquidity and wide spreads are the two quiet killers here. The agent blocks on both.' }),
    ),
  );

  return wrap;
}

async function fetchMarkets(ctx) {
  try {
    const out = await browserChannel.predictionMarkets(30);
    ctx.app.markets = out.markets;
    ctx.app.marketChannel = out.channel;
    toast(`${out.markets.length} markets loaded (${out.channel}).`, 'good');
    ctx.refresh({ keepScroll: true });
  } catch (err) {
    toast(err.message, 'danger', 8000);
  }
}

function researchDialog(ctx, market) {
  const evidence = h('textarea', { class: 'input', rows: 5, placeholder: 'Research notes: what the event is, what the evidence says, dates that matter, and what would change your mind. Be honest - fewer than ~12 words and the agent will SKIP.' });
  const low = h('input', { class: 'input', type: 'number', step: '0.5', placeholder: 'e.g. 25 (percent)' });
  const high = h('input', { class: 'input', type: 'number', step: '0.5', placeholder: 'e.g. 40 (percent)' });
  const days = h('input', { class: 'input', type: 'number', step: '1', placeholder: 'days until it resolves', value: market.endDate ? Math.max(0, Math.round((new Date(market.endDate) - Date.now()) / 86400000)) : '' });
  const resultBox = h('div', { class: 'stack' });

  const overlay = h('div', { class: 'overlay' });
  const dialog = h('div', { class: 'modal modal-wide' },
    h('h3', { text: 'Agent 4 - research this market' }),
    h('div', { class: 'modal-body' },
      kv('Market', market.question),
      kv('Current implied probability (YES)', market.yesPrice === null ? 'unknown' : `${fmtNum(market.yesPrice * 100, 1)}%`),
      kv('Bid / ask', `${market.bid ?? '—'} / ${market.ask ?? '—'} (spread ${market.spreadPoints === null ? 'unknown' : `${fmtNum(market.spreadPoints, 1)} pts`})`),
      kv('Liquidity', market.liquidityUsd === null ? 'not reported' : fmtUsd(market.liquidityUsd, 0)),
      h('label', { class: 'field' }, h('span', { text: 'Evidence and reasoning (required)' }), evidence),
      h('div', { class: 'grid-3' },
        h('label', { class: 'field' }, h('span', { text: 'Your range low %' }), low),
        h('label', { class: 'field' }, h('span', { text: 'Your range high %' }), high),
        h('label', { class: 'field' }, h('span', { text: 'Days to resolve' }), days),
      ),
      h('p', { class: 'muted small', text: 'Your range must be your own honest estimate, not a copy of the market price. If your midpoint is within a few points of the market, there is no edge and the agent will SKIP.' }),
      resultBox,
    ),
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn', text: 'Close', onclick: () => overlay.remove() }),
      h('button', {
        class: 'btn btn-primary',
        text: 'Run Agent 4 and log the outcome',
        onclick: async () => {
          const lo = Number(low.value) / 100;
          const hi = Number(high.value) / 100;
          try {
            const out = await api('/api/predictions/evaluate', {
              method: 'POST',
              body: {
                market,
                evidence: evidence.value,
                estimatedRange: Number.isFinite(lo) && Number.isFinite(hi) ? [lo, hi] : null,
                daysToResolve: days.value === '' ? null : Number(days.value),
              },
            });
            resultBox.replaceChildren(renderPredictionResult(out));
            toast(out.status === 'OPEN_BET' ? `Paper bet ${out.record.id} logged.` : `Skipped and logged (${out.record.id}).`, out.status === 'OPEN_BET' ? 'good' : 'warn');
            await ctx.reload();
          } catch (err) {
            toast(err.message, 'danger');
          }
        },
      }),
    ),
  );
  overlay.append(dialog);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.append(overlay);
}

function renderPredictionResult(out) {
  const r = out.result;
  return h('div', { class: `agent-box ${r.verdict === 'BET' ? 'agent-good' : 'agent-warn'}` },
    h('div', { class: 'row row-between' }, h('strong', { text: `Agent 4 verdict: ${r.verdict}` }), pill(out.record.id, 'neutral')),
    h('p', { class: 'small', text: r.summary }),
    h('table', { class: 'table' }, h('tbody', {},
      row('MARKET', r.market?.question),
      row('CURRENT IMPLIED PROBABILITY', `${r.market?.currentImpliedProbability}%`),
      row('YOUR ESTIMATED RANGE', r.estimatedRange ? `${r.estimatedRange.lowPct}% – ${r.estimatedRange.highPct}%` : 'not supplied'),
      row('EDGE', r.edgePoints === null ? 'none established' : `${r.edgePoints} points`),
      row('MAIN UNCERTAINTIES', (r.uncertainties || []).join(' ')),
      row('PAPER BET', r.verdict === 'BET' ? r.suggestedSide : 'SKIP'),
      row('MAX PAPER RISK', fmtUsd(r.maxPaperRiskUsd)),
      row('CONFIDENCE', r.confidence),
    )),
    h('details', { class: 'details' }, h('summary', { text: 'Show the checklist' }),
      h('ul', { class: 'small' }, ...r.checklist.map((c) => h('li', { text: `${c.label}: ${c.status.toUpperCase()} - ${c.reason}` })))),
    h('p', { class: 'muted small', text: r.disclaimer }),
  );
}

const row = (k, v) => h('tr', {}, h('td', { class: 'small muted', text: k }), h('td', { class: 'small', text: String(v ?? '—') }));
const tileMini = (k, v, sub) => h('div', { class: 'tile' }, h('div', { class: 'tile-k', text: k }), h('div', { class: 'tile-v', text: v }), sub ? h('div', { class: 'tile-sub', text: sub }) : null);
