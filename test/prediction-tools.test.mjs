import test from 'node:test';
import assert from 'node:assert/strict';
import { manualResearchMarket, RESEARCH_TOOLS } from '../public/client/prediction-tools.mjs';
import { fetchPredictionMarkets } from '../src/shared/livesources.mjs';
const input = { question: 'Will the named team win?', url: 'https://polymarket.com/event/example', price: '39', spread: '', liquidity: '', endDate: '2026-10-25T12:00' };
test('manual research preserves missing liquidity/spread and labels user data', () => {
  const m = manualResearchMarket(input);
  assert.equal(m.yesPrice, 0.39);
  assert.equal(m.spreadPoints, null);
  assert.equal(m.liquidityUsd, null);
  assert.match(m.question, /USER-PROVIDED/);
  assert.equal(m.source, 'manual');
});
test('manual research rejects invalid prices, dates and unsafe links', () => {
  for (const patch of [{ price: '' }, { price: '100' }, { endDate: '' }, { url: 'javascript:alert(1)' }, { url: 'https://polymarket.com.evil.test' }, { spread: '-1' }]) assert.throws(() => manualResearchMarket({ ...input, ...patch }));
});
test('all three research types include resolution and source checks', () => {
  assert.deepEqual(Object.keys(RESEARCH_TOOLS), ['nfl', 'tennis', 'btc']);
  for (const t of Object.values(RESEARCH_TOOLS)) {
    assert.match(t.prompts.join(' '), /rules/);
    assert.match(t.prompts.join(' '), /source/i);
  }
});
test('named outcomes are never silently mapped to YES', async () => {
  const out = await fetchPredictionMarkets({ fetchImpl: async () => ({ ok: true, json: async () => [{ id: '1', outcomes: '["Colts","Vikings"]', outcomePrices: '["0.29","0.71"]' }] }) });
  assert.equal(out.markets[0].yesPrice, null);
});
