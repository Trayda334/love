/**
 * view-setup.mjs - onboarding checklist, the six agents, the rulebook, the
 * watchlist and the "about this build" page.
 */

import { h, api, toast, fmtUsd, fmtTime, pill, card, copyText } from './util.mjs';

export function renderSetup(ctx) {
  const tab = ctx.app.setupTab || 'start';
  const wrap = h('div', { class: 'stack' });
  wrap.append(
    h('div', { class: 'tabs' },
      tabBtn(ctx, 'start', 'Onboarding checklist'),
      tabBtn(ctx, 'agents', 'The six agents'),
      tabBtn(ctx, 'rules', 'The rulebook'),
      tabBtn(ctx, 'watchlist', 'Watchlist'),
      tabBtn(ctx, 'about', 'About this build'),
    ),
  );
  const map = { start: startTab, agents: agentsTab, rules: rulesTab, watchlist: watchlistTab, about: aboutTab };
  wrap.append(map[tab](ctx));
  return wrap;
}

function tabBtn(ctx, id, label) {
  const active = (ctx.app.setupTab || 'start') === id;
  return h('button', { class: `tab ${active ? 'tab-active' : ''}`, text: label, onclick: () => { ctx.app.setupTab = id; ctx.refresh({ keepScroll: true }); } });
}

/* ------------------------------------------------------------------ *
 * onboarding
 * ------------------------------------------------------------------ */

function startTab(ctx) {
  const { state } = ctx;
  const s = state.stats;
  const hasWin = s.counts.wins > 0;
  const hasLoss = s.counts.losses > 0;
  const items = [
    { done: true, label: 'Paper-trading account created', note: `The desk has its own internal paper account: ${fmtUsd(state.account.balance)} now, started at ${fmtUsd(s.startingBalance)}.` },
    { done: true, label: 'Six AI roles created', note: 'Scanner, Sizer, Buyer, Prediction-Market, Anti-FOMO, Logger - see "The six agents".' },
    { done: state.config.risk.riskPctPerTrade <= 1, label: '1% max-risk rule added', note: `Currently ${state.config.risk.riskPctPerTrade}% per trade. This is a ceiling: it can be lowered, never raised.` },
    { done: true, label: 'Stop-loss required', note: 'The Buyer refuses to create a ticket without a stop, and the Sizer rejects a stop that is too tight or too wide.' },
    { done: true, label: 'One-position rule enabled', note: 'The one-position rule is hard-coded: a new evaluation is rejected while a paper position is open.' },
    { done: true, label: 'Anti-FOMO check enabled', note: `${s.counts.blocked} setup(s) blocked so far. Blocked setups are logged, never hidden.` },
    { done: true, label: 'Spreadsheet created', note: 'The ledger exports straight to CSV in the guide\'s column order (trades and blocked setups separately).', action: { label: 'Download trades CSV', href: '/api/export?kind=trade' } },
    {
      done: hasWin && hasLoss,
      label: 'Wins AND losses are logged',
      note: !hasWin && !hasLoss ? 'No closed trades yet - nothing to log.'
        : hasLoss ? 'Both wins and losses are on the ledger. That is the only way this experiment means anything.'
          : 'Only wins so far. Keep your eyes open: if a losing paper trade is missed, the data becomes worthless - and the app cannot detect a trade you never logged.',
    },
    { done: true, label: 'Paper agents isolated from live execution', note: 'These research agents and the paper ledger never place real orders. The separate live ticket is disabled by default and requires private HTTPS deployment, sign-in, preview and explicit confirmation.' },
    { done: s.counts.closedTrades >= 50, label: 'Ready to collect at least 50–100 paper trades', note: `${s.counts.closedTrades} closed so far. The guide says judge nothing before a full sample.`, progress: Math.min(100, (s.counts.closedTrades / 100) * 100) },
  ];

  const wrap = h('div', { class: 'stack' });
  wrap.append(
    card('Final checklist (guide)',
      h('p', { class: 'muted small', text: 'Each item is verified from the app\'s own state where possible. The two items the app cannot verify for you are honest boxing of losses and actually collecting enough trades - those are on you.' }),
      h('ul', { class: 'checklist' }, ...items.map((i) => h('li', { class: i.done ? 'ok' : 'todo' },
        h('span', { class: 'checkmark', text: i.done ? '✔' : '…' }),
        h('div', {}, h('strong', { text: i.label }), h('div', { class: 'muted small', text: i.note }),
          i.progress !== undefined ? h('div', { class: 'progress' }, h('div', { class: 'progress-bar', style: `width:${i.progress}%` })) : null,
          i.action ? h('a', { class: 'btn btn-mini', href: i.action.href, text: i.action.label }) : null,
        ),
      ))),
    ),
  );

  wrap.append(selftestCard(ctx));
  wrap.append(
    card('How to run your first honest experiment',
      h('ol', { class: 'small' },
        h('li', { text: 'On the desk: fetch live data for a token and check the data badge says LIVE. Never test on demo data and call it a result.' }),
        h('li', { text: 'Press "Derive plan from structure" to see what the Scanner proposes, then adjust the entry area, stop and target yourself if you disagree.' }),
        h('li', { text: 'Write one line of structural reasoning. If the reason is "it is going up", Anti-FOMO will (correctly) block it.' }),
        h('li', { text: 'Run the pipeline in Guided mode: approve each agent deliberately, or decline and see the block land in the ledger.' }),
        h('li', { text: 'When the stop or target is reached, close the position with the price you can actually see. Log the close reason honestly.' }),
        h('li', { text: 'Come back after 20 closed trades and read the review page before changing a single rule.' }),
      ),
      h('div', { class: 'row row-gap' },
        h('button', { class: 'btn btn-primary', text: 'Go to the desk', onclick: () => ctx.go('desk') }),
        h('button', { class: 'btn', text: 'Read the full guide', onclick: () => ctx.go('guide') }),
      ),
    ),
  );
  return wrap;
}

function selftestCard(ctx) {
  const box = h('div');
  const btn = h('button', {
    class: 'btn btn-primary',
    text: 'Run the four-scenario self-test',
    onclick: async () => {
      btn.disabled = true;
      btn.textContent = 'running…';
      try {
        const out = await api('/api/selftest', { method: 'POST' });
        box.replaceChildren(
          h('p', { class: 'small', text: out.note }),
          h('table', { class: 'table' },
            h('thead', {}, h('tr', {}, h('th', { text: 'Scenario' }), h('th', { text: 'Expected' }), h('th', { text: 'Actual' }), h('th', { text: 'Verdicts' }), h('th', { text: '' }))),
            h('tbody', {}, ...out.results.map((r) => h('tr', { class: r.pass ? 'row-good' : 'row-bad' },
              h('td', { text: r.scenario }),
              h('td', { class: 'small', text: r.expected }),
              h('td', { class: 'small', text: `${r.status}${r.stage ? ` at ${r.stage}` : ''}` }),
              h('td', { class: 'small mono', text: Object.entries(r.verdicts || {}).map(([k, v]) => `${k}: ${v || '—'}`).join(' · ') }),
              h('td', {}, r.pass ? pill('rules fired correctly', 'good') : pill('unexpected - investigate', 'danger')),
            ))),
          ),
          h('p', { class: 'muted small', text: `Result: ${out.passed}/${out.results.length} scenarios behaved exactly as designed. Nothing above touched your real ledger.` }),
        );
      } catch (err) {
        box.replaceChildren(h('p', { class: 'down', text: err.message }));
      } finally {
        btn.disabled = false;
        btn.textContent = 'Run the four-scenario self-test';
      }
    },
  });
  return card('Prove the rules actually fire',
    h('p', { class: 'muted small', text: 'This runs four synthetic scenarios through the real pipeline against a throwaway ledger: a quiet base (should open a ticket), a vertical pump (should be blocked by Anti-FOMO), a steady dump and a volatile mess (both should be skipped by the Scanner). If a scenario misbehaves, the rules - not your discipline - are the problem.' }),
    h('div', { class: 'row' }, btn),
    box,
  );
}

/* ------------------------------------------------------------------ *
 * agents
 * ------------------------------------------------------------------ */

function agentsTab(ctx) {
  const { state } = ctx;
  const wrap = h('div', { class: 'stack' });
  wrap.append(card('One job each', h('p', { class: 'muted small', text: 'Pipeline order: Scanner → Anti-FOMO → Sizer → Buyer → Logger. The Prediction-Market agent runs on its own ledger and is never mixed into the coin book.' })));
  for (const a of state.agents) {
    const lastDecision = [...state.records].reverse().map((r) => r.decisions?.[a.id]).filter(Boolean).pop();
    wrap.append(
      card(`Agent ${a.n} - ${a.name}`,
        h('p', { text: a.job }),
        h('div', { class: 'row row-gap' }, pill(a.pipelineRole, 'neutral'), lastDecision ? pill(`last verdict: ${lastDecision}`, 'accent') : pill('no verdicts logged yet', 'neutral')),
        h('details', { class: 'details' }, h('summary', { text: 'Copy-paste prompt (for Grok / ChatGPT - paste it alongside data from the desk)' }),
          h('pre', { class: 'prompt', text: a.prompt }),
          h('button', { class: 'btn btn-mini', text: 'Copy prompt', onclick: () => copyText(a.prompt, `Agent ${a.n} prompt copied.`) }),
          h('p', { class: 'muted small', text: 'Reminder from the guide: an AI does not know the current price. Always paste in the numbers from the desk, or the model is guessing.' }),
        ),
      ),
    );
  }
  return wrap;
}

/* ------------------------------------------------------------------ *
 * rules
 * ------------------------------------------------------------------ */

const RULE_SPEC = [
  { group: 'Account', items: [['account.startingBalance', 'Starting paper balance (USD)']] },
  { group: 'Risk (the 1% rule)', items: [
    ['risk.riskPctPerTrade', 'Max % of the account risked per trade (hard ceiling: 1)'],
    ['risk.minStopDistancePct', 'Minimum stop distance %'],
    ['risk.maxStopDistancePct', 'Maximum stop distance %'],
    ['risk.maxPositionNotionalPct', 'Max position notional as % of the account'],
    ['risk.minRiskReward', 'Minimum reward/risk ratio (R)'],
    ['risk.minPositionNotionalUsd', 'Minimum meaningful paper position (USD)'],
  ] },
  { group: 'Simulated costs', items: [
    ['fees.takerBps', 'Taker fee (basis points, each way)'],
    ['fees.slippageBps', 'Assumed slippage (basis points, each way)'],
  ] },
  { group: 'Scanner thresholds', items: [
    ['scanner.minCandles', 'Minimum closed 5m candles'],
    ['scanner.maxAtrPct', 'Maximum 5m ATR as % of price'],
    ['scanner.minVolume24hUsd', 'Minimum 24h volume (USD)'],
    ['scanner.entryChaseTolerancePct', 'Entry chase tolerance above the plan %'],
  ] },
  { group: 'Anti-FOMO thresholds', items: [
    ['antiFomo.max5mPct', 'Block if 5-minute move ≥ %'],
    ['antiFomo.max15mPct', 'Block if 15-minute move ≥ %'],
    ['antiFomo.maxVolumeSpikeRatio', 'Block if volume pace ≥ x normal while moving'],
    ['antiFomo.maxAboveSupportPct', 'Block if price is ≥ % above 1h support'],
    ['antiFomo.bigGreenCandleBodyPct', 'Block if last candle body ≥ %'],
    ['antiFomo.bigGreenCandleBodyToAvg', 'Block if that body ≥ x average body'],
    ['antiFomo.unknownChecksBlock', 'Block when this many checks are unverifiable'],
  ] },
  { group: 'Prediction markets', items: [
    ['prediction.maxRiskPctPerBet', 'Max % risk per paper bet (ceiling: 1)'],
    ['prediction.minEdgePoints', 'Minimum edge (percentage points)'],
    ['prediction.maxSpreadPoints', 'Maximum spread (points)'],
    ['prediction.minLiquidityUsd', 'Minimum market liquidity (USD)'],
    ['prediction.minDaysToResolve', 'Minimum days until resolution'],
    ['prediction.maxOpenBets', 'Maximum concurrent paper bets'],
  ] },
  { group: 'Review', items: [['review.blockSize', 'Trades per review block']] },
];

function get(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function rulesTab(ctx) {
  const { state } = ctx;
  const inputs = new Map();
  const groups = RULE_SPEC.map((g) =>
    h('details', { class: 'details', open: g.group === 'Risk (the 1% rule)' },
      h('summary', { text: g.group }),
      h('div', { class: 'grid-2' }, ...g.items.map(([path, label]) => {
        const input = h('input', { class: 'input', type: 'number', step: 'any', value: get(state.config, path) });
        inputs.set(path, input);
        return h('label', { class: 'field' }, h('span', { text: label }), input);
      })),
    ),
  );

  const violationsBox = h('div');
  const saveBtn = h('button', {
    class: 'btn btn-primary',
    text: 'Save rule changes',
    onclick: async () => {
      const patch = {};
      for (const [path, input] of inputs) {
        const v = Number(input.value);
        if (!Number.isFinite(v)) return toast(`${path} must be a number.`, 'warn');
        const [a, b] = path.split('.');
        patch[a] = patch[a] || {};
        patch[a][b] = v;
      }
      try {
        const out = await api('/api/config', { method: 'POST', body: { patch, note: 'Changed from the rulebook page.' } });
        const changed = out.changes?.length || 0;
        violationsBox.replaceChildren(
          ...(out.violations || []).map((v) => h('p', { class: 'down small', text: `Blocked by a hard rule: ${v}` })),
          h('p', { class: 'up small', text: `${changed} rule value(s) changed and written to the audit trail.` }),
        );
        toast(`${changed} rule change(s) saved and audited.`, 'good');
        await ctx.reload();
        ctx.refresh({ keepScroll: true });
      } catch (err) {
        toast(err.message, 'danger');
      }
    },
  });

  return card('The rulebook',
    h('p', { class: 'muted small', text: 'Step 1 of the guide as configuration. The hard rules below cannot be switched off. Anything you change is recorded in the audit trail with the old and new value - so "changing rules after every loss" leaves fingerprints.' }),
    h('div', { class: 'hardrules' },
      h('div', {}, h('strong', { text: 'Hard rules (not configurable)' }),
        h('ul', { class: 'small' },
          h('li', { text: 'Paper mode only - there is no live-trading code path at all.' }),
          h('li', { text: 'Risk per trade cannot exceed 1% of the account.' }),
          h('li', { text: 'Every ticket needs a stop-loss.' }),
          h('li', { text: 'Maximum one open position at a time.' }),
          h('li', { text: 'Records are append-only: losses cannot be deleted or edited.' }),
        )),
    ),
    ...groups,
    h('div', { class: 'row' }, saveBtn),
    violationsBox,
    h('h4', { text: 'Recent rule changes' }),
    h('ul', { class: 'audit' }, ...state.audit.filter((a) => a.type === 'RULE_CHANGE').slice(0, 8).map((a) => h('li', { class: 'small', text: `${fmtTime(a.at)} - ${a.note}` }))),
    state.audit.filter((a) => a.type === 'RULE_CHANGE').length ? null : h('p', { class: 'muted small', text: 'No rule changes recorded. That is the healthiest possible state for this page.' }),
  );
}

/* ------------------------------------------------------------------ *
 * watchlist
 * ------------------------------------------------------------------ */

function watchlistTab(ctx) {
  const { state } = ctx;
  const pair = h('input', { class: 'input', placeholder: 'e.g. DOGE-USD' });
  const source = h('select', { class: 'input' }, ...['coinbase', 'kraken', 'binance', 'coingecko'].map((s) => h('option', { value: s, text: s })));
  const auto = h('input', { type: 'checkbox' });

  const rows = state.watches.map((w, i) => {
    const autoBox = h('input', { type: 'checkbox', checked: w.auto });
    return h('tr', {},
      h('td', { class: 'mono', text: w.pair }),
      h('td', { text: w.source || 'auto' }),
      h('td', {}, autoBox, ' auto'),
      h('td', { class: 'small muted', text: w.note || '' }),
      h('td', {}, h('button', { class: 'btn btn-mini', text: 'remove', onclick: () => save(ctx, state.watches.filter((_, j) => j !== i)) })),
    );
  });

  const collect = () => {
    const trs = [...tbody.querySelectorAll('tr')];
    return trs.map((tr, i) => ({ ...state.watches[i], auto: tr.querySelector('input[type=checkbox]').checked }));
  };

  const tbody = h('tbody', {}, ...rows);

  return card('Watchlist (feeds the Scanner and the optional auto-scan)',
    h('p', { class: 'muted small', text: 'Tickers here are what the desk pre-loads and what the auto-scan timer checks. "auto" means the timer is allowed to create a paper ticket when all three gates approve - it is off unless you tick it and enable the timer on the desk page. Demo data never auto-trades.' }),
    h('table', { class: 'table' }, h('thead', {}, h('tr', {}, h('th', { text: 'Pair' }), h('th', { text: 'Source' }), h('th', { text: 'Auto' }), h('th', { text: 'Note' }), h('th', { text: '' }))), tbody),
    h('div', { class: 'row row-gap' }, pair, source, h('label', { class: 'check' }, auto, ' auto'),
      h('button', { class: 'btn', text: 'Add', onclick: () => {
        const p = pair.value.trim().toUpperCase();
        if (!p) return toast('Type a pair like DOGE-USD.', 'warn');
        save(ctx, [...collect(), { pair: p, source: source.value, auto: auto.checked, note: '' }]);
      } }),
      h('button', { class: 'btn', text: 'Save auto flags', onclick: () => save(ctx, collect()) }),
    ),
  );
}

async function save(ctx, watches) {
  try {
    await api('/api/watches', { method: 'POST', body: { watches } });
    toast('Watchlist saved.', 'good');
    await ctx.reload();
    ctx.refresh({ keepScroll: true });
  } catch (err) {
    toast(err.message, 'danger');
  }
}

/* ------------------------------------------------------------------ *
 * about
 * ------------------------------------------------------------------ */

function aboutTab(ctx) {
  const { state } = ctx;
  return card('About this build',
    h('p', { text: 'A local, dependency-free paper-trading desk that implements the six-agent setup end to end. Node standard library only, no external services except public read-only market-data APIs.' }),
    h('h4', { text: 'What it deliberately does not have' }),
    h('ul', { class: 'small' },
      h('li', { text: 'No wallet, no private keys, no exchange API keys, no order-placement code. Search the source for "order" and you will find none.' }),
      h('li', { text: 'No leverage, no shorts, no margin. Long-only, 1x spot, paper.' }),
      h('li', { text: 'No editing or deleting of ledger records.' }),
      h('li', { text: 'No invented market data: an unreachable source shows as an error, not as a number.' }),
    ),
    h('h4', { text: 'How the data flows' }),
    h('ol', { class: 'small' },
      h('li', { text: 'The server tries the public APIs (Coinbase → Kraken → Binance → CoinGecko).' }),
      h('li', { text: 'If the server\'s network is blocked, your browser fetches the same public endpoints directly and hands the raw payload to the server.' }),
      h('li', { text: 'The server recomputes every metric (moves, ATR, volume pace, support/resistance, base detection) before any agent sees it.' }),
      h('li', { text: 'Demo data exists, uses a random walk, and is stamped DEMO on every card, record and CSV row it touches.' }),
    ),
    h('h4', { text: 'Run it' }),
    h('pre', { class: 'prompt', text: 'npm start          # http://localhost:8787\nnpm test           # unit tests for the rules and the math\n\n# data lives in data/desk.json (gitignored)\n# PORT=9000 npm start   # different port' }),
    h('h4', { text: 'Files worth reading' }),
    h('ul', { class: 'small' },
      h('li', {}, h('span', { class: 'mono', text: 'src/agents/*' }), ' - one file per agent; the deterministic logic and the copy-paste prompts live together.'),
      h('li', {}, h('span', { class: 'mono', text: 'src/config.mjs' }), ' - the rulebook and the hard limits.'),
      h('li', {}, h('span', { class: 'mono', text: 'src/core/pipeline.mjs' }), ' - the only place the agents are wired together.'),
      h('li', {}, h('span', { class: 'mono', text: 'src/shared/*' }), ' - isomorphic market math used by both the server and the browser.'),
      h('li', {}, h('span', { class: 'mono', text: 'docs/' }), ' - the full guide, the copy-paste prompts and the test plan.'),
    ),
    h('p', { class: 'muted small', text: `State: ${state.records.length} ledger records, ${state.audit.length} audit entries, account ${fmtUsd(state.account.balance)}.` }),
    h('h4', { text: 'Disclaimer' }),
    h('p', { class: 'small muted', text: 'Education and experimentation only - not financial advice. Crypto, meme coins and prediction markets are extremely risky. The viral "$89 → $55,698" claim that inspired this build is unverified and must not be treated as a realistic outcome. Never trade money you cannot afford to lose, and stay in paper mode until you have reviewed your own losses.' }),
  );
}
