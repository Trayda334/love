/**
 * Agent 4 - PREDICTION-MARKET AGENT
 *
 * Research only, deliberately kept separate from the meme-coin book. It never
 * claims certainty: if evidence is missing it must choose SKIP. Paper bets are
 * logged on their own ledger with their own 1% risk cap.
 */

import { round } from '../shared/feedcore.mjs';

export const PREDICTION_PROMPT = `You are the Prediction Market Research Agent in a six-agent PAPER trading team.

PAPER MODE ONLY.

For each market, evaluate:
- what event is being predicted
- current market probability
- available evidence
- major arguments for YES
- major arguments for NO
- uncertainty
- important dates
- what information could change the probability

Return:
MARKET:
CURRENT IMPLIED PROBABILITY:
YOUR ESTIMATED RANGE:
WHY:
MAIN UNCERTAINTIES:
PAPER BET: YES / NO / SKIP
MAX PAPER RISK:
CONFIDENCE: LOW / MEDIUM / HIGH

Never claim certainty. If reliable information is missing, choose SKIP.`;

const MIN_WORDS_FOR_EVIDENCE = 12; // below this the operator has not actually researched the market

/** Spread check: implied probability and the cost of crossing the spread. */
export function predictionAgent({ market, account, config, evidence = '', estimatedRange = null, daysToResolve = null }) {
  const cfg = config.prediction;
  const checklist = [];
  const add = (id, label, status, value, threshold, reason) => checklist.push({ id, label, status, value, threshold, reason });

  if (!market || market.yesPrice === null || market.yesPrice === undefined) {
    return {
      agent: 'prediction',
      agentName: 'Agent 4 - Prediction Market',
      verdict: 'SKIP',
      summary: 'No usable market probability was provided - SKIP. Guessing here would be gambling, not research.',
      checklist,
    };
  }

  const implied = market.yesPrice; // 0..1
  const impliedPct = round(implied * 100, 1);

  /* liquidity */
  const liq = Number.isFinite(market.liquidityUsd) ? market.liquidityUsd : null;
  add('liquidity', 'Market is liquid enough to exit', liq === null ? 'unknown' : liq >= cfg.minLiquidityUsd ? 'pass' : 'trigger',
    liq, `>= $${cfg.minLiquidityUsd.toLocaleString('en-US')}`,
    liq === null ? 'The source did not report liquidity.' : liq >= cfg.minLiquidityUsd ? `Reported liquidity $${Math.round(liq).toLocaleString('en-US')}.` : `Only $${Math.round(liq).toLocaleString('en-US')} of liquidity - hard to get out of.`);

  /* spread */
  const spread = Number.isFinite(market.spreadPoints) ? market.spreadPoints : null;
  add('spread', 'Spread is not punishing', spread === null ? 'unknown' : spread <= cfg.maxSpreadPoints ? 'pass' : 'trigger',
    spread, `<= ${cfg.maxSpreadPoints} points`,
    spread === null ? 'Bid/ask were not reported.' : spread <= cfg.maxSpreadPoints ? `Spread is ${round(spread, 1)} points.` : `Spread is ${round(spread, 1)} points - you pay that immediately.`);

  /* time to resolve */
  const days = Number.isFinite(daysToResolve) ? daysToResolve : market.endDate ? (new Date(market.endDate) - Date.now()) / 86400000 : null;
  add('time', 'Enough time left to be right', days === null ? 'unknown' : days >= cfg.minDaysToResolve ? 'pass' : 'trigger',
    days === null ? null : round(days, 1), `>= ${cfg.minDaysToResolve} day(s)`,
    days === null ? 'Resolve date unknown.' : days >= cfg.minDaysToResolve ? `${round(days, 1)} days until it resolves.` : `Resolves in ${round(days, 1)} day(s) - almost no time for your thesis to play out.`);

  /* evidence */
  const words = String(evidence || '').trim().split(/\s+/).filter(Boolean).length;
  add('evidence', 'Evidence was actually gathered', words >= MIN_WORDS_FOR_EVIDENCE ? 'pass' : 'trigger', words, `>= ${MIN_WORDS_FOR_EVIDENCE} words of sourced reasoning`,
    words >= MIN_WORDS_FOR_EVIDENCE ? `${words} words of reasoning supplied.` : 'Almost no reasoning was supplied - the agent is told to SKIP rather than invent confidence.');

  /* edge */
  const est = Array.isArray(estimatedRange) && estimatedRange.length === 2 ? estimatedRange.map(Number) : null;
  let edge = null;
  if (est && est.every(Number.isFinite) && est[0] > 0 && est[1] < 1 && est[1] > est[0]) {
    const mid = (est[0] + est[1]) / 2;
    edge = (mid - implied) * 100;
    add('edge', 'Estimated probability differs from the market', Math.abs(edge) >= cfg.minEdgePoints ? 'pass' : 'trigger',
      round(edge, 1), `|edge| >= ${cfg.minEdgePoints} points`,
      Math.abs(edge) >= cfg.minEdgePoints
        ? `Your midpoint ${round(mid * 100, 1)}% vs market ${impliedPct}% = ${round(edge, 1)} points of edge.`
        : `Your midpoint is within ${round(Math.abs(edge), 1)} points of the market price - there is no edge to take.`);
  } else {
    add('edge', 'Estimated probability differs from the market', 'trigger', null, `|edge| >= ${cfg.minEdgePoints} points`,
      'No honest probability range was supplied, so no edge can be established.');
  }

  const triggers = checklist.filter((c) => c.status === 'trigger');
  const verdict = triggers.length ? 'SKIP' : 'BET';
  const side = edge === null ? (implied < 0.5 ? 'YES' : 'NO') : edge > 0 ? 'YES' : 'NO';
  const price = side === 'YES' ? (market.yesPrice ?? null) : Number.isFinite(market.yesPrice) ? 1 - market.yesPrice : null;

  const balance = Number(account?.equity ?? account?.balance ?? 0);
  const maxRiskPct = Math.min(Number(cfg.maxRiskPctPerBet) || 1, 1);
  const maxRiskUsd = round(balance * (maxRiskPct / 100), 2);
  const openBetCount = Number(account?.openBets ?? 0);
  const overCap = openBetCount >= cfg.maxOpenBets;
  if (overCap) triggers.push({ id: 'bet-cap', label: 'Open bet cap', status: 'trigger', value: openBetCount, threshold: `< ${cfg.maxOpenBets}`, reason: `Already ${openBetCount} paper bets open; the cap is ${cfg.maxOpenBets}.` });

  return {
    agent: 'prediction',
    agentName: 'Agent 4 - Prediction Market',
    verdict: overCap ? 'SKIP' : verdict,
    summary: verdict === 'BET' && !overCap
      ? `PAPER BET ${side} at ${round((price ?? 0) * 100, 1)}% implied, risking at most $${maxRiskUsd} (${maxRiskPct}% of the account).`
      : `SKIP: ${triggers.map((t) => t.reason).join(' ')}`,
    market: {
      id: market.id,
      question: market.question,
      url: market.url,
      endDate: market.endDate,
      currentImpliedProbability: impliedPct,
      bid: market.bid,
      ask: market.ask,
      spreadPoints: spread,
      liquidityUsd: liq,
    },
    estimatedRange: est ? { lowPct: round(est[0] * 100, 1), highPct: round(est[1] * 100, 1) } : null,
    edgePoints: edge === null ? null : round(edge, 1),
    suggestedSide: side,
    suggestedPricePct: price === null ? null : round(price * 100, 1),
    maxPaperRiskUsd: maxRiskUsd,
    confidence: triggers.length ? 'LOW' : words >= 40 && spread !== null && spread <= 2 ? 'MEDIUM' : 'LOW',
    checklist,
    uncertainties: [
      'Market prices are other people\'s opinions; they can stay wrong for a long time.',
      spread === null ? 'Spread unknown, so the true cost of this bet is unknown.' : `You pay about ${round(spread, 1)} points of spread on entry.`,
      days === null ? 'Resolve date unknown.' : `Resolves around ${new Date(market.endDate).toISOString().slice(0, 10)}.`,
    ],
    disclaimer: 'Research only. This is not financial advice and it is not a prediction of the future.',
  };
}

export function formatPredictionText(market, result) {
  return [
    `MARKET: ${result.market?.question || market?.question || 'n/a'}`,
    `CURRENT IMPLIED PROBABILITY: ${result.market?.currentImpliedProbability ?? 'n/a'}%`,
    `YOUR ESTIMATED RANGE: ${result.estimatedRange ? `${result.estimatedRange.lowPct}% - ${result.estimatedRange.highPct}%` : 'not supplied'}`,
    `WHY: ${result.edgePoints === null ? 'no honest edge established' : `${round(result.edgePoints, 1)} points of edge vs the market price`}`,
    `MAIN UNCERTAINTIES: ${(result.uncertainties || []).join(' ')}`,
    `PAPER BET: ${result.verdict === 'BET' ? result.suggestedSide : 'SKIP'}`,
    `MAX PAPER RISK: $${result.maxPaperRiskUsd}`,
    `CONFIDENCE: ${result.confidence}`,
  ].join('\n');
}
