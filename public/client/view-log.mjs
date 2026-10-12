/**
 * view-log.mjs - the ledger. Every trade AND every rejected setup.
 * Nothing here can be edited or deleted: that is the point of the Logger agent.
 */

import { h, api, toast, fmtUsd, fmtNum, fmtPrice, fmtTime, pill, verdictPill, card, modal, confirmDialog } from './util.mjs';

export function renderLog(ctx) {
  const { app } = ctx;
  const tab = app.logTab || 'trades';
  const wrap = h('div', { class: 'stack' });
  wrap.append(
    h('div', { class: 'tabs' },
      tabBtn('trades', 'Paper trades', ctx),
      tabBtn('blocked', 'Blocked setups', ctx),
      tabBtn('predictions', 'Prediction-market paper bets', ctx),
      tabBtn('audit', 'Audit trail', ctx),
    ),
  );
  if (tab === 'trades') wrap.append(tradesTab(ctx));
  else if (tab === 'blocked') wrap.append(blockedTab(ctx));
  else if (tab === 'predictions') wrap.append(predictionsTab(ctx));
  else wrap.append(auditTab(ctx));
  return wrap;
}

function tabBtn(id, label, ctx) {
  const active = (ctx.app.logTab || 'trades') === id;
  return h('button', { class: `tab ${active ? 'tab-active' : ''}`, text: label, onclick: () => { ctx.app.logTab = id; ctx.refresh({ keepScroll: true }); } });
}

function exportRow(kind = 'trade') {
  return h('a', { class: 'btn', href: `/api/export?kind=${kind}`, text: `Download ${kind === 'trade' ? 'trades' : 'blocked setups'} CSV` });
}

function tradesTab(ctx) {
  const { state } = ctx;
  const trades = state.records.filter((r) => r.kind === 'trade');
  if (!trades.length) {
    return card('Paper trades', h('p', { class: 'muted', text: 'No paper trades yet. Run the pipeline on the desk when you have fresh data.' }));
  }
  return card('Paper trades - append-only',
    h('p', { class: 'muted small', text: `Columns match guide Step 9, plus the Logger fields. ${state.stats.counts.closedTrades} closed, ${state.stats.counts.openTrades} open. Nothing on this page can be edited - only closed.` }),
    h('div', { class: 'row row-gap' }, exportRow('trade')),
    h('table', { class: 'table table-tight' },
      h('thead', {}, h('tr', {},
        h('th', { text: 'Trade ID' }), h('th', { text: 'Date / time' }), h('th', { text: 'Asset' }), h('th', { text: 'Setup' }), h('th', { text: 'Entry' }), h('th', { text: 'Exit' }),
        h('th', { text: 'Stop' }), h('th', { text: 'Size' }), h('th', { text: 'P&L' }), h('th', { text: 'Result' }), h('th', { text: 'Scanner' }), h('th', { text: 'Sizer' }), h('th', { text: 'FOMO' }), h('th', { text: '' }),
      )),
      h('tbody', {}, ...trades.map((t) => h('tr', { class: t.status === 'OPEN' ? 'row-open' : t.pnl?.result === 'LOSS' ? 'row-bad' : t.pnl?.result === 'WIN' ? 'row-good' : '' },
        h('td', { class: 'mono small', text: t.id }),
        h('td', { class: 'small', text: fmtTime(t.createdAt) }),
        h('td', {}, h('strong', { text: t.token }), t.executionMode === 'auto' ? pill('auto', 'warn') : null),
        h('td', { class: 'small', text: t.setup }),
        h('td', { class: 'mono', text: fmtPrice(t.entry?.price) }),
        h('td', { class: 'mono', text: t.exit ? fmtPrice(t.exit.price) : '—' }),
        h('td', { class: 'mono', text: fmtPrice(t.stopLoss) }),
        h('td', { class: 'mono small', text: `${t.entry?.units} u / ${fmtUsd(t.entry?.notionalUsd)}` }),
        h('td', { class: t.pnl ? (t.pnl.netUsd >= 0 ? 'up mono' : 'down mono') : 'mono', text: t.pnl ? `${t.pnl.netUsd >= 0 ? '+' : ''}${fmtUsd(t.pnl.netUsd)}` : '—' }),
        h('td', {}, t.status === 'OPEN' ? pill('OPEN', 'accent') : verdictPill(t.pnl?.result)),
        h('td', {}, verdictPill(t.decisions?.scanner)),
        h('td', {}, verdictPill(t.decisions?.sizer)),
        h('td', {}, verdictPill(t.decisions?.antiFomo)),
        h('td', {}, h('button', { class: 'btn btn-mini', text: 'detail', onclick: () => tradeDetail(ctx, t) })),
      ))),
    ),
  );
}

function tradeDetail(ctx, t) {
  modal(`${t.id} · ${t.token}`, h('div', { class: 'stack' },
    h('div', { class: 'metrics-grid' },
      kvMini('setup', t.setup),
      kvMini('data source', t.dataSource),
      kvMini('entry', fmtPrice(t.entry?.price)),
      kvMini('exit', t.exit ? fmtPrice(t.exit.price) : 'still open'),
      kvMini('stop', fmtPrice(t.stopLoss)),
      kvMini('target', fmtPrice(t.target)),
      kvMini('risk budget at entry', `${fmtNum(t.riskPctAtEntry, 2)}% of account`),
      kvMini('worst case from the fill', `${fmtUsd(t.maxDollarRisk)} (${fmtNum(t.riskPctAtFill, 2)}% of the account)`),
      kvMini('Sizer planned', fmtUsd(t.maxDollarRiskPlanned)),
      kvMini('stop distance', `${fmtNum(t.stopDistancePct, 2)}%`),
      kvMini('reward/risk', `${fmtNum(t.rewardRisk, 2)}R`),
      kvMini('P&L', t.pnl ? `${fmtUsd(t.pnl.netUsd)} (${fmtNum(t.pnl.netPct, 2)}%, ${fmtNum(t.pnl.rMultiple, 2)}R)` : 'open'),
      kvMini('exit reason', t.exit?.reason || '—'),
      kvMini('execution', t.executionMode || 'guided'),
    ),
    h('h4', { text: 'Why the trade was taken' }),
    h('ul', { class: 'small' }, ...(t.whyTaken || []).map((w) => h('li', { text: w }))),
    t.writtenReason ? h('p', { class: 'small' }, h('strong', { text: 'Written reason: ' }), t.writtenReason) : null,
    h('h4', { text: 'Mistakes tagged' }),
    h('p', { class: 'small', text: (t.mistakes || []).join(', ') || 'none' }),
    t.learned ? h('p', { class: 'small' }, h('strong', { text: 'What we learned: ' }), t.learned) : null,
    h('p', { class: 'muted small', text: 'This record is immutable apart from being closed. The audit trail shows every change.' }),
  ));
}

const kvMini = (k, v) => h('div', { class: 'kv' }, h('span', { class: 'kv-k', text: k }), h('span', { class: 'kv-v', text: String(v ?? '—') }));

function blockedTab(ctx) {
  const { state } = ctx;
  const blocked = state.records.filter((r) => r.kind === 'blocked');
  if (!blocked.length) {
    return card('Blocked setups', h('p', { class: 'muted', text: 'Nothing has been blocked yet. When an agent says no, the setup lands here with its reason and the mistake category it belongs to.' }));
  }
  const outcomeSelect = (b) =>
    h('select', { class: 'input input-mini', onchange: async (e) => {
      try {
        await api('/api/blocked-review', { method: 'POST', body: { recordId: b.id, reviewOutcome: e.target.value } });
        toast(`Reviewed ${b.id}: ${e.target.value}.`, 'good');
        await ctx.reload();
        ctx.refresh({ keepScroll: true });
      } catch (err) { toast(err.message, 'danger'); }
    } },
      h('option', { value: '', text: 'not reviewed', selected: !b.reviewOutcome }),
      h('option', { value: 'would have lost', text: 'would have lost (block saved us)', selected: b.reviewOutcome === 'would have lost' }),
      h('option', { value: 'would have won', text: 'would have won (we missed one)', selected: b.reviewOutcome === 'would have won' }),
      h('option', { value: 'unknown', text: 'unknown', selected: b.reviewOutcome === 'unknown' }),
    );

  return card('Blocked setups - the honest half of the record',
    h('p', { class: 'muted small', text: `Blocks by agent: ${Object.entries(state.stats.blockedByAgent).map(([a, n]) => `${a}: ${n}`).join(' · ') || 'none yet'}. Later, come back and mark what the price actually did - that is the only way to know whether a block was correct.` }),
    h('div', { class: 'row row-gap' }, exportRow('blocked')),
    h('table', { class: 'table table-tight' },
      h('thead', {}, h('tr', {},
        h('th', { text: 'Block ID' }), h('th', { text: 'Date' }), h('th', { text: 'Asset' }), h('th', { text: 'Stage' }), h('th', { text: 'Price then' }), h('th', { text: 'Category' }), h('th', { text: 'Reasons' }), h('th', { text: 'Decisions' }), h('th', { text: 'What happened next' }),
      )),
      h('tbody', {}, ...blocked.map((b) => h('tr', {},
        h('td', { class: 'mono small', text: b.id }),
        h('td', { class: 'small', text: fmtTime(b.createdAt) }),
        h('td', {}, h('strong', { text: b.token })),
        h('td', {}, pill(b.stage, 'neutral')),
        h('td', { class: 'mono', text: b.price === null ? '—' : fmtPrice(b.price) }),
        h('td', { class: 'small', text: b.category }),
        h('td', { class: 'small', text: (b.reasons || []).join(' ') }),
        h('td', { class: 'small mono', text: Object.entries(b.decisions || {}).map(([k, v]) => `${k}:${v}`).join(' ') }),
        h('td', {}, outcomeSelect(b)),
      ))),
    ),
    h('p', { class: 'muted small', text: 'Tip: re-open the same token on the desk a day later. If the price is below where the proposed stop was, it would have lost - mark it. Be just as willing to mark "would have won".' }),
  );
}

function predictionsTab(ctx) {
  const { state } = ctx;
  const preds = state.records.filter((r) => r.kind === 'prediction');
  if (!preds.length) {
    return card('Prediction-market paper bets', h('p', { class: 'muted', text: 'Nothing logged yet. Head to the Prediction markets tab to research a market with Agent 4.' }));
  }
  return card('Prediction-market paper bets and skips',
    h('p', { class: 'muted small', text: 'Kept on a separate ledger from the coin book, with their own 1% risk cap. Skips are logged too.' }),
    h('table', { class: 'table table-tight' },
      h('thead', {}, h('tr', {}, h('th', { text: 'Date' }), h('th', { text: 'Market' }), h('th', { text: 'Implied' }), h('th', { text: 'Our range' }), h('th', { text: 'Edge' }), h('th', { text: 'Bet' }), h('th', { text: 'Risk' }), h('th', { text: 'Confidence' }), h('th', { text: 'Status' }), h('th', { text: 'P&L' }), h('th', { text: '' }))),
      h('tbody', {}, ...preds.map((p) => h('tr', { class: p.pnlUsd > 0 ? 'row-good' : p.pnlUsd < 0 ? 'row-bad' : '' },
        h('td', { class: 'small', text: fmtTime(p.createdAt) }),
        h('td', { class: 'small' }, p.url ? h('a', { href: p.url, target: '_blank', rel: 'noreferrer', text: p.question }) : p.question),
        h('td', { class: 'mono', text: p.impliedProbabilityPct === null ? '—' : `${p.impliedProbabilityPct}%` }),
        h('td', { class: 'mono small', text: p.ourRange ? `${p.ourRange.lowPct}–${p.ourRange.highPct}%` : '—' }),
        h('td', { class: 'mono', text: p.edgePoints === null ? '—' : `${p.edgePoints} pts` }),
        h('td', { text: p.side || 'SKIP' }),
        h('td', { class: 'mono', text: p.maxRiskUsd ? fmtUsd(p.maxRiskUsd) : '—' }),
        h('td', { text: p.confidence }),
        h('td', {}, pill(p.status, p.status === 'OPEN_BET' ? 'accent' : p.status === 'RESOLVED' ? 'neutral' : 'warn')),
        h('td', { class: 'mono', text: p.pnlUsd === null ? '—' : fmtUsd(p.pnlUsd) }),
        h('td', {}, p.status === 'OPEN_BET' ? h('button', { class: 'btn btn-mini', text: 'resolve', onclick: () => resolveDialog(ctx, p) }) : null),
      ))),
    ),
  );
}

function resolveDialog(ctx, p) {
  modal(`Resolve ${p.id}`, h('div', {},
    h('p', { class: 'small', text: `Paper bet ${p.side} at ${p.entryPricePct}% implied, risking ${fmtUsd(p.maxRiskUsd)}. What did the market resolve to?` }),
    h('div', { class: 'row' },
      h('button', { class: 'btn btn-good', text: 'Resolved YES', onclick: () => doResolve('YES') }),
      h('button', { class: 'btn btn-danger', text: 'Resolved NO', onclick: () => doResolve('NO') }),
    ),
  ));
  async function doResolve(outcome) {
    try {
      const out = await api('/api/predictions/resolve', { method: 'POST', body: { recordId: p.id, outcome } });
      toast(`${p.id} resolved: ${out.record.resolution.outcome} (${fmtUsd(out.record.pnlUsd)}).`, 'info');
      await ctx.reload();
      ctx.refresh({ keepScroll: true });
    } catch (err) {
      toast(err.message, 'danger');
    }
  }
}

function auditTab(ctx) {
  const { state } = ctx;
  return card('Audit trail',
    h('p', { class: 'muted small', text: 'Every rule change, ticket, close and review outcome is written here with a timestamp. This is what makes "never change old results" checkable rather than a promise.' }),
    h('ul', { class: 'audit' }, ...state.audit.map((a) => h('li', {}, h('span', { class: 'mono small muted', text: fmtTime(a.at) }), ' ', pill(a.type, a.type === 'RULE_CHANGE' ? 'warn' : 'neutral'), ' ', h('span', { class: 'small', text: a.note })))),
    h('div', { class: 'row row-gap' },
      h('a', { class: 'btn', href: '/api/export?kind=trade', text: 'Export trades CSV' }),
      h('a', { class: 'btn', href: '/api/export?kind=blocked', text: 'Export blocks CSV' }),
      h('button', { class: 'btn btn-danger', text: 'Reset the desk (keeps a backup file)', onclick: async () => {
        const ok = await confirmDialog('Reset the paper desk?', 'This clears the ledger and starts fresh. A timestamped backup of data/desk.json is written first. Your rule settings are kept.', 'Reset');
        if (!ok) return;
        try {
          const out = await api('/api/reset', { method: 'POST', body: { confirm: 'RESET PAPER DESK', keepConfig: true } });
          toast(`Desk reset. Backup: ${out.backup}`, 'good');
          await ctx.reload();
          ctx.app.snapshot = null; ctx.app.pipeline = null; ctx.app.plan = null;
          ctx.refresh({ keepScroll: false });
        } catch (err) { toast(err.message, 'danger'); }
      } }),
    ),
  );
}
