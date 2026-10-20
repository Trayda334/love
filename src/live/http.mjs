/** Single-operator live API: secure cookie sessions, CSRF, origin/host checks.
 * Only deploy behind TLS on a private host. No forwarded-header trust.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { PolymarketUS } from 'polymarket-us';
import { createLiveTrading, createLiveJournal, LiveError, LIVE_CAP_CENTS } from './trading.mjs';
import { classifyUSError } from '../feeds/polymarket-us-errors.mjs';

const COOKIE = '__Secure-live_session';
const TTL = 15 * 60 * 1000;
const hash = value => createHash('sha256').update(value).digest();
export function createLiveHTTP({ env = process.env, root, now = Date.now, trading: injected } = {}) {
  const optedIn = env.LIVE_TRADING_ENABLED === 'true';
  let origin, setupError;
  try {
    const parsed = new URL(env.LIVE_APP_ORIGIN);
    if (parsed.protocol !== 'https:' || parsed.origin !== env.LIVE_APP_ORIGIN || parsed.username || parsed.password) throw new Error();
    origin = parsed;
  } catch { setupError = 'Set LIVE_APP_ORIGIN to the exact private HTTPS origin (no trailing slash).'; }
  if (!env.LIVE_ADMIN_PASSWORD || env.LIVE_ADMIN_PASSWORD.length < 32) setupError = 'Set a unique LIVE_ADMIN_PASSWORD of at least 32 characters in server secrets.';
  if (!env.POLYMARKET_KEY_ID?.trim() || !env.POLYMARKET_SECRET_KEY?.trim()) setupError = 'Configure both Polymarket US credentials in server secrets.';
  let trading, journal;
  if (optedIn && !setupError) {
    try {
      journal = injected ? undefined : createLiveJournal(env.LIVE_JOURNAL || path.join(root, 'data', 'live-dispatch.jsonl'));
      trading = injected || createLiveTrading({ client: new PolymarketUS({ keyId: env.POLYMARKET_KEY_ID.trim(), secretKey: env.POLYMARKET_SECRET_KEY.trim(), timeout: 8000 }), journal, now });
    } catch { setupError = 'Live dispatch journal is unavailable or invalid. Reconcile privately before enabling trading.'; }
  }
  const enabled = Boolean(trading);
  const sessions = new Map();
  let failures = 0, failureWindow = 0;
  const response = (payload, status = 200, headers = {}) => ({ status, headers, payload: { ok: status < 400, ...payload } });
  const cookie = value => `${COOKIE}=${value}; Path=/api/live; HttpOnly; Secure; SameSite=Strict; Max-Age=${value ? TTL / 1000 : 0}`;
  return {
    enabled,
    close: () => journal?.close(),
    async handle(req, url, readBody) {
      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /api/live/status' && !enabled) return response({ enabled: false, capCents: LIVE_CAP_CENTS, message: optedIn ? setupError : 'Live trading is disabled. Configure a private HTTPS deployment before enabling it.' });
      if (!enabled) return response({ error: 'Live trading is disabled.' }, 503);
      try {
        // Bind to the configured host, not an attacker-controlled forwarded host.
        if (req.headers.host !== origin.host || (req.headers.origin && req.headers.origin !== origin.origin) || req.headers['sec-fetch-site'] === 'cross-site') throw new LiveError('Origin or host not allowed.', 403);
        if (req.method === 'POST' && (req.headers.origin !== origin.origin || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''))) throw new LiveError('A same-origin JSON request is required.', 403);
        const rawCookie = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
        const sessionKey = rawCookie ? hash(rawCookie).toString('hex') : null;
        const session = sessions.get(sessionKey);
        if (session && session.expiresAt <= now()) sessions.delete(sessionKey);
        const authenticated = session && session.expiresAt > now();
        if (route === 'GET /api/live/status') return response({ enabled: true, authenticated: Boolean(authenticated), capCents: LIVE_CAP_CENTS, csrf: authenticated ? session.csrf : undefined, expiresAt: authenticated ? session.expiresAt : undefined, ...(authenticated ? trading.health() : {}) });
        if (route === 'POST /api/live/login') {
          if (now() - failureWindow > TTL) { failures = 0; failureWindow = now(); }
          if (failures >= 5) throw new LiveError('Too many login attempts. Wait 15 minutes.', 429);
          const body = await readBody(req, 8192);
          const password = typeof body.password === 'string' ? body.password : '';
          if (!password || !timingSafeEqual(hash(password), hash(env.LIVE_ADMIN_PASSWORD))) { failures++; if (!failureWindow) failureWindow = now(); throw new LiveError('Invalid sign-in.', 401); }
          const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
          sessions.clear(); // Single operator. New login revokes any old session.
          sessions.set(hash(token).toString('hex'), { csrf, expiresAt: now() + TTL });
          return response({ authenticated: true, csrf, expiresAt: now() + TTL }, 200, { 'set-cookie': cookie(token) });
        }
        if (!authenticated) throw new LiveError('Sign in to access the real account.', 401);
        if (req.method === 'POST' && req.headers['x-csrf-token'] !== session.csrf) throw new LiveError('Session confirmation is missing. Sign in again.', 403);
        if (route === 'POST /api/live/logout') {
          sessions.delete(sessionKey);
          return response({ authenticated: false }, 200, { 'set-cookie': cookie('') });
        }
        if (route === 'GET /api/live/account') return response({ ...await trading.account() });
        if (route === 'GET /api/live/operation') return response({ operation: trading.operation(url.searchParams.get('id')) });
        if (route === 'POST /api/live/preview') return response({ preview: await trading.preview(await readBody(req, 8192), sessionKey) });
        if (route === 'POST /api/live/submit') return response({ operation: await trading.submit(await readBody(req, 8192), sessionKey) });
        return response({ error: 'Live API route not found.' }, 404);
      } catch (error) {
        if (error instanceof LiveError) return response({ error: error.message, code: error.code }, error.status);
        if (error?.code?.startsWith('US_')) return response({ error: error.message, code: error.code }, error.status || 502);
        const info = classifyUSError(error);
        return response({ error: info.message, code: info.code }, info.status);
      }
    },
  };
}
