// Research prompts, not forecasts or external data.
export const RESEARCH_TOOLS = {
  nfl: { label: 'NFL', prompts: ['Exact game, kickoff timezone, and market type (winner / spread / total)', 'Which team or proposition does YES mean? Does overtime count? Tie / postponement rules?', 'Confirmed quarterback, injuries and inactive list — source URL and checked-at time', 'Weather, venue, rest and travel — source URL and checked-at time', 'Arguments for each side; your probability range and what would change it'] },
  tennis: { label: 'Tennis', prompts: ['Exact tournament, players, surface and match format', 'Which player does YES mean? Retirement / walkover / cancellation rules?', 'Score, server and match time — source URL and checked-at time (if live)', 'Fitness, recent workload and surface results — source URL and checked-at time', 'Arguments for each side; your probability range and stale-price risk'] },
  btc: { label: 'BTC Up/Down', prompts: ['Exact interval start/end with timezone — not just “today”', 'YES means BTC finishes UP; confirm official reference price and settlement source', 'Equality, price rounding and outage rules from the exact contract', 'Reference price, current reference-source price and quote time — source URLs', 'Arguments for UP and DOWN; your probability range; volatility and time remaining'] },
};

export function manualResearchMarket({ question, url, price, spread, liquidity, endDate }) {
  if (!question.trim()) throw new Error('Enter an explicit YES/NO question (for example: Will team X win this game?).');
  const link = new URL(url);
  if (link.protocol !== 'https:' || !(link.hostname === 'polymarket.com' || link.hostname.endsWith('.polymarket.com'))) throw new Error('Use an https Polymarket market link.');
  const pct = price === '' ? NaN : Number(price);
  if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) throw new Error('Enter the verified YES price between 0 and 100 percent.');
  const optional = (value, max) => {
    if (value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > max) throw new Error('Spread and liquidity must be valid non-negative numbers.');
    return n;
  };
  if (!endDate || !Number.isFinite(Date.parse(endDate))) throw new Error('Enter the exact resolution date and time.');
  return { id: `manual-${Date.now()}`, question: `[USER-PROVIDED] ${question.trim()}`, url: link.href, outcomes: ['Yes', 'No'], yesPrice: pct / 100, spreadPoints: optional(spread, 100), liquidityUsd: optional(liquidity, Number.MAX_SAFE_INTEGER), bid: null, ask: null, endDate: new Date(endDate).toISOString(), source: 'manual', fetchedAt: new Date().toISOString() };
}
