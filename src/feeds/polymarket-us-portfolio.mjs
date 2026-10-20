/** Private server-only reads. No routes, logs, persistence or trading methods. */
import { BadRequestError } from 'polymarket-us';
import { createPolymarketUSClient } from './polymarket-us.mjs';
import { safeUSError } from './polymarket-us-errors.mjs';

const ACTIVITY_TYPES = new Set([
  'ACTIVITY_TYPE_TRADE', 'ACTIVITY_TYPE_POSITION_RESOLUTION',
  'ACTIVITY_TYPE_ACCOUNT_DEPOSIT', 'ACTIVITY_TYPE_ACCOUNT_ADVANCED_DEPOSIT',
  'ACTIVITY_TYPE_ACCOUNT_WITHDRAWAL', 'ACTIVITY_TYPE_TRANSFER',
  'ACTIVITY_TYPE_REFERRAL_BONUS', 'ACTIVITY_TYPE_TAKER_FEE_REBATE',
  'ACTIVITY_TYPE_LIQUIDITY_PROGRAM',
]);

export function validatePortfolioParams(input = {}, activities = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestError();
  const allowed = activities ? ['limit', 'cursor', 'types', 'marketSlug', 'sortOrder'] : ['limit', 'cursor'];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new BadRequestError();
  const out = {};
  if (input.limit !== undefined) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new BadRequestError();
    out.limit = input.limit;
  }
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== 'string' || !input.cursor.length || input.cursor.length > 4096) throw new BadRequestError();
    out.cursor = input.cursor; // Opaque: never parse or alter pagination cursors.
  }
  if (input.marketSlug !== undefined) {
    if (typeof input.marketSlug !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(input.marketSlug)) throw new BadRequestError();
    out.marketSlug = input.marketSlug;
  }
  if (input.sortOrder !== undefined) {
    if (!['SORT_ORDER_DESCENDING', 'SORT_ORDER_ASCENDING'].includes(input.sortOrder)) throw new BadRequestError();
    out.sortOrder = input.sortOrder;
  }
  if (input.types !== undefined) {
    if (!Array.isArray(input.types) || !input.types.length || input.types.length > ACTIVITY_TYPES.size || input.types.some(type => !ACTIVITY_TYPES.has(type))) throw new BadRequestError();
    out.types = [...new Set(input.types)];
  }
  return out;
}

export function createPrivateUSPortfolio({ env = process.env, client } = {}) {
  if (!client) {
    if (!env.POLYMARKET_KEY_ID?.trim() || !env.POLYMARKET_SECRET_KEY?.trim()) throw new Error('Private portfolio reads require both Polymarket US credentials in the server environment.');
    client = createPolymarketUSClient(env);
  }
  const read = async (method, params) => {
    try {
      const validated = validatePortfolioParams(params, method === 'activities');
      // Preserve the raw response, including decimal strings, nextCursor and eof.
      const data = await client.portfolio[method](validated);
      return { source: 'polymarket-us', fetchedAt: new Date().toISOString(), data };
    } catch (error) { throw safeUSError(error); }
  };
  return Object.freeze({
    positions: (params = {}) => read('positions', params),
    activities: (params = {}) => read('activities', params),
  });
}
