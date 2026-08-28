const fs = require('fs');
const path = require('path');

// How often the background timer re-reads the catalog file off disk. The
// catalog itself is a hand-maintained JSON file (config/agent-model-catalog.json),
// not a live provider API — no CLI here exposes a "list models" command — so
// "refresh" means "pick up edits to that file without a server restart",
// not "discover brand-new models automatically."
const DEFAULT_REFRESH_INTERVAL_MS = Number(
  process.env.ORCHESTRATOR_MODEL_CATALOG_REFRESH_MS || 12 * 60 * 60 * 1000
);
const DEFAULT_CATALOG_PATH = path.join(__dirname, '..', 'config', 'agent-model-catalog.json');

class AgentModelCatalogService {
  constructor({
    logger = console,
    fsImpl = fs,
    catalogPath = DEFAULT_CATALOG_PATH,
    refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
    setIntervalFn = setInterval,
    now = () => Date.now()
  } = {}) {
    this.logger = logger;
    this.fs = fsImpl;
    this.catalogPath = catalogPath;
    this.refreshIntervalMs = refreshIntervalMs;
    this.setIntervalFn = setIntervalFn;
    this.now = now;

    this.catalog = null;
    this.lastLoadedAt = null;
    this.lastError = null;
    this.backgroundTimer = null;
  }

  static getInstance(options = {}) {
    if (!AgentModelCatalogService.instance) {
      AgentModelCatalogService.instance = new AgentModelCatalogService(options);
    }
    return AgentModelCatalogService.instance;
  }

  // Never called from tests, so a real setInterval never leaks into a test run.
  startBackgroundRefresh() {
    if (this.backgroundTimer) return;
    this.load();
    this.backgroundTimer = this.setIntervalFn(() => this.load(), this.refreshIntervalMs);
    if (this.backgroundTimer?.unref) this.backgroundTimer.unref();
  }

  stopBackgroundRefresh() {
    if (this.backgroundTimer) clearInterval(this.backgroundTimer);
    this.backgroundTimer = null;
  }

  getCatalog() {
    if (!this.catalog) this.load();
    return {
      providers: this.catalog || {},
      lastLoadedAt: this.lastLoadedAt,
      lastError: this.lastError
    };
  }

  // Manual refresh (the dropdown/modal "Refresh" button). Same as the
  // background tick, just triggered on demand and always returns fresh state.
  refresh() {
    this.load();
    return this.getCatalog();
  }

  load() {
    try {
      const raw = this.fs.readFileSync(this.catalogPath, 'utf8');
      const parsed = JSON.parse(raw);
      const providers = {};
      for (const [providerId, config] of Object.entries(parsed || {})) {
        if (providerId.startsWith('_') || !config || typeof config !== 'object') continue;
        providers[providerId] = this.normalizeProvider(providerId, config);
      }
      this.catalog = providers;
      this.lastLoadedAt = this.now();
      this.lastError = null;
    } catch (error) {
      this.lastError = error.message;
      this.logger.error?.('Failed to load agent model catalog', {
        error: error.message,
        catalogPath: this.catalogPath
      });
      // Keep serving the last good catalog (if any) rather than blanking the
      // picker out from under an open dropdown.
      if (!this.catalog) this.catalog = {};
    }
  }

  normalizeProvider(providerId, config) {
    const defaultEfforts = Array.isArray(config.efforts) ? config.efforts.filter(Boolean) : [];
    const models = Array.isArray(config.models) ? config.models : [];
    return {
      id: providerId,
      label: typeof config.label === 'string' && config.label.trim() ? config.label.trim() : providerId,
      models: models
        .filter((m) => m && typeof m.id === 'string' && m.id.trim())
        .map((m) => ({
          id: m.id.trim(),
          label: typeof m.label === 'string' && m.label.trim() ? m.label.trim() : m.id.trim(),
          efforts: Array.isArray(m.efforts) && m.efforts.length ? m.efforts.filter(Boolean) : defaultEfforts
        }))
    };
  }
}

module.exports = { AgentModelCatalogService };
