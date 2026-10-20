/**
 * feedcore.mjs - pure, dependency-free market math shared by the Node server
 * and the browser client. No Node builtins, no DOM: it runs in both places.
 *
 * PAPER MODE ONLY. Nothing in this file can place an order anywhere.
 */

export const FIVE_MIN_MS = 5 * 60 * 1000;
export const MINUTE_MS = 60 * 1000;

/* ------------------------------------------------------------------ *
 * small numeric helpers
 * ------------------------------------------------------------------ */

export function toNum(x) {
  if (typeof x === 'number') return x;
  if (typeof x === 'string' && x.trim() !== '') return Number(x);
  return NaN;
}

export function round(n, d = 2) {
  if (!Number.isFinite(n)) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** percent change from `from` to `to` */
export function pct(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  return ((to - from) / from) * 100;
}

export function mean(arr) {
  const v = arr.filter(Number.isFinite);
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

export function stdev(arr) {
  const v = arr.filter(Number.isFinite);
  if (v.length < 2) return null;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

/* ------------------------------------------------------------------ *
 * candles
 * ------------------------------------------------------------------ */

/**
 * Accepts candle arrays in several shapes and returns
 * [{ t: ms, o, h, l, c, v }] sorted ascending by time.
 */
export function normalizeCandles(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const row of raw) {
    if (!row) continue;
    let t, o, h, l, c, v;
    if (Array.isArray(row)) {
      [t, o, h, l, c, v] = row;
    } else {
      t = row.t ?? row.time ?? row.ts;
      o = row.o ?? row.open;
      h = row.h ?? row.high;
      l = row.l ?? row.low;
      c = row.c ?? row.close;
      v = row.v ?? row.volume;
    }
    t = toNum(t);
    o = toNum(o);
    h = toNum(h);
    l = toNum(l);
    c = toNum(c);
    v = toNum(v);
    if (![t, o, h, l, c].every(Number.isFinite)) continue;
    // seconds -> ms
    if (t > 0 && t < 1e12) t *= 1000;
    out.push({ t, o, h, l, c, v: Number.isFinite(v) ? v : 0 });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * Drops the still-forming candle. Exchanges include a partial current bucket;
 * using it would make "last 5 minute move" flicker and can invent data.
 */
export function dropInProgress(candles, now, intervalMs = FIVE_MIN_MS) {
  const list = candles.slice();
  while (list.length > 5) {
    const last = list[list.length - 1];
    if (now - last.t < intervalMs) list.pop();
    else break;
  }
  return list;
}

/** Aggregate 5m candles into larger buckets (used for context, e.g. 1h). */
export function aggregate(candles, factor) {
  if (factor <= 1) return candles.slice();
  const out = [];
  for (let i = 0; i < candles.length; i += factor) {
    const chunk = candles.slice(i, i + factor);
    if (!chunk.length) continue;
    out.push({
      t: chunk[0].t,
      o: chunk[0].o,
      h: Math.max(...chunk.map((c) => c.h)),
      l: Math.min(...chunk.map((c) => c.l)),
      c: chunk[chunk.length - 1].c,
      v: chunk.reduce((a, c) => a + c.v, 0),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * metrics
 * ------------------------------------------------------------------ */

/** Wilder-style true range average over the last `period` candles. */
export function atr(candles, period = 14) {
  if (candles.length < 2) return null;
  const slice = candles.slice(-(period + 1));
  const trs = [];
  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1];
    const cur = slice[i];
    trs.push(Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c)));
  }
  return mean(trs);
}

export function candleRangePct(c) {
  if (!c || !Number.isFinite(c.l) || c.l === 0) return null;
  return ((c.h - c.l) / c.l) * 100;
}

export function candleBodyPct(c) {
  if (!c || !Number.isFinite(c.o) || c.o === 0) return null;
  return ((Math.abs(c.c - c.o)) / c.o) * 100;
}

/**
 * Everything the six agents are allowed to reason about.
 * If a field cannot be computed from real data it is null / unknown - never guessed.
 */
export function computeMetrics(candles5m, opts = {}) {
  const { now = Date.now(), ticker = null } = opts;
  const notes = [];
  const closed = dropInProgress(normalizeCandles(candles5m), now, FIVE_MIN_MS);
  const m = {
    candles: closed.length,
    now,
    lastCandleTs: closed.length ? closed[closed.length - 1].t : null,
  };

  if (closed.length < 5) {
    return { ...m, ok: false, reason: 'Not enough closed 5-minute candles to compute anything reliable.', notes };
  }

  const last = closed[closed.length - 1];
  const price = Number.isFinite(toNum(ticker?.price)) ? toNum(ticker.price) : last.c;
  m.price = price;

  const closeAt = (nBack) => {
    const idx = closed.length - 1 - nBack;
    return idx >= 0 ? closed[idx].c : null;
  };

  m.r5 = pct(closeAt(1), price);
  m.r15 = pct(closeAt(3), price);
  m.r60 = pct(closeAt(12), price);
  if (closed.length >= 288) m.r24hFromCandles = pct(closeAt(288), price);

  m.change24h = Number.isFinite(toNum(ticker?.change24hPct)) ? toNum(ticker.change24hPct) : null;
  m.high24h = Number.isFinite(toNum(ticker?.high24h)) ? toNum(ticker.high24h) : null;
  m.low24h = Number.isFinite(toNum(ticker?.low24h)) ? toNum(ticker.low24h) : null;
  m.volume24hUsd = Number.isFinite(toNum(ticker?.volume24hUsd)) ? toNum(ticker.volume24hUsd) : null;
  m.marketCapUsd = Number.isFinite(toNum(ticker?.marketCapUsd)) ? toNum(ticker.marketCapUsd) : null;
  m.liquidityUsd = Number.isFinite(toNum(ticker?.liquidityUsd)) ? toNum(ticker.liquidityUsd) : null;
  if (m.liquidityUsd === null) notes.push('Pool/order-book liquidity was not supplied by the data source (CEX feeds do not publish DEX pool depth).');

  const a = atr(closed, 14);
  m.atrAbs = a;
  m.atrPct = a && price ? (a / price) * 100 : null;

  const rets = [];
  for (let i = closed.length - 20; i < closed.length; i++) {
    if (i <= 0) continue;
    const r = pct(closed[i - 1].c, closed[i].c);
    if (Number.isFinite(r)) rets.push(r);
  }
  m.stdev5mPct = stdev(rets);
  const ranges = closed.slice(-20).map(candleRangePct).filter(Number.isFinite);
  m.avgCandleRangePct = mean(ranges);
  m.maxCandleRangePct = ranges.length ? Math.max(...ranges) : null;

  const volRecent = mean(closed.slice(-3).map((c) => c.v));
  const volBase = mean(closed.slice(-23, -3).map((c) => c.v));
  m.volumeLastCandle = last.v;
  m.volumeRatio = volBase && volBase > 0 ? volRecent / volBase : null;
  m.volumeLastRatio = volBase && volBase > 0 ? last.v / volBase : null;

  const slice1h = closed.slice(-12);
  const slice3h = closed.slice(-36);
  m.support1h = Math.min(...slice1h.map((c) => c.l));
  m.resistance1h = Math.max(...slice1h.map((c) => c.h));
  m.support3h = Math.min(...slice3h.map((c) => c.l));
  m.resistance3h = Math.max(...slice3h.map((c) => c.h));
  m.distToSupportPct = pct(m.support1h, price);
  m.distToResistancePct = pct(price, m.resistance1h);
  const span = m.resistance1h - m.support1h;
  m.positionIn1hRange = span > 0 ? (price - m.support1h) / span : null;

  const slice6 = closed.slice(-6);
  m.recentLow6 = Math.min(...slice6.map((c) => c.l));
  m.recentHigh6 = Math.max(...slice6.map((c) => c.h));

  const rangeOf = (n) => {
    const s = closed.slice(-n);
    if (!s.length) return null;
    const hi = Math.max(...s.map((c) => c.h));
    const lo = Math.min(...s.map((c) => c.l));
    return price ? ((hi - lo) / price) * 100 : null;
  };
  m.base3RangePct = rangeOf(3);
  m.base6RangePct = rangeOf(6);
  m.base12RangePct = rangeOf(12);
  m.consolidating = m.base3RangePct !== null && m.base3RangePct <= 1.2;
  m.baseDetected = m.base6RangePct !== null && m.base6RangePct <= 2.5;

  const bodies = closed.slice(-20).map(candleBodyPct).filter(Number.isFinite);
  m.avgBodyPct = mean(bodies);
  m.lastCandle = {
    green: last.c > last.o,
    red: last.c < last.o,
    bodyPct: candleBodyPct(last),
    rangePct: candleRangePct(last),
    bodyToAvgBody: m.avgBodyPct ? candleBodyPct(last) / m.avgBodyPct : null,
    ts: last.t,
  };

  m.trend1h = Number.isFinite(m.r60) ? (m.r60 > 1.5 ? 'up' : m.r60 < -1.5 ? 'down' : 'flat') : null;
  m.trend24h = Number.isFinite(m.change24h) ? (m.change24h > 4 ? 'up' : m.change24h < -4 ? 'down' : 'flat') : null;

  m.extended =
    (Number.isFinite(m.r15) && m.r15 >= 8 && !m.baseDetected) ||
    (m.positionIn1hRange !== null && m.positionIn1hRange >= 0.9 && Number.isFinite(m.r15) && m.r15 >= 4) ||
    (m.positionIn1hRange !== null && m.positionIn1hRange >= 0.97);

  m.pullback = Number.isFinite(m.r5) && Number.isFinite(m.r15) && m.r5 < 0 && m.r15 > -6 && m.positionIn1hRange !== null && m.positionIn1hRange <= 0.6;
  m.orderly = Number.isFinite(m.atrPct) && m.atrPct <= 3;

  m.ok = true;
  m.notes = notes;
  return m;
}

/* ------------------------------------------------------------------ *
 * shared vocabulary
 * ------------------------------------------------------------------ */

/**
 * Mistake taxonomy. Every blocked setup and every losing trade is tagged with
 * one of these so the Logger can report "most common mistake" honestly.
 */
export const MISTAKE_CATEGORIES = [
  'Chased an extended move (Anti-FOMO)',
  'Stop too far from entry (Sizer)',
  'Stop inside the noise (Sizer)',
  'Reward/risk below minimum (Sizer)',
  'No clean setup / invalidation (Scanner)',
  'Excessive volatility (Scanner)',
  'Thin volume / liquidity unverified (Scanner)',
  'Hype-based rationale (Anti-FOMO)',
  'Position cap reduced size (Sizer)',
  'One-position rule (Sizer)',
  'Manual close judgement call',
  'Held too long',
  'Exited early',
  'Data quality problem',
  'Operator declined (human judgement)',
  'None / unknown',
];

export function categoryForBlock({ scanner, antiFomo, sizer, buyer }) {
  if (antiFomo && antiFomo.verdict === 'BLOCK') {
    const ids = (antiFomo.checks || []).filter((c) => c.status === 'trigger').map((c) => c.id);
    if (ids.includes('hype-rationale')) return 'Hype-based rationale (Anti-FOMO)';
    return 'Chased an extended move (Anti-FOMO)';
  }
  if (sizer && sizer.verdict === 'REJECT') {
    const ids = (sizer.checks || []).filter((c) => c.status === 'trigger').map((c) => c.id);
    if (ids.includes('max-stop')) return 'Stop too far from entry (Sizer)';
    if (ids.includes('min-stop')) return 'Stop inside the noise (Sizer)';
    if (ids.includes('risk-reward')) return 'Reward/risk below minimum (Sizer)';
    return 'Stop too far from entry (Sizer)';
  }
  if (scanner && scanner.verdict === 'SKIP') {
    const ids = (scanner.checks || []).filter((c) => c.status === 'trigger').map((c) => c.id);
    if (ids.includes('volatility')) return 'Excessive volatility (Scanner)';
    if (ids.includes('volume')) return 'Thin volume / liquidity unverified (Scanner)';
    return 'No clean setup / invalidation (Scanner)';
  }
  if (buyer && buyer.verdict === 'BLOCKED') return 'Data quality problem';
  return 'None / unknown';
}

export const PAPER_ONLY_NOTICE =
  'PAPER MODE ONLY. This research workflow never sends a live order. Its fills are simulated. The separate authenticated live gateway is not used by paper agents.';
