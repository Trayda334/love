/**
 * Agent 3 - BUYER (paper execution only)
 *
 * This agent NEVER sends an order. It builds a simulated trade ticket and it
 * only proceeds when every required approval exists and no position is open.
 * Anything missing => "TRADE BLOCKED".
 */

import { round } from '../shared/feedcore.mjs';

export const BUYER_PROMPT = `You are the execution agent for a six-agent PAPER trading system.

You NEVER place real trades.

Only proceed if:
- Scanner = PASS
- Sizer = APPROVE
- Anti-FOMO Agent = APPROVE
- No other position is currently open

Output:
PAPER TRADE ID:
TOKEN:
SIMULATED ENTRY:
SIMULATED POSITION SIZE:
STOP LOSS:
TARGET:
MAX DOLLAR RISK:
TIME ENTERED:
STATUS: OPEN

If any required approval is missing, respond: TRADE BLOCKED.

Never suggest connecting a wallet or sending a live order.`;

export function buyerAgent({ scanner, sizer, antiFomo, plan, snapshot, config, openPositions = [], sequence = 1, now = new Date() }) {
  const approvals = [
    { agent: 'Scanner (Agent 1)', required: 'PASS', actual: scanner?.verdict || 'MISSING' },
    { agent: 'Sizer (Agent 2)', required: 'APPROVE', actual: sizer?.verdict || 'MISSING' },
    { agent: 'Anti-FOMO (Agent 5)', required: 'APPROVE', actual: antiFomo?.verdict || 'MISSING' },
  ];
  const blockers = [];
  for (const a of approvals) {
    if (a.actual !== a.required) blockers.push(`${a.agent} returned ${a.actual}, expected ${a.required}.`);
  }
  if (openPositions.length > 0) {
    blockers.push(`Position ${openPositions[0].id} on ${openPositions[0].token} is still open - the one-position rule blocks new entries.`);
  }

  const price = Number(snapshot?.metrics?.price);
  const entryLow = Number(plan?.entryArea?.low);
  const entryHigh = Number(plan?.entryArea?.high);
  const stop = Number(plan?.stop);
  const target = Number(plan?.target1);

  if (!Number.isFinite(price)) blockers.push('No current price is available, so a simulated fill cannot be recorded.');
  if (![entryLow, entryHigh, stop, target].every(Number.isFinite)) blockers.push('The plan is incomplete (entry area, stop and target are all required).');

  if (!blockers.length) {
    const tolerance = config.scanner.entryChaseTolerancePct / 100;
    if (price > entryHigh * (1 + tolerance)) {
      blockers.push(`Price ${price} is already above the planned entry area (${entryLow}-${entryHigh}). Filling here would be a chase, so the ticket is blocked.`);
    }
    if (price < stop) {
      blockers.push(`Price ${price} is already below the invalidation level ${stop}. The setup is dead before it started.`);
    }
  }

  if (blockers.length) {
    return {
      agent: 'buyer',
      agentName: 'Agent 3 - Buyer',
      verdict: 'BLOCKED',
      status: 'BLOCKED',
      summary: `TRADE BLOCKED. ${blockers.join(' ')}`,
      blockers,
      approvals,
      reminders: ['This is paper only. No wallet, no exchange keys, no live order was or can be sent.'],
    };
  }

  const tradeId = `PT-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${String(sequence).padStart(3, '0')}`;
  const fill = round(price, 8);
  const units = round(Number(sizer.sizeUnits), 8);
  const notional = round(units * fill, 2);

  /* Risk is measured from the price actually filled, not from the middle of the
     planned entry area, so the ledger's "max dollar risk" is the real number. */
  const roundTripBps = (Number(config.fees?.takerBps) || 0) * 2 + (Number(config.fees?.slippageBps) || 0) * 2;
  const fillStopDistancePct = ((fill - stop) / fill) * 100;
  const grossRiskUsd = round(units * (fill - stop), 4);
  const estCostsUsd = config.fees?.includeInPaperPnl === false ? 0 : round((notional + units * stop) * (roundTripBps / 20000), 4);
  const maxDollarRisk = round(grossRiskUsd + estCostsUsd, 2);

  return {
    agent: 'buyer',
    agentName: 'Agent 3 - Buyer',
    verdict: 'TICKET',
    status: 'OPEN',
    summary: `Paper ticket ${tradeId} created. Simulated fill ${units} units at ${fill} ($${notional}). Status OPEN.`,
    approvals,
    ticket: {
      id: tradeId,
      token: snapshot.token,
      pair: snapshot.pair,
      simulatedEntry: fill,
      simulatedPositionSizeUnits: units,
      simulatedPositionNotionalUsd: notional,
      entryArea: { low: entryLow, high: entryHigh },
      stopLoss: stop,
      target: target,
      maxDollarRisk,
      maxDollarRiskGross: grossRiskUsd,
      maxDollarRiskPlanned: sizer.actualRiskUsd,
      fillStopDistancePct: round(fillStopDistancePct, 4),
      estExitCostsUsd: estCostsUsd,
      timeEntered: now.toISOString(),
      status: 'OPEN',
      timeframe: plan.timeframe,
      dataSourceAtEntry: `${snapshot.sourceLabel} (${snapshot.dataQuality})`,
    },
    reminders: [
      `Simulated fill recorded from the observed price - not a real execution, and slippage is estimated rather than measured. Worst case from this fill (stop + estimated costs): $${maxDollarRisk}.`,
      `The Sizer planned $${sizer.actualRiskUsd} of risk from the middle of the entry area (${sizer.stopDistancePct}%); the fill was ${round(fillStopDistancePct, 3)}% above the stop. The ledger keeps both figures.`,
      'Close it yourself when the stop or target is reached, or let the paper-desk mark it to market.',
    ],
  };
}

export function formatBuyerTicketText(ticket, buyer) {
  if (!ticket) return `TRADE BLOCKED\n${(buyer?.blockers || []).join('\n')}`;
  return [
    `PAPER TRADE ID: ${ticket.id}`,
    `TOKEN: ${ticket.token} (${ticket.pair})`,
    `SIMULATED ENTRY: ${ticket.simulatedEntry}`,
    `SIMULATED POSITION SIZE: ${ticket.simulatedPositionSizeUnits} units ($${ticket.simulatedPositionNotionalUsd} notional)`,
    `STOP LOSS: ${ticket.stopLoss}`,
    `TARGET: ${ticket.target}`,
    `MAX DOLLAR RISK: $${ticket.maxDollarRisk}`,
    `TIME ENTERED: ${ticket.timeEntered}`,
    `STATUS: ${ticket.status}`,
  ].join('\n');
}
