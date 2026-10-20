/**
 * Agent 2 - SIZER
 *
 * Job: turn a setup into a conservative *simulated* position size, or reject it.
 * Hard limits it can never exceed: 1% of the paper account, one open position,
 * no leverage. The 1% figure is the ceiling on what can be LOST if the stop is
 * hit - not the size of the position.
 */

import { round } from '../shared/feedcore.mjs';
import { HARD_RULES } from '../config.mjs';

export const SIZER_PROMPT = `You are the Risk and Position Sizing Agent in a six-agent PAPER trading team.

You do not place trades. Your job is to calculate a conservative simulated position size.

Rules:
- PAPER TRADING ONLY
- Maximum account risk per trade: 1%
- Only one open position at a time
- Never increase risk after losing trades
- Never recommend leverage
- If the stop-loss distance makes the trade too risky, reject it

I will provide:
ACCOUNT SIZE:
ENTRY:
STOP LOSS:
TARGET:

Calculate:
1. Maximum dollars allowed to be lost
2. Percentage distance between entry and stop
3. Suggested PAPER position size
4. Estimated risk/reward ratio
5. APPROVE or REJECT

Explain everything in simple language.`;

export function sizerAgent({ plan, account, config, openPositions = [], lastClosedTrade = null, reuseStopDistancePct = null }) {
  const cfg = config.risk;
  const checks = [];
  const plainEnglish = [];
  const add = (id, label, status, value, threshold, reason) => checks.push({ id, label, status, value, threshold, reason });

  const balance = Number(account?.balance);
  const equity = Number.isFinite(account?.equity) ? account.equity : balance;

  if (!Number.isFinite(balance) || balance <= 0) {
    return reject('Account balance is not available, so no size can be calculated.');
  }
  if (!plan || !Number.isFinite(plan.entryMid) || !Number.isFinite(plan.stop) || !Number.isFinite(plan.target1)) {
    return reject('Entry, stop and target must all be numbers before sizing.');
  }

  function reject(summary, extraChecks = []) {
    return {
      agent: 'sizer',
      agentName: 'Agent 2 - Sizer',
      verdict: 'REJECT',
      summary,
      checks: [...checks, ...extraChecks],
      plainEnglish,
    };
  }

  const entry = plan.entryMid;
  const stop = plan.stop;
  const target = plan.target1;

  /* --- the one-position rule --------------------------------------- */
  add('one-position', 'Only one open position at a time', openPositions.length === 0 ? 'pass' : 'trigger',
    openPositions.length, '0 open positions',
    openPositions.length === 0 ? 'No position is currently open.' : `Position ${openPositions[0].id} (${openPositions[0].token}) is still open - this rule is fixed.`);

  /* --- risk budget -------------------------------------------------- */
  let riskPct = Number(cfg.riskPctPerTrade);
  let riskReducedBy = null;
  if (cfg.neverIncreaseRiskAfterLoss && lastClosedTrade?.result === 'LOSS' && Number.isFinite(lastClosedTrade.riskPctAtEntry)) {
    const previous = Number(lastClosedTrade.riskPctAtEntry);
    if (riskPct > previous) {
      riskPct = previous;
      riskReducedBy = previous;
    }
  }
  riskPct = Math.min(riskPct, HARD_RULES.maxRiskPctPerTrade);
  const maxLossUsd = balance * (riskPct / 100);

  plainEnglish.push(`Risk budget: ${riskPct}% of a $${round(balance, 2)} paper account = $${round(maxLossUsd, 2)} that may be lost if the stop is hit.`);
  if (riskReducedBy !== null) {
    plainEnglish.push(`The last closed trade was a loss, so risk stays at or below the previous ${riskReducedBy}% - risk is never increased after a loss.`);
  }
  add('risk-budget', 'Max risk per trade <= 1% of account', 'pass', round(maxLossUsd, 2), `<= $${round(balance * (HARD_RULES.maxRiskPctPerTrade / 100), 2)}`,
    `Allowed loss this trade: $${round(maxLossUsd, 2)}.`);

  /* --- stop distance ------------------------------------------------ */
  const stopDistPct = ((entry - stop) / entry) * 100;
  if (!(entry > stop)) {
    return reject('Stop must be below the entry for a long. Rejecting.', [
      { id: 'stop-side', label: 'Stop below entry', status: 'trigger', value: stop, threshold: `< ${entry}`, reason: 'The stop is not below the entry, so the distance cannot be measured.' },
    ]);
  }
  add('stop-distance', 'Stop distance is sane', stopDistPct >= cfg.minStopDistancePct && stopDistPct <= cfg.maxStopDistancePct ? 'pass' : 'trigger',
    round(stopDistPct, 2), `${cfg.minStopDistancePct}% - ${cfg.maxStopDistancePct}%`,
    stopDistPct < cfg.minStopDistancePct
      ? `Stop is only ${round(stopDistPct, 2)}% away - inside normal 5-minute noise. It would be hit almost randomly.`
      : stopDistPct > cfg.maxStopDistancePct
        ? `Stop is ${round(stopDistPct, 2)}% away - too wide. Either the entry is late or the level is not a clean invalidation.`
        : `Stop is ${round(stopDistPct, 2)}% below the entry - a normal, defensible distance.`);

  /* --- reward/risk -------------------------------------------------- */
  const rr = (target - entry) / (entry - stop);
  add('risk-reward', 'Reward/risk at least the minimum', rr >= cfg.minRiskReward ? 'pass' : 'trigger', round(rr, 2), `>= ${cfg.minRiskReward}R`,
    rr >= cfg.minRiskReward ? `Reward is ${round(rr, 2)}x the risk.` : `Reward is only ${round(rr, 2)}x the risk; a losing streak would be brutal to recover from.`);

  /* --- sizing ------------------------------------------------------- */
  const roundTripBps = (Number(config.fees?.takerBps) || 0) * 2 + (Number(config.fees?.slippageBps) || 0) * 2;
  const lossPerDollar = stopDistPct / 100 + (config.fees?.includeInPaperPnl ? roundTripBps / 10000 : 0);
  let notional = maxLossUsd / lossPerDollar;

  const notionalCap = balance * (cfg.maxPositionNotionalPct / 100);
  const cashCap = balance;
  const capped = [];
  if (notional > notionalCap) {
    notional = notionalCap;
    capped.push(`capped at ${cfg.maxPositionNotionalPct}% of the account`);
  }
  if (notional > cashCap) {
    notional = cashCap;
    capped.push('capped at available paper cash');
  }

  const sizeUnits = notional / entry;
  const estFeeUsd = notional * (roundTripBps / 10000);
  const actualRiskUsd = notional * (stopDistPct / 100);
  const worstCaseUsd = actualRiskUsd + (config.fees?.includeInPaperPnl ? estFeeUsd : 0);

  plainEnglish.push(`Position math: $${round(maxLossUsd, 2)} ÷ ${round(stopDistPct, 2)}% stop distance = $${round(maxLossUsd / (stopDistPct / 100), 2)} of notional.`);
  plainEnglish.push(`That buys ${round(sizeUnits, 4)} ${plan.token || 'units'} at ${entry}. Note the POSITION is worth $${round(notional, 2)} - only $${round(actualRiskUsd, 2)} is at risk if the stop is hit.`);
  if (capped.length) plainEnglish.push(`Size was ${capped.join(' and ')}, which only ever makes the trade smaller.`);
  plainEnglish.push(`Simulated round-trip cost (fees $${round(estFeeUsd, 2)}): worst case including costs is about $${round(worstCaseUsd, 2)}.`);
  plainEnglish.push(`If the target is hit instead, the paper gain is about $${round(notional * ((target - entry) / entry), 2)} before costs.`);

  add('position-size', 'Position size is workable', notional >= cfg.minPositionNotionalUsd ? 'pass' : 'trigger',
    round(notional, 2), `>= $${cfg.minPositionNotionalUsd}`,
    notional >= cfg.minPositionNotionalUsd
      ? `Suggested paper position: $${round(notional, 2)} (${round(sizeUnits, 4)} units).`
      : `The maths gives a position of only $${round(notional, 2)} - too small to be a meaningful test.`);
  add('leverage', 'No leverage', 'pass', '1x spot', '1x spot only', 'This is a 1x spot paper position. Leverage is never suggested.');

  const notionalPct = balance ? (notional / balance) * 100 : null;
  if (Number.isFinite(notionalPct) && notionalPct > 50) {
    add('gap-risk', 'Position size vs gap risk (informational)', 'note', `${round(notionalPct, 1)}% of the account`, 'informational only',
      `A tight stop means a large position: this uses ${round(notionalPct, 1)}% of the paper account. The 1% rule assumes the stop is filled exactly - a gap or a bad fill would lose more than $${round(maxLossUsd, 2)}. That is the assumption the whole rule rests on.`);
    plainEnglish.push(`Note the size: ${round(notionalPct, 1)}% of the account sits in this one paper position because the stop is only ${round(stopDistPct, 2)}% away. The 1% rule holds only if the stop is actually filled where you planned.`);
  }

  if (Number.isFinite(reuseStopDistancePct)) {
    add('duplicate-setup', 'Not repeating an identical stop distance right after a block', Math.abs(reuseStopDistancePct - stopDistPct) < 0.01 ? 'note' : 'pass',
      round(stopDistPct, 2), 'informational', 'Informational only: an identical stop distance was recently rejected.');
  }

  const triggers = checks.filter((c) => c.status === 'trigger');
  const verdict = triggers.length ? 'REJECT' : 'APPROVE';

  return {
    agent: 'sizer',
    agentName: 'Agent 2 - Sizer',
    verdict,
    summary: verdict === 'APPROVE'
      ? `APPROVE: risk $${round(actualRiskUsd, 2)} (${round((actualRiskUsd / balance) * 100, 2)}% of the account) with a $${round(notional, 2)} paper position, stop ${round(stopDistPct, 2)}% away, ${round(rr, 2)}R.`
      : `REJECT: ${triggers.map((t) => t.reason).join(' ')}`,
    checks,
    riskPct: round(riskPct, 3),
    maxLossUsd: round(maxLossUsd, 2),
    stopDistancePct: round(stopDistPct, 3),
    positionNotionalUsd: round(notional, 2),
    sizeUnits: round(sizeUnits, 8),
    estRoundTripCostUsd: round(estFeeUsd, 4),
    actualRiskUsd: round(actualRiskUsd, 2),
    worstCaseUsd: round(worstCaseUsd, 2),
    rewardRisk: round(rr, 2),
    potentialGainUsd: round(notional * ((target - entry) / entry), 2),
    plainEnglish,
  };
}
