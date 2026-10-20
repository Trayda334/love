import { AuthenticationError, BadRequestError, NotFoundError, RateLimitError } from 'polymarket-us';

// Fixed messages only: upstream messages can contain private request details.
export function classifyUSError(error) {
  if (error instanceof AuthenticationError) return { code: 'US_AUTHENTICATION', status: 502, message: 'Polymarket US rejected the server credentials. Check account access and server secret settings.' };
  if (error instanceof BadRequestError) return { code: 'US_BAD_REQUEST', status: 400, message: 'Polymarket US rejected the request parameters. Check the market slug and supplied fields.' };
  if (error instanceof NotFoundError) return { code: 'US_NOT_FOUND', status: 404, message: 'Polymarket US market or resource not found. Check the US market slug.' };
  if (error instanceof RateLimitError) return { code: 'US_RATE_LIMIT', status: 429, message: 'Polymarket US rate limit reached. Wait before trying again; no automatic retry was made.' };
  return { code: 'US_UNAVAILABLE', status: 502, message: 'Polymarket US request failed. Check API connectivity and try again later.' };
}

export function safeUSError(error) {
  const info = classifyUSError(error);
  // No raw error cause/stack payload from the SDK is retained.
  return Object.assign(new Error(info.message), { code: info.code, status: info.status });
}
