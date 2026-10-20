/**
 * livesources.mjs - real market-data adapters. Pure fetch + JSON, no Node
 * builtins and no DOM, so the SAME code runs:
 *   - on the Node server (server-side fetch), and
 *   - in the user's browser (direct fetch fallback, when the server's
 *     egress is blocked by a sandbox/firewall).
 *
 * The app never invents numbers. If every source fails, the caller must show
 * that fact and fall back to explicit manual entry or clearly-labelled demo data.
 */

import { normalizeCandles, pct } from './feedcore.mjs';

export const SOURCE_INFO = {
  coinbase: {
    id: 'coinbase',
    label: 'Coinbase Exchange (public)',
    kind: 'cex',
    supports: ['candles5m', 'ticker', 'search'],
  },
  kraken: {
    id: 'kraken',
    label: 'Kraken (public)',
    kind: 'cex',
    supports: ['candles5m', 'ticker', 'search'],
  },
  binance: {
    id: 'binance',
    label: 'Binance (public)',
    kind: 'cex',
    supports: ['candles5m', 'ticker', 'search'],
    note: 'May be geo-blocked (e.g. US IPs).',
  },
  coingecko: {
    id: 'coingecko',
    label: 'CoinGecko (public, no key)',
    kind: 'aggregator',
    supports: ['ticker', 'search'],
    note: 'Provides 24h/1h price context and volume, but no 5-minute candles on the free tier.',
  },
};

export const SOURCE_CHAIN = ['coinbase', 'kraken', 'binance', 'coingecko'];

export class SourceError extends Error {
  constructor(message, { source, status, url } = {}) {
    super(message);
    this.name = 'SourceError';
    this.source = source;
    this.status = status;
    this.url = url;
  }
}

async function getJson(url, { timeoutMs = 8000, source, fetchImpl } = {}) {
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f) throw new SourceError('No fetch implementation available.', { source, url });
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await f(url, {
      signal: ctrl ? ctrl.signal : undefined,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new SourceError(`HTTP ${res.status} from ${source}`, { source, status: res.status, url });
    return await res.json();
  } catch (err) {
    if (err instanceof SourceError) throw err;
    throw new SourceError(`${source} unreachable: ${err?.message || err}`, { source, url });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * pair helpers
 * ------------------------------------------------------------------ */

export function normalizePairInput(text, source = 'coinbase') {
  const raw = String(text || '').trim().toUpperCase();
  if (!raw) return null;
  if (raw.includes(':')) {
    const [src, pair] = raw.split(':');
    return { source: src.trim().toLowerCase(), pair: pair.trim().toUpperCase() };
  }
  if (source === 'kraken') return { source, pair: raw.replace(/[/-]/g, '') };
  return { source, pair: raw.replace('/', '-') };
}

export function tokenFromPair(pair) {
  const raw = String(pair || '').toUpperCase();
  if (!raw) return '';
  // "BTC-USD" / "BTC/USD" split on the separator; "XBTUSD" needs the quote stripped
  const base = /[-/]/.test(raw) ? raw.split(/[-/]/)[0] : raw.replace(/(USD|USDT|USDC|EUR|GBP|ZUSD)$/, '');
  return base
    .replace(/^XBT$/, 'BTC')
    .replace(/^X/, '')
    .replace(/Z$/, '');
}

/* ------------------------------------------------------------------ *
 * Coinbase Exchange
 * ------------------------------------------------------------------ */

async function coinbaseCandles(pair, opts) {
  const url = `https://api.exchange.coinbase.com/products/${encodeURIComponent(pair)}/candles?granularity=300`;
  const data = await getJson(url, { ...opts, source: 'coinbase' });
  if (!Array.isArray(data) || !data.length) throw new SourceError('Coinbase returned no candles.', { source: 'coinbase', url });
  // Coinbase rows: [ time, low, high, open, close, volume ] newest-first
  const candles = normalizeCandles(
    data.map((r) => ({ t: r[0], o: r[3], h: r[2], l: r[1], c: r[4], v: r[5] })),
  );
  return candles.slice(-288);
}

async function coinbaseTicker(pair, opts) {
  const [ticker, stats, product] = await Promise.all([
    getJson(`https://api.exchange.coinbase.com/products/${encodeURIComponent(pair)}/ticker`, { ...opts, source: 'coinbase' }),
    getJson(`https://api.exchange.coinbase.com/products/${encodeURIComponent(pair)}/stats`, { ...opts, source: 'coinbase' }).catch(() => null),
    getJson(`https://api.exchange.coinbase.com/products/${encodeURIComponent(pair)}`, { ...opts, source: 'coinbase' }).catch(() => null),
  ]);
  const price = Number(ticker?.price ?? ticker?.ask);
  const volume24hUsd = Number(ticker?.volume) && price ? Number(ticker.volume) * price : null;
  const open24 = Number(stats?.open);
  return {
    price: Number.isFinite(price) ? price : null,
    change24hPct: Number.isFinite(open24) && open24 > 0 && Number.isFinite(price) ? pct(open24, price) : null,
    high24h: Number.isFinite(Number(stats?.high)) ? Number(stats.high) : null,
    low24h: Number.isFinite(Number(stats?.low)) ? Number(stats.low) : null,
    volume24hUsd: Number.isFinite(volume24hUsd) ? volume24hUsd : null,
    quote: product?.quote_currency || 'USD',
    displayName: product ? `${product.base_currency}/${product.quote_currency}` : pair,
  };
}

/* ------------------------------------------------------------------ *
 * Kraken
 * ------------------------------------------------------------------ */

async function krakenCandles(pair, opts) {
  const url = `https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(pair)}&interval=5`;
  const data = await getJson(url, { ...opts, source: 'kraken' });
  if (Array.isArray(data?.error) && data.error.length) {
    throw new SourceError(`Kraken error: ${data.error.join(', ')}`, { source: 'kraken', url });
  }
  const result = data?.result || {};
  const key = Object.keys(result).find((k) => Array.isArray(result[k]));
  if (!key) throw new SourceError('Kraken returned no candles.', { source: 'kraken', url });
  const candles = normalizeCandles(
    result[key].map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[6] })),
  );
  return candles.slice(-288);
}

async function krakenTicker(pair, opts) {
  const data = await getJson(`https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(pair)}`, { ...opts, source: 'kraken' });
  if (Array.isArray(data?.error) && data.error.length) {
    throw new SourceError(`Kraken error: ${data.error.join(', ')}`, { source: 'kraken' });
  }
  const result = data?.result || {};
  const key = Object.keys(result)[0];
  const t = result[key];
  if (!t) throw new SourceError('Kraken ticker empty.', { source: 'kraken' });
  const price = Number(t?.c?.[0]);
  const vol24 = Number(t?.v?.[1]);
  const open = Number(t?.o);
  return {
    price: Number.isFinite(price) ? price : null,
    change24hPct: Number.isFinite(open) && open > 0 && Number.isFinite(price) ? pct(open, price) : null,
    high24h: Number.isFinite(Number(t?.h?.[1])) ? Number(t.h[1]) : null,
    low24h: Number.isFinite(Number(t?.l?.[1])) ? Number(t.l[1]) : null,
    volume24hUsd: Number.isFinite(vol24) && Number.isFinite(price) ? vol24 * price : null,
    quote: pair.toUpperCase().endsWith('USD') ? 'USD' : 'USD',
    displayName: key,
  };
}

/* ------------------------------------------------------------------ *
 * Binance
 * ------------------------------------------------------------------ */

async function binanceCandles(pair, opts) {
  const symbol = String(pair).replace(/[-/]/g, '').toUpperCase();
  const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=5m&limit=288`;
  const data = await getJson(url, { ...opts, source: 'binance' });
  if (!Array.isArray(data)) throw new SourceError('Binance returned no candles.', { source: 'binance', url });
  return normalizeCandles(data.map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] })));
}

async function binanceTicker(pair, opts) {
  const symbol = String(pair).replace(/[-/]/g, '').toUpperCase();
  const data = await getJson(`https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`, { ...opts, source: 'binance' });
  const price = Number(data?.lastPrice);
  return {
    price: Number.isFinite(price) ? price : null,
    change24hPct: Number.isFinite(Number(data?.priceChangePercent)) ? Number(data.priceChangePercent) : null,
    high24h: Number(data?.highPrice) || null,
    low24h: Number(data?.lowPrice) || null,
    volume24hUsd: Number(data?.quoteVolume) || null,
    quote: 'USD',
    displayName: symbol,
  };
}

/* ------------------------------------------------------------------ *
 * CoinGecko (context only: no free 5m candles)
 * ------------------------------------------------------------------ */

export function coingeckoIdFromInput(text) {
  const raw = String(text || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw.includes(':')) return raw.split(':').pop().trim();
  return raw;
}

async function coingeckoTicker(id, opts) {
  const cid = coingeckoIdFromInput(id);
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(cid)}&price_change_percentage=1h,24h`;
  const data = await getJson(url, { ...opts, source: 'coingecko' });
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) throw new SourceError(`CoinGecko knows no coin for id "${cid}".`, { source: 'coingecko', url });
  return {
    price: Number(row.current_price) || null,
    change24hPct: Number.isFinite(Number(row.price_change_percentage_24h)) ? Number(row.price_change_percentage_24h) : null,
    change1hPct: Number.isFinite(Number(row.price_change_percentage_1h_in_currency))
      ? Number(row.price_change_percentage_1h_in_currency)
      : null,
    high24h: Number(row.high_24h) || null,
    low24h: Number(row.low_24h) || null,
    volume24hUsd: Number(row.total_volume) || null,
    marketCapUsd: Number(row.market_cap) || null,
    quote: 'USD',
    displayName: row.symbol ? row.symbol.toUpperCase() : cid,
    name: row.name || cid,
  };
}

/* ------------------------------------------------------------------ *
 * public API
 * ------------------------------------------------------------------ */

const TICKER_FETCHERS = { coinbase: coinbaseTicker, kraken: krakenTicker, binance: binanceTicker, coingecko: coingeckoTicker };
const CANDLE_FETCHERS = { coinbase: coinbaseCandles, kraken: krakenCandles, binance: binanceCandles };

export function sourceSupportsCandles(source) {
  return Boolean(CANDLE_FETCHERS[source]);
}

/** Fetches raw market data from one named source. No metrics, no opinions. */
export async function fetchRawFromSource(source, pair, opts = {}) {
  const info = SOURCE_INFO[source];
  if (!info) throw new SourceError(`Unknown source "${source}".`, { source });
  const candleFetcher = CANDLE_FETCHERS[source];
  const tickerFetcher = TICKER_FETCHERS[source];
  let candles = [];
  let ticker = null;
  const warnings = [];

  if (candleFetcher) {
    try {
      candles = await candleFetcher(pair, opts);
    } catch (err) {
      warnings.push(`${source}: candles unavailable (${err.message})`);
    }
  } else {
    warnings.push(`${info.label} does not provide 5-minute candles on the free tier; only price/volume context.`);
  }

  if (tickerFetcher) {
    try {
      ticker = await tickerFetcher(pair, opts);
    } catch (err) {
      if (!candles.length) throw err;
      warnings.push(`${source}: ticker unavailable (${err.message})`);
    }
  }

  if (!candles.length && !ticker) throw new SourceError(`${source} returned nothing usable.`, { source });

  return {
    source,
    sourceLabel: info.label,
    pair,
    token: tokenFromPair(pair),
    candles,
    ticker,
    fetchedAt: new Date().toISOString(),
    warnings,
  };
}

/**
 * Walks the source chain until one returns usable data.
 * Returns { ok:true, raw, attempts } or { ok:false, attempts, message }.
 */
export async function fetchMarketData(pairInput, opts = {}) {
  const { preferredSource = null, fetchImpl, timeoutMs = 7000 } = opts;
  const chain = preferredSource ? [preferredSource, ...SOURCE_CHAIN.filter((s) => s !== preferredSource)] : SOURCE_CHAIN;
  const attempts = [];

  for (const source of chain) {
    if (!SOURCE_INFO[source]) continue;
    const { pair } = normalizePairInput(pairInput, source);
    try {
      const raw = await fetchRawFromSource(source, pair, { fetchImpl, timeoutMs });
      if (!raw.candles.length && !raw.ticker) {
        attempts.push({ source, ok: false, error: 'no usable payload' });
        continue;
      }
      attempts.push({ source, ok: true, candles: raw.candles.length, warnings: raw.warnings, pair });
      return { ok: true, raw, attempts };
    } catch (err) {
      attempts.push({ source, ok: false, error: err.message, status: err.status ?? null, pair });
    }
  }
  return {
    ok: false,
    attempts,
    message:
      'No live source was reachable. The desk will not invent prices - fetch from the browser, enter data manually, or use clearly-labelled demo data.',
  };
}

/** Symbol search across the public catalogs (used for the token picker). */
export async function searchMarkets(query, opts = {}) {
  const q = String(query || '').trim().toUpperCase();
  if (q.length < 1) return { ok: true, results: [], attempts: [] };
  const { fetchImpl, timeoutMs = 7000, preferredSource } = opts;
  const attempts = [];
  const results = [];
  const seen = new Set();

  const push = (r) => {
    const key = `${r.source}:${r.pair}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push(r);
  };

  const scope = preferredSource ? [preferredSource, ...SOURCE_CHAIN.filter((s) => s !== preferredSource)] : ['coinbase', 'kraken', 'coingecko'];

  for (const source of scope) {
    try {
      if (source === 'coinbase') {
        const products = await getJson('https://api.exchange.coinbase.com/products', { fetchImpl, timeoutMs, source });
        for (const p of products || []) {
          if (p?.status !== 'online') continue;
          if (!['USD', 'USDT', 'USDC'].includes(p.quote_currency)) continue;
          const hay = `${p.base_currency}${p.id}`.toUpperCase();
          if (!hay.includes(q)) continue;
          push({ source, pair: p.id, token: p.base_currency, quote: p.quote_currency, label: `${p.base_currency}/${p.quote_currency}`, kind: 'cex' });
        }
        attempts.push({ source, ok: true });
      } else if (source === 'kraken') {
        const pairs = await getJson('https://api.kraken.com/0/public/AssetPairs', { fetchImpl, timeoutMs, source });
        for (const [key, v] of Object.entries(pairs?.result || {})) {
          if (v?.status && v.status !== 'online') continue;
          if (!String(v?.quote || '').match(/USD|ZUSD/)) continue;
          const base = String(v.base || '').replace(/^X/, '').replace(/^Z/, '');
          const hay = `${base}${key}`.toUpperCase();
          if (!hay.includes(q)) continue;
          push({ source, pair: key, token: base, quote: 'USD', label: `${base}/USD`, kind: 'cex' });
        }
        attempts.push({ source, ok: true });
      } else if (source === 'binance') {
        const syms = await getJson('https://api.binance.com/api/v3/exchangeInfo', { fetchImpl, timeoutMs, source });
        for (const s of syms?.symbols || []) {
          if (s.status !== 'TRADING' || s.quoteAsset !== 'USDT') continue;
          if (!String(s.symbol).includes(q)) continue;
          push({ source, pair: s.symbol, token: s.baseAsset, quote: 'USDT', label: `${s.baseAsset}/USDT`, kind: 'cex' });
        }
        attempts.push({ source, ok: true });
      } else if (source === 'coingecko') {
        const s = await getJson(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`, { fetchImpl, timeoutMs, source });
        for (const c of (s?.coins || []).slice(0, 12)) {
          push({ source: 'coingecko', pair: c.id, token: String(c.symbol || '').toUpperCase(), quote: 'USD', label: `${c.name} (${String(c.symbol || '').toUpperCase()})`, kind: 'aggregator' });
        }
        attempts.push({ source, ok: true });
      }
    } catch (err) {
      attempts.push({ source, ok: false, error: err.message });
    }
    if (results.length >= 25) break;
  }

  return { ok: results.length > 0, results: results.slice(0, 25), attempts };
}

/* ------------------------------------------------------------------ *
 * Prediction markets (Polymarket public API) - Agent 4 research only
 * ------------------------------------------------------------------ */

export async function fetchPredictionMarkets(opts = {}) {
  const { fetchImpl, timeoutMs = 8000, limit = 25 } = opts;
  const url = `https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=${limit}&order=volumeNum&ascending=false`;
  const attempts = [];
  let data;
  try {
    data = await getJson(url, { fetchImpl, timeoutMs, source: 'polymarket' });
    attempts.push({ source: 'polymarket', ok: true, url });
  } catch (err) {
    attempts.push({ source: 'polymarket', ok: false, error: err.message, url });
    return { ok: false, attempts, markets: [], message: 'Prediction-market API unreachable from here.' };
  }
  const markets = (Array.isArray(data) ? data : []).map((m) => {
    const parse = (v) => {
      try {
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return null;
      }
    };
    const outcomes = parse(m.outcomes) || [];
    const prices = (parse(m.outcomePrices) || []).map(Number);
    const yesIdx = outcomes.findIndex((o) => String(o).toLowerCase() === 'yes');
    const yesPrice = yesIdx >= 0 ? prices[yesIdx] : null;
    const bid = Number(m.bestBid);
    const ask = Number(m.bestAsk);
    const spread = Number.isFinite(bid) && Number.isFinite(ask) ? (ask - bid) * 100 : null;
    return {
      id: String(m.id ?? m.conditionId ?? ''),
      question: m.question || m.title || '(untitled market)',
      slug: m.slug || null,
      url: m.slug ? `https://polymarket.com/event/${m.slug}` : 'https://polymarket.com',
      outcomes,
      yesPrice: Number.isFinite(yesPrice) ? yesPrice : null,
      bid: Number.isFinite(bid) ? bid : null,
      ask: Number.isFinite(ask) ? ask : null,
      spreadPoints: spread,
      liquidityUsd: Number(m.liquidityNum ?? m.liquidity) || null,
      volumeUsd: Number(m.volumeNum ?? m.volume) || null,
      endDate: m.endDate || m.endDateIso || null,
      closed: Boolean(m.closed),
      source: 'polymarket',
    };
  });
  return { ok: true, markets, attempts };
}
