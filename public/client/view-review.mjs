/**
 * view-review.mjs - the review dashboard.
 *
 * This is the "do not judge it after five trades" page: the numbers the guide
 * asks for, the 20-trade review blocks, per-setup performance, a rule-following
 * audit, and an honest data-quality tally.
 */

import { h, fmtUsd, fmtNum, pill, card, fmtTime } from './util.mjs';
import { equityChart, blockChart, noteIfMissing } from './chart.mjs';

export function renderReview(ctx) {
  const { state } = ctx;
  const s = state.stats;
  const wrap = h('div', { class: 'stack' });

  wrap.append(
    card('The headline numbers',
      h('div', { class: 'tiles' },
        tile('paper balance', fmtUsd(state.account.balance), `started at ${fmtUsd(state.stats.startingBalance)}`),
        tile('total simulated P&L', `${s.realizedPnlUsd >= 0 ? '+' : ''}${fmtUsd(s.realizedPnlUsd)}`, `${fmtNum(s.realizedPnlPct, 2)}% on the starting balance`),
        tile('win rate', s.winRate === null ? '—' : `${fmtNum(s.winRate, 1)}%`, `${s.counts.wins}W / ${s.counts.losses}L / ${s.counts.breakeven}BE of ${s.counts.closedTrades} closed`),
        tile('average win', fmtUsd(s.avgWinUsd), 'per winning trade, net of simulated costs'),
        tile('average loss', fmtUsd(s.avgLossUsd), 'per losing trade'),
        tile('biggest win', fmtUsd(s.biggestWinUsd), 'best single paper trade'),
        tile('biggest loss', fmtUsd(s.biggestLossUsd), 'worst single paper trade'),
        tile('profit factor', s.profitFactor === null ? '—' : String(s.profitFactor), 'gross wins ÷ gross losses'),
        tile('expectancy', s.expectancyUsd === null ? '—' : fmtUsd(s.expectancyUsd), 'average P&L per closed trade'),
        tile('max drawdown', `${fmtNum(s.maxDrawdownPct, 2)}%`, `worst losing streak: ${s.worstLosingStreak} · best win streak: ${s.bestWinStreak}`),
        tile('blocked setups', String(s.counts.blocked), 'blocked setups are part of the record, not a failure'),
        tile('trades toward review', `${s.counts.closedTrades} / ${state.config.review.blockSize}`, 'guide: do not judge before 50–100 trades'),
      ),
      h('ul', { class: 'small' }, ...s.observations.map((o) => h('li', { text: o }))),
    ),
  );

  /* charts */
  const eqCanvas = h('canvas', { height: 200 });
  const blkCanvas = h('canvas', { height: 160 });
  const charts = card('Equity curve and blocks',
    h('p', { class: 'muted small', text: 'The equity curve only moves when trades close. If it is flat while you feel busy, nothing has actually been resolved yet.' }),
    h('div', { class: 'chart-wrap' }, eqCanvas),
    h4('Blocked setups by agent'),
    h('div', { class: 'chart-wrap chart-small' }, blkCanvas),
  );
  setTimeout(() => {
    if (noteIfMissing(eqCanvas.parentElement)) return;
    try {
      equityChart(eqCanvas, s.equityCurve);
      blockChart(blkCanvas, s.blockedByAgent);
    } catch (err) {
      console.warn(err);
    }
  });
  wrap.append(charts);

  /* blocked review */
  const br = s.blockedReview;
  wrap.append(
    card('Did the Anti-FOMO agent earn its place?',
      h('p', { class: 'muted small', text: 'Mark blocked setups in the ledger with what the price actually did. This is the only evidence that can settle the question.' }),
      br.reviewed === 0
        ? h('p', { class: 'muted', text: 'No blocked setups have been reviewed yet - so there is honestly nothing to conclude. A block that saved you and a block that cost you look identical until you check.' })
        : h('div', { class: 'tiles' },
            tile('blocks reviewed', String(br.reviewed), ''),
            tile('blocks that avoided a loss', String(br.savedFromLoss), 'price would have hit the proposed stop'),
            tile('blocks that missed a winner', String(br.missedWinners), 'price would have hit the proposed target'),
          ),
    ),
  );

  /* 20-trade reviews */
  const reviews = state.reviews;
  wrap.append(
    card(`Reviews every ${state.config.review.blockSize} trades`,
      reviews.length
        ? h('table', { class: 'table' },
            h('thead', {}, h('tr', {}, ...['Block', 'Window', 'Trades', 'W', 'L', 'Win rate', 'Avg win', 'Avg loss', 'Biggest win', 'Biggest loss', 'Total P&L', 'Blocked', 'Most common mistake'].map((t) => h('th', { text: t })))),
            h('tbody', {}, ...reviews.map((r) => h('tr', {},
              h('td', { text: `#${r.block}` }),
              h('td', { class: 'small', text: `${fmtTime(r.from)} → ${fmtTime(r.to)}` }),
              h('td', { text: r.totalTrades }),
              h('td', { text: r.wins }),
              h('td', { text: r.losses }),
              h('td', { class: 'mono', text: `${r.winRate}%` }),
              h('td', { class: 'mono', text: fmtUsd(r.avgWinUsd) }),
              h('td', { class: 'mono', text: fmtUsd(r.avgLossUsd) }),
              h('td', { class: 'mono', text: fmtUsd(r.biggestWinUsd) }),
              h('td', { class: 'mono', text: fmtUsd(r.biggestLossUsd) }),
              h('td', { class: 'mono', text: fmtUsd(r.totalPnlUsd) }),
              h('td', { text: r.blockedCount }),
              h('td', { class: 'small', text: r.mostCommonMistake }),
            ))),
          )
        : h('p', { class: 'muted', text: `Nothing to review yet: a block only unlocks once ${state.config.review.blockSize} trades have closed. Until then the numbers above are anecdotes, not evidence.` }),
    ),
  );

  /* setups */
  if (s.bySetup.length) {
    wrap.append(card('Which setups actually work',
      h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', { text: 'Setup' }), h('th', { text: 'Trades' }), h('th', { text: 'Wins' }), h('th', { text: 'P&L' }))),
        h('tbody', {}, ...s.bySetup.map((x) => h('tr', {}, h('td', { class: 'small', text: x.setup }), h('td', { text: x.trades }), h('td', { text: x.wins }), h('td', { class: x.pnl >= 0 ? 'up mono' : 'down mono', text: fmtUsd(x.pnl) })))),
      ),
    ));
  }

  /* mistakes */
  wrap.append(card('Most common mistakes',
    s.topMistakes.length
      ? h('table', { class: 'table' },
          h('thead', {}, h('tr', {}, h('th', { text: 'Mistake category' }), h('th', { text: 'Occurrences' }))),
          h('tbody', {}, ...s.topMistakes.map((m) => h('tr', {}, h('td', { class: 'small', text: m.mistake }), h('td', { text: m.count })))),
        )
      : h('p', { class: 'muted', text: 'No mistakes classified yet.' }),
  ));

  /* rule audit */
  wrap.append(
    card('Rule-following audit',
      h('p', { class: 'muted small', text: 'The checklist the whole experiment rests on: was risk ever above 1%? Was a trade held without a stop? Did two positions overlap? Were losses logged?' }),
      s.ruleViolations.length
        ? h('ul', { class: 'small' }, ...s.ruleViolations.map((v) => h('li', { class: 'down', text: v })))
        : h('p', { class: 'up', text: 'No rule violations detected in the ledger. Every trade has a stop, every risk figure is within 1%, and no positions overlapped.' }),
      h('div', { class: 'row row-gap' },
        pill(`risk per trade: ${state.config.risk.riskPctPerTrade}%`, 'good'),
        pill('one position at a time', 'good'),
        pill('stop required', 'good'),
        pill('losses retained', 'good'),
      ),
    ),
  );

  /* data quality tally */
  const tally = {};
  for (const r of state.records) {
    const q = r.dataQuality || 'unknown';
    const key = q.startsWith('DEMO') ? 'DEMO (not real data)' : q.startsWith('USER') ? 'USER-PROVIDED' : q.startsWith('LIVE') ? 'LIVE' : q;
    tally[key] = (tally[key] || 0) + 1;
  }
  wrap.append(card('How good was the data you tested on?',
    h('p', { class: 'muted small', text: 'A result built on demo or hand-typed data tests the RULES, not the market. Zero live-data trades means the performance numbers mean very little - which the app says out loud rather than hiding.' }),
    h('table', { class: 'table' }, h('thead', {}, h('tr', {}, h('th', { text: 'Data quality' }), h('th', { text: 'Records' }))),
      h('tbody', {}, ...Object.entries(tally).map(([k, v]) => h('tr', {}, h('td', {}, k.startsWith('DEMO') ? pill(k, 'danger') : k === 'LIVE' ? pill(k, 'good') : pill(k, 'warn')), h('td', { text: v }))))),
  ));

  return wrap;
}

function tile(k, v, sub) {
  return h('div', { class: 'tile' }, h('div', { class: 'tile-k', text: k }), h('div', { class: 'tile-v', text: v }), sub ? h('div', { class: 'tile-sub', text: sub }) : null);
}

const h4 = (text) => h('h4', { class: 'section-h', text });
