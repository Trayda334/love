import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthenticationError } from 'polymarket-us';
import { createPrivateUSPortfolio, validatePortfolioParams } from '../src/feeds/polymarket-us-portfolio.mjs';

test('portfolio positions preserve decimal strings and pagination without following pages', async () => {
  const data = { positions: { example: { netPositionDecimal: '-0.123456789123456789', qtyAvailableDecimal: '0.05' } }, nextCursor: 'opaque+/=', eof: false };
  const calls = [];
  const portfolio = createPrivateUSPortfolio({ client: { portfolio: { positions: async params => { calls.push(params); return data; } } } });
  const result = await portfolio.positions({ limit: 20, cursor: 'previous+/=' });
  assert.deepEqual(calls, [{ limit: 20, cursor: 'previous+/=' }]);
  assert.strictEqual(result.data, data);
  assert.equal(result.data.positions.example.netPositionDecimal, '-0.123456789123456789');
  assert.deepEqual(Object.keys(portfolio), ['positions', 'activities']);
});

test('portfolio activity filters include the supplied rebate and liquidity types', async () => {
  const params = { limit: 20, marketSlug: 'test-market', types: ['ACTIVITY_TYPE_TAKER_FEE_REBATE', 'ACTIVITY_TYPE_LIQUIDITY_PROGRAM'], sortOrder: 'SORT_ORDER_ASCENDING' };
  const data = { activities: [{ trade: { qtyDecimal: '0.123456789123456789' } }], eof: true };
  const portfolio = createPrivateUSPortfolio({ client: { portfolio: { activities: async actual => { assert.deepEqual(actual, params); return data; } } } });
  assert.strictEqual((await portfolio.activities(params)).data, data);
});

test('portfolio validation rejects invalid or unsupported filters', () => {
  for (const params of [{ limit: 0 }, { limit: 101 }, { limit: 0.5 }, { cursor: '' }, { types: ['UNKNOWN'] }, { marketSlug: '../bad' }, { sortOrder: 'DESC' }, { unknown: true }]) assert.throws(() => validatePortfolioParams(params, true));
  assert.throws(() => validatePortfolioParams({ types: ['ACTIVITY_TYPE_TRADE'] }));
  assert.deepEqual(validatePortfolioParams({}), {});
});

test('private portfolio requires credentials and sanitizes SDK failures', async () => {
  assert.throws(() => createPrivateUSPortfolio({ env: {} }), /require both/);
  const portfolio = createPrivateUSPortfolio({ client: { portfolio: { positions: async () => { throw new AuthenticationError('secret-payload'); } } } });
  await assert.rejects(portfolio.positions(), err => {
    assert.equal(err.code, 'US_AUTHENTICATION');
    assert.doesNotMatch(err.message, /secret-payload/);
    return true;
  });
});
