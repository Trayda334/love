/** Manual real-money gateway. Never called by paper agents or background timers. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { safeUSError } from '../feeds/polymarket-us-errors.mjs';

export const LIVE_CAP_CENTS = 1000;
export class LiveError extends Error {
  constructor(message, status = 400, code = 'LIVE_BLOCKED') { super(message); this.status = status; this.code = code; }
}
const block = (message, status = 400) => { throw new LiveError(message, status); };
const slugOK = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(value);
function decimal(value, digits) {
  const text = String(value);
  if (!new RegExp(`^\\d{1,12}(?:\\.\\d{1,${digits}})?$`).test(text)) block('Invalid decimal value or unsupported precision.');
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, '0'));
}
const ceil = (a, b) => (a + b - 1n) / b;

export function validateLiveOrder(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['marketSlug', 'price', 'quantity'].includes(key))) block('Only marketSlug, price and quantity are accepted.');
  if (!slugOK(input.marketSlug)) block('Enter a valid US market slug.');
  const price = decimal(input.price, 4), quantity = decimal(input.quantity, 3);
  if (price <= 0n || price >= 10000n || quantity <= 0n || quantity > 1000000n) block('Use a price between $0 and $1 and a positive quantity of at most 1,000 contracts.');
  if (ceil(price * quantity, 100000n) > BigInt(LIVE_CAP_CENTS)) block('The hard per-order spending cap is $10, including the fee reserve.');
  return Object.freeze({ marketSlug: input.marketSlug, intent: 'ORDER_INTENT_BUY_LONG', type: 'ORDER_TYPE_LIMIT', price: Object.freeze({ value: String(input.price), currency: 'USD' }), quantity: Number(input.quantity), tif: 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL', manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_MANUAL' });
}

export function reportedUSDBalance(data) {
  const entries = Array.isArray(data?.balances) ? data.balances.filter(b => b?.currency === 'USD') : data?.currency === 'USD' ? [data] : [];
  if (entries.length !== 1 || entries[0].buyingPower === null || entries[0].buyingPower === undefined) block('The API did not report an unambiguous USD buying power. Submission is blocked.');
  return entries[0];
}

function checkPreview(request, response) {
  const order = response?.order;
  if (!order || order.marketSlug !== request.marketSlug || order.intent !== request.intent || order.type !== request.type || order.tif !== request.tif || order.price?.currency !== 'USD' || decimal(order.price.value, 4) !== decimal(request.price.value, 4) || decimal(order.quantity, 3) !== decimal(request.quantity, 3)) block('The preview did not confirm the exact requested IOC limit order. No order was sent.');
  if (!['ORDER_STATE_NEW', 'ORDER_STATE_PENDING_NEW'].includes(order.state)) block('The preview did not report an acceptable new-order state. No order was sent.');
  if (order.commissionsBasisPoints === undefined || order.makerCommissionsBasisPoints === undefined) block('The preview did not report both fee rates. Cannot enforce the $10 spending cap.');
  const taker = decimal(order.commissionsBasisPoints, 4), maker = decimal(order.makerCommissionsBasisPoints, 4);
  const feeRate = taker > maker ? taker : maker;
  if (feeRate > 100000000n) block('Unsupported fee rate.');
  const product = decimal(request.price.value, 4) * decimal(request.quantity, 3);
  const notionalCents = Number(ceil(product, 100000n));
  const feeReserveCents = Number(ceil(product * feeRate, 10000000000000n));
  const totalCents = notionalCents + feeReserveCents;
  if (totalCents > LIVE_CAP_CENTS) block('Order plus reported fee reserve exceeds the $10 hard cap. Reduce the quantity.');
  return { notionalCents, feeReserveCents, totalCents };
}

/** Durable dispatch log prevents retrying an ambiguous submission after restart. */
export function createLiveJournal(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const lockname = filename + '.lock';
  // Exclusive startup lock. A crash leaves it behind: never guess a stale lock.
  const lockFD = fs.openSync(lockname, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  let fd, closed = false, lockOpen = true;
  try {
    fs.writeFileSync(lockFD, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    fs.fsyncSync(lockFD);
    fs.closeSync(lockFD);
    lockOpen = false;
    fd = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
    fs.fchmodSync(fd, 0o600);
    const dirFD = fs.openSync(path.dirname(filename), 'r');
    try { fs.fsyncSync(fd); fs.fsyncSync(dirFD); } finally { fs.closeSync(dirFD); }
    const latest = new Map();
    const text = fs.readFileSync(fd, 'utf8');
    try {
      for (const line of text.split('\n').filter(Boolean)) {
        const entry = JSON.parse(line);
        if (typeof entry.id !== 'string' || !entry.id || !['DISPATCHING', 'ACCEPTED', 'UNKNOWN'].includes(entry.state) || (entry.state === 'ACCEPTED' && (typeof entry.orderId !== 'string' || !entry.orderId))) throw new Error();
        latest.set(entry.id, entry);
      }
    } catch { throw new Error('Live dispatch journal is invalid; trading remains disabled. Reconcile it privately before restarting.'); }
    return {
      latest,
      append(entry) {
        if (closed) throw new Error('Journal closed.');
        const line = Buffer.from(JSON.stringify(entry) + '\n');
        if (fs.writeSync(fd, line) !== line.length) throw new Error('Incomplete journal write.');
        fs.fsyncSync(fd);
        latest.set(entry.id, entry);
      },
      close() {
        if (closed) return;
        closed = true;
        fs.closeSync(fd);
        fs.unlinkSync(lockname);
      },
    };
  } catch (error) {
    if (lockOpen) try { fs.closeSync(lockFD); } catch {}
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockname); } catch {}
    throw error;
  }
}

export function createLiveTrading({ client, journal, now = Date.now }) {
  const drafts = new Map();
  let submitting = false;
  const uncertain = () => [...journal.latest.values()].some(entry => entry.state !== 'ACCEPTED');
  const call = async fn => { try { return await fn(); } catch (error) { if (error instanceof LiveError) throw error; throw safeUSError(error); } };
  const review = async request => {
    const [marketResponse, balances, preview] = await call(() => Promise.all([
      client.markets.retrieveBySlug(request.marketSlug), client.account.balances(), client.orders.preview({ request }),
    ]));
    const market = marketResponse?.market;
    if (!market || market.slug !== request.marketSlug || market.active !== true || market.closed !== false || typeof market.title !== 'string' || !market.title || typeof market.outcome !== 'string' || !market.outcome) block('Market identity, long outcome or active status is unverified.');
    const costs = checkPreview(request, preview);
    const balance = reportedUSDBalance(balances);
    const buyingPowerCents = decimal(balance.buyingPower, 6) / 10000n;
    if (BigInt(costs.totalCents) > buyingPowerCents) block('Insufficient reported USD buying power for the order and fee reserve.');
    return { request, market: { slug: market.slug, title: market.title, outcome: market.outcome, description: market.description || '' }, ...costs, buyingPower: balance.buyingPower };
  };
  return {
    health: () => ({ capCents: LIVE_CAP_CENTS, uncertain: uncertain() }),
    account: () => call(async () => {
      const [balances, positions, orders] = await Promise.all([client.account.balances(), client.portfolio.positions({ limit: 20 }), client.orders.list()]);
      return { balances, positions, orders, fetchedAt: new Date(now()).toISOString() };
    }),
    async preview(input, owner) {
      if (uncertain()) block('An earlier submission has an unknown outcome. Reconcile it in Polymarket US before any new order.', 409);
      for (const [key, draft] of drafts) if (draft.expiresAt <= now() || draft.owner === owner) drafts.delete(key);
      if (drafts.size >= 100) block('Too many pending previews. Try later.', 429);
      const request = validateLiveOrder(input);
      const reviewed = await review(request);
      const id = randomUUID(), expiresAt = now() + 60000;
      drafts.set(id, { ...reviewed, id, expiresAt, owner });
      return { ...reviewed, id, expiresAt, confirmation: `BUY ${request.quantity} LONG ${request.marketSlug}` };
    },
    async submit({ previewId, confirmation, acknowledged }, owner) {
      if (submitting || uncertain()) block('Submission is busy or an earlier outcome is unknown. Do not retry.', 409);
      const draft = drafts.get(previewId);
      if (!draft || draft.owner !== owner || draft.expiresAt <= now()) block('Preview expired or not found. Request a new preview.', 409);
      if (acknowledged !== true || confirmation !== `BUY ${draft.request.quantity} LONG ${draft.request.marketSlug}`) block('Confirm the exact long outcome and type the displayed confirmation.');
      // Consume BEFORE any await: concurrent clicks cannot send two orders.
      drafts.delete(previewId);
      submitting = true;
      let dispatched = false;
      try {
        const fresh = await review(draft.request);
        if (draft.expiresAt <= now() || fresh.totalCents > draft.totalCents || fresh.market.title !== draft.market.title || fresh.market.outcome !== draft.market.outcome || fresh.market.description !== draft.market.description) block('Preview changed or expired. Review a new preview before submission.', 409);
        const dispatch = { id: draft.id, state: 'DISPATCHING', at: new Date(now()).toISOString(), marketSlug: draft.request.marketSlug, totalCents: fresh.totalCents };
        journal.append(dispatch); // Fail closed if durable write fails.
        dispatched = true;
        const result = await client.orders.create(draft.request); // Exactly one attempt; never retried.
        if (!result || typeof result.id !== 'string' || !result.id) throw new Error('Missing order ID');
        const record = { ...dispatch, state: 'ACCEPTED', orderId: result.id, at: new Date(now()).toISOString() };
        journal.append(record);
        return { ...record, message: 'Exchange returned an order ID. This is not a fill confirmation. Check the order in Polymarket US.' };
      } catch (error) {
        if (dispatched) {
          try { journal.append({ id: draft.id, state: 'UNKNOWN', at: new Date(now()).toISOString(), marketSlug: draft.request.marketSlug }); } catch { /* DISPATCHING already survives restart */ }
          throw new LiveError('Submission outcome is unknown. Do NOT retry. Check orders and activity in Polymarket US and reconcile the dispatch journal.', 409, 'LIVE_UNKNOWN');
        }
        if (error instanceof LiveError) throw error;
        throw safeUSError(error);
      } finally { submitting = false; }
    },
    operation(id) {
      const record = journal.latest.get(id);
      if (!record) block('Operation not found. If a submit request was interrupted, do not assume no order was sent.', 404);
      return record;
    },
  };
}
