/**
 * view-research.mjs - Agent 4's page: prediction markets, kept strictly
 * separate from the meme-coin book. Research, not gambling: when there is no
 * honest edge the agent is required to say SKIP.
 */

import { h, api, toast, fmtUsd, fmtNum, fmtTime, pill, card, kv } from './util.mjs';
import { RESEARCH_TOOLS, manualResearchMarket } from './prediction-tools.mjs';
import { browserChannel } from './browserFeed.mjs';

export function renderResearch(ctx) {
  const { state, app } = ctx;
  const wrap = h('div', { class: 'stack' });

  wrap.append(
    card('Polymarket · Prediction-Market research',
      h('p', { class: 'muted small', text: 'Research YES/NO outcomes before risking anything. This rules-based checker uses YOUR evidence and estimated probability range; it does not discover an edge or predict the future. Maximum paper risk is 1% per bet. No wallet, no real orders.' }),
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

  wrap.append(card('Your Polymarket workflow',
    h('p', { text: '1. Load markets → 2. Read the exact resolution rules on Polymarket → 3. Supply sourced evidence and your probability range → 4. Log a YES / NO paper position or SKIP → 5. Record the verified outcome.' }),
    h('p', { class: 'muted small', text: 'A probability is not a guarantee. Paper risk is the entire stake, not a crypto stop-loss. Settlement is recorded manually; check the official outcome before resolving. Reported prices are snapshots, not executable quotes, and simulated results are not live trading performance.' }),
    h('button', { class: 'btn', text: 'View paper positions & resolve outcomes', onclick: () => { app.logTab = 'predictions'; ctx.go('log'); } }),
  ));

  wrap.append(publicUSPanel(), researchTools(ctx));

  if (!app.markets?.length) {
    wrap.append(card('No markets loaded yet', h('p', { class: 'muted', text: 'Press "Fetch prediction markets" to pull open markets with their implied probabilities. Nothing is bet automatically - every market goes through the agent, and SKIP is a perfectly normal outcome.' })));
    return wrap;
  }

  const search = h('input', { class: 'input', type: 'search', placeholder: 'Filter loaded markets by question…', 'aria-label': 'Filter markets' });
  search.addEventListener('input', () => {
    for (const row of wrap.querySelectorAll('tbody tr')) {
      row.hidden = !row.textContent.toLowerCase().includes(search.value.toLowerCase());
    }
  });
  wrap.append(
    card('Open markets',
      search,
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

function researchDialog(ctx, market, researchNotes = '') {
  const evidence = h('textarea', { class: 'input', rows: 5, placeholder: 'Research notes: what the event is, what the evidence says, dates that matter, and what would change your mind. Be honest - fewer than ~12 words and the agent will SKIP.' });
  evidence.value = researchNotes;
  const low = h('input', { class: 'input', type: 'number', step: '0.5', placeholder: 'e.g. 25 (percent)' });
  const high = h('input', { class: 'input', type: 'number', step: '0.5', placeholder: 'e.g. 40 (percent)' });
  const days = h('input', { class: 'input', type: 'number', step: '1', placeholder: 'days until it resolves', value: market.endDate ? Math.max(0, Math.round((new Date(market.endDate) - Date.now()) / 86400000)) : '' });
  const resultBox = h('div', { class: 'stack' });

  const overlay = h('div', { class: 'overlay' });
  const dialog = h('div', { class: 'modal modal-wide' },
    h('h3', { text: 'Agent 4 - research this market' }),
    h('div', { class: 'modal-body' },
      kv('Market', market.question),
      h('p', { class: 'muted small', text: 'YES refers to the exact proposition above, not automatically the favorite or first team. Evidence templates are questions, not evidence: replace every prompt with verified findings and source URLs. Live scores and prices are not streamed here.' }),
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
            await ctx.refresh({ keepScroll: true });
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

function researchTools(ctx) {
  const type = h('select', { class: 'input', 'aria-label': 'Research category' },
    ...Object.entries(RESEARCH_TOOLS).map(([id, t]) => h('option', { value: id, text: t.label })));
  const prompts = h('ul', { class: 'small' });
  const update = () => prompts.replaceChildren(...RESEARCH_TOOLS[type.value].prompts.map(text => h('li', { text })));
  type.addEventListener('change', update);
  update();
  const fields = {};
  const field = (key, label, attrs = {}) => {
    fields[key] = h('input', { class: 'input', ...attrs });
    return h('label', { class: 'field' }, h('span', { text: label }), fields[key]);
  };
  const confirmed = h('input', { type: 'checkbox' });
  return card('NFL, tennis & BTC research tools',
    type, prompts,
    h('p', { class: 'muted small', text: 'These are research checklists, not picks. Use a loaded YES/NO market or enter an exact contract below. Screenshot percentages are not current quotes. No automatic score, injury or price feed is provided by these tools.' }),
    h('details', {}, h('summary', { text: 'Research a specific market from a link or screenshot' }),
      field('question', 'Explicit YES proposition (include teams/players or BTC interval)'),
      field('url', 'Polymarket contract link', { type: 'url', placeholder: 'https://polymarket.com/event/…' }),
      field('price', 'Verified YES price %', { type: 'number', min: '0', max: '100', step: 'any' }),
      field('spread', 'Spread in percentage points (blank if unknown)', { type: 'number', min: '0', step: 'any' }),
      field('liquidity', 'Reported liquidity USD (blank if unknown)', { type: 'number', min: '0', step: 'any' }),
      field('endDate', 'Resolution date/time (your local timezone)', { type: 'datetime-local' }),
      h('label', { class: 'field' }, confirmed, h('span', { text: 'I checked the exact resolution rules and which outcome YES represents.' })),
      h('button', { class: 'btn btn-primary', text: 'Open research worksheet', onclick: () => {
        try {
          if (!confirmed.checked) throw new Error('Confirm the outcome mapping and resolution rules first.');
          const market = manualResearchMarket(Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value])));
          researchDialog(ctx, market);
        } catch (err) { toast(err.message, 'danger'); }
      } }),
    ),
  );
}

function publicUSPanel() {
  const slug = h('input', { class: 'input', placeholder: 'US market slug (example: chiefs-super-bowl)', 'aria-label': 'US market slug' });
  const output = h('pre', { class: 'small', style: 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:24rem;overflow:auto', 'aria-live': 'polite', text: 'No US data loaded. No API keys required.' });
  const load = async (button, path) => {
    button.disabled = true;
    output.textContent = 'Loading public Polymarket US data…';
    try {
      const result = await api(path);
      output.textContent = JSON.stringify(result, null, 2);
    } catch (err) { output.textContent = err.message; }
    finally { button.disabled = false; }
  };
  const limit = h('input', { class: 'input', type: 'number', min: 1, max: 100, value: 10 });
  const offset = h('input', { class: 'input', type: 'number', min: 0, max: 100000, value: 0 });
  const categories = h('input', { class: 'input', placeholder: 'sports,crypto' });
  const seriesId = h('input', { class: 'input', placeholder: 'Comma-separated numeric series IDs' });
  const flags = Object.fromEntries(['active', 'closed', 'archived', 'featured', 'live', 'ended'].map(key => [key,
    h('select', { class: 'input' }, ...['', 'true', 'false'].map(value => h('option', { value, text: value || 'Any' }))) ]));
  flags.active.value = 'true';
  const field = (label, input) => h('label', { class: 'field' }, h('span', { text: label }), input);
  const eventKey = h('input', { class: 'input', placeholder: 'Event ID or event slug' });
  const eventType = h('select', { class: 'input', 'aria-label': 'Event lookup type' }, h('option', { value: 'slug', text: 'Event slug' }), h('option', { value: 'id', text: 'Numeric event ID' }));
  const eventLookup = h('button', { class: 'btn', text: 'Look up US event' });
  eventLookup.addEventListener('click', () => load(eventLookup, `/api/polymarket-us/event?${eventType.value}=${encodeURIComponent(eventKey.value.trim())}`));
  const events = h('button', { class: 'btn', text: 'Load filtered US events' });
  const seriesSlugs = h('input', { class: 'input', placeholder: 'Comma-separated series slugs' });
  const recurrence = h('input', { class: 'input', placeholder: 'daily, weekly, etc.' });
  const seriesList = h('button', { class: 'btn', text: 'Load filtered US series' });
  seriesList.addEventListener('click', () => {
    const params = new URLSearchParams({ limit: limit.value, offset: offset.value });
    for (const [key, input] of Object.entries({ slug: seriesSlugs, recurrence, active: flags.active, closed: flags.closed, archived: flags.archived })) if (input.value !== '') params.set(key, input.value);
    load(seriesList, `/api/polymarket-us/series?${params}`);
  });
  const lookupSeriesId = h('input', { class: 'input', type: 'number', min: 1, placeholder: 'Numeric series ID' });
  const seriesLookup = h('button', { class: 'btn', text: 'Look up US series' });
  seriesLookup.addEventListener('click', () => load(seriesLookup, `/api/polymarket-us/series-detail?id=${encodeURIComponent(lookupSeriesId.value)}`));
  const searchQuery = h('input', { class: 'input', type: 'search', placeholder: 'bitcoin, NFL, player or team…' });
  const searchLimit = h('input', { class: 'input', type: 'number', min: 1, max: 100, value: 10 });
  const searchPage = h('input', { class: 'input', type: 'number', min: 0, max: 10000, placeholder: 'Optional page number' });
  const searchSeries = h('input', { class: 'input', placeholder: 'Optional comma-separated series IDs' });
  const searchTypes = h('input', { class: 'input', placeholder: 'Optional API market-type values, comma-separated' });
  const searchStatus = h('select', { class: 'input' }, ...['', 'active', 'closed', 'upcoming'].map(value => h('option', { value, text: value || 'Any status' })));
  const searchButton = h('button', { class: 'btn btn-primary', text: 'Search US events & markets' });
  const runSearch = () => {
    const params = new URLSearchParams({ query: searchQuery.value.trim(), limit: searchLimit.value });
    for (const [key, input] of Object.entries({ page: searchPage, seriesIds: searchSeries, marketType: searchTypes, status: searchStatus })) if (input.value.trim()) params.set(key, input.value.trim());
    return load(searchButton, `/api/polymarket-us/search?${params}`);
  };
  const searchForm = h('form', { onsubmit: event => { event.preventDefault(); if (!searchButton.disabled) runSearch(); } },
    field('Search text', searchQuery),
    h('div', { class: 'grid-3' }, field('Search result limit', searchLimit), field('Search page', searchPage), field('Search status', searchStatus), field('Search series IDs', searchSeries), field('Search market types', searchTypes)), searchButton);
  const sportsList = h('button', { class: 'btn', text: 'Load sports configuration' });
  sportsList.addEventListener('click', () => load(sportsList, '/api/polymarket-us/sports'));
  const provider = h('select', { class: 'input' }, ...['', 'PROVIDER_SPORTRADAR', 'PROVIDER_SPORTSDATAIO'].map(value => h('option', { value, text: value || 'Any provider' })));
  const league = h('input', { class: 'input', placeholder: 'NFL, NBA, MLB, etc.' });
  const teamIds = h('input', { class: 'input', placeholder: 'Optional comma-separated numeric IDs' });
  const teamsList = h('button', { class: 'btn', text: 'Look up teams' });
  teamsList.addEventListener('click', () => {
    const params = new URLSearchParams();
    for (const [key, input] of Object.entries({ provider, league, teamIds })) if (input.value.trim() !== '') params.set(key, input.value.trim());
    load(teamsList, `/api/polymarket-us/teams?${params}`);
  });
  const sportsType = h('select', { class: 'input' }, ...['', 'MONEYLINE', 'SPREAD', 'TOTAL', 'PROP'].map(value => h('option', { value, text: value || 'All sports market types' })));
  const volumeMin = h('input', { class: 'input', type: 'number', min: 0, step: 'any' });
  const liquidityMin = h('input', { class: 'input', type: 'number', min: 0, step: 'any' });
  const markets = h('button', { class: 'btn', text: 'Load filtered US markets' });
  markets.addEventListener('click', () => {
    const params = new URLSearchParams({ limit: limit.value, offset: offset.value });
    for (const [key, input] of Object.entries({ categories, active: flags.active, closed: flags.closed, archived: flags.archived, sportsMarketTypes: sportsType, volumeNumMin: volumeMin, liquidityNumMin: liquidityMin })) if (input.value !== '') params.set(key, input.value);
    load(markets, `/api/polymarket-us/markets?${params}`);
  });
  const marketId = h('input', { class: 'input', type: 'number', min: 1, placeholder: 'Numeric market ID' });
  const byId = h('button', { class: 'btn', text: 'Look up market by ID' });
  byId.addEventListener('click', () => load(byId, `/api/polymarket-us/market-read?id=${encodeURIComponent(marketId.value)}`));
  const reads = ['details', 'book', 'bbo', 'settlement'].map(kind => {
    const button = h('button', { class: 'btn', text: `Read ${kind} by slug` });
    button.addEventListener('click', () => load(button, `/api/polymarket-us/market-read?kind=${kind}&slug=${encodeURIComponent(slug.value.trim())}`));
    return button;
  });
  const market = h('button', { class: 'btn btn-primary', text: 'Inspect US market & order book' });
  events.addEventListener('click', () => {
    const params = new URLSearchParams({ limit: limit.value, offset: offset.value });
    for (const [key, input] of Object.entries({ categories, seriesId, ...flags })) if (input.value !== '') params.set(key, input.value);
    load(events, `/api/polymarket-us/events?${params}`);
  });
  market.addEventListener('click', () => load(market, `/api/polymarket-us/market?slug=${encodeURIComponent(slug.value.trim())}`));
  return card('Polymarket US · public market explorer',
    h('p', { class: 'muted small', text: 'Read-only SDK data, separate from the existing Polymarket feed. US slugs and market availability can differ. The example slug is not verified. Raw API results are shown for inspection; they do not automatically create a paper bet or stream live updates.' }),
    h('h4', { text: 'Search US events & markets' }),
    h('p', { class: 'muted small', text: 'Server-side public API search, separate from the loaded-market filter. Results include associated markets when returned. Page numbering and marketType filtering are not live-verified; leave optional fields blank to use API defaults.' }),
    searchForm,
    h('div', { class: 'grid-3' }, field('Limit (1–100)', limit), field('Offset (results to skip)', offset), field('Categories', categories), field('Series IDs', seriesId), ...Object.entries(flags).map(([key, input]) => field(key, input))),
    h('p', { class: 'muted small', text: 'Pagination: increase offset by limit for the next page. Sports scores and participants, when returned, appear in the raw response. Live is documented in the supplied reference but absent from SDK 0.1.1 types; it is forwarded as a query filter and is not live-verified here. No streaming or automatic refresh.' }),
    events, field('Event lookup', eventType), eventKey, eventLookup,
    h('h4', { text: 'Sports & teams' }),
    h('p', { class: 'muted small', text: 'Public provider configuration and team data, when available. Operational and automatic-resolution flags describe provider configuration, not a guarantee that a specific market is tradable or settled. Team data is not a live score or injury feed. Responses are preserved as returned.' }),
    sportsList, field('Team data provider', provider), field('League', league), field('Team IDs', teamIds), teamsList,
    h('h4', { text: 'Browse event series' }),
    h('p', { class: 'muted small', text: 'Series group related events. Lists share limit, offset, active, closed and archived above; event category and live filters do not apply here. Copy an ID from the response into Series IDs above to filter events. Responses are raw snapshots, not live subscriptions.' }),
    field('Series slugs', seriesSlugs), field('Recurrence', recurrence), seriesList,
    field('Series lookup ID', lookupSeriesId), seriesLookup,
    h('h4', { text: 'Market filters & pricing' }),
    h('p', { class: 'muted small', text: 'Market lists share limit, offset, categories, active, closed and archived above. Sports type and minimum volume/liquidity use the supplied documentation names, which SDK 0.1.1 types do not declare; upstream filtering is unverified. Settlement is a raw read only, not automatic ledger resolution. BBO and book are fetched snapshots, not streams.' }),
    field('Sports market type', sportsType), field('Minimum volume', volumeMin), field('Minimum liquidity', liquidityMin), markets,
    field('Market ID', marketId), byId, field('Market slug', slug), market, h('div', { class: 'row row-gap' }, ...reads), output);
}
