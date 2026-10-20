/**
 * browserFeed.mjs - the browser-direct data channel.
 *
 * Why this exists: the desk's server is the right place to fetch market data,
 * but when the server cannot reach the public APIs (locked-down network, a
 * sandbox, a firewall), your browser usually can. In that case the page fetches
 * the raw payload itself and hands it to the server, which recomputes every
 * metric. Nothing is trusted from the browser: the payload is validated and
 * re-derived server-side.
 *
 * The same rules apply as everywhere else: if the fetch fails, the app says so.
 * It never fills in a number to make the screen look complete.
 */

import { fetchMarketData, searchMarkets, fetchPredictionMarkets, SOURCE_CHAIN, SOURCE_INFO } from '/shared/livesources.mjs';
import { api } from './util.mjs';

export const browserChannel = {
  async market(pair, { preferredSource = null, onAttempt = null } = {}) {
    const log = (line) => { try { onAttempt?.(line); } catch { /* reporting only */ } };
    // 1. ask the server (its network is the better one when it works)
    try {
      const server = await api('/api/snapshot', { method: 'POST', body: { pair, source: preferredSource, force: true } });
      if (server.ok && server.snapshot) return { snapshot: server.snapshot, channel: 'server-live', attempts: [] };
      const tried = (server.attempts || []).map((a) => `${a.source}: ${a.error || 'no data'}`).join(', ');
      if (tried) log(`server could not reach any source (${tried}) - trying from your browser`);
    } catch (err) {
      // fall through to the browser channel
      var serverError = err.message;
      log(`server fetch failed (${err.message}) - trying from your browser`);
    }

    // 2. fetch from the browser directly
    const result = await fetchMarketData(pair, { preferredSource, fetchImpl: fetch, timeoutMs: 9000 });
    if (!result.ok) {
      throw new Error(
        `No live source reachable from the server OR the browser. ${result.message} Tried: ${result.attempts
          .map((a) => `${a.source} (${a.error})`)
          .join(', ')}${serverError ? ` [server: ${serverError}]` : ''}`,
      );
    }
    log(`browser reached ${result.raw.source} (${result.raw.candles.length} candles)`);
    // 3. hand the raw payload to the server for validation + metric derivation
    const ingested = await api('/api/snapshot/ingest', {
      method: 'POST',
      body: {
        payload: {
          source: result.raw.source,
          pair: result.raw.pair,
          token: result.raw.token,
          fetchedAt: result.raw.fetchedAt,
          candles: result.raw.candles,
          ticker: result.raw.ticker,
          warnings: result.raw.warnings,
        },
      },
    });
    return { snapshot: ingested.snapshot, channel: `browser-live (${result.raw.source})`, attempts: result.attempts };
  },

  async search(query) {
    try {
      const server = await api(`/api/search?q=${encodeURIComponent(query)}`);
      if (server.ok && server.results?.length) return server;
    } catch {
      /* fall through */
    }
    const local = await searchMarkets(query, { fetchImpl: fetch, timeoutMs: 9000 });
    if (!local.results?.length) {
      throw new Error(`No symbols found for "${query}" (tried the server and the browser).`);
    }
    return api('/api/search/ingest', { method: 'POST', body: { results: local.results } });
  },

  async predictionMarkets(limit = 25) {
    try {
      const server = await api(`/api/predictions?limit=${limit}`);
      if (server.ok && server.markets?.length) return { markets: server.markets, channel: 'server-live' };
    } catch {
      /* fall through */
    }
    const local = await fetchPredictionMarkets({ fetchImpl: fetch, timeoutMs: 9000, limit });
    if (!local.ok || !local.markets?.length) throw new Error(`Prediction-market data is unreachable right now. ${local.message || ''}`);
    const ingested = await api('/api/predictions/ingest', { method: 'POST', body: { markets: local.markets } });
    return { markets: ingested.markets, channel: 'browser-live' };
  },

  sourceInfo: SOURCE_INFO,
  chain: SOURCE_CHAIN,
};
