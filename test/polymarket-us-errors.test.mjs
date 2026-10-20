import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthenticationError, BadRequestError, NotFoundError, RateLimitError } from 'polymarket-us';
import { classifyUSError, safeUSError } from '../src/feeds/polymarket-us-errors.mjs';

for (const [Type, code, status] of [
  [AuthenticationError, 'US_AUTHENTICATION', 502],
  [BadRequestError, 'US_BAD_REQUEST', 400],
  [NotFoundError, 'US_NOT_FOUND', 404],
  [RateLimitError, 'US_RATE_LIMIT', 429],
  [Error, 'US_UNAVAILABLE', 502],
]) {
  test(`US errors classify ${code} without exposing upstream details`, () => {
    const upstream = new Type('private-account-and-secret');
    const info = classifyUSError(upstream);
    assert.equal(info.code, code);
    assert.equal(info.status, status);
    assert.doesNotMatch(JSON.stringify(info), /private-account-and-secret/);
    const safe = safeUSError(upstream);
    assert.equal(safe.message, info.message);
    assert.equal(safe.code, code);
    assert.equal(safe.cause, undefined);
    assert.doesNotMatch(safe.stack, /private-account-and-secret/);
  });
}
test('non-Error throws get a safe fallback', () => {
  for (const value of [null, undefined, 'secret', { message: 'secret' }]) {
    assert.equal(classifyUSError(value).code, 'US_UNAVAILABLE');
  }
});
