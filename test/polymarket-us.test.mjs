import test from 'node:test';
import assert from 'node:assert/strict';
import { PolymarketUS } from 'polymarket-us';
import { createPolymarketUSClient } from '../src/feeds/polymarket-us.mjs';

test('US SDK can initialize without credentials for public data', () => {
  assert.ok(createPolymarketUSClient({}) instanceof PolymarketUS);
});
test('US SDK rejects incomplete credentials without leaking their values', () => {
  for (const env of [{ POLYMARKET_KEY_ID: 'test-private-id' }, { POLYMARKET_SECRET_KEY: 'test-private-secret' }]) {
    assert.throws(() => createPolymarketUSClient(env), err => {
      assert.match(err.message, /Set both/);
      assert.doesNotMatch(err.message, /test-private/);
      return true;
    });
  }
});

test('public research exposes only the requested reads and validates slugs', async () => {
  const { createPublicUSResearch } = await import('../src/feeds/polymarket-us.mjs');
  const calls = [];
  const research = createPublicUSResearch({
    events: { list: async params => { calls.push(params); return { events: [] }; } },
    markets: {
      retrieveBySlug: async slug => ({ slug }),
      book: async slug => ({ slug, bids: [], asks: [] }),
    },
  });
  assert.deepEqual(await research.events(), { events: [] });
  assert.deepEqual(calls, [{ limit: 10, active: true }]);
  assert.deepEqual(await research.market('chiefs-super-bowl'), {
    market: { slug: 'chiefs-super-bowl' }, book: { slug: 'chiefs-super-bowl', bids: [], asks: [] },
  });
  for (const slug of ['', '../orders', 'https://example.com']) await assert.rejects(research.market(slug), /valid market slug/);
  assert.deepEqual(Object.keys(research).sort(), ['event', 'events', 'market', 'marketRead', 'markets', 'search', 'series', 'seriesById', 'sports', 'teams']);
});

test('private account snapshot reads balances, positions and orders without mutations', async () => {
  const { readUSAccountSnapshot } = await import('../src/feeds/polymarket-us.mjs');
  const calls = [];
  const read = (name, result) => async () => { calls.push(name); return result; };
  const result = await readUSAccountSnapshot({ client: {
    account: { balances: read('balances', { balances: [] }) },
    portfolio: { positions: read('positions', { positions: [] }) },
    orders: { list: read('orders', { orders: [] }), create: () => assert.fail('must not place orders') },
  } });
  assert.deepEqual(calls.sort(), ['balances', 'orders', 'positions']);
  assert.deepEqual(result.balances, { balances: [] });
  assert.deepEqual(result.positions, { positions: [] });
  assert.deepEqual(result.openOrders, { orders: [] });
  assert.equal(result.source, 'polymarket-us');
  assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
});

test('private account reads require credentials and sanitize upstream errors', async () => {
  const { readUSAccountSnapshot } = await import('../src/feeds/polymarket-us.mjs');
  await assert.rejects(readUSAccountSnapshot({ env: {} }), /require both/);
  const failure = async () => { throw new Error('private-key-or-account-payload'); };
  await assert.rejects(readUSAccountSnapshot({ client: {
    account: { balances: failure }, portfolio: { positions: async () => [] }, orders: { list: async () => [] },
  } }), err => {
    assert.match(err.message, /request failed/);
    assert.doesNotMatch(err.message, /private-key-or-account-payload/);
    return true;
  });
});


test('US event filters validate bounds, booleans and arrays', async () => {
  const { parseUSEventFilters } = await import('../src/feeds/polymarket-us.mjs');
  assert.deepEqual(parseUSEventFilters({ limit: '20', offset: '10', live: 'true', categories: 'sports,crypto', seriesId: '1,2', active: 'false' }), { limit: 20, offset: 10, active: false, live: true, categories: ['sports', 'crypto'], seriesId: [1, 2] });
  for (const input of [{ limit: 101 }, { offset: -1 }, { active: 'maybe' }, { seriesId: 'abc' }, { categories: '' }]) assert.throws(() => parseUSEventFilters(input));
});

test('US event retrieval selects ID or JS retrieveBySlug method', async () => {
  const { createPublicUSResearch } = await import('../src/feeds/polymarket-us.mjs');
  const research = createPublicUSResearch({ events: { retrieve: async id => ({ id }), retrieveBySlug: async slug => ({ slug }) } });
  assert.deepEqual(await research.event({ id: '123' }), { id: 123 });
  assert.deepEqual(await research.event({ slug: 'example-event' }), { slug: 'example-event' });
  for (const input of [{}, { id: 0 }, { slug: '../bad' }, { id: 1, slug: 'example' }]) assert.throws(() => research.event(input));
});


test('US market filters validate sports types and numeric thresholds', async () => {
  const { parseUSMarketFilters } = await import('../src/feeds/polymarket-us.mjs');
  assert.deepEqual(parseUSMarketFilters({ sportsMarketTypes: 'MONEYLINE,TOTAL', liquidityNumMin: '500', volumeNumMin: '0', live: true }), { limit: 10, active: true, sportsMarketTypes: ['MONEYLINE', 'TOTAL'], volumeNumMin: 0, liquidityNumMin: 500 });
  for (const params of [{ sportsMarketTypes: 'unknown' }, { liquidityNumMin: -1 }, { volumeNumMin: 'NaN' }, { limit: 0 }]) assert.throws(() => parseUSMarketFilters(params));
});

test('US market reads dispatch only whitelisted SDK methods', async () => {
  const { createPublicUSResearch } = await import('../src/feeds/polymarket-us.mjs');
  const methods = Object.fromEntries(['retrieve', 'retrieveBySlug', 'book', 'bbo', 'settlement'].map(name => [name, async value => ({ name, value })]));
  const research = createPublicUSResearch({ markets: { ...methods, list: async params => params } });
  assert.deepEqual(await research.marketRead({ id: '42' }), { name: 'retrieve', value: 42 });
  for (const kind of ['details', 'book', 'bbo', 'settlement']) assert.deepEqual(await research.marketRead({ kind, slug: 'test' }), { name: kind === 'details' ? 'retrieveBySlug' : kind, value: 'test' });
  for (const params of [{ kind: 'create', slug: 'test' }, { id: 0 }, { id: 1, kind: 'book' }, { slug: '../bad' }, { id: 1, slug: 'test' }]) assert.throws(() => research.marketRead(params));
  assert.equal((await research.markets({ limit: 20 })).limit, 20);
});

test('balance-only read preserves reported financial fields and pending withdrawals', async () => {
  const { readUSAccountBalances } = await import('../src/feeds/polymarket-us.mjs');
  const data = { currentBalance: 100, currency: 'USD', buyingPower: 43.25, assetNotional: 30, assetAvailable: 20, openOrders: 60, unsettledFunds: 5, marginRequirement: 10, pendingWithdrawals: [{ id: 'test', amount: '6.75' }] };
  let calls = 0;
  const result = await readUSAccountBalances({ client: { account: { balances: async () => { calls++; return data; } } } });
  assert.equal(calls, 1);
  assert.strictEqual(result.data, data);
  assert.equal(result.data.buyingPower, 43.25, 'do not overwrite API buying power with a locally computed value');
  assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
});

test('balance-only read also preserves the installed SDK array response shape', async () => {
  const { readUSAccountBalances } = await import('../src/feeds/polymarket-us.mjs');
  const data = { balances: [{ currency: 'USD', currentBalance: '100.123456789' }] };
  const result = await readUSAccountBalances({ client: { account: { balances: async () => data } } });
  assert.strictEqual(result.data, data);
});

test('balance-only read requires credentials and sanitizes authentication errors', async () => {
  const { readUSAccountBalances } = await import('../src/feeds/polymarket-us.mjs');
  const { AuthenticationError } = await import('polymarket-us');
  await assert.rejects(readUSAccountBalances({ env: {} }), /require both/);
  await assert.rejects(readUSAccountBalances({ client: { account: { balances: async () => { throw new AuthenticationError('private-secret'); } } } }), error => {
    assert.equal(error.code, 'US_AUTHENTICATION');
    assert.doesNotMatch(error.message, /private-secret/);
    return true;
  });
});


test('US series filters validate pagination, slug lists, recurrence and status', async () => {
  const { parseUSSeriesFilters } = await import('../src/feeds/polymarket-us.mjs');
  assert.deepEqual(parseUSSeriesFilters({ limit: '20', offset: '20', active: 'false', slug: 'nfl,daily-btc', recurrence: 'daily' }), { limit: 20, offset: 20, active: false, slug: ['nfl', 'daily-btc'], recurrence: 'daily' });
  for (const params of [{ slug: [] }, { slug: '../bad' }, { recurrence: '' }, { recurrence: 'bad value' }, { limit: 101 }, { offset: -1 }, { live: true }, { active: 'maybe' }]) assert.throws(() => parseUSSeriesFilters(params));
});

test('US series reads call SDK list/retrieve and reject invalid IDs', async () => {
  const { createPublicUSResearch } = await import('../src/feeds/polymarket-us.mjs');
  const research = createPublicUSResearch({ series: { list: async params => ({ params, series: [] }), retrieve: async id => ({ series: { id, title: 'Example' } }) } });
  assert.deepEqual(await research.series({ limit: 20 }), { params: { limit: 20, active: true }, series: [] });
  assert.deepEqual(await research.seriesById('123'), { series: { id: 123, title: 'Example' } });
  for (const id of ['', null, undefined, 0, -1, 1.5, 'abc', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => research.seriesById(id));
});


test('US sports and team reads preserve raw configuration and team maps', async () => {
  const { createPublicUSResearch } = await import('../src/feeds/polymarket-us.mjs');
  const sports = { sports: [{ sport: 'Football', isOperational: false, automaticResolution: true }] };
  const teams = { teams: { '123': { name: 'Example', record: '3-2' } } };
  const research = createPublicUSResearch({ sports: { list: async () => sports, teams: async params => {
    assert.deepEqual(params, { provider: 'PROVIDER_SPORTRADAR', league: 'NFL', teamIds: ['123'] });
    return teams;
  } } });
  assert.strictEqual(await research.sports(), sports);
  assert.strictEqual(await research.teams({ provider: 'PROVIDER_SPORTRADAR', league: 'NFL', teamIds: [123] }), teams);
});

test('US team filters validate provider/league and preserve integer ID precision', async () => {
  const { parseUSTeamFilters } = await import('../src/feeds/polymarket-us.mjs');
  assert.deepEqual(parseUSTeamFilters({ teamIds: '123,9007199254740993' }), { teamIds: ['123', '9007199254740993'] });
  assert.deepEqual(parseUSTeamFilters({}), {});
  for (const input of [{ provider: 'UNKNOWN' }, { league: '../bad' }, { teamIds: [] }, { teamIds: '1.5' }, { teamIds: '-1' }, { teamIds: [Number.MAX_SAFE_INTEGER + 1] }, { unknown: true }]) assert.throws(() => parseUSTeamFilters(input));
});


test('US search forwards validated text, pagination and array filters', async () => {
  const { createPublicUSResearch } = await import('../src/feeds/polymarket-us.mjs');
  const data = { events: [{ title: 'Example', markets: [{ slug: 'example-market' }] }] };
  const research = createPublicUSResearch({ search: { query: async params => {
    assert.deepEqual(params, { query: 'bitcoin', limit: 20, page: 1, seriesIds: [123, 456], marketType: ['MONEYLINE'], status: 'active' });
    return data;
  } } });
  assert.strictEqual(await research.search({ query: ' bitcoin ', limit: '20', page: '1', seriesIds: '123,456', marketType: 'MONEYLINE', status: 'active' }), data);
});

test('US search rejects empty text and malformed filters before SDK access', async () => {
  const { parseUSSearchFilters } = await import('../src/feeds/polymarket-us.mjs');
  assert.deepEqual(parseUSSearchFilters({ query: 'NFL' }), { query: 'NFL', limit: 10 });
  for (const patch of [{ query: '' }, { query: '  ' }, { limit: 101 }, { page: -1 }, { page: 0.5 }, { seriesIds: 'bad' }, { marketType: [] }, { marketType: '../bad' }, { status: 'unknown' }, { extra: true }]) assert.throws(() => parseUSSearchFilters({ query: 'test', ...patch }));
});
