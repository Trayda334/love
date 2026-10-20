import test from 'node:test';
import assert from 'node:assert/strict';

import { scannerAgent, derivePlan } from '../src/agents/scanner.mjs';
import { sizerAgent } from '../src/agents/sizer.mjs';
import { buyerAgent } from '../src/agents/buyer.mjs';
import { antiFomoAgent } from '../src/agents/antiFomo.mjs';
import { predictionAgent } from '../src/agents/prediction.mjs';
import { computeStats, reviewBlocks, closeTradeRecord, createTradeRecord } from '../src/agents/logger.mjs';
import { DEFAULT_CONFIG, validateConfigPatch } from '../src/config.mjs';
import { demoSnapshot } from '../src/feeds/index.mjs';

const cfg = () => JSON.parse(JSON.stringify(DEFAULT_CONFIG));
const account = (balance = 1000) => ({ balance, equity: balance, currency: 'USD' });

function snap(scenario, token = 'DEMO') {
  return demoSnapshot({ scenario, token }).snapshot;
}

/* ------------------------------------------------------------------ *
 * hard rules
 * ------------------------------------------------------------------ */

test('the 1% ceiling cannot be raised, only lowered', () => {
  const raised = validateConfigPatch({}, { risk: { riskPctPerTrade: 5 } });
  assert.equal(raised.config.risk.riskPctPerTrade, 1);
  assert.ok(raised.violations.some((v) => /cannot exceed/i.test(v)));

  const lowered = validateConfigPatch({}, { risk: { riskPctPerTrade: 0.5 } });
  assert.equal(lowered.config.risk.riskPctPerTrade, 0.5);
  assert.equal(lowered.violations.length, 0);

  const pred = validateConfigPatch({}, { prediction: { maxRiskPctPerBet: 9 } });
  assert.equal(pred.config.prediction.maxRiskPerBet, undefined);
  assert.equal(pred.config.prediction.maxRiskPctPerBet, 1);
});

test('config changes are diffed so the audit trail can show old and new values', () => {
  const out = validateConfigPatch({}, { antiFomo: { max15mPct: 20 } });
  const change = out.changes.find((c) => c.path === 'antiFomo.max15mPct');
  assert.deepEqual({ from: change.from, to: change.to }, { from: 15, to: 20 });
});

/* ------------------------------------------------------------------ *
 * Scanner
 * ------------------------------------------------------------------ */

test('Scanner passes a clean coil and skips wild or falling markets', () => {
  const base = snap('base');
  const plan = derivePlan(base.metrics, cfg(), { token: 'DEMO' });
  const pass = scannerAgent({ snapshot: base, plan, config: cfg() });
  assert.equal(pass.verdict, 'PASS');
  assert.ok(pass.whyItMayBeInteresting.length > 0);

  const volatile = snap('volatile');
  const vplan = derivePlan(volatile.metrics, cfg(), { token: 'DEMO' });
  const skip = scannerAgent({ snapshot: volatile, plan: vplan, config: cfg() });
  assert.equal(skip.verdict, 'SKIP');
  assert.ok(skip.checks.some((c) => c.id === 'volatility' && c.status === 'trigger'));

  const dump = snap('dump');
  const dplan = derivePlan(dump.metrics, cfg(), { token: 'DEMO' });
  const dskip = scannerAgent({ snapshot: dump, plan: dplan, config: cfg() });
  assert.equal(dskip.verdict, 'SKIP');
  assert.ok(dskip.checks.some((c) => c.id === 'trend' && c.status === 'trigger'));
});

test('Scanner refuses a setup whose stop is not below the entry or whose reward is too small', () => {
  const base = snap('base');
  const bad = derivePlan(base.metrics, cfg(), { token: 'DEMO', stop: base.metrics.price * 2, target1: base.metrics.price * 1.001 });
  const result = scannerAgent({ snapshot: base, plan: bad, config: cfg() });
  assert.equal(result.verdict, 'SKIP');
  assert.ok(result.checks.some((c) => c.id === 'invalidation' && c.status === 'trigger'));
});

test('Scanner marks candle-dependent checks unknown on hand-typed data instead of guessing', () => {
  const manual = {
    token: 'WIF',
    pair: 'WIF',
    dataQuality: 'USER-PROVIDED (typed in by the operator)',
    metrics: { manual: true, ok: true, price: 2, r5: 0.2, r15: 1.1, volume24hUsd: 9_000_000, atrPct: null, volumeRatio: null, support1h: 1.9, resistance1h: 2.2, distToSupportPct: 5, candleFieldsUnknown: true },
  };
  const plan = derivePlan(manual.metrics, cfg(), { token: 'WIF' });
  const result = scannerAgent({ snapshot: manual, plan, config: cfg() });
  const unknowns = result.checks.filter((c) => c.status === 'unknown');
  assert.ok(unknowns.length >= 1);
  assert.match(result.notes.join(' '), /could not be verified/i);
});

/* ------------------------------------------------------------------ *
 * Anti-FOMO
 * ------------------------------------------------------------------ */

test('Anti-FOMO blocks the pump on multiple independent checks', () => {
  const pump = snap('pump');
  const plan = derivePlan(pump.metrics, cfg(), { token: 'DEMO' });
  const result = antiFomoAgent({ snapshot: pump, plan, config: cfg() });
  assert.equal(result.verdict, 'BLOCK');
  const triggered = result.checks.filter((c) => c.status === 'trigger').map((c) => c.id);
  assert.ok(triggered.includes('move-5m'));
  assert.ok(triggered.includes('move-15m'));
  assert.ok(triggered.includes('dist-support'));
  assert.ok(triggered.includes('structure'));
  assert.ok(result.explanation.split(/(?<=[.!?])\s+/).length <= 3, 'explanation is capped at three sentences');
});

test('Anti-FOMO approves an orderly coil', () => {
  const base = snap('base');
  const plan = derivePlan(base.metrics, cfg(), { token: 'DEMO' });
  const result = antiFomoAgent({ snapshot: base, plan, config: cfg() });
  assert.equal(result.verdict, 'APPROVE');
  assert.equal(result.triggers.length, 0);
});

test('Anti-FOMO blocks on hype language and blocks when risk cannot be defined', () => {
  const base = snap('base');
  const plan = derivePlan(base.metrics, cfg(), { token: 'DEMO' });
  const hype = antiFomoAgent({ snapshot: base, plan, config: cfg(), ideaText: 'This is easy money, 100x guaranteed, do not miss out' });
  assert.equal(hype.verdict, 'BLOCK');
  assert.ok(hype.checks.some((c) => c.id === 'hype-rationale' && c.status === 'trigger'));

  const manual = {
    token: 'X', pair: 'X',
    dataQuality: 'USER-PROVIDED',
    metrics: { manual: true, ok: true, price: 1, r5: null, r15: null, volumeRatio: null, distToSupportPct: null, extended: false },
  };
  const manualPlan = derivePlan(manual.metrics, cfg(), { token: 'X' });
  const blocked = antiFomoAgent({ snapshot: manual, plan: manualPlan, config: cfg() });
  assert.equal(blocked.verdict, 'BLOCK', '"if risk cannot be clearly defined, block it"');
  assert.match(blocked.explanation, /could not be evaluated/i);
});

/* ------------------------------------------------------------------ *
 * Sizer
 * ------------------------------------------------------------------ */

function planFor({ entry = 100, stop = 99, target = 103, token = 'T' } = {}) {
  const plan = { direction: 'long', token, setup: 'test', setupQuality: 'clean', entryArea: { low: entry * 0.999, high: entry * 1.001 }, stop, target1: target };
  plan.entryMid = entry;
  plan.stopDistancePct = ((entry - stop) / entry) * 100;
  plan.rewardRisk = (target - entry) / (entry - stop);
  return plan;
}

test('Sizer sizes to the 1% rule and explains the maths', () => {
  const result = sizerAgent({ plan: planFor({ entry: 100, stop: 99, target: 103 }), account: account(1000), config: cfg() });
  assert.equal(result.verdict, 'APPROVE');
  assert.equal(result.maxLossUsd, 10);
  assert.ok(Math.abs(result.stopDistancePct - 1) < 1e-9);
  // $10 risk over a 1% stop, with simulated costs subtracted first
  assert.ok(result.positionNotionalUsd > 700 && result.positionNotionalUsd <= 1000);
  assert.ok(result.worstCaseUsd <= 10.0001, `worst case ${result.worstCaseUsd} must respect the 1% rule`);
  assert.ok(result.plainEnglish.some((l) => /Risk budget/.test(l)));
  assert.match(result.summary, /APPROVE/);
});

test('Sizer rejects stops that are too tight, too wide, or offer too little reward', () => {
  const tight = sizerAgent({ plan: planFor({ entry: 100, stop: 99.8, target: 110 }), account: account(1000), config: cfg() });
  assert.equal(tight.verdict, 'REJECT');
  assert.ok(tight.checks.some((c) => c.id === 'stop-distance' && c.status === 'trigger'));

  const wide = sizerAgent({ plan: planFor({ entry: 100, stop: 80, target: 150 }), account: account(1000), config: cfg() });
  assert.equal(wide.verdict, 'REJECT');

  const poorReward = sizerAgent({ plan: planFor({ entry: 100, stop: 99, target: 101 }), account: account(1000), config: cfg() });
  assert.equal(poorReward.verdict, 'REJECT');
  assert.ok(poorReward.checks.some((c) => c.id === 'risk-reward' && c.status === 'trigger'));
});

test('Sizer enforces the one-position rule and never suggests leverage', () => {
  const result = sizerAgent({
    plan: planFor(), account: account(1000), config: cfg(),
    openPositions: [{ id: 'PT-1', token: 'BTC' }],
  });
  assert.equal(result.verdict, 'REJECT');
  assert.match(result.summary, /still open|one-position/i);
});

test('Sizer never increases risk after a losing trade', () => {
  const lastLoss = { result: 'LOSS', riskPctAtEntry: 0.5, id: 'PT-x' };
  const result = sizerAgent({ plan: planFor(), account: account(1000), config: cfg(), lastClosedTrade: lastLoss });
  assert.equal(result.riskPct, 0.5, 'risk must stay at or below the previous level after a loss');
  assert.equal(result.maxLossUsd, 5);
  assert.ok(result.plainEnglish.some((l) => /never increased after a loss/i.test(l)));
});

test('Sizer cannot be pushed above the 1% ceiling even by a tampered config', () => {
  const bad = cfg();
  bad.risk.riskPctPerTrade = 25;
  const result = sizerAgent({ plan: planFor(), account: account(1000), config: bad });
  assert.equal(result.riskPct, 1);
  assert.equal(result.maxLossUsd, 10);
});

/* ------------------------------------------------------------------ *
 * Buyer
 * ------------------------------------------------------------------ */

test('Buyer refuses without every approval and blocks a chase above the entry area', () => {
  const base = snap('base');
  const plan = derivePlan(base.metrics, cfg(), { token: 'DEMO' });
  const scanner = { verdict: 'PASS', summary: 'ok', checks: [] };
  const antiFomo = { verdict: 'APPROVE', explanation: 'fine', checks: [] };
  const goodSizer = { verdict: 'APPROVE', sizeUnits: 10, actualRiskUsd: 5, riskPct: 1, stopDistancePct: 1, rewardRisk: 3, summary: 'ok', checks: [] };

  const missing = buyerAgent({ scanner, sizer: { verdict: 'REJECT' }, antiFomo, plan, snapshot: base, config: cfg() });
  assert.equal(missing.verdict, 'BLOCKED');
  assert.match(missing.summary, /TRADE BLOCKED/);

  const chase = buyerAgent({
    scanner, sizer: goodSizer, antiFomo, plan,
    snapshot: { ...base, metrics: { ...base.metrics, price: plan.entryArea.high * 1.02 } },
    config: cfg(),
  });
  assert.equal(chase.verdict, 'BLOCKED');
  assert.match(chase.summary, /chase/i);

  const opened = buyerAgent({ scanner, sizer: goodSizer, antiFomo, plan, snapshot: base, config: cfg(), sequence: 7 });
  assert.equal(opened.verdict, 'TICKET');
  assert.equal(opened.ticket.status, 'OPEN');
  assert.match(opened.ticket.id, /^PT-\d{8}-007$/);
  assert.ok(opened.reminders.some((r) => /no wallet/i.test(r) || /Not a real execution/i.test(r)));
});

test('Buyer respects the one-position rule even with all approvals', () => {
  const base = snap('base');
  const plan = derivePlan(base.metrics, cfg(), { token: 'DEMO' });
  const blocked = buyerAgent({
    scanner: { verdict: 'PASS' }, sizer: { verdict: 'APPROVE', sizeUnits: 1, actualRiskUsd: 1 }, antiFomo: { verdict: 'APPROVE' },
    plan, snapshot: base, config: cfg(), openPositions: [{ id: 'PT-2', token: 'ETH' }],
  });
  assert.equal(blocked.verdict, 'BLOCKED');
  assert.match(blocked.summary, /still open/);
});

/* ------------------------------------------------------------------ *
 * Prediction agent
 * ------------------------------------------------------------------ */

const market = (over = {}) => ({
  id: 'm1', question: 'Will X happen?', yesPrice: 0.3, bid: 0.29, ask: 0.31, spreadPoints: 2,
  liquidityUsd: 50_000, endDate: new Date(Date.now() + 20 * 86400000).toISOString(), url: 'https://example.com',
  ...over,
});

test('Prediction agent bets only on a genuine edge and skips thin evidence', () => {
  const skipEvidence = predictionAgent({ market: market(), account: account(1000), config: cfg(), evidence: 'sounds good', estimatedRange: [0.25, 0.35] });
  assert.equal(skipEvidence.verdict, 'SKIP');
  assert.match(skipEvidence.summary, /SKIP/);

  const noEdge = predictionAgent({
    market: market(), account: account(1000), config: cfg(),
    evidence: 'Polling averages have been stable for three weeks and the remaining undecided voters break evenly on this question.',
    estimatedRange: [0.28, 0.33],
  });
  assert.equal(noEdge.verdict, 'SKIP');
  assert.ok(noEdge.checklist.some((c) => c.id === 'edge' && c.status === 'trigger'));

  const bet = predictionAgent({
    market: market(), account: account(1000), config: cfg(),
    evidence: 'Polling averages have been stable for three weeks and the remaining undecided voters break evenly on this question.',
    estimatedRange: [0.05, 0.15],
  });
  assert.equal(bet.verdict, 'BET');
  assert.equal(bet.suggestedSide, 'NO', 'estimating 5-15% against a 30% market means betting NO');
  assert.equal(bet.maxPaperRiskUsd, 10);
});

test('Prediction agent skips wide spreads and illiquid markets', () => {
  const result = predictionAgent({
    market: market({ spreadPoints: 9, liquidityUsd: 100 }),
    account: account(1000), config: cfg(),
    evidence: 'A long sentence of genuine reasoning so the evidence check passes cleanly here.',
    estimatedRange: [0.05, 0.15],
  });
  assert.equal(result.verdict, 'SKIP');
  assert.ok(result.checklist.some((c) => c.id === 'spread' && c.status === 'trigger'));
  assert.ok(result.checklist.some((c) => c.id === 'liquidity' && c.status === 'trigger'));
});

/* ------------------------------------------------------------------ *
 * Logger maths
 * ------------------------------------------------------------------ */

function openRecord(over = {}) {
  return {
    kind: 'trade', id: 'PT-1', status: 'OPEN', token: 'T', pair: 'T-USD', dataQuality: 'LIVE',
    setup: 'Base / coil', setupQuality: 'clean',
    entry: { price: 100, units: 5, notionalUsd: 500, at: new Date().toISOString(), entryArea: { low: 99.9, high: 100.1 } },
    stopLoss: 99, target: 103, maxDollarRisk: 5, riskPctAtEntry: 1, stopDistancePct: 1, rewardRisk: 3,
    decisions: { scanner: 'PASS', sizer: 'APPROVE', antiFomo: 'APPROVE', buyer: 'TICKET' },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), mistakes: [],
    ...over,
  };
}

test('closing a trade computes P&L net of simulated costs and can never be repeated', () => {
  const closed = closeTradeRecord(openRecord(), { exitPrice: 103, closeReason: 'Target reached', config: cfg() });
  assert.equal(closed.status, 'CLOSED_TARGET');
  assert.equal(closed.pnl.result, 'WIN');
  assert.ok(closed.pnl.grossUsd > 14 && closed.pnl.grossUsd < 16);
  assert.ok(closed.pnl.feesUsd > 0, 'fees are subtracted so the numbers are not flattering');
  assert.ok(closed.pnl.netUsd < closed.pnl.grossUsd);
  assert.equal(closed.exit.hitTarget, true);
  assert.ok(closed.pnl.rMultiple > 2.5);

  assert.throws(() => closeTradeRecord(closed, { exitPrice: 103, config: cfg() }), /not OPEN|cannot|rewrit/i);
});

test('a stop-out is recorded as a loss and tagged automatically when the setup was weak', () => {
  const closed = closeTradeRecord(openRecord({ setupQuality: 'weak' }), { exitPrice: 99, closeReason: 'Stop loss hit', config: cfg() });
  assert.equal(closed.status, 'CLOSED_STOP');
  assert.equal(closed.pnl.result, 'LOSS');
  assert.ok(closed.mistakes.length >= 1);
});

test('stats and the 20-trade review report exactly what the guide asks for', () => {
  const records = [];
  for (let i = 0; i < 20; i++) {
    const win = i % 2 === 0;
    const base = openRecord({ id: `PT-${i}`, setup: i % 3 === 0 ? 'Base / coil' : 'Pullback' });
    const closed = closeTradeRecord(
      { ...base, createdAt: new Date(Date.now() - (40 - i) * 3600000).toISOString() },
      { exitPrice: win ? 103 : 99, closeReason: win ? 'Target reached' : 'Stop loss hit', config: cfg(), closedAt: new Date(Date.now() - (39 - i) * 3600000) },
    );
    records.push(closed);
  }
  records.push({ kind: 'blocked', id: 'BLK-1', createdAt: new Date(Date.now() - 30 * 3600000).toISOString(), category: 'Chased an extended move (Anti-FOMO)', decisions: { antiFomo: 'BLOCK' }, reasons: ['x'] });

  const stats = computeStats(records, cfg(), { startingBalance: 1000 });
  assert.equal(stats.counts.totalTrades, 20);
  assert.equal(stats.counts.wins, 10);
  assert.equal(stats.counts.losses, 10);
  assert.equal(stats.winRate, 50);
  assert.equal(stats.counts.blocked, 1);
  assert.ok(stats.topMistakes.some((m) => m.mistake === 'Chased an extended move (Anti-FOMO)'), 'blocked setups feed the mistake tally');
  assert.equal(stats.mostCommonMistake, 'None / unknown', 'the ten closed trades with no tagged mistake dominate here');
  assert.ok(Number.isFinite(stats.avgWinUsd) && stats.avgWinUsd > 0);
  assert.ok(Number.isFinite(stats.avgLossUsd) && stats.avgLossUsd < 0);
  assert.ok(stats.biggestWinUsd >= stats.avgWinUsd);
  assert.ok(stats.biggestLossUsd <= stats.avgLossUsd);
  assert.ok(stats.equityCurve.length === 21);
  assert.ok(stats.maxDrawdownPct >= 0);
  assert.equal(stats.ruleViolations.length, 0);

  const blocks = reviewBlocks(records, cfg());
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].totalTrades, 20);
  assert.equal(blocks[0].wins, 10);
  assert.equal(blocks[0].blockedCount, 1);
  assert.ok(blocks[0].totalPnlUsd !== 0);
});

test('the rule audit catches a trade that exceeded the risk limit or skipped a stop', () => {
  const bad = closeTradeRecord(openRecord({ id: 'PT-bad', riskPctAtEntry: 4, stopLoss: null }), { exitPrice: 99, config: cfg() });
  const stats = computeStats([bad], cfg(), { startingBalance: 1000 });
  assert.ok(stats.ruleViolations.some((v) => /risk was 4%/.test(v)));
  assert.ok(stats.ruleViolations.some((v) => /without a stop-loss/.test(v)));
});

test('createTradeRecord keeps every decision and the written reason', () => {
  const record = createTradeRecord({
    scanner: { verdict: 'PASS', summary: 's', whyItMayBeInteresting: ['why'] },
    sizer: { verdict: 'APPROVE', summary: 'z', riskPct: 1, stopDistancePct: 1, rewardRisk: 3 },
    antiFomo: { verdict: 'APPROVE', explanation: 'af' },
    buyer: { verdict: 'TICKET', ticket: { id: 'PT-9', token: 'T', pair: 'T-USD', simulatedEntry: 100, simulatedPositionSizeUnits: 1, simulatedPositionNotionalUsd: 100, entryArea: { low: 99, high: 101 }, stopLoss: 99, target: 103, maxDollarRisk: 1, timeEntered: new Date().toISOString(), dataSourceAtEntry: 'x' } },
    plan: { setup: 'Base', setupQuality: 'clean', reason: 'reason' },
    snapshot: { token: 'T', pair: 'T-USD', dataQuality: 'LIVE' },
    config: cfg(),
  });
  assert.equal(record.kind, 'trade');
  assert.equal(record.decisions.scanner, 'PASS');
  assert.deepEqual(record.mistakes, []);
  assert.ok(record.whyTaken.length >= 3);
  assert.equal(record.writtenReason, 'reason');
});
