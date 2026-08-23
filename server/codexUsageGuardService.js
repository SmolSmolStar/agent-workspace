const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { getAgentWorkspaceDir } = require('./utils/pathUtils');

const STATE_VERSION = 1;
const MODE_MONITORING = 'monitoring';
const MODE_DRAINING = 'draining';
const DEFAULT_POLL_INTERVAL_MS = 2 * 60 * 1000;
const MIN_POLL_INTERVAL_MS = 2 * 60 * 1000;
const MAX_POLL_INTERVAL_MS = 5 * 60 * 1000;
const EXHAUSTED_PERCENTAGE = 100;

function resolveEnabled(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return true;
  return !['0', 'false', 'no', 'off'].includes(normalized);
}

function resolvePollInterval(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_POLL_INTERVAL_MS;
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, Math.round(parsed)));
}

function normalizePercentage(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(100, Math.max(0, Math.round(parsed)));
}

function normalizeResetTime(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
}

class CodexUsageGuardService extends EventEmitter {
  constructor({
    usageLimitsService,
    logger = console,
    storePath = null,
    pollIntervalMs = process.env.ORCHESTRATOR_CODEX_USAGE_GUARD_POLL_MS,
    enabled = resolveEnabled(process.env.ORCHESTRATOR_CODEX_USAGE_GUARD_ENABLED),
    now = () => Date.now()
  } = {}) {
    super();
    this.usageLimitsService = usageLimitsService;
    this.logger = logger;
    this.enabled = resolveEnabled(enabled);
    this.pollIntervalMs = resolvePollInterval(pollIntervalMs);
    this.now = now;
    this.storePath = this.resolveStorePath(storePath);
    this.pollTimer = null;
    this.pollInFlight = null;
    this.state = this.loadState();
  }

  static getInstance(options = {}) {
    if (!CodexUsageGuardService.instance) {
      CodexUsageGuardService.instance = new CodexUsageGuardService(options);
    }
    return CodexUsageGuardService.instance;
  }

  resolveStorePath(storePath) {
    if (storePath) return path.resolve(String(storePath));
    const explicitPath = String(process.env.ORCHESTRATOR_CODEX_USAGE_GUARD_STATE_PATH || '').trim();
    if (explicitPath) return path.resolve(explicitPath);
    const dataDirRaw = String(process.env.ORCHESTRATOR_DATA_DIR || '').trim();
    const baseDir = dataDirRaw ? path.resolve(dataDirRaw) : getAgentWorkspaceDir();
    return path.join(baseDir, 'codex-usage-guard.json');
  }

  getDefaultState() {
    return {
      version: STATE_VERSION,
      mode: MODE_MONITORING,
      drainReason: null,
      triggeredAt: null,
      resumedAt: null,
      resumedBy: null,
      lastPollAt: null,
      lastSuccessAt: null,
      lastError: null,
      observedWindow: null,
      rollover: null,
      updatedAt: null
    };
  }

  normalizeWindow(value) {
    if (!value || typeof value !== 'object') return null;
    const bucket = String(value.bucket || '').trim();
    const name = String(value.name || '').trim();
    const window = String(value.window || '').trim();
    const usedPercentage = normalizePercentage(value.usedPercentage);
    const resetsAt = normalizeResetTime(value.resetsAt);
    if (!bucket || !name || !window || usedPercentage === null || resetsAt === null) return null;
    return {
      key: `${bucket.toLowerCase()}:${name.toLowerCase()}:${window.toLowerCase()}`,
      bucket,
      name,
      window,
      usedPercentage,
      resetsAt,
      observedAt: typeof value.observedAt === 'string' ? value.observedAt : null
    };
  }

  normalizeState(value) {
    const defaults = this.getDefaultState();
    const source = value && typeof value === 'object' ? value : {};
    const mode = source.mode === MODE_DRAINING ? MODE_DRAINING : MODE_MONITORING;
    const drainReason = ['window-rollover', 'exhausted'].includes(source.drainReason)
      ? source.drainReason
      : null;
    const rollover = source.rollover && typeof source.rollover === 'object'
      ? {
          previousResetsAt: normalizeResetTime(source.rollover.previousResetsAt),
          currentResetsAt: normalizeResetTime(source.rollover.currentResetsAt),
          previousUsedPercentage: normalizePercentage(source.rollover.previousUsedPercentage),
          currentUsedPercentage: normalizePercentage(source.rollover.currentUsedPercentage)
        }
      : null;
    const timestamp = (field) => typeof source[field] === 'string' ? source[field] : defaults[field];
    return {
      version: STATE_VERSION,
      mode,
      drainReason: mode === MODE_DRAINING ? drainReason : null,
      triggeredAt: mode === MODE_DRAINING ? timestamp('triggeredAt') : null,
      resumedAt: timestamp('resumedAt'),
      resumedBy: typeof source.resumedBy === 'string' ? source.resumedBy : null,
      lastPollAt: timestamp('lastPollAt'),
      lastSuccessAt: timestamp('lastSuccessAt'),
      lastError: typeof source.lastError === 'string' ? source.lastError : null,
      observedWindow: this.normalizeWindow(source.observedWindow),
      rollover: mode === MODE_DRAINING ? rollover : null,
      updatedAt: timestamp('updatedAt')
    };
  }

  loadState() {
    try {
      if (!fs.existsSync(this.storePath)) return this.getDefaultState();
      return this.normalizeState(JSON.parse(fs.readFileSync(this.storePath, 'utf8')));
    } catch (error) {
      this.logger.warn?.('Failed to load Codex usage guard state', {
        error: error.message,
        path: this.storePath
      });
      return this.getDefaultState();
    }
  }

  persistState(nextState) {
    const normalized = this.normalizeState({
      ...nextState,
      updatedAt: this.nowIso()
    });
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    const tmpPath = `${this.storePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    fs.renameSync(tmpPath, this.storePath);
    this.state = normalized;
    return normalized;
  }

  nowIso() {
    return new Date(this.now()).toISOString();
  }

  selectGuardWindow(windows) {
    const candidates = (Array.isArray(windows) ? windows : [])
      .map((window) => this.normalizeWindow(window))
      .filter(Boolean)
      .filter((window) => window.bucket.toLowerCase() === 'codex')
      .filter((window) => /\bweek\b/i.test(window.window));
    if (!candidates.length) return null;
    candidates.sort((a, b) => {
      const aPrimary = a.name.toLowerCase() === 'primary' ? 1 : 0;
      const bPrimary = b.name.toLowerCase() === 'primary' ? 1 : 0;
      return bPrimary - aPrimary || a.key.localeCompare(b.key);
    });
    return candidates[0];
  }

  isWindowRollover(previous, current) {
    if (!previous || !current || previous.key !== current.key) return false;
    return current.resetsAt > previous.resetsAt
      && current.usedPercentage < previous.usedPercentage;
  }

  start() {
    if (!this.enabled || this.pollTimer) return;
    this.pollOnce().catch((error) => {
      this.logger.warn?.('Initial Codex usage guard poll failed', { error: error.message });
    });
    this.pollTimer = setInterval(() => {
      this.pollOnce().catch((error) => {
        this.logger.warn?.('Codex usage guard poll failed', { error: error.message });
      });
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
    this.logger.info?.('Codex usage guard started', { pollIntervalMs: this.pollIntervalMs });
  }

  stop() {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  pollOnce() {
    if (!this.enabled) return Promise.resolve(this.getStatus());
    if (this.pollInFlight) return this.pollInFlight;
    this.pollInFlight = this.performPoll().finally(() => {
      this.pollInFlight = null;
    });
    return this.pollInFlight;
  }

  async performPoll() {
    const pollAt = this.nowIso();
    try {
      if (!this.usageLimitsService?.getCodexLimits) {
        throw new Error('usage-limits-service-unavailable');
      }
      const result = await this.usageLimitsService.getCodexLimits({ refresh: true });
      if (!result?.available) {
        throw new Error(String(result?.reason || 'codex-limits-unavailable'));
      }
      const selected = this.selectGuardWindow(result.windows);
      if (!selected) throw new Error('codex-weekly-window-missing');

      const current = { ...selected, observedAt: pollAt };
      const previous = this.state.observedWindow;
      const rolloverDetected = this.isWindowRollover(previous, current);
      const exhausted = current.usedPercentage >= EXHAUSTED_PERCENTAGE;
      const wasDraining = this.state.mode === MODE_DRAINING;
      const next = {
        ...this.state,
        lastPollAt: pollAt,
        lastSuccessAt: pollAt,
        lastError: null,
        observedWindow: current
      };

      if (rolloverDetected) {
        next.mode = MODE_DRAINING;
        next.drainReason = 'window-rollover';
        next.triggeredAt = next.triggeredAt || pollAt;
        next.rollover = {
          previousResetsAt: previous.resetsAt,
          currentResetsAt: current.resetsAt,
          previousUsedPercentage: previous.usedPercentage,
          currentUsedPercentage: current.usedPercentage
        };
      } else if (exhausted && !wasDraining) {
        next.mode = MODE_DRAINING;
        next.drainReason = 'exhausted';
        next.triggeredAt = pollAt;
        next.rollover = null;
      }

      this.persistState(next);
      const status = this.getStatus();
      if (!wasDraining && this.state.mode === MODE_DRAINING) {
        this.logger.warn?.('Codex usage guard entered drain mode', {
          reason: this.state.drainReason,
          usedPercentage: current.usedPercentage,
          resetsAt: current.resetsAt
        });
        this.emit('drain-started', status);
      }
      this.emit('state-changed', status);
      return status;
    } catch (error) {
      this.persistState({
        ...this.state,
        lastPollAt: pollAt,
        lastError: String(error?.message || error)
      });
      const status = this.getStatus();
      this.emit('state-changed', status);
      return status;
    }
  }

  getAdmissionDecision({ agentId } = {}) {
    const normalizedAgent = String(agentId || '').trim().toLowerCase();
    if (!this.enabled || normalizedAgent !== 'codex' || this.state.mode !== MODE_DRAINING) {
      return { allowed: true };
    }
    return {
      allowed: false,
      code: 'codex-usage-draining',
      reason: this.state.drainReason,
      triggeredAt: this.state.triggeredAt
    };
  }

  resumeAdmissions({ acknowledgedBy = null } = {}) {
    const now = this.nowIso();
    this.persistState({
      ...this.state,
      mode: MODE_MONITORING,
      drainReason: null,
      triggeredAt: null,
      rollover: null,
      resumedAt: now,
      resumedBy: String(acknowledgedBy || '').trim().slice(0, 100) || null
    });
    const status = this.getStatus();
    this.emit('state-changed', status);
    return status;
  }

  getStatus() {
    const mode = this.enabled ? this.state.mode : 'disabled';
    return {
      enabled: this.enabled,
      mode,
      admittingCodex: !this.enabled || this.state.mode !== MODE_DRAINING,
      drainReason: this.state.drainReason,
      triggeredAt: this.state.triggeredAt,
      resumedAt: this.state.resumedAt,
      resumedBy: this.state.resumedBy,
      lastPollAt: this.state.lastPollAt,
      lastSuccessAt: this.state.lastSuccessAt,
      lastError: this.state.lastError,
      observedWindow: this.state.observedWindow,
      rollover: this.state.rollover,
      pollIntervalMs: this.pollIntervalMs
    };
  }
}

module.exports = {
  CodexUsageGuardService,
  DEFAULT_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS
};
