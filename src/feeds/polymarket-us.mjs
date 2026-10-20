/** Server-only SDK initialization. Not wired to HTTP routes or paper execution.
 * Never import this module from public/client or return the client via an API.
 */
import { safeUSError } from './polymarket-us-errors.mjs';
import { PolymarketUS, BadRequestError } from 'polymarket-us';

export function createPolymarketUSClient(env = process.env) {
  const keyId = env.POLYMARKET_KEY_ID?.trim();
  const secretKey = env.POLYMARKET_SECRET_KEY?.trim();
  if (Boolean(keyId) !== Boolean(secretKey)) {
    throw new Error('Set both POLYMARKET_KEY_ID and POLYMARKET_SECRET_KEY, or neither for public read-only data.');
  }
  // Public market data needs no credentials. Construction makes no API request.
  return keyId ? new PolymarketUS({ keyId, secretKey }) : new PolymarketUS();
}

// Deliberately exposes only public reads, never the authenticated SDK client.
export function createPublicUSResearch(client = new PolymarketUS({ timeout: 8000 })) {
  return Object.freeze({
    search: (params = {}) => client.search.query(parseUSSearchFilters(params)),
    sports: () => client.sports.list(),
    teams: (params = {}) => client.sports.teams(parseUSTeamFilters(params)),
    series: (params = {}) => client.series.list(parseUSSeriesFilters(params)),
    seriesById: (id) => {
      const n = Number(id);
      if (!Number.isSafeInteger(n) || n <= 0) throw new BadRequestError();
      return client.series.retrieve(n);
    },
    events: (params = {}) => client.events.list(parseUSEventFilters(params)),
    event: ({ id, slug } = {}) => {
      if (id !== undefined && slug !== undefined) throw new BadRequestError();
      if (id !== undefined) {
        const n = Number(id);
        if (!Number.isSafeInteger(n) || n <= 0) throw new BadRequestError();
        return client.events.retrieve(n);
      }
      if (typeof slug !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(slug)) throw new BadRequestError();
      return client.events.retrieveBySlug(slug);
    },
    markets: (params = {}) => client.markets.list(parseUSMarketFilters(params)),
    marketRead: ({ kind = 'details', id, slug } = {}) => {
      if (!['details', 'book', 'bbo', 'settlement'].includes(kind)) throw new BadRequestError();
      if (id !== undefined) {
        const n = Number(id);
        if (slug !== undefined || kind !== 'details' || !Number.isSafeInteger(n) || n <= 0) throw new BadRequestError();
        return client.markets.retrieve(n);
      }
      if (typeof slug !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(slug)) throw new BadRequestError();
      return kind === 'details' ? client.markets.retrieveBySlug(slug) : client.markets[kind](slug);
    },
    async market(slug) {
      if (typeof slug !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(slug)) {
        throw new Error('Enter a valid market slug (letters, numbers, hyphens or underscores).');
      }
      const [market, book] = await Promise.all([
        client.markets.retrieveBySlug(slug),
        client.markets.book(slug),
      ]);
      return { market, book };
    },
  });
}

/** Private read-only snapshot. Intentionally has no HTTP route or disk storage.
 * The three reads are not an atomic snapshot and SDK responses may be paginated.
 * Call only from a trusted server context; never log the returned account data.
 */
export async function readUSAccountSnapshot({ env = process.env, client } = {}) {
  if (!client) {
    if (!env.POLYMARKET_KEY_ID?.trim() || !env.POLYMARKET_SECRET_KEY?.trim()) {
      throw new Error('Private account reads require both Polymarket US credentials in the server environment.');
    }
    client = createPolymarketUSClient(env);
  }
  const startedAt = new Date().toISOString();
  try {
    const [balances, positions, openOrders] = await Promise.all([
      client.account.balances(),
      client.portfolio.positions(),
      client.orders.list(),
    ]);
    return { source: 'polymarket-us', startedAt, fetchedAt: new Date().toISOString(), balances, positions, openOrders };
  } catch (error) {
    throw safeUSError(error);
  }
}

// Whitelist filters and bound pagination; never forward arbitrary query fields.
export function parseUSEventFilters(input = {}) {
  const out = { limit: 10, active: true };
  for (const [key, max] of [['limit', 100], ['offset', 100000]]) {
    if (input[key] === undefined) continue;
    const value = Number(input[key]);
    if (input[key] === '' || !Number.isSafeInteger(value) || value < (key === 'limit' ? 1 : 0) || value > max) throw new BadRequestError();
    out[key] = value;
  }
  for (const key of ['active', 'closed', 'archived', 'featured', 'live', 'ended']) {
    if (input[key] === undefined) continue;
    if (![true, false, 'true', 'false'].includes(input[key])) throw new BadRequestError();
    out[key] = input[key] === true || input[key] === 'true';
  }
  for (const key of ['categories', 'seriesId']) {
    if (input[key] === undefined) continue;
    const values = Array.isArray(input[key]) ? input[key] : String(input[key]).split(',');
    if (!values.length || values.length > 10) throw new BadRequestError();
    out[key] = values.map(raw => {
      const value = String(raw).trim();
      if (key === 'categories') {
        if (!/^[a-zA-Z0-9_-]{1,60}$/.test(value)) throw new BadRequestError();
        return value;
      }
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n <= 0) throw new BadRequestError();
      return n;
    });
  }
  return out;
}

export function parseUSMarketFilters(input = {}) {
  const selected = Object.fromEntries(['limit', 'offset', 'active', 'closed', 'archived', 'categories'].filter(key => input[key] !== undefined).map(key => [key, input[key]]));
  const out = parseUSEventFilters(selected);
  if (input.sportsMarketTypes !== undefined) {
    const values = Array.isArray(input.sportsMarketTypes) ? input.sportsMarketTypes : String(input.sportsMarketTypes).split(',');
    if (!values.length || values.length > 4 || values.some(v => !['MONEYLINE', 'SPREAD', 'TOTAL', 'PROP'].includes(v))) throw new BadRequestError();
    out.sportsMarketTypes = values;
  }
  for (const key of ['volumeNumMin', 'liquidityNumMin']) {
    if (input[key] === undefined) continue;
    const n = Number(input[key]);
    if (input[key] === '' || !Number.isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) throw new BadRequestError();
    out[key] = n;
  }
  return out;
}

/** Private balance-only read. No routes, logging, persistence or order actions.
 * Preserve API shape: SDK 0.1.1 declares { balances: UserBalance[] }, whereas
 * the supplied Account reference documents top-level financial fields.
 */
export async function readUSAccountBalances({ env = process.env, client } = {}) {
  if (!client) {
    if (!env.POLYMARKET_KEY_ID?.trim() || !env.POLYMARKET_SECRET_KEY?.trim()) {
      throw new Error('Private account reads require both Polymarket US credentials in the server environment.');
    }
    client = createPolymarketUSClient(env);
  }
  try {
    const data = await client.account.balances();
    return { source: 'polymarket-us', fetchedAt: new Date().toISOString(), data };
  } catch (error) { throw safeUSError(error); }
}

export function parseUSSeriesFilters(input = {}) {
  const allowed = ['limit', 'offset', 'slug', 'active', 'closed', 'archived', 'recurrence'];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new BadRequestError();
  const selected = Object.fromEntries(['limit', 'offset', 'active', 'closed', 'archived'].filter(key => input[key] !== undefined).map(key => [key, input[key]]));
  const out = parseUSEventFilters(selected);
  if (input.slug !== undefined) {
    const values = Array.isArray(input.slug) ? input.slug : String(input.slug).split(',');
    if (!values.length || values.length > 10) throw new BadRequestError();
    out.slug = values.map(value => {
      if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(value.trim())) throw new BadRequestError();
      return value.trim();
    });
  }
  if (input.recurrence !== undefined) {
    if (typeof input.recurrence !== 'string' || !/^[a-zA-Z0-9_-]{1,60}$/.test(input.recurrence)) throw new BadRequestError();
    out.recurrence = input.recurrence;
  }
  return out;
}

export function parseUSTeamFilters(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['provider', 'league', 'teamIds'].includes(key))) throw new BadRequestError();
  const out = {};
  if (input.provider !== undefined) {
    if (!['PROVIDER_SPORTRADAR', 'PROVIDER_SPORTSDATAIO'].includes(input.provider)) throw new BadRequestError();
    out.provider = input.provider;
  }
  if (input.league !== undefined) {
    if (typeof input.league !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(input.league)) throw new BadRequestError();
    out.league = input.league;
  }
  if (input.teamIds !== undefined) {
    const ids = Array.isArray(input.teamIds) ? input.teamIds : String(input.teamIds).split(',');
    if (!ids.length || ids.length > 50) throw new BadRequestError();
    // SDK 0.1.1 expects strings; preserve integer identifiers without precision loss.
    out.teamIds = ids.map(id => {
      if (typeof id === 'number' && !Number.isSafeInteger(id)) throw new BadRequestError();
      const value = String(id).trim();
      if (!/^[1-9][0-9]{0,29}$/.test(value)) throw new BadRequestError();
      return value;
    });
  }
  return out;
}

export function parseUSSearchFilters(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['query', 'limit', 'page', 'seriesIds', 'marketType', 'status'].includes(key))) throw new BadRequestError();
  if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 300) throw new BadRequestError();
  const out = { query: input.query.trim(), limit: 10 };
  for (const [key, max] of [['limit', 100], ['page', 10000]]) {
    if (input[key] === undefined) continue;
    const value = Number(input[key]);
    // Page zero is accepted because the supplied reference does not specify a base.
    if (input[key] === '' || !Number.isSafeInteger(value) || value < (key === 'limit' ? 1 : 0) || value > max) throw new BadRequestError();
    out[key] = value;
  }
  if (input.status !== undefined) {
    if (!['active', 'closed', 'upcoming'].includes(input.status)) throw new BadRequestError();
    out.status = input.status;
  }
  if (input.seriesIds !== undefined) {
    out.seriesIds = parseUSEventFilters({ seriesId: input.seriesIds }).seriesId;
  }
  if (input.marketType !== undefined) {
    const values = Array.isArray(input.marketType) ? input.marketType : String(input.marketType).split(',');
    if (!values.length || values.length > 10) throw new BadRequestError();
    out.marketType = values.map(value => {
      if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,60}$/.test(value.trim())) throw new BadRequestError();
      return value.trim();
    });
  }
  return out;
}
