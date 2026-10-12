/**
 * store.mjs - the append-only ledger and settings file (data/desk.json).
 *
 * Records are append-only in spirit AND in code: closing a trade replaces the
 * open record with a closed one (the open state is kept in the audit trail),
 * and nothing can delete history. The logger's rule "never change old results
 * to make performance look better" is enforced by the audit trail, not by trust.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG, validateConfigPatch, diffConfig, HARD_RULES } from '../config.mjs';
import { computeStats, reviewBlocks, loggerApi } from '../agents/logger.mjs';

const DEFAULT_STATE = () => ({
  schema: 1,
  createdAt: new Date().toISOString(),
  config: JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
  records: [],
  audit: [],
  watches: [],
  dataMode: 'live', // 'live' | 'demo' - demo data is always watermarked
  autoScan: { enabled: false, intervalMs: 60000, lastRunAt: null, lastRun: [], log: [] },
  lastAutoScanAt: null,
  scanHistory: [],
});

export class Store {
  constructor(filePath, { memory = false } = {}) {
    this.filePath = filePath;
    this.memory = memory;
    this.state = DEFAULT_STATE();
    if (memory) {
      this.state.watches = [];
      return;
    }
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        this.state = {
          ...DEFAULT_STATE(),
          ...parsed,
          config: validateConfigPatch(parsed.config || {}, {}).config,
          records: Array.isArray(parsed.records) ? parsed.records : [],
          audit: Array.isArray(parsed.audit) ? parsed.audit : [],
        };
      } else {
        this.persist();
      }
    } catch (err) {
      throw new Error(`Could not read ${this.filePath}: ${err.message}. Move the file aside and restart.`);
    }
  }

  persist() {
    if (this.memory) return; // throwaway ledger (self-test): never touches disk
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  /* ---------------- settings ---------------- */
  getDataMode() {
    return this.state.dataMode === 'demo' ? 'demo' : 'live';
  }

  setDataMode(mode) {
    this.state.dataMode = mode === 'demo' ? 'demo' : 'live';
    this.auditEvent('DATA_MODE', `Data mode set to ${this.state.dataMode}.`);
    this.persist();
    return this.state.dataMode;
  }

  getAutoScan() {
    return this.state.autoScan;
  }

  setAutoScan(patch) {
    const before = this.state.autoScan;
    this.state.autoScan = {
      ...before,
      ...patch,
      intervalMs: Math.max(30000, Math.min(3600000, Number(patch.intervalMs ?? before.intervalMs) || 60000)),
    };
    this.auditEvent('AUTOSCAN', `Auto-scan ${this.state.autoScan.enabled ? 'enabled' : 'disabled'} every ${Math.round(this.state.autoScan.intervalMs / 1000)}s.`);
    this.persist();
    return this.state.autoScan;
  }

  pushAutoScanRun(entry) {
    const a = this.state.autoScan;
    a.lastRunAt = entry.at;
    a.lastRun = entry.results;
    a.log.unshift(entry);
    if (a.log.length > 200) a.log.length = 200;
    this.persist();
  }

  setReviewOutcome(id, outcome) {
    const idx = this.state.records.findIndex((r) => r.id === id);
    if (idx === -1) throw new Error(`No record ${id}.`);
    const rec = this.state.records[idx];
    if (rec.kind !== 'blocked') throw new Error(`${id} is not a blocked setup.`);
    const before = rec.reviewOutcome;
    this.state.records[idx] = { ...rec, reviewOutcome: outcome, updatedAt: new Date().toISOString() };
    this.auditEvent('BLOCK_REVIEW', `${id} reviewed: ${before || 'unreviewed'} -> ${outcome}`);
    this.persist();
    return this.state.records[idx];
  }

  /* ---------------- audit ---------------- */
  get audit() {
    return this.state.audit;
  }

  auditEvent(type, note, extra = {}) {
    this.state.audit.push({ at: new Date().toISOString(), type, note, ...extra });
    if (this.state.audit.length > 5000) this.state.audit = this.state.audit.slice(-4000);
  }

  /* ---------------- config ---------------- */
  getConfig() {
    return this.state.config;
  }

  updateConfig(patch, note = '') {
    const before = this.state.config;
    const { config, violations, changes } = validateConfigPatch(before, patch);
    this.state.config = config;
    if (changes.length) {
      const diffText = changes.map((c) => `${c.path}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`).join('; ');
      this.auditEvent('RULE_CHANGE', note ? `${note} (${diffText})` : `Rules changed: ${diffText}`, { changes });
    }
    if (violations.length) {
      this.auditEvent('RULE_CHANGE_REFUSED', `${violations.join(' ')}${note ? ` (request: ${note})` : ''}`, { violations, patch });
    }
    this.persist();
    return { config, violations, changes };
  }

  getHardRules() {
    return HARD_RULES;
  }

  /* ---------------- records ---------------- */
  listRecords({ kind = null, status = null, limit = null } = {}) {
    let out = this.state.records;
    if (kind) out = out.filter((r) => r.kind === kind);
    if (status) out = out.filter((r) => r.status === status);
    out = [...out].sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
    return limit ? out.slice(0, limit) : out;
  }

  getRecord(id) {
    return this.state.records.find((r) => r.id === id) || null;
  }

  addRecord(record, { event = 'RECORD', note = '' } = {}) {
    if (this.state.records.some((r) => r.id === record.id)) {
      throw new Error(`Record ${record.id} already exists; the ledger is append-only.`);
    }
    this.state.records.push(record);
    this.auditEvent(event, note || `${record.id} created`, { id: record.id, kind: record.kind });
    this.persist();
    return record;
  }

  replaceRecord(next, { event = 'RECORD_UPDATE', note = '' } = {}) {
    const idx = this.state.records.findIndex((r) => r.id === next.id);
    if (idx === -1) throw new Error(`No record ${next.id}.`);
    const before = this.state.records[idx];
    this.state.records[idx] = next;
    this.auditEvent(event, note || `${next.id} updated`, {
      id: next.id,
      kind: next.kind,
      before: { status: before.status, pnlNetUsd: before.pnl?.netUsd ?? null },
      after: { status: next.status, pnlNetUsd: next.pnl?.netUsd ?? null },
    });
    this.persist();
    return next;
  }

  nextTradeSequence() {
    const n = this.state.records.filter((r) => r.kind === 'trade').length + 1;
    return n;
  }

  openPositions() {
    return this.state.records.filter((r) => r.kind === 'trade' && r.status === 'OPEN');
  }

  openPredictionBets() {
    return this.state.records.filter((r) => r.kind === 'prediction' && r.status === 'OPEN_BET');
  }

  lastClosedTrade() {
    const closed = this.state.records
      .filter((r) => r.kind === 'trade' && r.status !== 'OPEN')
      .sort((a, b) => new Date(b.exit?.at || b.updatedAt) - new Date(a.exit?.at || a.updatedAt));
    return closed[0] || null;
  }

  /* ---------------- account ---------------- */
  account() {
    const stats = computeStats(this.state.records, this.state.config, { startingBalance: this.state.config.account.startingBalance });
    return {
      startingBalance: stats.startingBalance,
      realizedPnlUsd: stats.realizedPnlUsd,
      balance: stats.startingBalance + stats.realizedPnlUsd,
      equity: stats.currentBalance,
      openPositions: this.openPositions().length,
      currency: 'USD',
    };
  }

  stats() {
    return computeStats(this.state.records, this.state.config, { startingBalance: this.state.config.account.startingBalance });
  }

  reviews() {
    return reviewBlocks(this.state.records, this.state.config);
  }

  /* ---------------- watches ---------------- */
  setWatches(watches) {
    this.state.watches = Array.isArray(watches) ? watches.slice(0, 40) : [];
    this.auditEvent('WATCHLIST_UPDATE', `${this.state.watches.length} token(s) on the watchlist.`);
    this.persist();
    return this.state.watches;
  }

  recordScan(entry) {
    this.state.scanHistory.unshift(entry);
    if (this.state.scanHistory.length > 500) this.state.scanHistory.length = 500;
    this.state.lastAutoScanAt = entry.at;
    this.persist();
  }

  /* ---------------- export ---------------- */
  toCsv(kind = 'trade') {
    const esc = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    if (kind === 'trade') {
      const rows = this.listRecords({ kind: 'trade' }).map((t) => [
        t.createdAt, t.id, t.token, t.setup, t.entry?.price, t.exit?.price, t.stopLoss, t.target,
        t.entry?.notionalUsd, t.entry?.units, t.pnl?.netUsd, t.pnl?.netPct, t.pnl?.rMultiple,
        t.status === 'OPEN' ? 'OPEN' : t.pnl?.result, t.decisions?.scanner, t.decisions?.sizer, t.decisions?.antiFomo,
        t.riskPctAtEntry, t.stopDistancePct, t.rewardRisk, t.exit?.reason || '', (t.mistakes || []).join(' | '),
        (t.whyTaken || []).join(' | '), t.learned || '', t.executionMode || '',
      ]);
      return toCsvString([
        'date_time', 'trade_id', 'asset', 'setup', 'entry', 'exit', 'stop', 'target', 'position_notional_usd', 'units',
        'pnl_usd', 'pnl_pct', 'r_multiple', 'result', 'scanner', 'sizer', 'anti_fomo', 'risk_pct_at_entry',
        'stop_distance_pct', 'reward_risk', 'why_closed', 'mistakes', 'why_taken', 'learned', 'execution_mode',
      ], rows);
    }
    const rows = this.listRecords({ kind: 'blocked' }).map((b) => [
      b.createdAt, b.id, b.token, b.stage, b.price, b.setup, b.decisions?.scanner, b.decisions?.sizer,
      b.decisions?.antiFomo, b.decisions?.buyer, b.category, (b.reasons || []).join(' | '), b.reviewOutcome || '',
      b.proposedPlan?.stop ?? '', b.proposedPlan?.target ?? '', b.dataQuality || '',
    ]);
    return toCsvString(
      ['date_time', 'block_id', 'asset', 'stage', 'price', 'setup', 'scanner', 'sizer', 'anti_fomo', 'buyer', 'why_blocked', 'reasons', 'review_outcome', 'proposed_stop', 'proposed_target', 'data_quality'],
      rows,
    );

    function toCsvString(header, rows) {
      return [header.join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
    }
  }

  exportState() {
    return JSON.parse(JSON.stringify(this.state));
  }

  replaceState(next, { note = 'State imported' } = {}) {
    this.state = { ...DEFAULT_STATE(), ...next, config: validateConfigPatch(next?.config || {}, {}).config };
    this.auditEvent('STATE_IMPORT', note, { records: this.state.records.length });
    this.persist();
  }
}

export { validateConfigPatch, diffConfig, HARD_RULES, loggerApi };
