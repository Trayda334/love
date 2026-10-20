/**
 * Agent 5 - ANTI-FOMO
 *
 * Job: block entries that are chasing a move already in progress.
 * Default stance is cautious: missing a trade is better than chasing one.
 * The explanation is deliberately capped at three sentences, as the guide asks.
 */

import { round } from '../shared/feedcore.mjs';

export const ANTIFOMO_PROMPT = `You are the Anti-FOMO Risk Agent.

Your job is to BLOCK bad entries caused by chasing pumps. PAPER TRADING ONLY.

For every proposed trade, check:
- How much has price moved in the last 5 minutes?
- How much has price moved in the last 15 minutes?
- Is volume suddenly exploding?
- Is price far above recent support?
- Is the proposed entry happening after a large green candle?
- Would the trader be entering mainly because they are afraid of missing the move?

If the token has just made an extreme move and there is no clean pullback or base, BLOCK IT.
If risk cannot be clearly defined, BLOCK IT.
If the entry is based mostly on hype, BLOCK IT.

Return only APPROVE or BLOCK, then give a maximum 3-sentence explanation.

Your default should be cautious. Missing a trade is better than chasing one.`;

export function antiFomoAgent({ snapshot, plan, config, ideaText = '' }) {
  const m = snapshot?.metrics || {};
  const cfg = config.antiFomo;
  const checks = [];
  const add = (id, label, status, value, threshold, reason) => checks.push({ id, label, status, value, threshold, reason });
  const num = (v) => (Number.isFinite(v) ? v : null);

  /* 1. last 5 minutes */
  add('move-5m', 'Move in the last 5 minutes', !Number.isFinite(m.r5) ? 'unknown' : m.r5 >= cfg.max5mPct ? 'trigger' : 'ok',
    num(m.r5), `<= ${cfg.max5mPct}%`,
    !Number.isFinite(m.r5) ? 'No 5-minute move available from this data source.'
      : m.r5 >= cfg.max5mPct ? `Price ran ${round(m.r5, 2)}% in the last 5 minutes - that is a vertical candle, not an entry.`
        : `Last 5 minutes: ${round(m.r5, 2)}%.`);

  /* 2. last 15 minutes */
  add('move-15m', 'Move in the last 15 minutes', !Number.isFinite(m.r15) ? 'unknown' : m.r15 >= cfg.max15mPct ? 'trigger' : 'ok',
    num(m.r15), `<= ${cfg.max15mPct}%`,
    !Number.isFinite(m.r15) ? 'No 15-minute move available from this data source.'
      : m.r15 >= cfg.max15mPct ? `Up ${round(m.r15, 2)}% in 15 minutes - you would be buying the top of the move.`
        : `Last 15 minutes: ${round(m.r15, 2)}%.`);

  /* 3. volume spike */
  const spike = Number.isFinite(m.volumeRatio) && Number.isFinite(m.r15) && m.volumeRatio >= cfg.maxVolumeSpikeRatio && m.r15 >= cfg.volumeSpikeMinMovePct;
  add('volume-spike', 'Volume suddenly exploding', !Number.isFinite(m.volumeRatio) ? 'unknown' : spike ? 'trigger' : 'ok',
    num(m.volumeRatio && round(m.volumeRatio, 2)), `< ${cfg.maxVolumeSpikeRatio}x normal`,
    !Number.isFinite(m.volumeRatio) ? 'Volume pace could not be measured.'
      : spike ? `Volume is ${round(m.volumeRatio, 2)}x the recent pace while price is already up ${round(m.r15, 2)}% - classic chase conditions.`
        : `Volume pace is ${round(m.volumeRatio, 2)}x normal.`);

  /* 4. distance above support */
  const farFromSupport = Number.isFinite(m.distToSupportPct) && m.distToSupportPct >= cfg.maxAboveSupportPct;
  add('dist-support', 'Distance above recent support', !Number.isFinite(m.distToSupportPct) ? 'unknown' : farFromSupport ? 'trigger' : 'ok',
    Number.isFinite(m.distToSupportPct) ? round(m.distToSupportPct, 2) : null, `< ${cfg.maxAboveSupportPct}% above 1h support`,
    !Number.isFinite(m.distToSupportPct) ? 'Support level unknown, so distance above support cannot be checked.'
      : farFromSupport ? `Price is ${round(m.distToSupportPct, 2)}% above the 1-hour support - a long way to fall back to a real level.`
        : `Price is ${round(m.distToSupportPct, 2)}% above support.`);

  /* 5. entering right after a big green candle */
  const lc = m.lastCandle;
  const bigGreen = lc
    ? lc.green && (lc.bodyPct ?? 0) >= cfg.bigGreenCandleBodyPct && (lc.bodyToAvgBody ?? 0) >= cfg.bigGreenCandleBodyToAvg
    : false;
  add('green-candle', 'Entry right after a large green candle', !lc ? 'unknown' : bigGreen ? 'trigger' : 'ok',
    lc ? num(round(lc.bodyPct ?? 0, 2)) : null, `body < ${cfg.bigGreenCandleBodyPct}% and < ${cfg.bigGreenCandleBodyToAvg}x average`,
    !lc ? 'Last candle unknown.'
      : bigGreen ? `The last closed candle was a large green one (${round(lc.bodyPct ?? 0, 2)}%, ${round(lc.bodyToAvgBody ?? 0, 1)}x the average body) - entering here is chasing.`
        : 'The most recent candle is not an outsized green candle.');

  /* 6. hype rationale */
  const hype = /\b(moon|to the moon|100x|1000x|guaranteed|can'?t lose|can ?not lose|easy money|missing out|fomo|last chance|about to explode|next (?:100|1000)x|free money|sure thing)\b/i.test(String(ideaText || ''));
  add('hype-rationale', 'Written reason is analysis, not hype', hype ? 'trigger' : 'ok', null, 'no hype language in the written reason',
    hype ? 'The written reason contains hype language rather than a structural reason.' : 'The written reason contains no hype language.');

  /* 7. is the chase excused by a base/pullback? */
  const noStructure = m.extended && !m.baseDetected && !m.consolidating && !m.pullback;
  add('structure', 'Extended move has a base or clean pullback', !Number.isFinite(m.r15) ? 'unknown' : noStructure ? 'trigger' : 'ok',
    null, 'a base or pullback to enter against',
    !Number.isFinite(m.r15) ? 'Structure cannot be checked without recent price history.'
      : noStructure ? 'The move is extended and there is no base or pullback to enter against.'
        : 'There is a base and/or pullback structure to lean the entry against.');

  const triggers = checks.filter((c) => c.status === 'trigger');
  const unknowns = checks.filter((c) => c.status === 'unknown');
  const unknownBlock = unknowns.length >= cfg.unknownChecksBlock;
  const verdict = triggers.length || unknownBlock ? 'BLOCK' : 'APPROVE';

  const sentences = [];
  if (verdict === 'BLOCK') {
    if (triggers.length) {
      sentences.push(`Blocked because ${triggers.slice(0, 2).map((t) => lowerFirst(t.reason)).join(' and ')}`);
    }
    if (unknownBlock) {
      sentences.push(`Risk cannot be clearly defined here: ${unknowns.length} checks could not be evaluated from this data source.`);
    }
    sentences.push('The default is cautious - a missed trade costs nothing, a chased one costs 1% of the paper account.');
  } else {
    sentences.push(`Approved: nothing is chasing - 5m move is ${fmt(m.r5)}, 15m move is ${fmt(m.r15)}.`);
    sentences.push(`Volume pace is ${Number.isFinite(m.volumeRatio) ? `${round(m.volumeRatio, 2)}x` : 'unknown'} normal and price is ${fmt(m.distToSupportPct)} above support.`);
    sentences.push('If any of those conditions change before the fill, this approval is void and the trade must be re-checked.');
  }

  return {
    agent: 'antiFomo',
    agentName: 'Agent 5 - Anti-FOMO',
    verdict,
    summary: sentences.slice(0, 3).join(' '),
    explanation: sentences.slice(0, 3).join(' '),
    checks,
    triggers,
    unknowns: unknowns.map((u) => u.label),
    notes: verdict === 'BLOCK'
      ? ['A blocked setup is logged, never deleted. Blocked setups are the core evidence for reviewing whether this agent earns its place.']
      : [],
  };
}

function lowerFirst(s) {
  const str = String(s || '');
  return str.charAt(0).toLowerCase() + str.slice(1);
}

function fmt(v) {
  if (!Number.isFinite(v)) return 'unknown';
  return `${v >= 0 ? '+' : ''}${round(v, 2)}%`;
}
