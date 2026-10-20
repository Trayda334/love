/** Opt-in server-only streams. No HTTP routes, storage, order actions or logs. */
import { randomUUID } from 'node:crypto';
import { createPolymarketUSClient } from './polymarket-us.mjs';

const TYPES = {
  markets: {
    marketData: 'SUBSCRIPTION_TYPE_MARKET_DATA',
    marketDataLite: 'SUBSCRIPTION_TYPE_MARKET_DATA_LITE',
    trade: 'SUBSCRIPTION_TYPE_TRADE',
  },
  private: {
    orderSnapshot: 'SUBSCRIPTION_TYPE_ORDER', orderUpdate: 'SUBSCRIPTION_TYPE_ORDER',
    positionSnapshot: 'SUBSCRIPTION_TYPE_POSITION', positionUpdate: 'SUBSCRIPTION_TYPE_POSITION',
    accountBalanceSnapshot: 'SUBSCRIPTION_TYPE_ACCOUNT_BALANCE', accountBalanceUpdate: 'SUBSCRIPTION_TYPE_ACCOUNT_BALANCE',
  },
};

export function createUSStream({ mode = 'markets', marketSlugs = [], events,
  env = process.env, client, onData = () => {}, onStatus = () => {},
  maxReconnects = 5, baseDelayMs = 1000, connectTimeoutMs = 10000,
} = {}) {
  const definitions = TYPES[mode];
  if (!definitions || !Array.isArray(marketSlugs) || marketSlugs.length > 10 || marketSlugs.some(s => typeof s !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(s))) throw new Error('Invalid stream mode or market slugs (maximum 10).');
  if (mode === 'markets' && !marketSlugs.length) throw new Error('Market streams require at least one slug.');
  events ??= Object.keys(definitions);
  if (!Array.isArray(events) || !events.length || events.some(e => !Object.hasOwn(definitions, e))) throw new Error('Invalid stream event selection.');
  if (!Number.isInteger(maxReconnects) || maxReconnects < 0 || maxReconnects > 10 || !Number.isFinite(baseDelayMs) || baseDelayMs < 1 || baseDelayMs > 30000 || !Number.isFinite(connectTimeoutMs) || connectTimeoutMs < 1 || connectTimeoutMs > 60000) throw new Error('Invalid stream retry or timeout settings.');
  if (!client) {
    // Installed SDK signs BOTH market and private WebSocket handshakes.
    if (!env.POLYMARKET_KEY_ID?.trim() || !env.POLYMARKET_SECRET_KEY?.trim()) throw new Error('The installed SDK requires both server credentials for WebSocket connections.');
    client = createPolymarketUSClient(env);
  }
  const slugs = [...new Set(marketSlugs)];
  const selected = [...new Set(events)];
  let running = false, socket, retryTimer, timeoutTimer, attempts = 0, generation = 0;
  let queue = Promise.resolve(), pending = 0;
  const status = (state) => { try { onStatus({ state, reconnects: attempts, stale: true }); } catch { /* observer only */ } };
  const dispose = () => {
    clearTimeout(timeoutTimer);
    const old = socket;
    socket = undefined;
    generation++;
    try { old?.close(); } catch { /* never expose SDK errors */ }
  };
  const stop = () => {
    running = false;
    clearTimeout(retryTimer);
    dispose();
    status('stopped');
  };
  const failed = (token) => {
    if (!running || token !== generation) return;
    dispose();
    status('disconnected');
    if (attempts >= maxReconnects) { running = false; status('exhausted'); return; }
    const delay = Math.min(baseDelayMs * 2 ** attempts, 30000);
    attempts++;
    status('reconnecting');
    retryTimer = setTimeout(connect, delay);
    retryTimer.unref?.();
  };
  const connect = async () => {
    if (!running) return;
    const token = ++generation;
    status('connecting');
    try {
      const ws = client.ws[mode]();
      socket = ws;
      ws.on('error', () => failed(token));
      ws.on('close', () => failed(token));
      for (const event of selected) ws.on(event, data => {
        if (!running || token !== generation) return;
        if (pending >= 100) { stop(); status('consumer-overflow'); return; }
        pending++;
        queue = queue.then(async () => {
          if (running && token === generation) await onData({ event, data, receivedAt: new Date().toISOString(), generation: token });
        }).catch(() => { stop(); status('consumer-error'); }).finally(() => { pending--; });
      });
      timeoutTimer = setTimeout(() => failed(token), connectTimeoutMs);
      timeoutTimer.unref?.();
      await ws.connect();
      if (!running || token !== generation) { try { ws.close(); } catch {} return; }
      clearTimeout(timeoutTimer);
      for (const type of new Set(selected.map(event => definitions[event]))) ws.subscribe(randomUUID(), type, mode === 'markets' ? slugs : undefined);
      // A subscribed transport is NOT confirmation of fresh or complete data.
      status('subscribed');
    } catch { failed(token); }
  };
  return Object.freeze({
    start() { if (running) return; running = true; attempts = 0; void connect(); },
    stop,
  });
}
