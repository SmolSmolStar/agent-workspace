const fs = require('fs');
const os = require('os');
const path = require('path');

// How often the background timer re-reads the catalog file off disk. The
// catalog itself is a hand-maintained JSON file (config/agent-model-catalog.json),
// not a live provider API — no CLI here exposes a "list models" command — so
// "refresh" means "pick up edits to that file without a server restart",
// not "discover brand-new models automatically." Codex is the one exception:
// see enrichCodexFromLiveCache() below.
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
    now = () => Date.now(),
    homeDir = null
  } = {}) {
    this.logger = logger;
    this.fs = fsImpl;
    this.catalogPath = catalogPath;
    this.refreshIntervalMs = refreshIntervalMs;
    this.setIntervalFn = setIntervalFn;
    this.now = now;
    this.homeDir = homeDir || os.homedir();

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
      this.enrichCodexFromLiveCache(providers);
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

  // Codex itself caches the real, currently-available model list (with
  // per-model reasoning-effort support) at ~/.codex/models_cache.json,
  // refreshed by the Codex CLI on its own schedule. When present, this
  // replaces the curated codex.models list with that live data instead of
  // the hand-maintained fallback in config/agent-model-catalog.json — the
  // one provider here that gets genuine live discovery rather than a
  // curated list a human has to keep updating by hand.
  enrichCodexFromLiveCache(providers) {
    if (!providers.codex) return;
    const cachePath = path.join(this.homeDir, '.codex', 'models_cache.json');
    try {
      const raw = this.fs.readFileSync(cachePath, 'utf8');
      const parsed = JSON.parse(raw);
      const liveModels = Array.isArray(parsed?.models) ? parsed.models : [];
      const models = liveModels
        .filter((m) => m && typeof m.slug === 'string' && m.slug.trim() && m.visibility !== 'hidden')
        .map((m) => ({
          id: m.slug.trim(),
          label: typeof m.display_name === 'string' && m.display_name.trim() ? m.display_name.trim() : m.slug.trim(),
          efforts: Array.isArray(m.supported_reasoning_levels)
            ? m.supported_reasoning_levels.map((l) => l?.effort).filter(Boolean)
            : [],
          // Service tiers (e.g. "priority" = the "Fast" 1.5x-speed tier from
          // `codex.service_tier` config, verified against this machine's own
          // ~/.codex/config.toml). Only some models offer one; "default" (the
          // model's normal, non-priority tier) is always first and always
          // selected unless the user explicitly picks another.
          tiers: [
            { id: 'default', label: 'Normal' },
            ...(Array.isArray(m.service_tiers) ? m.service_tiers : [])
              .filter((t) => t && typeof t.id === 'string' && t.id.trim() && t.id !== 'default')
              .map((t) => ({
                id: t.id.trim(),
                label: typeof t.name === 'string' && t.name.trim() ? t.name.trim() : t.id.trim()
              }))
          ]
        }))
        .filter((m) => m.efforts.length)
        // Drop the tier picker entirely when there's nothing but "Normal" -
        // most models don't offer a priority tier, and a single-option
        // selector is pure clutter.
        .map((m) => (m.tiers.length > 1 ? m : { ...m, tiers: [] }));
      if (models.length) {
        providers.codex.models = models;
        providers.codex.liveSource = cachePath;
      }
    } catch {
      // No cache file (Codex never run here) or unreadable — keep the
      // curated fallback from agent-model-catalog.json, no error surfaced.
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
          efforts: Array.isArray(m.efforts) && m.efforts.length ? m.efforts.filter(Boolean) : defaultEfforts,
          // Only Codex's live cache (enrichCodexFromLiveCache) populates
          // this today; every model still gets the field so client code
          // never has to guard against it being undefined.
          tiers: Array.isArray(m.tiers) ? m.tiers.filter((t) => t && t.id) : []
        }))
    };
  }
}

module.exports = { AgentModelCatalogService };
