const fs = require('fs');
const os = require('os');
const path = require('path');
const winston = require('winston');
const { CodexRateLimitsClient } = require('./codexRateLimitsClient');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/usage-limits.log' }),
    new winston.transports.Console({ format: winston.format.simple() })
  ]
});

// Claude values are tapped into this file by the user's Claude Code status
// line on every refresh, so they're fresh whenever any Claude session is open.
const CLAUDE_LIVE_FILE = path.join(os.homedir(), '.local', 'state', 'ai-usage-monitor', 'claude-live.json');
// Values older than this are shown as stale rather than hidden — a limit
// percentage from an hour ago still beats nothing.
const CLAUDE_STALE_AFTER_MS = 60 * 60 * 1000;

// A local app-server round trip reaches the ChatGPT backend, so poll gently.
const CODEX_CACHE_TTL_MS = Number(process.env.ORCHESTRATOR_CODEX_USAGE_TTL_MS || 15 * 60 * 1000);

// Grok subscription usage comes from the CLI proxy's billing endpoints, using
// the OAuth access token the grok CLI already keeps in ~/.grok/auth.json.
// IMPORTANT: never refresh that token here — xAI rotates refresh tokens, and
// an out-of-band refresh can log the user's grok CLI out. If the token is
// expired we simply report stale until the CLI refreshes it on next use.
// Fuller Claude quota picture straight from the endpoint Claude Code's /usage
// screen uses — includes the per-model weekly window (e.g. "Fable") that the
// status-line tap never carries, and stays fresh even with no session open.
// Token is read from the CLI's own credentials and NEVER refreshed or logged.
const CLAUDE_CREDENTIALS_FILE = path.join(os.homedir(), '.claude', '.credentials.json');
const CLAUDE_OAUTH_USAGE_URL = process.env.CLAUDE_OAUTH_USAGE_URL || 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_OAUTH_CACHE_TTL_MS = Number(process.env.ORCHESTRATOR_CLAUDE_USAGE_TTL_MS || 5 * 60 * 1000);
const CLAUDE_OAUTH_TIMEOUT_MS = 15 * 1000;

// A usage percentage only means anything inside the window it was measured in.
// Once resets_at has passed the window has rolled over and the quota is back,
// so a reading that still carries the old percentage has to be dropped instead
// of shown as current. This bites hardest on the status-line tap file: when
// every session is sitting blocked on a full 5-hour window, nothing rewrites
// the tap, and the widget kept reporting "5h 99%" hours after the reset.
const WINDOW_EXPIRY_GRACE_MS = 60 * 1000;

const GROK_AUTH_FILE = path.join(os.homedir(), '.grok', 'auth.json');
const GROK_BILLING_BASE = process.env.GROK_BILLING_BASE_URL || 'https://cli-chat-proxy.grok.com/v1';
const GROK_CACHE_TTL_MS = Number(process.env.ORCHESTRATOR_GROK_USAGE_TTL_MS || 15 * 60 * 1000);
const GROK_TIMEOUT_MS = 20 * 1000;

class UsageLimitsService {
  constructor({ codexRateLimitsClient = null } = {}) {
    this.codexRateLimitsClient = codexRateLimitsClient || new CodexRateLimitsClient({ logger });
    this.codexCache = null; // { at, data }
    this.codexInFlight = null;
    this.grokCache = null; // { at, data }
    this.grokInFlight = null;
    this.claudeOauthCache = null; // { at, data }
    this.claudeOauthInFlight = null;
  }

  static getInstance() {
    if (!UsageLimitsService.instance) {
      UsageLimitsService.instance = new UsageLimitsService();
    }
    return UsageLimitsService.instance;
  }

  isWindowOver(bucket, now = Date.now()) {
    const resetsAt = Number(bucket?.resetsAt);
    // No reset time means no way to tell the window ended (the per-model weekly
    // buckets arrive that way), so those are always kept.
    if (!Number.isFinite(resetsAt) || resetsAt <= 0) return false;
    return resetsAt * 1000 + WINDOW_EXPIRY_GRACE_MS <= now;
  }

  liveBucket(bucket, now = Date.now()) {
    return bucket && !this.isWindowOver(bucket, now) ? bucket : null;
  }

  dropExpiredWindows(providerData, now = Date.now()) {
    if (!providerData?.available || !Array.isArray(providerData.windows)) return providerData;
    const windows = providerData.windows.filter((w) => !this.isWindowOver(w, now));
    if (windows.length === providerData.windows.length) return providerData;
    return { ...providerData, windows };
  }

  dropExpiredClaudeBuckets(limits, now = Date.now()) {
    if (!limits?.available) return limits;
    return {
      ...limits,
      fiveHour: this.liveBucket(limits.fiveHour, now),
      sevenDay: this.liveBucket(limits.sevenDay, now),
      extraBuckets: (Array.isArray(limits.extraBuckets) ? limits.extraBuckets : [])
        .filter((b) => !this.isWindowOver(b, now))
    };
  }

  readClaudeOauthToken() {
    try {
      const raw = JSON.parse(fs.readFileSync(CLAUDE_CREDENTIALS_FILE, 'utf8'));
      const oauth = raw?.claudeAiOauth || {};
      const token = String(oauth.accessToken || '').trim();
      if (!token) return null;
      const expiresAt = Number(oauth.expiresAt);
      if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return null;
      return token;
    } catch {
      return null;
    }
  }

  // Parse the /api/oauth/usage `limits` array: session → 5h, weekly_all → 7d,
  // and per-model weekly windows (scope.model.display_name, e.g. "Fable") →
  // extra buckets the widget renders as "<Model> 7d".
  parseClaudeOauthLimits(payload) {
    const toEpochSeconds = (iso) => {
      const t = Date.parse(String(iso || ''));
      return Number.isFinite(t) ? Math.round(t / 1000) : null;
    };
    let fiveHour = null;
    let sevenDay = null;
    const extraBuckets = [];
    for (const limit of (Array.isArray(payload?.limits) ? payload.limits : [])) {
      const pct = Number(limit?.percent);
      if (!Number.isFinite(pct)) continue;
      const bucket = { usedPercentage: Math.round(pct), resetsAt: toEpochSeconds(limit?.resets_at) };
      if (limit.kind === 'session') {
        fiveHour = bucket;
      } else if (limit.kind === 'weekly_all') {
        sevenDay = bucket;
      } else if (limit.group === 'weekly') {
        const name = String(limit?.scope?.model?.display_name || '').trim();
        if (!name) continue;
        extraBuckets.push({
          key: `seven_day_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
          ...bucket
        });
      }
    }
    if (!fiveHour && !sevenDay && !extraBuckets.length) return null;
    return { fiveHour, sevenDay, extraBuckets };
  }

  async fetchClaudeOauthLimits() {
    const token = this.readClaudeOauthToken();
    if (!token) return { available: false, reason: 'no-oauth-token' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLAUDE_OAUTH_TIMEOUT_MS);
    try {
      const res = await fetch(CLAUDE_OAUTH_USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20'
        },
        signal: controller.signal
      });
      if (!res.ok) return { available: false, reason: `http-${res.status}` };
      const parsed = this.parseClaudeOauthLimits(await res.json());
      if (!parsed) return { available: false, reason: 'no-limits' };
      return { available: true, ...parsed };
    } catch (error) {
      return { available: false, reason: String(error?.message || error) };
    } finally {
      clearTimeout(timer);
    }
  }

  // Live OAuth data when available (fresher + has the per-model weekly bucket),
  // status-line tap file as fallback.
  // The cached OAuth response is only good until one of its windows resets —
  // past that the cached percentages describe a window that no longer exists,
  // so refetch rather than serve them for the rest of the TTL.
  claudeOauthCacheUsable(now = Date.now()) {
    if (!this.claudeOauthCache) return false;
    if (now - this.claudeOauthCache.at >= CLAUDE_OAUTH_CACHE_TTL_MS) return false;
    const { fiveHour, sevenDay, extraBuckets } = this.claudeOauthCache.data || {};
    return ![fiveHour, sevenDay, ...(Array.isArray(extraBuckets) ? extraBuckets : [])]
      .some((bucket) => this.isWindowOver(bucket, now));
  }

  async getClaudeLimits({ refresh = false } = {}) {
    const tap = this.readClaudeLimits();
    if (this.claudeOauthInFlight) await this.claudeOauthInFlight.catch(() => {});
    let oauth = (!refresh && this.claudeOauthCacheUsable())
      ? this.claudeOauthCache.data
      : null;
    if (!oauth) {
      this.claudeOauthInFlight = this.fetchClaudeOauthLimits().then((data) => {
        if (data.available) this.claudeOauthCache = { at: Date.now(), data };
        return data;
      }).finally(() => {
        this.claudeOauthInFlight = null;
      });
      oauth = await this.claudeOauthInFlight;
    }
    if (!oauth?.available) return tap;
    // tap is already expiry-filtered, so a bucket the live payload omits is only
    // grafted in when its window is still running.
    return this.dropExpiredClaudeBuckets({
      available: true,
      updatedAt: Math.round(Date.now() / 1000),
      stale: false,
      model: tap?.model || null,
      fiveHour: oauth.fiveHour || tap?.fiveHour || null,
      sevenDay: oauth.sevenDay || tap?.sevenDay || null,
      extraBuckets: (oauth.extraBuckets && oauth.extraBuckets.length) ? oauth.extraBuckets : (tap?.extraBuckets || [])
    });
  }

  readClaudeLimits() {
    try {
      const raw = JSON.parse(fs.readFileSync(CLAUDE_LIVE_FILE, 'utf8'));
      const limits = raw?.rate_limits || {};
      const updatedAt = Number(raw?.updated_at) || null;
      const bucket = (b) => {
        if (!b || typeof b !== 'object') return null;
        const pct = Number(b.used_percentage);
        const resets = Number(b.resets_at);
        return {
          usedPercentage: Number.isFinite(pct) ? Math.round(pct) : null,
          resetsAt: Number.isFinite(resets) ? resets : null
        };
      };
      // Pass through any additional rate-limit buckets Claude Code reports
      // (e.g. a model-specific weekly bucket like seven_day_opus/seven_day_fable)
      // so new buckets surface in the UI without code changes here.
      const extraBuckets = [];
      for (const [key, value] of Object.entries(limits)) {
        if (key === 'five_hour' || key === 'seven_day') continue;
        const parsed = bucket(value);
        if (parsed) extraBuckets.push({ key, ...parsed });
      }
      return this.dropExpiredClaudeBuckets({
        available: true,
        updatedAt,
        stale: updatedAt ? (Date.now() - updatedAt * 1000) > CLAUDE_STALE_AFTER_MS : true,
        model: String(raw?.model || '').trim() || null,
        fiveHour: bucket(limits.five_hour),
        sevenDay: bucket(limits.seven_day),
        extraBuckets
      });
    } catch {
      return { available: false };
    }
  }

  formatCodexWindowDuration(windowDurationMins) {
    const minutes = Number(windowDurationMins);
    if (!Number.isFinite(minutes) || minutes <= 0) return null;
    if (minutes % 10_080 === 0) {
      const weeks = minutes / 10_080;
      return `${weeks} ${weeks === 1 ? 'week' : 'weeks'}`;
    }
    if (minutes % 1_440 === 0) {
      const days = minutes / 1_440;
      return `${days} ${days === 1 ? 'day' : 'days'}`;
    }
    if (minutes % 60 === 0) {
      const hours = minutes / 60;
      return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
    }
    return `${minutes} minutes`;
  }

  parseCodexRateLimits(result) {
    const windows = [];
    if (!result || typeof result !== 'object') return windows;

    const byLimitId = result.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === 'object'
      ? Object.entries(result.rateLimitsByLimitId)
      : [];
    const snapshots = byLimitId.length
      ? byLimitId
      : [['codex', result.rateLimits]];

    for (const [fallbackBucket, snapshot] of snapshots) {
      if (!snapshot || typeof snapshot !== 'object') continue;
      const bucket = String(snapshot.limitId || fallbackBucket || '').trim();
      if (!bucket) continue;
      for (const name of ['primary', 'secondary']) {
        const rawWindow = snapshot[name];
        if (!rawWindow || typeof rawWindow !== 'object') continue;
        const usedPercentage = Number(rawWindow.usedPercent);
        const windowDurationMins = Number(rawWindow.windowDurationMins);
        const resetsAt = Number(rawWindow.resetsAt);
        const window = this.formatCodexWindowDuration(windowDurationMins);
        if (!Number.isFinite(usedPercentage) || !window || !Number.isFinite(resetsAt) || resetsAt <= 0) continue;
        windows.push({
          bucket,
          bucketName: String(snapshot.limitName || '').trim() || null,
          name,
          window,
          windowDurationMins,
          usedPercentage: Math.min(100, Math.max(0, Math.round(usedPercentage))),
          resetsAt: Math.round(resetsAt)
        });
      }
    }
    return windows;
  }

  fetchCodexLimits() {
    if (this.codexInFlight) return this.codexInFlight;
    this.codexInFlight = this.codexRateLimitsClient.read().then((result) => {
      const windows = this.parseCodexRateLimits(result);
      return {
        available: windows.length > 0,
        reason: windows.length > 0 ? undefined : 'weekly-windows-missing',
        updatedAt: Math.floor(Date.now() / 1000),
        windows
      };
    }).catch((error) => {
      const message = String(error?.message || error);
      logger.warn('Codex app-server usage read failed', { error: message });
      return {
        available: false,
        reason: message === 'codex-app-server-cancelled' ? 'cancelled' : 'app-server-failed'
      };
    }).then((data) => {
      if (data.available) this.codexCache = { at: Date.now(), data };
      return data;
    }).finally(() => {
      this.codexInFlight = null;
    });
    return this.codexInFlight;
  }

  async cancelCodexFetch() {
    await this.codexRateLimitsClient.cancelActive();
    await this.codexInFlight?.catch(() => {});
  }

  readGrokToken() {
    try {
      const auth = JSON.parse(fs.readFileSync(GROK_AUTH_FILE, 'utf8'));
      const account = Object.values(auth).find(a => a && typeof a === 'object' && a.key);
      if (!account) return null;
      const token = String(account.key);
      // The access token is a JWT; check exp locally so we never send (or try
      // to refresh) an expired credential.
      const parts = token.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (Number.isFinite(payload.exp) && payload.exp * 1000 < Date.now()) {
          return { expired: true };
        }
      }
      return { token };
    } catch {
      return null;
    }
  }

  grokFetch(pathSuffix, token) {
    return fetch(`${GROK_BILLING_BASE}${pathSuffix}`, {
      headers: {
        authorization: `Bearer ${token}`,
        'x-xai-token-auth': 'xai-grok-cli',
        accept: 'application/json'
      },
      signal: AbortSignal.timeout(GROK_TIMEOUT_MS)
    }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  }

  parseGrokWindows({ monthly, weekly }) {
    const windows = [];
    const num = (v) => (Number.isFinite(Number(v?.val)) ? Number(v.val) : null);
    const epoch = (iso) => {
      const t = Date.parse(iso);
      return Number.isFinite(t) ? Math.floor(t / 1000) : null;
    };
    const wc = weekly?.config;
    if (wc && wc.currentPeriod?.type === 'USAGE_PERIOD_TYPE_WEEKLY') {
      const cap = num(wc.onDemandCap);
      const used = num(wc.onDemandUsed);
      windows.push({
        bucket: 'grok',
        name: 'weekly',
        window: '1 week',
        usedPercentage: cap > 0 && used !== null ? Math.min(100, Math.round((used / cap) * 100)) : 0,
        resetsAt: epoch(wc.billingPeriodEnd)
      });
    }
    const mc = monthly?.config;
    const monthlyLimit = num(mc?.monthlyLimit);
    if (monthlyLimit > 0) {
      const used = num(mc.used) || 0;
      windows.push({
        bucket: 'grok',
        name: 'monthly',
        window: '1 month',
        usedPercentage: Math.min(100, Math.round((used / monthlyLimit) * 100)),
        resetsAt: epoch(mc.billingPeriodEnd)
      });
    }
    return windows;
  }

  fetchGrokLimits() {
    if (this.grokInFlight) return this.grokInFlight;
    this.grokInFlight = (async () => {
      const cred = this.readGrokToken();
      if (!cred) return { available: false, reason: 'not-installed' };
      if (cred.expired) return { available: false, reason: 'token-expired' };
      const [monthly, weekly] = await Promise.all([
        this.grokFetch('/billing', cred.token),
        this.grokFetch('/billing?format=credits', cred.token)
      ]);
      if (!monthly && !weekly) return { available: false, reason: 'fetch-failed' };
      const windows = this.parseGrokWindows({ monthly, weekly });
      return { available: windows.length > 0, updatedAt: Math.floor(Date.now() / 1000), windows };
    })().then((data) => {
      if (data.available) this.grokCache = { at: Date.now(), data };
      return data;
    }).finally(() => {
      this.grokInFlight = null;
    });
    return this.grokInFlight;
  }

  async getProviderCached({ enabled, cache, ttl, fetcher }) {
    if (!enabled) return { available: false, reason: 'disabled' };
    if (cache && Date.now() - cache.at < ttl) return this.dropExpiredWindows(cache.data);
    const data = await fetcher();
    // A failed refresh falls back to the last good read, which may well be old
    // enough that some of its windows have since reset.
    if (!data.available && cache) return this.dropExpiredWindows({ ...cache.data, stale: true });
    // A fresh read is passed through untouched — the Codex guard reads rollover
    // out of it and must see exactly what the provider reported.
    return data;
  }

  async getCodexLimits({ refresh = false, enabled = true } = {}) {
    return this.getProviderCached({
      enabled,
      cache: refresh ? null : this.codexCache,
      ttl: CODEX_CACHE_TTL_MS,
      fetcher: () => this.fetchCodexLimits()
    });
  }

  async getLimits({ refresh = false, providers = {} } = {}) {
    const enabled = (name) => providers[name] !== false;
    const claude = enabled('claude')
      ? await this.getClaudeLimits({ refresh })
      : { available: false, reason: 'disabled' };
    const [codex, grok] = await Promise.all([
      this.getCodexLimits({ refresh, enabled: enabled('codex') }),
      this.getProviderCached({
        enabled: enabled('grok'),
        cache: refresh ? null : this.grokCache,
        ttl: GROK_CACHE_TTL_MS,
        fetcher: () => this.fetchGrokLimits()
      })
    ]);
    return { claude, codex, grok };
  }
}

module.exports = { UsageLimitsService };
