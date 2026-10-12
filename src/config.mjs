/**
 * config.mjs - the fixed rulebook (guide Step 1) as editable-but-audited config.
 *
 * Two rule classes live here:
 *   HARD_RULES  - cannot be switched off by the user (paper mode, 1% ceiling,
 *                 stop-loss required, one position at a time, losses are kept).
 *   tunables    - thresholds a user may deliberately change; every change is
 *                 written to the audit log as a RULE_CHANGE event.
 */

export const HARD_RULES = {
  paperOnly: true,
  maxRiskPctPerTrade: 1, // the 1% ceiling can be lowered, never raised
  requireStopLoss: true,
  maxOpenPositions: 1,
  logsAreAppendOnly: true,
};

export const DEFAULT_CONFIG = {
  schema: 1,
  paperOnly: true,
  account: {
    startingBalance: 1000,
    currency: 'USD',
  },
  risk: {
    riskPctPerTrade: 1, // <= HARD_RULES.maxRiskPctPerTrade
    minStopDistancePct: 0.5,
    maxStopDistancePct: 12,
    maxPositionNotionalPct: 100, // notional guard: 100 = limited by paper cash only (never leverage)
    minRiskReward: 1.5,
    minPositionNotionalUsd: 10,
    neverIncreaseRiskAfterLoss: true,
  },
  fees: {
    takerBps: 10,
    slippageBps: 5,
    includeInPaperPnl: true,
  },
  scanner: {
    minCandles: 40,
    maxAtrPct: 5,
    minVolume24hUsd: 2_000_000,
    minRiskReward: 1.5,
    minEntryAreaHalfWidthPct: 0.4,
    entryChaseTolerancePct: 0.75, // buyer blocks fills this far above the planned area
  },
  antiFomo: {
    max5mPct: 8,
    max15mPct: 15,
    maxVolumeSpikeRatio: 5,
    volumeSpikeMinMovePct: 3,
    maxAboveSupportPct: 12,
    bigGreenCandleBodyPct: 2,
    bigGreenCandleBodyToAvg: 1.5,
    requireBaseWhenExtended: true,
    unknownChecksBlock: 2, // 2+ unevaluable checks on manual data => BLOCK
  },
  prediction: {
    maxRiskPctPerBet: 1,
    minEdgePoints: 5,
    maxSpreadPoints: 3,
    minLiquidityUsd: 5_000,
    minDaysToResolve: 1,
    maxOpenBets: 3,
  },
  review: {
    blockSize: 20,
  },
};

export function deepMerge(base, patch) {
  if (Array.isArray(base)) return Array.isArray(patch) ? patch.slice() : base.slice();
  if (base && typeof base === 'object') {
    const out = { ...base };
    if (!patch || typeof patch !== 'object') return out;
    for (const [k, v] of Object.entries(patch)) {
      out[k] = k in base ? deepMerge(base[k], v) : v;
    }
    return out;
  }
  return patch === undefined ? base : patch;
}

/**
 * Validates a proposed config patch against the hard rules.
 * Returns { config, violations: string[], changes: [{path, from, to}] }.
 */
export function validateConfigPatch(current, patch) {
  const merged = deepMerge(DEFAULT_CONFIG, current || {});
  const candidate = deepMerge(merged, patch || {});
  const violations = [];

  candidate.paperOnly = true; // cannot be turned off, ever
  candidate.account = { ...DEFAULT_CONFIG.account, ...candidate.account, currency: 'USD' };

  const riskPct = Number(candidate.risk?.riskPctPerTrade);
  if (!Number.isFinite(riskPct) || riskPct <= 0) {
    violations.push('risk.riskPctPerTrade must be a positive number.');
  } else if (riskPct > HARD_RULES.maxRiskPctPerTrade) {
    violations.push(
      `risk.riskPctPerTrade cannot exceed ${HARD_RULES.maxRiskPctPerTrade}% - the 1% max-risk rule is fixed.`,
    );
    candidate.risk.riskPctPerTrade = HARD_RULES.maxRiskPctPerTrade;
  }

  const predRisk = Number(candidate.prediction?.maxRiskPctPerBet);
  if (!Number.isFinite(predRisk) || predRisk <= 0) {
    violations.push('prediction.maxRiskPctPerBet must be a positive number.');
  } else if (predRisk > HARD_RULES.maxRiskPctPerTrade) {
    violations.push(`prediction.maxRiskPctPerBet cannot exceed ${HARD_RULES.maxRiskPctPerTrade}%.`);
    candidate.prediction.maxRiskPctPerBet = HARD_RULES.maxRiskPctPerTrade;
  }

  const r = candidate.risk || {};
  if (!(r.minStopDistancePct > 0)) violations.push('risk.minStopDistancePct must be > 0.');
  if (!(r.maxStopDistancePct > r.minStopDistancePct)) {
    violations.push('risk.maxStopDistancePct must be greater than minStopDistancePct.');
  }
  if (!(r.maxPositionNotionalPct > 0 && r.maxPositionNotionalPct <= 100)) {
    violations.push('risk.maxPositionNotionalPct must be between 0 and 100.');
  }
  if (!(r.minRiskReward >= 0)) violations.push('risk.minRiskReward must be >= 0.');

  const scanner = candidate.scanner || {};
  if (!(scanner.minCandles >= 20)) violations.push('scanner.minCandles must be at least 20.');
  if (!(scanner.maxAtrPct > 0)) violations.push('scanner.maxAtrPct must be > 0.');
  if (!(scanner.minVolume24hUsd >= 0)) violations.push('scanner.minVolume24hUsd must be >= 0.');

  const af = candidate.antiFomo || {};
  for (const key of ['max5mPct', 'max15mPct', 'maxVolumeSpikeRatio', 'maxAboveSupportPct']) {
    if (!(typeof af[key] === 'number' && af[key] > 0)) violations.push(`antiFomo.${key} must be > 0.`);
  }

  const changes = diffConfig(merged, candidate);
  return { config: candidate, violations, changes };
}

export function diffConfig(before, after, prefix = '') {
  const out = [];
  const walk = (b, a, path) => {
    if (a && typeof a === 'object' && !Array.isArray(a)) {
      for (const k of Object.keys(a)) walk(b ? b[k] : undefined, a[k], path ? `${path}.${k}` : k);
      return;
    }
    if (JSON.stringify(b) !== JSON.stringify(a)) out.push({ path, from: b ?? null, to: a ?? null });
  };
  walk(before, after, prefix);
  return out;
}
