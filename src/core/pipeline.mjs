/**
 * pipeline.mjs - the only place the six agents are wired together.
 *
 * Order follows guide Step 8:
 *   1. Scanner finds the setup
 *   2. Anti-FOMO checks whether the entry is chasing
 *   3. Sizer calculates simulated risk
 *   4. Buyer creates the paper trade
 *   5. Logger records the decision and result
 *
 * Two modes:
 *   guided - after each approving agent the run pauses and waits for the
 *            operator's explicit approval (human in the loop; a silent
 *            onlooker cannot let a trade through).
 *   auto   - the agents run straight through; the chosen mode is stamped on
 *            the record so a viewer can never mistake auto-trades for
 *            operator-approved ones.
 *
 * Nothing here can place a real order. There is no broker client anywhere.
 */

import { scannerAgent, sizerAgent, buyerAgent, antiFomoAgent, predictionAgent, derivePlan } from '../agents/index.mjs';
import { loggerApi } from '../agents/logger.mjs';

export async function evaluateSetup({ store, snapshot, planOverride = null, gates = {}, mode = 'guided', writtenReason = '', ideaText = '', now = new Date() }) {
  const config = store.getConfig();
  const openPositions = store.openPositions();
  const account = store.account();
  const results = {};

  /* The one-position rule is checked first so the reason is unmistakable. */
  if (openPositions.length > 0) {
    const blocked = loggerApi.createBlockedRecord({ plan: { token: snapshot.token, setup: 'n/a' }, snapshot, stage: 'one-position', now });
    blocked.decisions.sizer = 'REJECT';
    blocked.category = 'One-position rule (Sizer)';
    blocked.reasons.unshift(
      `Position ${openPositions[0].id} (${openPositions[0].token}) is still open. The one-position rule is fixed, so this setup was not evaluated.`,
    );
    store.addRecord(blocked, { event: 'BLOCKED', note: `One-position rule: ${openPositions[0].id} is still open.` });
    return { status: 'blocked', stage: 'one-position', results, plan: null, record: blocked };
  }

  const plan = derivePlan(snapshot.metrics, config, {
    token: snapshot.token,
    pair: snapshot.pair,
    reason: writtenReason,
    ...(planOverride || {}),
  });
  if (!plan.ok) {
    const blocked = loggerApi.createBlockedRecord({ plan, snapshot, stage: 'data', now });
    store.addRecord(blocked, { event: 'BLOCKED', note: 'Snapshot had no usable metrics.' });
    return { status: 'blocked', stage: 'data', results, plan, record: blocked };
  }

  /** A declined gate is a decision, so it gets recorded like any other block. */
  const recordOperatorDecline = (agentLabel, agentKey) => {
    const blocked = loggerApi.createBlockedRecord({ scanner: results.scanner, antiFomo: results.antiFomo, sizer: results.sizer, plan, snapshot, stage: 'operator', now });
    blocked.decisions.operator = 'DECLINED';
    blocked.category = 'Operator declined (human judgement)';
    blocked.reasons.unshift(`Operator declined to approve at the ${agentLabel} gate even though that agent approved.`);
    store.addRecord(blocked, { event: 'BLOCKED', note: `Operator declined at the ${agentLabel} gate.` });
    return { status: 'blocked', stage: 'operator', results, plan, record: blocked, declinedAt: agentKey };
  };

  /* ---------------- Agent 1: Scanner ---------------- */
  results.scanner = scannerAgent({ snapshot, plan, config });
  if (results.scanner.verdict !== 'PASS') {
    const gate = gates.scanner;
    if (mode === 'guided' && gate === undefined) {
      return { status: 'awaiting', stage: 'scanner', results, plan, prompt: 'The Scanner returned SKIP. Approve anyway, or let it stand as a recorded block.' };
    }
    if (!(mode === 'guided' && gate === 'approve')) {
      const blocked = loggerApi.createBlockedRecord({ scanner: results.scanner, plan, snapshot, stage: 'scanner', now });
      store.addRecord(blocked, { event: 'BLOCKED', note: 'Scanner said SKIP.' });
      return { status: 'blocked', stage: 'scanner', results, plan, record: blocked };
    }
    results.scanner = { ...results.scanner, overriddenByOperator: true, verdict: 'PASS', originalVerdict: 'SKIP', summary: `${results.scanner.summary} [OVERRIDDEN BY OPERATOR - the skip is still logged]` };
  }
  if (mode === 'guided' && gates.scanner === 'decline') return recordOperatorDecline('Scanner', 'scanner');
  if (mode === 'guided' && gates.scanner !== 'approve') {
    return { status: 'awaiting', stage: 'scanner', results, plan, prompt: 'Scanner PASSED. Approve to continue to the Anti-FOMO check.' };
  }

  /* ---------------- Agent 5: Anti-FOMO ---------------- */
  results.antiFomo = antiFomoAgent({ snapshot, plan, config, ideaText: ideaText || writtenReason });
  if (results.antiFomo.verdict !== 'APPROVE') {
    const gate = gates.antiFomo;
    if (!(mode === 'guided' && gate === 'approve')) {
      const blocked = loggerApi.createBlockedRecord({ scanner: results.scanner, antiFomo: results.antiFomo, plan, snapshot, stage: 'antiFomo', now });
      store.addRecord(blocked, { event: 'BLOCKED', note: 'Anti-FOMO agent blocked the entry.' });
      return { status: 'blocked', stage: 'antiFomo', results, plan, record: blocked };
    }
    results.antiFomo = {
      ...results.antiFomo,
      overriddenByOperator: true,
      verdict: 'APPROVE',
      summary: `${results.antiFomo.summary} [OVERRIDDEN BY OPERATOR - the block is still logged]`,
      explanation: `${results.antiFomo.explanation} [OVERRIDDEN BY OPERATOR - the block is still logged: this trade must not be judged as if Anti-FOMO approved it.]`,
      originalVerdict: 'BLOCK',
    };
  }
  if (mode === 'guided' && gates.antiFomo === 'decline') return recordOperatorDecline('Anti-FOMO', 'antiFomo');
  if (mode === 'guided' && gates.antiFomo !== 'approve') {
    return { status: 'awaiting', stage: 'antiFomo', results, plan, prompt: 'Anti-FOMO approved. Approve to let the Sizer calculate the simulated size.' };
  }

  /* ---------------- Agent 2: Sizer ---------------- */
  const lastClosed = store.lastClosedTrade();
  results.sizer = sizerAgent({ plan, account, config, openPositions, lastClosedTrade: lastClosed });
  if (results.sizer.verdict !== 'APPROVE') {
    const gate = gates.sizer;
    if (!(mode === 'guided' && gate === 'approve')) {
      const blocked = loggerApi.createBlockedRecord({ scanner: results.scanner, antiFomo: results.antiFomo, sizer: results.sizer, plan, snapshot, stage: 'sizer', now });
      store.addRecord(blocked, { event: 'BLOCKED', note: 'Sizer rejected the trade.' });
      return { status: 'blocked', stage: 'sizer', results, plan, record: blocked };
    }
    results.sizer = {
      ...results.sizer,
      overriddenByOperator: true,
      verdict: 'APPROVE',
      originalVerdict: 'REJECT',
      summary: `${results.sizer.summary} [OVERRIDDEN BY OPERATOR - the rejection is still logged]`,
    };
  }
  if (mode === 'guided' && gates.sizer === 'decline') return recordOperatorDecline('Sizer', 'sizer');
  if (mode === 'guided' && gates.sizer !== 'approve') {
    return { status: 'awaiting', stage: 'sizer', results, plan, prompt: `Sizer approved $${results.sizer.positionNotionalUsd} for a worst case of $${results.sizer.actualRiskUsd}. Approve to create the paper ticket.` };
  }

  /* ---------------- Agent 3: Buyer ---------------- */
  results.buyer = buyerAgent({
    scanner: results.scanner,
    sizer: results.sizer,
    antiFomo: results.antiFomo,
    plan,
    snapshot,
    config,
    openPositions,
    sequence: store.nextTradeSequence(),
    now,
  });
  if (results.buyer.verdict !== 'TICKET') {
    const blocked = loggerApi.createBlockedRecord({ scanner: results.scanner, antiFomo: results.antiFomo, sizer: results.sizer, buyer: results.buyer, plan, snapshot, stage: 'buyer', now });
    store.addRecord(blocked, { event: 'BLOCKED', note: 'Buyer refused to create the ticket.' });
    return { status: 'blocked', stage: 'buyer', results, plan, record: blocked };
  }

  /* ---------------- Agent 6: Logger ---------------- */
  const record = loggerApi.createTradeRecord({ scanner: results.scanner, sizer: results.sizer, antiFomo: results.antiFomo, buyer: results.buyer, plan, snapshot, config, account, now });
  record.executionMode = mode;
  record.operatorOverrides = {
    scanner: Boolean(results.scanner.overriddenByOperator),
    antiFomo: Boolean(results.antiFomo.overriddenByOperator),
    sizer: Boolean(results.sizer.overriddenByOperator),
  };
  store.addRecord(record, { event: 'PAPER_TRADE_OPEN', note: `${record.id} opened at ${record.entry.price} on ${mode} mode.` });

  return { status: 'opened', stage: 'logger', results, plan, record };
}

export async function evaluatePrediction({ store, market, evidence = '', estimatedRange = null, daysToResolve = null, now = new Date() }) {
  const config = store.getConfig();
  const account = { ...store.account(), openBets: store.openPredictionBets().length };
  const result = predictionAgent({ market, account, config, evidence, estimatedRange, daysToResolve });
  const record = loggerApi.createPredictionRecord({ market, result, account, evidence, now });
  store.addRecord(record, { event: record.status === 'OPEN_BET' ? 'PAPER_BET_OPEN' : 'BET_SKIPPED', note: `${record.id} - ${record.question}` });
  return { status: record.status, result, record };
}

export function closePosition({ store, recordId, exitPrice, closeReason, mistakes, learned, now = new Date() }) {
  const config = store.getConfig();
  const record = store.getRecord(recordId);
  if (!record) throw new Error(`No record ${recordId}.`);
  const closed = loggerApi.closeTradeRecord(record, { exitPrice, closeReason, mistakes, learned, closedAt: now, config });
  store.replaceRecord(closed, { event: 'PAPER_TRADE_CLOSE', note: `${closed.id} closed ${closed.pnl.result} for $${closed.pnl.netUsd} (${closed.pnl.netPct}%).` });
  return closed;
}

export function checkAutoEntry({ store, snapshot }) {
  const config = store.getConfig();
  const openPositions = store.openPositions();
  if (openPositions.length > 0) {
    return { ok: false, reason: `Position ${openPositions[0].id} is still open (one-position rule).` };
  }
  const plan = derivePlan(snapshot.metrics, config, { token: snapshot.token, pair: snapshot.pair });
  if (!plan.ok) return { ok: false, reason: plan.notes.join(' ') };
  const scanner = scannerAgent({ snapshot, plan, config });
  const antiFomo = antiFomoAgent({ snapshot, plan, config });
  const sizer = sizerAgent({ plan, account: store.account(), config, openPositions });
  if (scanner.verdict === 'PASS' && antiFomo.verdict === 'APPROVE' && sizer.verdict === 'APPROVE') return { ok: true, plan };
  return { ok: false, reason: `scanner=${scanner.verdict}, antiFomo=${antiFomo.verdict}, sizer=${sizer.verdict}` };
}
