/**
 * marketProvider.mjs - one place that decides which data the agents see.
 *
 * Three channels, in order:
 *   1. live via the server (best),
 *   2. live via the user's browser when the server's egress is blocked -
 *      the client fetches the raw payload and the server recomputes metrics,
 *   3. explicit DEMO data (clearly watermarked) for testing the rules.
 *
 * Manual snapshots bypass this provider entirely and go straight to the store
 * path in the server, always labelled USER-PROVIDED.
 */

import { liveSnapshot, demoSnapshot, DATA_QUALITY } from '../feeds/index.mjs';

export class MarketProvider {
  constructor(store, { ttlMs = 45000 } = {}) {
    this.store = store;
    this.ttlMs = ttlMs;
    this.cache = new Map(); // key -> { snapshot, at }
    this.byId = new Map(); // snapshot id -> snapshot (for the client's evaluate calls)
  }

  key(pair, source) {
    return `${source || 'auto'}:${String(pair).toUpperCase()}`;
  }

  cached(pair, source) {
    const hit = this.cache.get(this.key(pair, source));
    if (!hit) return null;
    if (Date.now() - hit.at > this.ttlMs) return null;
    return hit.snapshot;
  }

  adopt(snapshot) {
    this.cache.set(this.key(snapshot.pair, snapshot.source), { snapshot, at: Date.now() });
    this.byId.set(snapshot.id, snapshot);
    if (this.byId.size > 60) {
      const oldest = this.byId.keys().next().value;
      this.byId.delete(oldest);
    }
    return snapshot;
  }

  getById(id) {
    const hit = this.byId.get(id);
    if (!hit) return null;
    if (Date.now() - new Date(hit.receivedAt).getTime() > 30 * 60 * 1000) return null; // stale snapshots cannot be traded on
    return hit;
  }

  getCacheAge(pair, source) {
    const hit = this.cache.get(this.key(pair, source));
    return hit ? { ageMs: Date.now() - hit.at, snapshot: hit.snapshot } : null;
  }

  /**
   * Returns { ok:true, snapshot, fromCache } or
   * { ok:false, needBrowser:true, attempts, message }.
   */
  async snapshot({ pair, source = null, force = false, demo = null }) {
    const mode = this.store.getDataMode();
    const useDemo = demo || (mode === 'demo' ? 'base' : null);

    if (useDemo) {
      const { snapshot } = demoSnapshot({ scenario: useDemo, token: String(pair || 'DEMO').split(/[-/]/)[0].toUpperCase() });
      this.adopt(snapshot);
      return { ok: true, snapshot, fromCache: false, demo: true };
    }

    if (!force) {
      const hit = this.cached(pair, source);
      if (hit) return { ok: true, snapshot: hit, fromCache: true };
    }

    const result = await liveSnapshot(pair, { preferredSource: source, timeoutMs: 7000 });
    if (result.ok) {
      this.adopt(result.snapshot);
      return { ok: true, snapshot: result.snapshot, fromCache: false };
    }
    return {
      ok: false,
      needBrowser: true,
      attempts: result.attempts,
      message: result.message,
      quality: DATA_QUALITY.LIVE_SERVER,
    };
  }

  /** Snapshots for the whole watchlist, in parallel, with per-token outcomes. */
  async snapshots(pairs, { force = false } = {}) {
    const out = [];
    await Promise.all(
      pairs.map(async (w) => {
        const r = await this.snapshot({ pair: w.pair, source: w.source || null, force });
        out.push({ watch: w, ...r });
      }),
    );
    return out;
  }
}
