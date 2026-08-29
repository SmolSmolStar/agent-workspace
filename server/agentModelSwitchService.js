const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_POLL_INTERVAL_MS = 150;
const DEFAULT_POLL_TIMEOUT_MS = 4000;
// Claude Code writes each slash command's result to disk separately — after
// detecting the first change, give a second in-flight command (e.g. /effort
// right after /model) time to land before we restore the snapshot.
const DEFAULT_SETTLE_DELAY_MS = 300;

class AgentModelSwitchService {
  constructor({
    logger = console,
    fsImpl = fs,
    homeDir = null,
    sessionManager = null,
    sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    settleDelayMs = DEFAULT_SETTLE_DELAY_MS
  } = {}) {
    this.logger = logger;
    this.fs = fsImpl;
    this.homeDir = homeDir || os.homedir();
    this.sessionManager = sessionManager;
    this.sleepFn = sleepFn;
    this.pollIntervalMs = pollIntervalMs;
    this.pollTimeoutMs = pollTimeoutMs;
    this.settleDelayMs = settleDelayMs;
  }

  static getInstance(options = {}) {
    if (!AgentModelSwitchService.instance) {
      AgentModelSwitchService.instance = new AgentModelSwitchService(options);
    }
    return AgentModelSwitchService.instance;
  }

  get userSettingsPath() {
    return path.join(this.homeDir, '.claude', 'settings.json');
  }

  readSettings() {
    try {
      const raw = this.fs.readFileSync(this.userSettingsPath, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  writeSettings(settings) {
    this.fs.mkdirSync(path.dirname(this.userSettingsPath), { recursive: true });
    this.fs.writeFileSync(this.userSettingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }

  // Switch a running Claude session to `model`/`effort` for THIS SESSION ONLY.
  // Claude Code's `/model <name>` and `/effort <level>` (low/medium/high/xhigh)
  // always save to ~/.claude/settings.json as the new default when typed with
  // an argument — confirmed against Claude Code's own docs, there is no CLI
  // flag for "switch but don't persist". So: snapshot the two fields, let the
  // CLI do its normal (persisting) switch, then restore the snapshot once the
  // write lands. The running process already holds the new model/effort in
  // memory; only the on-disk default needs putting back.
  async switchClaudeSession({ sessionId, model, effort }) {
    if (!this.sessionManager) throw new Error('AgentModelSwitchService requires a sessionManager');
    if (!model && !effort) throw new Error('model or effort is required');

    const session = this.sessionManager.getSessionById(sessionId);
    if (!session) return { ok: false, error: 'SESSION_NOT_FOUND' };
    if (String(session.type || '').toLowerCase() !== 'claude') {
      return { ok: false, error: 'UNSUPPORTED_SESSION_TYPE' };
    }
    if (session.status === 'busy') {
      return { ok: false, error: 'SESSION_BUSY' };
    }

    const before = this.readSettings();
    const hadModel = Object.prototype.hasOwnProperty.call(before, 'model');
    const hadEffort = Object.prototype.hasOwnProperty.call(before, 'effortLevel');
    const prevModel = before.model;
    const prevEffort = before.effortLevel;

    if (model) this.sessionManager.writeToSession(sessionId, `/model ${model}\r`);
    if (effort) this.sessionManager.writeToSession(sessionId, `/effort ${effort}\r`);

    const defaultChangeDetected = await this.waitForSettingsChange({
      prevModel,
      prevEffort,
      expectModel: !!model,
      expectEffort: !!effort
    });
    await this.sleepFn(this.settleDelayMs);

    const after = this.readSettings();
    if (hadModel) after.model = prevModel;
    else delete after.model;
    if (hadEffort) after.effortLevel = prevEffort;
    else delete after.effortLevel;
    this.writeSettings(after);

    const verified = this.readSettings();
    const defaultRestored =
      (hadModel ? verified.model === prevModel : !('model' in verified)) &&
      (hadEffort ? verified.effortLevel === prevEffort : !('effortLevel' in verified));

    return {
      ok: true,
      sessionId,
      model: model || null,
      effort: effort || null,
      defaultChangeDetected,
      defaultRestored
    };
  }

  // Same snapshot/restore trick as switchClaudeSession, for a Commander
  // instance instead of a worktree session: Commander is its own service
  // (not part of sessionManager.sessions), so it needs its own PTY-write
  // path (commanderService.sendInput) and its own readiness check
  // (commanderService.isReady, Commander has no 'busy' status concept).
  async switchCommanderSession({ commanderService, model, effort }) {
    if (!commanderService) throw new Error('commanderService is required');
    if (!model && !effort) throw new Error('model or effort is required');

    if (!commanderService.session) {
      return { ok: false, error: 'SESSION_NOT_FOUND' };
    }
    if (commanderService.activeProvider && commanderService.activeProvider !== 'claude') {
      return { ok: false, error: 'UNSUPPORTED_SESSION_TYPE', type: commanderService.activeProvider };
    }
    if (!commanderService.isReady) {
      return { ok: false, error: 'SESSION_BUSY' };
    }

    const before = this.readSettings();
    const hadModel = Object.prototype.hasOwnProperty.call(before, 'model');
    const hadEffort = Object.prototype.hasOwnProperty.call(before, 'effortLevel');
    const prevModel = before.model;
    const prevEffort = before.effortLevel;

    if (model) commanderService.sendInput(`/model ${model}\r`, { bypassLaunchQueue: true });
    if (effort) commanderService.sendInput(`/effort ${effort}\r`, { bypassLaunchQueue: true });

    const defaultChangeDetected = await this.waitForSettingsChange({
      prevModel,
      prevEffort,
      expectModel: !!model,
      expectEffort: !!effort
    });
    await this.sleepFn(this.settleDelayMs);

    const after = this.readSettings();
    if (hadModel) after.model = prevModel;
    else delete after.model;
    if (hadEffort) after.effortLevel = prevEffort;
    else delete after.effortLevel;
    this.writeSettings(after);

    const verified = this.readSettings();
    const defaultRestored =
      (hadModel ? verified.model === prevModel : !('model' in verified)) &&
      (hadEffort ? verified.effortLevel === prevEffort : !('effortLevel' in verified));

    return {
      ok: true,
      model: model || null,
      effort: effort || null,
      defaultChangeDetected,
      defaultRestored
    };
  }

  async waitForSettingsChange({ prevModel, prevEffort, expectModel, expectEffort }) {
    const deadline = Date.now() + this.pollTimeoutMs;
    while (Date.now() < deadline) {
      const current = this.readSettings();
      const modelOk = !expectModel || current.model !== prevModel;
      const effortOk = !expectEffort || current.effortLevel !== prevEffort;
      if (modelOk && effortOk) return true;
      await this.sleepFn(this.pollIntervalMs);
    }
    return false;
  }
}

module.exports = { AgentModelSwitchService };
