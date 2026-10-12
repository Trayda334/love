import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchRawFromSource, fetchMarketData, searchMarkets, normalizePairInput, tokenFromPair } from '../src/shared/livesources.mjs';
import { ingestClientSnapshot, manualSnapshot, demoSnapshot, liveSnapshot, DATA_QUALITY } from '../src/feeds/index.mjs';

const FIVE = 5 * 60 * 1000;
const bucket = Math.floor(Date.now() / FIVE) * FIVE;

/** Coinbase-shaped fake: rows are [time, low, high, open, close, volume], newest first. */
function coinbaseCandles(n = 60) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const t = Math.floor((bucket - i * FIVE) / 1000);
    const open = 100 + (n - i) * 0.1;
    rows.push([t, open - 1, open + 1, open, open + 0.5, 12.5]);
  }
  return rows;
}

function fakeFetch(routes) {
  return async (url) => {
    for (const [match, respond] of Object.entries(routes)) {
      if (url.includes(match)) {
        const out = typeof respond === 'function' ? respond(url) : respond;
        if (out instanceof Error) throw out;
        if (out === undefined) throw new Error(`no route for ${url}`);
        return { ok: true, status: 200, json: async () => out };
      }
    }
    throw new Error(`unmocked url: ${url}`);
  };
}

test('pair normalisation handles CEX and CoinGecko shapes', () => {
  assert.deepEqual(normalizePairInput('btc-usd', 'coinbase'), { source: 'coinbase', pair: 'BTC-USD' });
  assert.deepEqual(normalizePairInput('XBTUSD', 'kraken'), { source: 'kraken', pair: 'XBTUSD' });
  assert.deepEqual(normalizePairInput('kraken:ethusd', 'coinbase'), { source: 'kraken', pair: 'ETHUSD' });
  assert.equal(tokenFromPair('BTC-USD'), 'BTC');
  assert.equal(tokenFromPair('XBTUSD'), 'BTC', 'XBT is Kraken\'s name for BTC, including in concatenated pairs');
  assert.equal(tokenFromPair('SOLUSDT'), 'SOL');
});

test('Coinbase rows are mapped in the right order (low/high must not be swapped)', async () => {
  const fetchImpl = fakeFetch({
    '/candles': coinbaseCandles(50),
    '/ticker': { price: '123.45', volume: '1000' },
    '/stats': { open: '120', high: '130', low: '110' },
    '/products/BTC-USD': { base_currency: 'BTC', quote_currency: 'USD' },
  });
  const raw = await fetchRawFromSource('coinbase', 'BTC-USD', { fetchImpl });
  assert.equal(raw.candles.length, 50);
  const c = raw.candles[raw.candles.length - 1];
  assert.ok(c.l < c.o && c.o < c.h, `low ${c.l} < open ${c.o} < high ${c.h}`);
  assert.equal(c.v, 12.5);
  assert.equal(raw.ticker.price, 123.45);
  assert.equal(raw.ticker.volume24hUsd, 123450);
  assert.ok(raw.ticker.change24hPct > 2.8 && raw.ticker.change24hPct < 2.9);
  assert.equal(raw.candles[0].t <= raw.candles[1].t, true, 'candles are sorted oldest first');
});

test('the source chain falls through to the next source when the first fails', async () => {
  const fetchImpl = fakeFetch({
    'exchange.coinbase.com': new Error('blocked by network policy'),
    'api.kraken.com': new Error('also blocked'),
    'api.binance.com/api/v3/klines': Array.from({ length: 40 }, (_, i) => [bucket - i * FIVE, 10, 11, 10.5, 10.8, 5]),
  });
  const result = await fetchMarketData('SOL-USD', { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.raw.source, 'binance');
  assert.ok(result.attempts.some((a) => a.source === 'coinbase' && a.ok === false));
  assert.ok(result.attempts.some((a) => a.source === 'kraken' && a.ok === false));
});

test('when nothing is reachable the feed says so instead of inventing data', async () => {
  const fetchImpl = async () => {
    throw new Error('offline');
  };
  const result = await fetchMarketData('BTC-USD', { fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.message, /invent|no live source/i);
  assert.equal(result.attempts.length, 4);
  const direct = await liveSnapshot('BTC-USD', { timeoutMs: 1500 });
  assert.equal(direct.ok, false);
  assert.equal(direct.code, 'LIVE_UNREACHABLE');
});

test('client-fetched payloads are recomputed server-side and never trusted', () => {
  const out = ingestClientSnapshot({
    source: 'coinbase',
    pair: 'BTC-USD',
    token: 'BTC',
    candles: coinbaseCandles(60),
    ticker: { price: 106.5, volume24hUsd: 5_000_000 },
    metrics: { r5: 999, verdict: 'PASS', trustMe: true },
  });
  assert.equal(out.ok, true);
  assert.equal(out.snapshot.dataQuality, DATA_QUALITY.LIVE_BROWSER);
  assert.notEqual(out.snapshot.metrics.r5, 999, 'client-supplied metrics are ignored');
  assert.ok(Math.abs(out.snapshot.metrics.r5) < 1);
  assert.equal(out.snapshot.metrics.clientSuppliedMetricsRejected, undefined);
});

test('an empty client payload is refused', () => {
  assert.equal(ingestClientSnapshot({}).ok, false);
  assert.equal(ingestClientSnapshot({ candles: [], ticker: null }).code, 'EMPTY_PAYLOAD');
  assert.equal(ingestClientSnapshot(null).code, 'BAD_PAYLOAD');
});

test('manual snapshots keep unknown fields unknown and label themselves', () => {
  const out = manualSnapshot({ token: 'WIF', price: '2.5', r15: '1.4', support: '2.3', resistance: '2.9', volume24hUsd: '9000000' });
  assert.equal(out.ok, true);
  assert.equal(out.snapshot.dataQuality, DATA_QUALITY.MANUAL);
  assert.equal(out.snapshot.metrics.r15, 1.4);
  assert.equal(out.snapshot.metrics.volume24hUsd, 9_000_000);
  assert.equal(out.snapshot.metrics.atrPct, null, 'no candle history => null, not a guess');
  assert.equal(out.snapshot.metrics.candleFieldsUnknown, true);
  assert.ok(Math.abs(out.snapshot.metrics.distToSupportPct - ((2.5 - 2.3) / 2.3) * 100) < 1e-6);
  assert.equal(manualSnapshot({ token: 'X' }).code, 'BAD_PRICE');
});

test('demo snapshots are watermarked and shaped to test the rules', () => {
  const base = demoSnapshot({ scenario: 'base' });
  assert.match(base.snapshot.dataQuality, /^DEMO/);
  assert.equal(base.snapshot.metrics.ok, true);
  assert.equal(base.snapshot.metrics.baseDetected, true);
  const pump = demoSnapshot({ scenario: 'pump' });
  assert.equal(pump.snapshot.metrics.extended, true);
  assert.ok(pump.snapshot.metrics.r15 > 15);
  assert.equal(demoSnapshot({ scenario: 'volatile' }).snapshot.metrics.atrPct > 5, true);
  assert.ok(demoSnapshot({ scenario: 'nonsense' }).snapshot.candles.length > 0, 'unknown scenarios fall back to base');
});

test('search normalises different catalog shapes into one list', async () => {
  const fetchImpl = fakeFetch({
    'exchange.coinbase.com/products': [
      { id: 'BTC-USD', base_currency: 'BTC', quote_currency: 'USD', status: 'online' },
      { id: 'BTC-USDC', base_currency: 'BTC', quote_currency: 'USDC', status: 'online' },
      { id: 'ETH-USD', base_currency: 'ETH', quote_currency: 'USD', status: 'offline' },
    ],
    'api.kraken.com/0/public/AssetPairs': new Error('blocked'),
    'api.coingecko.com': { coins: [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }] },
  });
  const out = await searchMarkets('BTC', { fetchImpl });
  assert.equal(out.ok, true);
  const pairs = out.results.map((r) => r.pair);
  assert.ok(pairs.includes('BTC-USD'));
  assert.ok(pairs.includes('BTC-USDC'));
  assert.ok(!pairs.includes('ETH-USD'), 'offline products are filtered out');
  assert.ok(out.results.some((r) => r.source === 'coingecko'));
  assert.ok(out.attempts.some((a) => a.source === 'kraken' && a.ok === false));
});
