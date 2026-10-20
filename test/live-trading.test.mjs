import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLiveTrading, createLiveJournal, validateLiveOrder, reportedUSDBalance } from '../src/live/trading.mjs';

function fixture() {
  let clock = 1000000;
  const calls = [];
  const journal = { latest: new Map(), append(entry) { this.latest.set(entry.id, entry); } };
  const client = {
    markets: { retrieveBySlug: async slug => ({ market: { slug, active: true, closed: false, title: 'Example contract', outcome: 'Verified outcome', description: 'Verified rules' } }) },
    account: { balances: async () => ({ balances: [{ currency: 'USD', buyingPower: 50 }] }) },
    portfolio: { positions: async () => ({ positions: {} }) },
    orders: {
      preview: async ({ request }) => { calls.push(['preview', request]); return { order: { ...request, state: 'ORDER_STATE_NEW', commissionsBasisPoints: '100', makerCommissionsBasisPoints: '0' } }; },
      create: async request => { calls.push(['create', request]); return { id: 'order-123' }; },
      list: async () => ({ orders: [] }),
    },
  };
  const service = createLiveTrading({ client, journal, now: () => clock });
  return { client, journal, calls, service, advance: ms => { clock += ms; } };
}
const ticket = { marketSlug: 'example', price: '0.55', quantity: '10' };
const confirm = p => ({ previewId: p.id, confirmation: p.confirmation, acknowledged: true });

test('live ticket whitelists long IOC limit orders and enforces exact arithmetic', () => {
  const request = validateLiveOrder(ticket);
  assert.equal(request.intent, 'ORDER_INTENT_BUY_LONG');
  assert.equal(request.tif, 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL');
  assert.equal(request.type, 'ORDER_TYPE_LIMIT');
  for (const patch of [{ intent: 'ORDER_INTENT_BUY_SHORT' }, { type: 'ORDER_TYPE_MARKET' }, { tif: 'TIME_IN_FORCE_GOOD_TILL_CANCEL' }, { price: '1' }, { price: '0' }, { price: '-0.5' }, { quantity: '-1' }, { quantity: '1e2' }, { quantity: '0.0001' }, { quantity: '18.182' }, { price: 'NaN' }, { marketSlug: '../bad' }]) assert.throws(() => validateLiveOrder({ ...ticket, ...patch }));
});

test('preview is non-executing, scoped to a session, and includes fee reserve', async () => {
  const f = fixture();
  const p = await f.service.preview(ticket, 'owner');
  assert.equal(p.notionalCents, 550);
  assert.equal(p.feeReserveCents, 6);
  assert.equal(p.totalCents, 556);
  assert.equal(f.calls.filter(c => c[0] === 'create').length, 0);
  await assert.rejects(f.service.submit(confirm(p), 'other'), /not found/);
  await assert.rejects(f.service.submit({ ...confirm(p), confirmation: 'wrong' }, 'owner'), /Confirm/);
  const result = await f.service.submit(confirm(p), 'owner');
  assert.equal(result.orderId, 'order-123');
  assert.equal(result.state, 'ACCEPTED');
  assert.equal(f.calls.filter(c => c[0] === 'create').length, 1);
  await assert.rejects(f.service.submit(confirm(p), 'owner'), /not found/);
});

test('fees cannot push the order over the $10 hard cap', async () => {
  const f = fixture();
  await assert.rejects(f.service.preview({ ...ticket, price: '0.5', quantity: '20' }, 'owner'), /fee reserve exceeds/);
  assert.equal(f.calls.filter(c => c[0] === 'create').length, 0);
});

test('stale previews and replacement previews cannot submit', async () => {
  const f = fixture();
  const p = await f.service.preview(ticket, 'owner');
  f.advance(60001);
  await assert.rejects(f.service.submit(confirm(p), 'owner'), /expired/);
  const old = await f.service.preview(ticket, 'owner');
  await f.service.preview(ticket, 'owner');
  await assert.rejects(f.service.submit(confirm(old), 'owner'), /not found/);
});

test('missing/mismatched preview fees, status, identity or buying power fail closed', async () => {
  for (const mutate of [
    f => { f.client.orders.preview = async ({ request }) => ({ order: { ...request } }); },
    f => { f.client.orders.preview = async ({ request }) => ({ order: { ...request, state: 'ORDER_STATE_NEW', quantity: 2, commissionsBasisPoints: '0', makerCommissionsBasisPoints: '0' } }); },
    f => { f.client.markets.retrieveBySlug = async () => ({ market: { slug: 'example', active: false, closed: false, title: 'title', outcome: 'Yes' } }); },
    f => { f.client.account.balances = async () => ({ balances: [{ currency: 'USD', buyingPower: 1 }] }); },
    f => { f.client.account.balances = async () => ({ balances: [{ currency: 'EUR', buyingPower: 50 }] }); },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(f.service.preview(ticket, 'owner'));
    assert.equal(f.calls.filter(c => c[0] === 'create').length, 0);
  }
  assert.throws(() => reportedUSDBalance({ balances: [{ currency: 'USD' }, { currency: 'USD' }] }));
});

test('submit rechecks the preview and refuses changed costs or outcomes', async () => {
  const f = fixture();
  const p = await f.service.preview(ticket, 'owner');
  f.client.orders.preview = async ({ request }) => ({ order: { ...request, state: 'ORDER_STATE_NEW', commissionsBasisPoints: '200', makerCommissionsBasisPoints: '0' } });
  await assert.rejects(f.service.submit(confirm(p), 'owner'), /changed/);
  assert.equal(f.calls.filter(c => c[0] === 'create').length, 0);
});

test('dispatch is journaled before exactly one create call; ambiguous outcome blocks future orders', async () => {
  const f = fixture();
  const p = await f.service.preview(ticket, 'owner');
  let creates = 0;
  f.client.orders.create = async () => {
    creates++;
    assert.equal(f.journal.latest.get(p.id).state, 'DISPATCHING');
    throw new Error('timeout-with-secret');
  };
  await assert.rejects(f.service.submit(confirm(p), 'owner'), err => err.code === 'LIVE_UNKNOWN' && !err.message.includes('timeout-with-secret'));
  assert.equal(creates, 1);
  assert.equal(f.service.operation(p.id).state, 'UNKNOWN');
  await assert.rejects(f.service.preview(ticket, 'owner'), /unknown outcome/);
  assert.equal(f.service.health().uncertain, true);
});

test('concurrent submissions cannot dispatch twice', async () => {
  const f = fixture();
  const p = await f.service.preview(ticket, 'owner');
  const results = await Promise.allSettled([f.service.submit(confirm(p), 'owner'), f.service.submit(confirm(p), 'owner')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'create').length, 1);
});

test('failed journal write prevents dispatch', async () => {
  const f = fixture();
  const p = await f.service.preview(ticket, 'owner');
  f.journal.append = () => { throw new Error('disk failure'); };
  await assert.rejects(f.service.submit(confirm(p), 'owner'));
  assert.equal(f.calls.filter(c => c[0] === 'create').length, 0);
});

test('durable journal survives restart and blocks unresolved dispatch; corrupt data fails startup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-journal-'));
  const filename = path.join(dir, 'dispatch.jsonl');
  try {
    const a = createLiveJournal(filename);
    assert.throws(() => createLiveJournal(filename), /EEXIST/, 'another process cannot open the same journal');
    a.append({ id: 'operation-1', state: 'DISPATCHING', at: new Date().toISOString() });
    a.close();
    const b = createLiveJournal(filename);
    const f = fixture();
    const restarted = createLiveTrading({ client: f.client, journal: b });
    assert.equal(restarted.health().uncertain, true);
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    b.close();
    fs.appendFileSync(filename, '{broken');
    assert.throws(() => createLiveJournal(filename), /invalid/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
