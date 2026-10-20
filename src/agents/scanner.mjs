/**
 * Agent 1 - SCANNER
 *
 * Job: find possible setups and say PASS or SKIP. It does not size anything and
 * it never executes. If structure is unclear it must say SKIP.
 *
 * Deterministic by design: the same snapshot + config always yields the same
 * verdict, and every reason is printed with the number that produced it.
 */

import { round } from '../shared/feedcore.mjs';

export const SCANNER_PROMPT = `You are the Scanner in a six-agent paper-trading team.

Your job is ONLY to identify potential crypto meme-coin trade setups.
PAPER TRADING ONLY. Do not tell me to buy anything with real money.

For every token I give you, analyze:
- current price action
- recent volume
- liquidity
- recent percentage move
- whether price looks extended
- major support and resistance
- whether the move appears orderly or extremely volatile

Return:
TOKEN:
SETUP:
ENTRY AREA:
INVALIDATION LEVEL:
WHY IT MAY BE INTERESTING:
MAIN RISKS:
PASS OR SKIP:

Never choose position size. Never execute a trade. Never chase a token simply
because it is already pumping. If the setup is unclear, say SKIP.`;

/* ------------------------------------------------------------------ *
 * plan derivation - a *proposed* structure, which the Sizer may reject and
 * the Anti-FOMO agent may block. The operator can always override by hand.
 * ------------------------------------------------------------------ */

export function derivePlan(metrics, config, override = {}) {
  const notes = [];
  if (!metrics?.ok && !metrics?.manual) {
    return { ok: false, notes: [metrics?.reason || 'No usable metrics.'], setup: null };
  }
  const price = metrics.price;
  const atrPct = Number.isFinite(override.atrPct) ? override.atrPct : metrics.atrPct ?? metrics.stdev5mPct ?? 1.5;
  const bufferPct = Math.max(0.3, atrPct * 0.35);
  const baseLow = metrics.recentLow6 ?? metrics.support1h ?? price * 0.98;
  const baseHigh = metrics.recentHigh6 ?? metrics.resistance1h ?? price * 1.02;

  let setup;
  let entryLow;
  let entryHigh;
  let stop;
  let target;
  let quality;

  if (!metrics.manual && metrics.trend1h === 'down' && (metrics.positionIn1hRange ?? 0.5) <= 0.35) {
    setup = 'Falling structure - no long entry here';
    quality = 'weak';
    entryLow = price * 0.9975;
    entryHigh = price * 1.0025;
    stop = price * (1 - Math.max(bufferPct * 1.6, 1.2) / 100);
    target = Number.isFinite(metrics.resistance1h) && metrics.resistance1h > price * 1.01
      ? metrics.resistance1h
      : price * (1 + 3 * Math.max(bufferPct * 1.6, 1.2) / 100);
    notes.push('Price is falling relative to its own recent range; the Scanner is expected to SKIP this.');
  } else if (!metrics.manual && (metrics.consolidating || metrics.baseDetected)) {
    setup = 'Base / coil near recent range lows-mid';
    entryLow = baseLow;
    entryHigh = baseHigh;
    stop = Math.min(baseLow, metrics.support1h ?? baseLow) * (1 - bufferPct / 100);
    target = Number.isFinite(metrics.resistance3h) && metrics.resistance3h > entryHigh * 1.005
      ? metrics.resistance3h
      : entryHigh * (1 + 3 * bufferPct / 100);
    quality = metrics.consolidating ? 'clean' : 'acceptable';
  } else if (!metrics.manual && metrics.pullback) {
    setup = 'Pullback into support after an advance';
    entryLow = Math.min(metrics.support1h ?? price, price);
    entryHigh = price * 1.002;
    stop = Math.min(baseLow, metrics.support1h ?? baseLow) * (1 - bufferPct / 100);
    target = Number.isFinite(metrics.resistance1h) && metrics.resistance1h > price * 1.005
      ? metrics.resistance1h
      : price * (1 + 3 * bufferPct / 100);
    quality = 'acceptable';
  } else {
    setup = metrics.manual
      ? 'Operator-defined level (manual data - no candle structure available)'
      : 'Momentum continuation with no clean base';
    entryLow = price * 0.9975;
    entryHigh = price * 1.0025;
    stop = price * (1 - Math.max(bufferPct * 1.6, 1.2) / 100);
    target = Number.isFinite(metrics.resistance1h) && metrics.resistance1h > price * 1.01
      ? metrics.resistance1h
      : price * (1 + 3 * Math.max(bufferPct * 1.6, 1.2) / 100);
    quality = 'weak';
    notes.push('No base or pullback was detected, so the derived entry area is a guess around the last price. The Anti-FOMO agent will usually block this.');
  }

  const plan = {
    ok: true,
    direction: 'long',
    setup,
    setupQuality: quality,
    entryArea: { low: round(entryLow, 8), high: round(entryHigh, 8) },
    stop: round(stop, 8),
    target1: round(target, 8),
    timeframe: 'intraday (5-minute bars)',
    derivedFrom: metrics.manual ? 'operator input' : 'candle structure',
    notes,
    ...override,
  };
  plan.entryMid = round(((plan.entryArea.low + plan.entryArea.high) / 2), 8);
  plan.stopDistancePct = round(((plan.entryMid - plan.stop) / plan.entryMid) * 100, 3);
  plan.rewardRisk = plan.entryMid > plan.stop ? round((plan.target1 - plan.entryMid) / (plan.entryMid - plan.stop), 2) : null;
  return plan;
}

/* ------------------------------------------------------------------ *
 * agent
 * ------------------------------------------------------------------ */

export function scannerAgent({ snapshot, plan, config }) {
  const m = snapshot?.metrics || {};
  const checks = [];
  const add = (id, label, status, value, threshold, reason) => checks.push({ id, label, status, value, threshold, reason });

  if (!m.ok && !m.manual) {
    return {
      agent: 'scanner',
      agentName: 'Agent 1 - Scanner',
      verdict: 'SKIP',
      summary: m.reason || 'Snapshot had no usable metrics.',
      checks,
      notes: [snapshot?.dataQuality ? `Data quality: ${snapshot.dataQuality}` : ''],
    };
  }

  const cfg = config.scanner;
  const manual = Boolean(m.manual);

  /* 1. data sufficiency */
  if (manual) {
    add('data', 'Enough history to read structure', 'unknown', null, `${cfg.minCandles} closed 5m candles`, 'Manual entry supplies no candles, so structure checks cannot be verified.');
  } else {
    add('data', 'Enough history to read structure', m.candles >= cfg.minCandles ? 'pass' : 'trigger', m.candles, `>= ${cfg.minCandles} closed 5m candles`,
      m.candles >= cfg.minCandles ? `${m.candles} closed 5-minute candles available.` : `Only ${m.candles} candles - too little to judge structure.`);
  }

  /* 2. volatility */
  if (Number.isFinite(m.atrPct)) {
    add('volatility', 'Orderly or extremely volatile', m.atrPct <= cfg.maxAtrPct ? 'pass' : 'trigger', round(m.atrPct, 2), `ATR <= ${cfg.maxAtrPct}% of price`,
      m.atrPct <= cfg.maxAtrPct ? `Average 5-minute range is ${round(m.atrPct, 2)}% of price - moving in a readable way.` : `Average 5-minute range is ${round(m.atrPct, 2)}% of price - wild enough that stops get hit randomly.`);
  } else {
    add('volatility', 'Orderly or extremely volatile', 'unknown', null, `ATR <= ${cfg.maxAtrPct}%`, 'Volatility could not be measured from the supplied data.');
  }

  /* 3. volume / liquidity */
  const vol = m.volume24hUsd;
  if (Number.isFinite(vol)) {
    add('volume', 'Volume is real', vol >= cfg.minVolume24hUsd ? 'pass' : 'trigger', Math.round(vol), `>= $${cfg.minVolume24hUsd.toLocaleString('en-US')} 24h`,
      vol >= cfg.minVolume24hUsd ? `24-hour volume of about $${Math.round(vol).toLocaleString('en-US')}.` : `24-hour volume of only about $${Math.round(vol).toLocaleString('en-US')} - easy to get trapped.`);
  } else if (Number.isFinite(m.liquidityUsd)) {
    add('volume', 'Liquidity is real', m.liquidityUsd >= cfg.minVolume24hUsd ? 'pass' : 'trigger', Math.round(m.liquidityUsd), `>= $${cfg.minVolume24hUsd.toLocaleString('en-US')}`,
      m.liquidityUsd >= cfg.minVolume24hUsd ? 'Operator-supplied liquidity clears the bar.' : 'Operator-supplied liquidity is thin.');
  } else {
    add('volume', 'Volume is real', 'unknown', null, `>= $${cfg.minVolume24hUsd.toLocaleString('en-US')}`, 'No volume or liquidity figure was supplied - it stays UNVERIFIED.');
  }

  /* 4. trend - a long-only desk declines to buy a falling market */
  const downtrend = m.trend1h === 'down' && (m.trend24h === 'down' || m.positionIn1hRange === null || m.positionIn1hRange <= 0.35);
  add('trend', 'Not trying to catch a downtrend', m.trend1h === null ? 'unknown' : downtrend ? 'trigger' : 'pass',
    m.trend1h, 'the 1-hour trend is not down while price sits in the lower part of its range',
    m.trend1h === null ? 'The trend could not be measured.'
      : downtrend ? `The 1-hour trend is down (1h ${fmtPct(m.r60)}) and price is in the lower part of its recent range - a long here is a falling knife.`
        : `The 1-hour trend is ${m.trend1h} (1h ${fmtPct(m.r60)}), so this is not a knife-catch.`);

  /* 5. extension is INFORMATIONAL here: chasing is Agent 5's job, not the Scanner's */
  add('extension', 'Not already stretched (informational)', 'note', m.extended ? 'extended' : 'normal', 'not at the top of its range after a fast move',
    m.extended
      ? `Price looks stretched (5m ${fmtPct(m.r5)}, 15m ${fmtPct(m.r15)}, ${m.positionIn1hRange === null ? 'range position unknown' : `${Math.round((m.positionIn1hRange || 0) * 100)}% up its 1-hour range`}). The Scanner does not block on this - Agent 5 does, and it is stricter.`
      : 'Price is not stretched relative to its recent range.');

  /* 5. clean invalidation (stop makes sense) */
  if (plan && Number.isFinite(plan.stop) && Number.isFinite(plan.entryArea?.low)) {
    const stopBelowEntry = plan.stop < plan.entryArea.low;
    add('invalidation', 'Invalidation level exists and makes sense', stopBelowEntry ? 'pass' : 'trigger', plan.stop, `< entry area low ${plan.entryArea.low}`,
      stopBelowEntry ? `Stop at ${plan.stop} sits below the entry area, so the trade has a clear "I was wrong" level.` : 'Stop is not below the entry area - there is no defined invalidation.');
  } else {
    add('invalidation', 'Invalidation level exists and makes sense', 'trigger', null, 'a stop below entry', 'No stop level was supplied.');
  }

  /* 6. reward/risk */
  if (plan && Number.isFinite(plan.rewardRisk)) {
    add('risk-reward', 'Reward justifies the risk', plan.rewardRisk >= cfg.minRiskReward ? 'pass' : 'trigger', plan.rewardRisk, `>= ${cfg.minRiskReward}R`,
      plan.rewardRisk >= cfg.minRiskReward ? `Target is ${plan.rewardRisk}x the distance to the stop.` : `Target is only ${plan.rewardRisk}x the distance to the stop - not worth taking.`);
  } else {
    add('risk-reward', 'Reward justifies the risk', 'trigger', null, `>= ${cfg.minRiskReward}R`, 'Reward/risk could not be computed.');
  }

  const triggers = checks.filter((c) => c.status === 'trigger');
  const unknowns = checks.filter((c) => c.status === 'unknown');
  const verdict = triggers.length ? 'SKIP' : 'PASS';

  const why = [];
  if (plan) {
    why.push(`${plan.setup} (${plan.setupQuality} quality) on ${snapshot.token}/USD at ${m.price}.`);
    if (Number.isFinite(m.distToSupportPct)) why.push(`Price sits ${fmtPct(m.distToSupportPct)} above the 1-hour support at ${round(m.support1h, 8)}.`);
    if (Number.isFinite(m.atrPct)) why.push(`5-minute ATR is ${round(m.atrPct, 2)}% of price.`);
    if (Number.isFinite(m.volumeRatio)) why.push(`Last 15 minutes traded ${round(m.volumeRatio, 2)}x the prior hour's pace.`);
  }

  const risks = [];
  if (m.extended) risks.push('Price is extended - a sudden reversal would hit the stop fast (this is exactly what the Anti-FOMO agent watches for).');
  if (!Number.isFinite(m.liquidityUsd)) risks.push('DEX pool depth was never verified, so a simulated exit may be optimistic.');
  if (m.trend24h === 'down') risks.push('The 24-hour trend is still down; you would be catching a falling knife if the pullback fails.');
  if (Number.isFinite(m.volumeRatio) && m.volumeRatio < 0.6) risks.push('Volume has dried up; a breakout from here may not follow through.');
  if (snapshot.dataQuality?.startsWith('DEMO')) risks.push('DEMO DATA: none of this is real - it only tests the rules.');
  if (snapshot.dataQuality?.startsWith('USER-PROVIDED')) risks.push('Operator-supplied numbers cannot be independently checked by the app.');
  if (!risks.length) risks.push('Normal market risk: the setup can simply fail, which is why the stop and the 1% rule exist.');

  return {
    agent: 'scanner',
    agentName: 'Agent 1 - Scanner',
    verdict,
    summary: verdict === 'PASS'
      ? `${plan?.setup || 'Setup'} passes the structural checks - send it to the Sizer.`
      : `Skipped: ${triggers.map((t) => t.reason).join(' ')}`,
    checks,
    unknowns: unknowns.length,
    plan,
    whyItMayBeInteresting: why,
    mainRisks: risks,
    notes: [
      ...(unknowns.length ? [`${unknowns.length} check(s) could not be verified from this data source: ${unknowns.map((u) => u.label).join(', ')}.`] : []),
      ...(snapshot.warnings || []),
    ].filter(Boolean),
  };
}

function fmtPct(v) {
  if (!Number.isFinite(v)) return 'n/a';
  return `${v >= 0 ? '+' : ''}${round(v, 2)}%`;
}

/** The exact copy-paste block from the guide, filled in with real numbers. */
export function formatScannerText(snapshot, result, plan) {
  const m = snapshot.metrics || {};
  const rp = (v, d = 8) => (Number.isFinite(v) ? round(v, d) : 'unknown');
  return [
    `TOKEN: ${snapshot.token} (${snapshot.pair})`,
    `DATA SOURCE: ${snapshot.sourceLabel} - ${snapshot.dataQuality} @ ${snapshot.fetchedAt}`,
    `SETUP: ${plan?.setup || 'none'} [${plan?.setupQuality || 'n/a'}]`,
    `ENTRY AREA: ${rp(plan?.entryArea?.low)} - ${rp(plan?.entryArea?.high)} (mid ${rp(plan?.entryMid)})`,
    `INVALIDATION LEVEL: ${rp(plan?.stop)} (${rp(plan?.stopDistancePct, 2)}% below mid)`,
    `TARGET: ${rp(plan?.target1)} (${plan?.rewardRisk ?? 'n/a'}R)`,
    `RECENT MOVE: 5m ${fmtPct(m.r5)} | 15m ${fmtPct(m.r15)} | 1h ${fmtPct(m.r60)} | 24h ${fmtPct(m.change24h)}`,
    `VOLATILITY: 5m ATR ${rp(m.atrPct, 2)}% | avg candle range ${rp(m.avgCandleRangePct, 2)}% | orderliness: ${m.orderly === true ? 'orderly' : m.orderly === false ? 'very volatile' : 'unknown'}`,
    `VOLUME / LIQUIDITY: 24h $${Number.isFinite(m.volume24hUsd) ? Math.round(m.volume24hUsd).toLocaleString('en-US') : 'unknown'} | volume pace ${rp(m.volumeRatio, 2)}x | pool depth ${rp(m.liquidityUsd, 0)}`,
    `SUPPORT / RESISTANCE: 1h support ${rp(m.support1h)} / resistance ${rp(m.resistance1h)} | 3h ${rp(m.support3h)} / ${rp(m.resistance3h)}`,
    `EXTENDED? ${m.extended ? 'YES - looks stretched' : m.extended === false ? 'no' : 'unknown'}`,
    `WHY IT MAY BE INTERESTING: ${(result.whyItMayBeInteresting || []).join(' ') || 'n/a'}`,
    `MAIN RISKS: ${(result.mainRisks || []).join(' ') || 'n/a'}`,
    `PASS OR SKIP: ${result.verdict}`,
  ].join('\n');
}
