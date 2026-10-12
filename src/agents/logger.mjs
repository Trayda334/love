/**
 * Agent 6 - LOGGER
 *
 * The honesty layer. Records every trade AND every rejected setup. Records are
 * append-only: nothing here can rewrite an old result. Losses are kept.
 *
 * Every 20 trades it produces the review the guide asks for: win rate, average
 * win/loss, biggest win/loss, total simulated P&L, blocked count and the most
 * common mistake.
 */

import { round } from '../shared/feedcore.mjs';
import { MISTAKE_CATEGORIES, categoryForBlock } from '../shared/feedcore.mjs';

export const LOGGER_PROMPT = `You are the Logger for a six-agent PAPER trading team.

Record EVERY trade and EVERY rejected trade.

For each trade, record:
- Date and time
- Asset
- Setup
- Paper entry and exit
- Position size
- Stop and target
- Profit/loss in dollars and percent
- Scanner decision
- Sizer decision
- Anti-FOMO decision
- Why the trade was taken
- Why it was closed
- Mistakes
- What we learned

At the end of every 20 trades, calculate:
- Total trades
- Wins and losses
- Win rate
- Average win and average loss
- Biggest win and biggest loss
- Total simulated P&L
- Number of blocked trades
- Most common mistake

Never change old results to make performance look better.`;

export { MISTAKE_CATEGORIES, categoryForBlock };

let counter = 0;
function makeId(prefix, now = new Date()) {
  counter = (counter + 1) % 10000;
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `${prefix}-${stamp}-${String(counter).padStart(3, '0')}`;
}

/* ------------------------------------------------------------------ *
 * record builders
 * ------------------------------------------------------------------ */

export function createTradeRecord({ scanner, sizer, antiFomo, buyer, plan, snapshot, config, account = null, now = new Date() }) {
  const ticket = buyer.ticket;
  const record = {
    kind: 'trade',
    id: ticket.id,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    token: ticket.token,
    pair: ticket.pair,
    status: 'OPEN',
    dataSource: ticket.dataSourceAtEntry,
    dataQuality: snapshot.dataQuality,
    setup: plan.setup,
    setupQuality: plan.setupQuality,
    entry: {
      at: ticket.timeEntered,
      price: ticket.simulatedEntry,
      units: ticket.simulatedPositionSizeUnits,
      notionalUsd: ticket.simulatedPositionNotionalUsd,
      entryArea: ticket.entryArea,
    },
    stopLoss: ticket.stopLoss,
    target: ticket.target,
    maxDollarRisk: ticket.maxDollarRisk,
    maxDollarRiskPlanned: ticket.maxDollarRiskPlanned ?? sizer.actualRiskUsd,
    maxDollarRiskGross: ticket.maxDollarRiskGross ?? null,
    estExitCostsUsd: ticket.estExitCostsUsd ?? null,
    riskPctAtEntry: sizer.riskPct,
    // reporting only: what the fill-based worst case actually was as a share of the account
    riskPctAtFill: Number.isFinite(account?.balance) && account.balance > 0 && Number.isFinite(ticket.maxDollarRisk)
      ? Math.round((ticket.maxDollarRisk / account.balance) * 10000) / 100
      : null,
    stopDistancePct: sizer.stopDistancePct,
    fillStopDistancePct: ticket.fillStopDistancePct ?? null,
    rewardRisk: sizer.rewardRisk,
    decisions: {
      scanner: scanner.verdict,
      sizer: sizer.verdict,
      antiFomo: antiFomo.verdict,
      buyer: 'TICKET',
    },
    whyTaken: [
      `Scanner: ${scanner.summary}`,
      ...(scanner.whyItMayBeInteresting || []),
      `Sizer: ${sizer.summary}`,
      `Anti-FOMO: ${antiFomo.explanation}`,
    ].filter(Boolean),
    writtenReason: plan.reason || '',
    exit: null,
    pnl: null,
    mistakes: [],
    learned: '',
    reviewOutcome: null,
  };
  return record;
}

export function createBlockedRecord({ scanner, sizer, antiFomo, buyer, plan, snapshot, stage, now = new Date() }) {
  const s = scanner?.verdict;
  const z = sizer?.verdict;
  const af = antiFomo?.verdict;
  const b = buyer?.verdict;
  const reasonParts = [];
  if (s === 'SKIP') reasonParts.push(`Scanner SKIP: ${scanner.summary}`);
  if (z === 'REJECT') reasonParts.push(`Sizer REJECT: ${sizer.summary}`);
  if (af === 'BLOCK') reasonParts.push(`Anti-FOMO BLOCK: ${antiFomo.explanation}`);
  if (b === 'BLOCKED') reasonParts.push(`Buyer blocked: ${(buyer.blockers || []).join(' ')}`);

  const record = {
    kind: 'blocked',
    id: makeId('BLK', now),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    token: snapshot?.token || plan?.token || 'UNKNOWN',
    pair: snapshot?.pair || null,
    status: 'BLOCKED',
    stage: stage || 'unknown',
    price: snapshot?.metrics?.price ?? null,
    dataSource: snapshot ? `${snapshot.sourceLabel} (${snapshot.dataQuality})` : null,
    dataQuality: snapshot?.dataQuality || null,
    setup: plan?.setup || null,
    proposedPlan: plan
      ? { entryArea: plan.entryArea, stop: plan.stop, target: plan.target1, stopDistancePct: plan.stopDistancePct, rewardRisk: plan.rewardRisk }
      : null,
    decisions: {
      scanner: s || 'MISSING',
      sizer: z || 'NOT_RUN',
      antiFomo: af || 'NOT_RUN',
      buyer: b || 'NOT_RUN',
    },
    reasons: reasonParts,
    category: categoryForBlock({ scanner, antiFomo, sizer, buyer }),
    signalsAtBlock: snapshot?.metrics
      ? {
          r5: snapshot.metrics.r5,
          r15: snapshot.metrics.r15,
          r60: snapshot.metrics.r60,
          atrPct: snapshot.metrics.atrPct,
          volumeRatio: snapshot.metrics.volumeRatio,
          distToSupportPct: snapshot.metrics.distToSupportPct,
          extended: snapshot.metrics.extended,
        }
      : null,
    reviewOutcome: null, // 'would have lost' | 'would have won' | 'unknown' - filled in later, never deleted
  };
  return record;
}

export function createPredictionRecord({ market, result, account, evidence = '', now = new Date() }) {
  const isBet = result.verdict === 'BET';
  return {
    kind: 'prediction',
    id: makeId(isBet ? 'PB' : 'PBS', now),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: isBet ? 'OPEN_BET' : 'SKIPPED',
    marketId: market?.id || null,
    question: market?.question || '(unknown market)',
    url: market?.url || null,
    endDate: market?.endDate || null,
    impliedProbabilityPct: result.market?.currentImpliedProbability ?? null,
    ourRange: result.estimatedRange,
    edgePoints: result.edgePoints,
    side: isBet ? result.suggestedSide : null,
    entryPricePct: isBet ? result.suggestedPricePct : null,
    maxRiskUsd: isBet ? result.maxPaperRiskUsd : 0,
    confidence: result.confidence,
    checklist: result.checklist,
    evidence,
    resolution: null,
    pnlUsd: null,
    accountEquityAtCreation: account?.equity ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * closing + resolution
 * ------------------------------------------------------------------ */

export function closeTradeRecord(record, { exitPrice, closeReason, closedAt = new Date(), mistakes, learned, config }) {
  if (record.kind !== 'trade') throw new Error('Only trade records can be closed.');
  if (record.status !== 'OPEN') throw new Error(`Record ${record.id} is ${record.status}, not OPEN. Old results are never rewritten.`);
  const exit = Number(exitPrice);
  if (!Number.isFinite(exit) || exit <= 0) throw new Error('A positive exit price is required.');

  const units = record.entry.units;
  const notional = record.entry.notionalUsd;
  const gross = (exit - record.entry.price) * units;
  const bps = Number(config?.fees?.takerBps || 0) * 2 + Number(config?.fees?.slippageBps || 0) * 2;
  const fees = config?.fees?.includeInPaperPnl === false ? 0 : (notional + exit * units) * (bps / 20000);
  const pnl = gross - fees;
  const pnlPct = notional ? (pnl / notional) * 100 : null;

  const hitStop = Number.isFinite(record.stopLoss) && exit <= record.stopLoss;
  const hitTarget = Number.isFinite(record.target) && exit >= record.target;
  const rMultiple = Number.isFinite(record.stopDistancePct) && record.entry.price
    ? (exit - record.entry.price) / ((record.stopDistancePct / 100) * record.entry.price)
    : null;

  const autoMistakes = [];
  if (pnl < 0 && record.decisions.antiFomo === 'APPROVE' && record.setupQuality === 'weak') {
    autoMistakes.push('Chased an extended move (Anti-FOMO)');
  }
  if (closeReason && /manual|discretion|feel|panic|scared/i.test(closeReason)) autoMistakes.push('Manual close judgement call');
  if (closeReason && /early|too soon/i.test(closeReason)) autoMistakes.push('Exited early');
  if (closeReason && /held|too long|waited|didn't sell|did not sell/i.test(closeReason)) autoMistakes.push('Held too long');

  const chosen = Array.isArray(mistakes) && mistakes.length ? mistakes : autoMistakes.length ? autoMistakes : ['None / unknown'];

  return {
    ...record,
    status: hitTarget ? 'CLOSED_TARGET' : hitStop ? 'CLOSED_STOP' : 'CLOSED_MANUAL',
    updatedAt: closedAt.toISOString(),
    exit: {
      at: closedAt.toISOString(),
      price: exit,
      reason: closeReason || (hitTarget ? 'Target reached' : hitStop ? 'Stop loss hit' : 'Manual close'),
      hitStop,
      hitTarget,
    },
    pnl: {
      grossUsd: round(gross, 4),
      feesUsd: round(fees, 4),
      netUsd: round(pnl, 4),
      netPct: round(pnlPct, 4),
      rMultiple: round(rMultiple, 3),
      result: pnl > 0.005 ? 'WIN' : pnl < -0.005 ? 'LOSS' : 'BREAKEVEN',
    },
    mistakes: chosen,
    learned: learned || '',
  };
}

export function resolvePrediction(record, { outcome, resolvedAt = new Date() }) {
  if (record.kind !== 'prediction') throw new Error('Not a prediction record.');
  if (record.status !== 'OPEN_BET') throw new Error(`Record ${record.id} is ${record.status}, not an open paper bet.`);
  const won = String(outcome).toUpperCase() === 'YES';
  const side = record.side;
  const resolvedYes = String(resolvedAt?.outcome ?? '').toUpperCase() === 'YES';
  const win = (side === 'YES' && won) || (side === 'NO' && !won);
  const paid = win ? record.maxRiskUsd * ((1 - (record.entryPricePct ?? 50) / 100) / ((record.entryPricePct ?? 50) / 100)) : -record.maxRiskUsd;
  return {
    ...record,
    status: 'RESOLVED',
    updatedAt: resolvedAt.toISOString(),
    resolution: { outcome: win ? 'WIN' : 'LOSS', marketResolvedTo: String(outcome).toUpperCase(), at: resolvedAt.toISOString(), resolvedYes },
    pnlUsd: round(paid, 2),
  };
}

/* ------------------------------------------------------------------ *
 * statistics + reviews
 * ------------------------------------------------------------------ */

export function computeStats(records, config, { startingBalance = 1000 } = {}) {
  const trades = records.filter((r) => r.kind === 'trade');
  const closed = trades.filter((r) => r.status !== 'OPEN');
  const open = trades.filter((r) => r.status === 'OPEN');
  const blocked = records.filter((r) => r.kind === 'blocked');
  const preds = records.filter((r) => r.kind === 'prediction');
  const predsResolved = preds.filter((r) => r.status === 'RESOLVED' && Number.isFinite(r.pnlUsd));

  const wins = closed.filter((t) => t.pnl?.result === 'WIN');
  const losses = closed.filter((t) => t.pnl?.result === 'LOSS');
  const be = closed.filter((t) => t.pnl?.result === 'BREAKEVEN');
  const sum = (arr, f) => arr.reduce((a, b) => a + (Number(f(b)) || 0), 0);

  const closedPnl = sum(closed, (t) => t.pnl.netUsd);
  const predPnl = sum(predsResolved, (p) => p.pnlUsd);
  const realized = closedPnl + predPnl;

  const winsUsd = wins.map((t) => t.pnl.netUsd);
  const lossesUsd = losses.map((t) => t.pnl.netUsd);
  const grossWin = sum(wins, (t) => t.pnl.netUsd);
  const grossLoss = Math.abs(sum(losses, (t) => t.pnl.netUsd));

  const winRate = closed.length ? (wins.length / closed.length) * 100 : null;
  const avgWin = winsUsd.length ? grossWin / winsUsd.length : null;
  const avgLoss = lossesUsd.length ? -grossLoss / lossesUsd.length : null;
  const biggestWin = winsUsd.length ? Math.max(...winsUsd) : null;
  const biggestLoss = lossesUsd.length ? Math.min(...lossesUsd) : null;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null;
  const expectancy = closed.length ? closedPnl / closed.length : null;

  /* equity curve from closed trades in chronological order */
  let equity = startingBalance;
  const curve = [{ at: null, equity: round(startingBalance, 2), label: 'start' }];
  let peak = startingBalance;
  let maxDrawdown = 0;
  let streak = 0;
  let worstLosingStreak = 0;
  let bestWinStreak = 0;
  let winStreak = 0;
  for (const t of [...closed].sort((a, b) => new Date(a.exit?.at || a.updatedAt) - new Date(b.exit?.at || b.updatedAt))) {
    equity += t.pnl.netUsd;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, ((peak - equity) / peak) * 100);
    streak = t.pnl.result === 'LOSS' ? streak - 1 : 0;
    worstLosingStreak = Math.min(worstLosingStreak, streak);
    winStreak = t.pnl.result === 'WIN' ? winStreak + 1 : 0;
    bestWinStreak = Math.max(bestWinStreak, winStreak);
    curve.push({ at: t.exit?.at || t.updatedAt, equity: round(equity, 2), id: t.id, result: t.pnl.result });
  }

  /* mistakes */
  const mistakeCounts = {};
  for (const t of closed) for (const m of t.mistakes || []) mistakeCounts[m] = (mistakeCounts[m] || 0) + 1;
  for (const b of blocked) mistakeCounts[b.category] = (mistakeCounts[b.category] || 0) + 1;
  const topMistakes = Object.entries(mistakeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([mistake, count]) => ({ mistake, count }));

  /* blocked analysis */
  const blockedByAgent = {};
  for (const b of blocked) {
    for (const [agent, verdict] of Object.entries(b.decisions || {})) {
      if (verdict === 'SKIP' || verdict === 'REJECT' || verdict === 'BLOCK' || verdict === 'BLOCKED') {
        blockedByAgent[agent] = (blockedByAgent[agent] || 0) + 1;
      }
    }
  }
  const reviewedBlocks = blocked.filter((b) => b.reviewOutcome);
  const blockSaved = reviewedBlocks.filter((b) => b.reviewOutcome === 'would have lost').length;
  const blockCost = reviewedBlocks.filter((b) => b.reviewOutcome === 'would have won').length;

  /* per-setup performance */
  const bySetup = {};
  for (const t of closed) {
    const key = t.setup || 'unknown';
    bySetup[key] = bySetup[key] || { setup: key, trades: 0, wins: 0, pnl: 0 };
    bySetup[key].trades++;
    if (t.pnl.result === 'WIN') bySetup[key].wins++;
    bySetup[key].pnl = round(bySetup[key].pnl + t.pnl.netUsd, 2);
  }

  /* rule-following audit */
  const ruleViolations = [];
  for (const t of closed) {
    if (Number.isFinite(t.riskPctAtEntry) && t.riskPctAtEntry > 1.0001) ruleViolations.push(`${t.id}: risk was ${t.riskPctAtEntry}% (>1%).`);
    if (Number.isFinite(t.pnl.netPct) && t.pnl.netPct < -1.6) ruleViolations.push(`${t.id}: lost ${round(t.pnl.netPct, 2)}% - more than the 1% rule should ever allow.`);
    if (!t.stopLoss) ruleViolations.push(`${t.id}: entered without a stop-loss.`);
    if (!t.exit?.reason) ruleViolations.push(`${t.id}: closed without a recorded reason.`);
  }
  const overlap = detectOverlap(closed);
  if (overlap) ruleViolations.push(overlap);

  const openMarkToMarket = open.length ? null : 0; // marked separately by the store when prices are known

  return {
    startingBalance: round(startingBalance, 2),
    currentBalance: round(startingBalance + realized, 2),
    realizedPnlUsd: round(realized, 2),
    realizedPnlPct: round(((startingBalance + realized - startingBalance) / startingBalance) * 100, 3),
    openMarkToMarket,
    counts: {
      totalTrades: trades.length,
      closedTrades: closed.length,
      openTrades: open.length,
      wins: wins.length,
      losses: losses.length,
      breakeven: be.length,
      blocked: blocked.length,
      predictions: preds.length,
      predictionsResolved: predsResolved.length,
    },
    winRate: winRate === null ? null : round(winRate, 1),
    avgWinUsd: avgWin === null ? null : round(avgWin, 2),
    avgLossUsd: avgLoss === null ? null : round(avgLoss, 2),
    biggestWinUsd: biggestWin === null ? null : round(biggestWin, 2),
    biggestLossUsd: biggestLoss === null ? null : round(biggestLoss, 2),
    grossWinUsd: round(grossWin, 2),
    grossLossUsd: round(grossLoss, 2),
    profitFactor: profitFactor === null ? null : Number.isFinite(profitFactor) ? round(profitFactor, 2) : 'inf',
    expectancyUsd: expectancy === null ? null : round(expectancy, 2),
    maxDrawdownPct: round(maxDrawdown, 2),
    worstLosingStreak,
    bestWinStreak,
    equityCurve: curve,
    topMistakes,
    mostCommonMistake: topMistakes[0]?.mistake || null,
    blockedByAgent,
    blockedReview: { reviewed: reviewedBlocks.length, savedFromLoss: blockSaved, missedWinners: blockCost },
    bySetup: Object.values(bySetup),
    ruleViolations,
    observations: buildObservations({ closed, wins, losses, winRate, avgWin, avgLoss, profitFactor, closedPnl, tradeCount: trades.length, blockedCount: blocked.length, config }),
  };
}

function detectOverlap(closed) {
  const sorted = [...closed].filter((t) => t.entry?.at && t.exit?.at).sort((a, b) => new Date(a.entry.at) - new Date(b.entry.at));
  for (let i = 1; i < sorted.length; i++) {
    if (new Date(sorted[i].entry.at) < new Date(sorted[i - 1].exit.at)) {
      return `${sorted[i].id} was opened while ${sorted[i - 1].id} was still open - the one-position rule was broken.`;
    }
  }
  return null;
}

function buildObservations({ closed, wins, losses, tradeCount, blockedCount, config }) {
  const out = [];
  const blockSize = config.review.blockSize || 20;
  if (tradeCount < blockSize) {
    out.push(`${tradeCount} of the first ${blockSize} logged trades are in. The guide says do not judge the system yet - keep collecting.`);
  } else {
    out.push(`${tradeCount} trades logged - that clears one full ${blockSize}-trade review block.`);
  }
  if (!closed.length) {
    out.push('No closed trades yet, so there is nothing honest to say about performance.');
    return out;
  }
  const winRate = (wins.length / closed.length) * 100;
  const avgWin = wins.length ? wins.reduce((a, t) => a + t.pnl.netUsd, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((a, t) => a + t.pnl.netUsd, 0) / losses.length) : 0;
  if (avgLoss > 0) {
    out.push(avgWin > avgLoss
      ? `Average win ($${round(avgWin, 2)}) is larger than average loss ($${round(avgLoss, 2)}) - the payoff shape is working.`
      : `Average loss ($${round(avgLoss, 2)}) is larger than average win ($${round(avgWin, 2)}) - that shape needs a high win rate to survive.`);
  }
  if (winRate < 35) out.push(`Win rate is ${round(winRate, 1)}% - low win rates are survivable only with real reward/risk discipline.`);
  if (wins.length && losses.length === 0) out.push('No losses recorded yet. That is suspicious rather than impressive - check that losing trades are being closed and logged.');
  out.push(`${blockedCount} setup(s) were blocked. Blocked setups are the evidence for whether the Anti-FOMO agent earns its place.`);
  return out;
}

export function reviewBlocks(records, config) {
  const size = config.review.blockSize || 20;
  const closed = records.filter((r) => r.kind === 'trade' && r.status !== 'OPEN')
    .sort((a, b) => new Date(a.exit?.at || a.updatedAt) - new Date(b.exit?.at || b.updatedAt));
  const blocks = [];
  for (let i = 0; i < closed.length; i += size) {
    const slice = closed.slice(i, i + size);
    if (slice.length < size) break;
    const wins = slice.filter((t) => t.pnl.result === 'WIN');
    const losses = slice.filter((t) => t.pnl.result === 'LOSS');
    const pnl = slice.reduce((a, t) => a + t.pnl.netUsd, 0);
    const mistakes = {};
    for (const t of slice) for (const m of t.mistakes || []) mistakes[m] = (mistakes[m] || 0) + 1;
    const blockedInWindow = records.filter((r) => r.kind === 'blocked' && new Date(r.createdAt) >= new Date(slice[0].createdAt) && new Date(r.createdAt) <= new Date(slice[slice.length - 1].exit?.at || slice[slice.length - 1].updatedAt));
    blocks.push({
      block: blocks.length + 1,
      from: slice[0].createdAt,
      to: slice[slice.length - 1].exit?.at || slice[slice.length - 1].updatedAt,
      totalTrades: slice.length,
      wins: wins.length,
      losses: losses.length,
      winRate: round((wins.length / slice.length) * 100, 1),
      avgWinUsd: wins.length ? round(wins.reduce((a, t) => a + t.pnl.netUsd, 0) / wins.length, 2) : null,
      avgLossUsd: losses.length ? round(Math.abs(losses.reduce((a, t) => a + t.pnl.netUsd, 0) / losses.length), 2) : null,
      biggestWinUsd: wins.length ? round(Math.max(...wins.map((t) => t.pnl.netUsd)), 2) : null,
      biggestLossUsd: losses.length ? round(Math.min(...losses.map((t) => t.pnl.netUsd)), 2) : null,
      totalPnlUsd: round(pnl, 2),
      blockedCount: blockedInWindow.length,
      mostCommonMistake: Object.entries(mistakes).sort((a, b) => b[1] - a[1])[0]?.[0] || 'None / unknown',
    });
  }
  return blocks;
}

export const loggerApi = {
  createTradeRecord,
  createBlockedRecord,
  createPredictionRecord,
  closeTradeRecord,
  resolvePrediction,
  computeStats,
  reviewBlocks,
};
