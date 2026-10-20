import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveHTTP } from '../src/live/http.mjs';

const origin = 'https://private.example.test';
const env = { LIVE_TRADING_ENABLED: 'true', LIVE_APP_ORIGIN: origin, LIVE_ADMIN_PASSWORD: 'test-only-long-private-app-password-12345', POLYMARKET_KEY_ID: 'mock-key', POLYMARKET_SECRET_KEY: 'mock-secret' };
function fixture() {
  let clock = 1000000;
  const calls = [];
  const trading = { health: () => ({ uncertain: false }), account: async () => { calls.push('account'); return { balances: { currentBalance: 10 } }; }, preview: async (body, owner) => { calls.push(['preview', body, owner]); return { id: 'draft' }; }, submit: async (body, owner) => { calls.push(['submit', body, owner]); return { id: 'operation' }; }, operation: id => ({ id, state: 'ACCEPTED' }) };
  const api = createLiveHTTP({ env, trading, now: () => clock });
  const request = async (route, { method = 'GET', body = {}, headers = {} } = {}) => api.handle({ method, headers: { host: 'private.example.test', origin, 'content-type': 'application/json', ...headers } }, new URL(`${origin}/api/live/${route}`), async () => body);
  const login = async () => {
    const result = await request('login', { method: 'POST', body: { password: env.LIVE_ADMIN_PASSWORD } });
    assert.equal(result.status, 200);
    return { cookie: result.headers['set-cookie'].split(';')[0], 'x-csrf-token': result.payload.csrf };
  };
  return { api, request, login, calls, advance: ms => { clock += ms; } };
}

test('live API is disabled by default and fails closed on incomplete configuration', async () => {
  for (const config of [{}, { ...env, LIVE_TRADING_ENABLED: 'false' }, { ...env, LIVE_ADMIN_PASSWORD: 'short' }, { ...env, LIVE_APP_ORIGIN: 'http://private.example.test' }, { ...env, POLYMARKET_KEY_ID: '' }]) {
    const api = createLiveHTTP({ env: config });
    assert.equal(api.enabled, false);
    const res = await api.handle({ method: 'POST', headers: {} }, new URL(`${origin}/api/live/submit`), () => assert.fail('must not read body'));
    assert.equal(res.status, 503);
  }
});

test('private reads and mutation routes require a valid session', async () => {
  const f = fixture();
  for (const route of ['account', 'operation?id=x']) assert.equal((await f.request(route)).status, 401);
  for (const route of ['preview', 'submit']) assert.equal((await f.request(route, { method: 'POST' })).status, 401);
  assert.equal(f.calls.length, 0);
  const headers = await f.login();
  assert.equal((await f.request('account', { headers })).status, 200);
  assert.deepEqual(f.calls, ['account']);
});

test('secure session cookies and CSRF protect live actions; foreign origins/hosts rejected', async () => {
  const f = fixture();
  const login = await f.request('login', { method: 'POST', body: { password: env.LIVE_ADMIN_PASSWORD } });
  assert.match(login.headers['set-cookie'], /HttpOnly; Secure; SameSite=Strict/);
  assert.match(login.headers['set-cookie'], /Path=\/api\/live/);
  const cookie = login.headers['set-cookie'].split(';')[0];
  assert.equal((await f.request('preview', { method: 'POST', headers: { cookie } })).status, 403);
  const headers = { cookie, 'x-csrf-token': login.payload.csrf };
  for (const overrides of [{ origin: 'https://evil.test' }, { origin: undefined }, { host: 'evil.test' }, { 'content-type': 'text/plain' }, { 'sec-fetch-site': 'cross-site' }]) assert.equal((await f.request('submit', { method: 'POST', headers: { ...headers, ...overrides } })).status, 403);
  assert.equal((await f.request('preview', { method: 'POST', headers, body: { marketSlug: 'example' } })).status, 200);
  assert.equal(f.calls.filter(c => Array.isArray(c) && c[0] === 'submit').length, 0);
});

test('sessions expire, logout revokes, and new login invalidates prior cookie', async () => {
  const f = fixture();
  const first = await f.login();
  const second = await f.login();
  assert.equal((await f.request('account', { headers: first })).status, 401);
  assert.equal((await f.request('logout', { method: 'POST', headers: second })).status, 200);
  assert.equal((await f.request('account', { headers: second })).status, 401);
  const third = await f.login();
  f.advance(15 * 60 * 1000 + 1);
  assert.equal((await f.request('account', { headers: third })).status, 401);
});

test('login has a bounded attempt window and never echoes secrets', async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) {
    const result = await f.request('login', { method: 'POST', body: { password: 'wrong-secret' } });
    assert.equal(result.status, 401);
    assert.doesNotMatch(JSON.stringify(result), /wrong-secret|mock-secret/);
  }
  assert.equal((await f.request('login', { method: 'POST', body: { password: env.LIVE_ADMIN_PASSWORD } })).status, 429);
  f.advance(15 * 60 * 1000 + 1);
  await f.login();
});

test('authenticated operation recovery and submit are passed only to the service', async () => {
  const f = fixture(), headers = await f.login();
  const result = await f.request('submit', { method: 'POST', headers, body: { previewId: 'draft', confirmation: 'confirmed', acknowledged: true } });
  assert.equal(result.status, 200);
  const call = f.calls[0];
  assert.equal(call[0], 'submit');
  assert.equal(typeof call[2], 'string');
  assert.notEqual(call[2], headers.cookie, 'service uses a session digest, not the raw cookie');
  assert.equal((await f.request('operation?id=operation', { headers })).payload.operation.state, 'ACCEPTED');
});
