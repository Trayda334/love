import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../src/core/store.mjs';
import { evaluateSetup, evaluatePrediction, closePosition } from '../src/core/pipeline.mjs';
import { demoSnapshot } from '../src/feeds/index.mjs';

const memStore = () => new Store(path.join(os.tmpdir(), 'desk-unused.json'), { memory: true });
const snapshot = (scenario) => demoSnapshot({ scenario, token: 'DEMO' }).snapshot;

test('the pipeline opens a ticket for a clean coil, in the guide\'s order', async () => {
  const store = memStore();
  const out = await evaluateSetup({ store, snapshot: snapshot('base'), mode: 'auto', writtenReason: 'Coil under resistance, stop below the base.' });
  assert.equal(out.status, 'opened');
  assert.equal(out.results.scanner.verdict, 'PASS');
  assert.equal(out.results.antiFomo.verdict, 'APPROVE');
  assert.equal(out.results.sizer.verdict, 'APPROVE');
  assert.equal(out.results.buyer.verdict, 'TICKET');
  assert.equal(store.openPositions().length, 1);

  const record = store.getRecord(out.record.id);
  assert.equal(record.status, 'OPEN');
  assert.ok(record.entry.units > 0);
  assert.ok(record.whyTaken.length >= 3);
  assert.equal(record.executionMode, 'auto');
  assert.equal(store.stats().counts.openTrades, 1);
});

test('a pump is blocked by Anti-FOMO and the block is written to the ledger', async () => {
  const store = memStore();
  const out = await evaluateSetup({ store, snapshot: snapshot('pump'), mode: 'auto' });
  assert.equal(out.status, 'blocked');
  assert.equal(out.stage, 'antiFomo');
  assert.equal(store.openPositions().length, 0, 'no ticket is created for a chase');
  const blocks = store.listRecords({ kind: 'blocked' });
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].category, /Anti-FOMO/);
  assert.ok(blocks[0].reasons.length > 0, 'the reasons are kept, never trimmed to look good');
  assert.equal(blocks[0].decisions.scanner, 'PASS');
  assert.equal(blocks[0].reviewOutcome, null, 'the honest "what happened next" field starts empty');
});

test('dump and volatile scenarios never reach the Sizer', async () => {
  for (const scenario of ['dump', 'volatile']) {
    const store = memStore();
    const out = await evaluateSetup({ store, snapshot: snapshot(scenario), mode: 'auto' });
    assert.equal(out.status, 'blocked', scenario);
    assert.equal(out.stage, 'scanner', scenario);
    assert.equal(out.results.sizer, undefined, `${scenario} must not be sized`);
  }
});

test('the one-position rule blocks a second entry', async () => {
  const store = memStore();
  const first = await evaluateSetup({ store, snapshot: snapshot('base'), mode: 'auto' });
  assert.equal(first.status, 'opened');

  const second = await evaluateSetup({ store, snapshot: snapshot('base'), mode: 'auto' });
  assert.equal(second.status, 'blocked');
  assert.equal(second.stage, 'one-position', 'the rule is checked before anything else is evaluated');
  assert.match(second.record.reasons.join(' '), /still open/);
  assert.equal(second.record.decisions.sizer, 'REJECT');
  assert.equal(store.openPositions().length, 1, 'no second ticket can exist');
});

test('guided mode pauses after each approving agent and writes nothing until the operator approves', async () => {
  const store = memStore();
  const first = await evaluateSetup({ store, snapshot: snapshot('base'), mode: 'guided', gates: {} });
  assert.equal(first.status, 'awaiting');
  assert.equal(first.stage, 'scanner');
  assert.equal(store.state.records.length, 0, 'a paused run must not touch the ledger');

  const second = await evaluateSetup({ store, snapshot: snapshot('base'), mode: 'guided', gates: { scanner: 'approve' } });
  assert.equal(second.status, 'awaiting');
  assert.equal(second.stage, 'antiFomo');
  assert.equal(store.state.records.length, 0);

  const third = await evaluateSetup({ store, snapshot: snapshot('base'), mode: 'guided', gates: { scanner: 'approve', antiFomo: 'approve' } });
  assert.equal(third.status, 'awaiting');
  assert.equal(third.stage, 'sizer');

  const fourth = await evaluateSetup({ store, snapshot: snapshot('base'), mode: 'guided', gates: { scanner: 'approve', antiFomo: 'approve', sizer: 'approve' } });
  assert.equal(fourth.status, 'opened');
  assert.equal(store.state.records.length, 1);
});

test('declining a gate records the block rather than quietly doing nothing', async () => {
  const store = memStore();
  const out = await evaluateSetup({ store, snapshot: snapshot('base'), mode: 'guided', gates: { scanner: 'decline' } });
  assert.equal(out.status, 'blocked');
  assert.equal(out.stage, 'operator');
  const blocks = store.listRecords({ kind: 'blocked' });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].decisions.operator, 'DECLINED');
  assert.match(blocks[0].reasons.join(' '), /Operator declined/);
});

test('an operator can override a block, and the override is stamped on the record', async () => {
  const store = memStore();
  const out = await evaluateSetup({
    store, snapshot: snapshot('pump'), mode: 'guided',
    gates: { scanner: 'approve', antiFomo: 'approve', sizer: 'approve' },
    writtenReason: 'Deliberate override test.',
  });
  assert.equal(out.status, 'opened');
  const record = store.getRecord(out.record.id);
  assert.equal(record.operatorOverrides.antiFomo, true);
  assert.match(record.whyTaken.join(' '), /OVERRIDDEN BY OPERATOR/);
  assert.equal(out.results.antiFomo.originalVerdict, 'BLOCK');
  assert.equal(out.results.antiFomo.verdict, 'APPROVE');
});

test('closing a position writes the result and updates the account', async () => {
  const store = memStore();
  const out = await evaluateSetup({ store, snapshot: snapshot('base'), mode: 'auto' });
  const record = store.getRecord(out.record.id);
  const closed = closePosition({
    store, recordId: record.id, exitPrice: record.target, closeReason: 'Target reached',
    mistakes: ['None / unknown'], learned: 'Followed the plan.',
  });
  assert.equal(closed.pnl.result, 'WIN');
  assert.ok(store.account().balance > store.getConfig().account.startingBalance);
  assert.equal(store.stats().counts.closedTrades, 1);
  assert.equal(store.openPositions().length, 0);
  assert.match(store.state.audit.map((a) => a.note).join(' '), /closed WIN/);
});

test('the ledger is append-only and settings changes are audited', async () => {
  const store = memStore();
  const out = await evaluateSetup({ store, snapshot: snapshot('base'), mode: 'auto' });
  assert.throws(() => store.addRecord(store.getRecord(out.record.id)), /append-only/i);

  const { violations, changes } = store.updateConfig({ risk: { riskPctPerTrade: 5 } }, 'trying to raise risk');
  assert.equal(store.getConfig().risk.riskPctPerTrade, 1);
  assert.ok(violations.length > 0);
  assert.equal(changes.length, 0, 'the refused change is not applied, so nothing is written as changed');
  const audit = store.audit.map((a) => `${a.type}: ${a.note}`).join(' | ');
  assert.match(audit, /trying to raise risk|cannot exceed/);

  store.updateConfig({ antiFomo: { max15mPct: 20 } }, 'deliberate loosening');
  assert.equal(store.getConfig().antiFomo.max15mPct, 20);
  assert.ok(store.audit.some((a) => a.type === 'RULE_CHANGE' && /max15mPct/.test(a.note)));
});

test('prediction bets are logged on their own ledger and can be resolved', async () => {
  const store = memStore();
  const market = {
    id: 'm1', question: 'Will it happen?', yesPrice: 0.2, bid: 0.19, ask: 0.21, spreadPoints: 2,
    liquidityUsd: 100_000, endDate: new Date(Date.now() + 30 * 86400000).toISOString(), url: 'https://example.com/m1',
  };
  const out = await evaluatePrediction({
    store, market,
    evidence: 'Base rates for this kind of event sit around ten percent and the recent data supports that level.',
    estimatedRange: [0.05, 0.1],
  });
  assert.equal(out.record.kind, 'prediction');
  assert.equal(out.record.status, 'OPEN_BET');
  assert.equal(store.stats().counts.predictions, 1);

  const skipped = await evaluatePrediction({ store, market, evidence: 'meh', estimatedRange: null });
  assert.equal(skipped.record.status, 'SKIPPED');
  assert.equal(store.stats().counts.predictions, 2);
});

test('state persisted to disk survives a reload (the ledger is real, not in-memory)', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'desk-')), 'desk.json');
  const store = new Store(file);
  await evaluateSetup({ store, snapshot: snapshot('base'), mode: 'auto' });
  const reopened = new Store(file);
  assert.equal(reopened.state.records.length, 1);
  assert.equal(reopened.getConfig().risk.riskPctPerTrade, 1);
  assert.ok(fs.existsSync(file));
});

test('the ledger records worst-case risk measured from the simulated fill, and keeps the Sizer plan too', async () => {
  const store = memStore();
  const out = await evaluateSetup({ store, snapshot: snapshot('base'), mode: 'auto' });
  const record = store.getRecord(out.record.id);
  assert.ok(record.maxDollarRisk > 0);
  assert.ok(record.maxDollarRisk <= 10.0001, `worst case ${record.maxDollarRisk} must stay inside the 1% rule`);
  assert.ok(Number.isFinite(record.maxDollarRiskPlanned), 'the Sizer plan is kept as well');
  assert.ok(record.fillStopDistancePct > 0);
  assert.ok(record.riskPctAtFill <= 1.0001, `fill-based risk ${record.riskPctAtFill}% must respect the ceiling`);
  assert.equal(record.riskPctAtEntry, 1, 'the budget that authorised the trade is the Sizer value');

  // closing at the stop must lose roughly the recorded worst case, never more than 1% of the account
  const closed = closePosition({ store, recordId: record.id, exitPrice: record.stopLoss, closeReason: 'Stop was hit' });
  assert.equal(closed.pnl.result, 'LOSS');
  const lossPct = Math.abs(closed.pnl.netUsd) / store.getConfig().account.startingBalance * 100;
  assert.ok(lossPct <= 1.0001, `a stop-out lost ${lossPct}% of the account`);
  assert.ok(Math.abs(Math.abs(closed.pnl.netUsd) - record.maxDollarRisk) < 0.35, 'the recorded worst case matches the realised loss');
});
