import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import { createUSStream } from '../src/feeds/polymarket-us-stream.mjs';

class Socket extends EventEmitter {
  subscriptions = [];
  closes = 0;
  async connect() {}
  subscribe(...args) { this.subscriptions.push(args); }
  close() { this.closes++; this.emit('close'); }
}
const tick = () => wait(0);

test('market stream uses unique subscription IDs and serializes async messages', async () => {
  const ws = new Socket(), received = [];
  const stream = createUSStream({ marketSlugs: ['test', 'test'], client: { ws: { markets: () => ws } }, onData: async ({ event, data }) => { await wait(data === 1 ? 5 : 0); received.push([event, data]); } });
  stream.start();
  await tick();
  assert.equal(ws.subscriptions.length, 3);
  assert.equal(new Set(ws.subscriptions.map(s => s[0])).size, 3);
  assert.deepEqual(ws.subscriptions[0][2], ['test']);
  ws.emit('marketData', 1);
  ws.emit('trade', 2);
  await wait(20);
  assert.deepEqual(received, [['marketData', 1], ['trade', 2]]);
  stream.stop();
  ws.emit('trade', 3);
  await tick();
  assert.equal(received.length, 2);
});

test('private stream deduplicates subscription types without forwarding account data to status', async () => {
  const ws = new Socket(), statuses = [];
  const stream = createUSStream({ mode: 'private', client: { ws: { private: () => ws } }, onStatus: s => statuses.push(s) });
  stream.start(); await tick();
  assert.equal(ws.subscriptions.length, 3);
  assert.equal(ws.subscriptions[0][2], undefined);
  assert.ok(ws.subscriptions.some(s => s[1] === 'SUBSCRIPTION_TYPE_ACCOUNT_BALANCE'));
  assert.ok(statuses.every(s => s.stale === true), 'transport subscription is not a freshness guarantee');
  stream.stop();
});

test('stream reconnects with fresh subscriptions, then respects stop', async () => {
  const sockets = [], statuses = [];
  const stream = createUSStream({ marketSlugs: ['test'], baseDelayMs: 1, maxReconnects: 1, client: { ws: { markets: () => { const ws = new Socket(); sockets.push(ws); return ws; } } }, onStatus: s => statuses.push(s.state) });
  stream.start(); await tick();
  sockets[0].emit('close');
  await wait(15);
  assert.equal(sockets.length, 2);
  assert.notEqual(sockets[0].subscriptions[0][0], sockets[1].subscriptions[0][0]);
  sockets[1].emit('error', new Error('secret-upstream-message'));
  await wait(10);
  assert.ok(statuses.includes('exhausted'));
  assert.doesNotMatch(JSON.stringify(statuses), /secret-upstream/);
  stream.stop();
});

test('stream timeout is bounded and consumer failures stop delivery', async () => {
  const stalled = new Socket();
  stalled.connect = () => new Promise(() => {});
  const states = [];
  const timeoutStream = createUSStream({ marketSlugs: ['test'], connectTimeoutMs: 2, maxReconnects: 0, client: { ws: { markets: () => stalled } }, onStatus: s => states.push(s.state) });
  timeoutStream.start(); await wait(15);
  assert.ok(states.includes('exhausted'));
  assert.ok(stalled.closes >= 1);
  timeoutStream.stop();
  const ws = new Socket(), consumerStates = [];
  const consumer = createUSStream({ marketSlugs: ['test'], client: { ws: { markets: () => ws } }, onData: async () => { throw new Error('private-payload'); }, onStatus: s => consumerStates.push(s.state) });
  consumer.start(); await tick(); ws.emit('trade', {}); await tick();
  assert.ok(consumerStates.includes('consumer-error'));
  consumer.stop();
});

test('streams require credentials and validate subscription bounds before connecting', () => {
  assert.throws(() => createUSStream({ marketSlugs: ['test'], env: {} }), /both server credentials/);
  for (const patch of [{ mode: 'bad' }, { marketSlugs: [] }, { marketSlugs: ['../bad'] }, { marketSlugs: Array(11).fill('test') }, { events: ['market_data'] }, { maxReconnects: -1 }]) assert.throws(() => createUSStream({ marketSlugs: ['test'], client: {}, ...patch }));
});
