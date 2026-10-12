import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeCandles, dropInProgress, computeMetrics, atr, pct, round, MISTAKE_CATEGORIES, categoryForBlock,
} from '../src/shared/feedcore.mjs';

const MIN = 60 * 1000;
const FIVE = 5 * MIN;
const nowBucket = Math.floor(Date.now() / FIVE) * FIVE;

function series(closes, { volume = 100, bucket = nowBucket } = {}) {
  return closes.map((c, i) => ({
    t: bucket - (closes.length - 1 - i) * FIVE,
    o: i === 0 ? c : closes[i - 1],
    h: Math.max(i === 0 ? c : closes[i - 1], c) * 1.001,
    l: Math.min(i === 0 ? c : closes[i - 1], c) * 0.999,
    c,
    v: volume,
  }));
}

test('normalizeCandles accepts arrays and objects, sorts, and converts seconds to ms', () => {
  // array form is [time, open, high, low, close, volume] - adapters re-map source
  // specific shapes (e.g. Coinbase's low-first rows) before they get here.
  const arr = normalizeCandles([[1700000000, 1.5, 2, 1, 1.8, 10]]);
  assert.equal(arr.length, 1);
  assert.equal(arr[0].t, 1700000000000);
  assert.equal(arr[0].o, 1.5);
  assert.equal(arr[0].h, 2);
  assert.equal(arr[0].l, 1);
  assert.equal(arr[0].c, 1.8);
  const obj = normalizeCandles([{ time: 1700000300, open: 1, high: 2, low: 0.5, close: 1.2, volume: 3 }]);
  assert.equal(obj[0].c, 1.2);
  assert.equal(normalizeCandles([{ t: 1, o: 1 }]).length, 0, 'incomplete rows are dropped, never guessed');
  const sorted = normalizeCandles([
    { t: 1700000300, o: 1, h: 1, l: 1, c: 1 },
    { t: 1700000000, o: 1, h: 1, l: 1, c: 1 },
  ]);
  assert.deepEqual(sorted.map((c) => c.t), [1700000000000, 1700000300000]);
});

test('dropInProgress removes the still-forming candle so moves do not flicker', () => {
  const candles = series(Array.from({ length: 10 }, (_, i) => 1 + i * 0.01));
  // series() already ends on the current bucket, so that candle is dropped too
  const withCurrent = [...candles, { t: nowBucket + FIVE, o: 1, h: 1, l: 1, c: 1, v: 1 }];
  const kept = dropInProgress(withCurrent, Date.now(), FIVE);
  assert.equal(kept.length, 9);
  assert.ok(kept.every((c) => c.t <= nowBucket - FIVE), 'only fully closed candles survive');
});

test('computeMetrics refuses to guess when there is not enough history', () => {
  const m = computeMetrics(series([1, 1.01, 1.02]), { now: Date.now() });
  assert.equal(m.ok, false);
  assert.match(m.reason, /Not enough/);
  assert.equal(m.r5, undefined);
});

test('computeMetrics computes the last 5 and 15 minute moves from closed candles', () => {
  const closes = [...Array.from({ length: 40 }, () => 1), 1.0, 1.01, 1.02, 1.03];
  const m = computeMetrics(series(closes), { now: Date.now() });
  assert.equal(m.ok, true);
  // the newest candle is still forming, so price is the last closed close (1.02)
  assert.ok(Math.abs(m.r5 - 0.99) < 0.02, `r5 was ${m.r5}`);
  assert.ok(Math.abs(m.r15 - 2.0) < 0.02, `r15 was ${m.r15}`);
});

test('computeMetrics keeps unknown values null instead of inventing them', () => {
  const m = computeMetrics(series(Array.from({ length: 60 }, () => 1)), { now: Date.now() });
  assert.equal(m.volume24hUsd, null);
  assert.equal(m.liquidityUsd, null);
  assert.equal(m.change24h, null, 'no ticker and no 24h of candles => null, not 0');
  assert.ok(m.notes.some((n) => /liquidity/i.test(n)));
});

test('ticker context is used when supplied', () => {
  const m = computeMetrics(series(Array.from({ length: 60 }, () => 2)), {
    now: Date.now(),
    ticker: { price: 2, volume24hUsd: 5_000_000, change24hPct: -7, liquidityUsd: 900_000 },
  });
  assert.equal(m.volume24hUsd, 5_000_000);
  assert.equal(m.change24h, -7);
  assert.equal(m.trend24h, 'down');
  assert.equal(m.liquidityUsd, 900_000);
});

test('atr and helpers behave sanely', () => {
  const candles = series([1, 1.02, 1.01, 1.03, 1.02, 1.04]);
  const a = atr(candles, 5);
  assert.ok(a > 0);
  assert.equal(pct(100, 110), 10);
  assert.equal(pct(0, 10), null);
  assert.equal(round(1.23456, 3), 1.235);
  assert.equal(atr([{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 }], 14), null);
});

test('a vertical pump is flagged as extended and a tight coil is detected as a base', () => {
  const pumpCloses = [...Array.from({ length: 40 }, () => 1)];
  for (let i = 0; i < 6; i++) pumpCloses.push(pumpCloses[pumpCloses.length - 1] * 1.05);
  const pump = computeMetrics(series(pumpCloses), { now: Date.now() });
  assert.equal(pump.extended, true);
  assert.ok(pump.r15 > 15);

  const coil = computeMetrics(series(Array.from({ length: 60 }, (_, i) => 1 + (i % 2) * 0.0005)), { now: Date.now() });
  assert.equal(coil.consolidating, true);
  assert.equal(coil.extended, false);
});

test('mistake taxonomy is stable and block categorisation points at the right agent', () => {
  assert.ok(MISTAKE_CATEGORIES.includes('Chased an extended move (Anti-FOMO)'));
  const cat = categoryForBlock({
    antiFomo: { verdict: 'BLOCK', checks: [{ id: 'move-15m', status: 'trigger' }] },
  });
  assert.match(cat, /Anti-FOMO/);
  const sizerCat = categoryForBlock({ sizer: { verdict: 'REJECT', checks: [{ id: 'max-stop', status: 'trigger' }] } });
  assert.match(sizerCat, /Stop too far/);
  const scannerCat = categoryForBlock({ scanner: { verdict: 'SKIP', checks: [{ id: 'volatility', status: 'trigger' }] } });
  assert.match(scannerCat, /volatility/i);
});
