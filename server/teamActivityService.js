const { execFile } = require('child_process');
const winston = require('winston');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/team-activity.log' }),
    new winston.transports.Console({ format: winston.format.simple() })
  ]
});

// Also doubles as the background-refresh cadence — see startBackgroundRefresh().
const REFRESH_INTERVAL_MS = Number(process.env.ORCHESTRATOR_TEAM_ACTIVITY_CACHE_TTL_MS || 300000);
const DEFAULT_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 31;
const SEARCH_PAGE_LIMIT = 100; // GitHub search API per_page ceiling
const GH_TIMEOUT_MS = 20000;
const TRELLO_CARD_PATTERN = /https?:\/\/trello\.com\/c\/[A-Za-z0-9]+/g;
// A manual `?refresh=1` click still respects this floor, so mashing Refresh
// can't re-trigger the same GitHub search rate limit a live-per-request
// design used to hit.
const MIN_MANUAL_REFRESH_GAP_MS = 20000;
// Re-ask for anything touched since the last successful pull, minus this
// much overlap, as insurance against clock skew between here and GitHub.
const INCREMENTAL_OVERLAP_MS = 120000;

function defaultGhJson(args) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { timeout: GH_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        logger.error('gh call failed', { error: error.message, stderr, args: args.slice(0, 3) });
        reject(error);
        return;
      }
      try {
        resolve(JSON.parse(String(stdout || 'null')));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

function emptyBucket() {
  // items: Map<id, item> — the accumulated, deduped result set for one
  // member's PRs or commits. cursor: Date the next incremental pull should
  // ask "updated since". floorDateKey: the oldest date we can GUARANTEE is
  // fully covered — null until the first backfill lands.
  return { items: new Map(), cursor: null, floorDateKey: null, lastFetchAt: 0 };
}

class TeamActivityService {
  constructor({
    ghJson = defaultGhJson,
    settingsProvider = null,
    now = () => new Date(),
    nowMs = () => Date.now(),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval
  } = {}) {
    this.ghJson = ghJson;
    this.settingsProvider = settingsProvider;
    this.now = now;
    this.nowMs = nowMs;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.prBuckets = new Map(); // key -> bucket
    this.commitBuckets = new Map();
    this.fetchInFlight = new Map(); // key -> Promise, coalesces concurrent pulls per member
    this.backgroundTimer = null;
  }

  static getInstance(options) {
    if (!TeamActivityService.instance) {
      TeamActivityService.instance = new TeamActivityService(options);
    }
    return TeamActivityService.instance;
  }

  // Starts the periodic pull. Idempotent — call it once at server boot.
  // Never called from tests, so a real setInterval never leaks into a test
  // run unless a test explicitly asks for it (with injected timer fns).
  startBackgroundRefresh() {
    if (this.backgroundTimer) return;
    const tick = () => {
      const { members, repos } = this.teamConfig();
      members.forEach((member) => {
        this.refreshMember({ member, repos }).catch((error) => {
          logger.error('Background team activity refresh failed', {
            member: member.githubUsername,
            error: error.message
          });
        });
      });
    };
    this.backgroundTimer = this.setIntervalFn(tick, REFRESH_INTERVAL_MS);
    if (this.backgroundTimer && typeof this.backgroundTimer.unref === 'function') {
      this.backgroundTimer.unref(); // a quiet dashboard poll shouldn't hold the process open
    }
    tick();
  }

  stopBackgroundRefresh() {
    if (this.backgroundTimer) {
      this.clearIntervalFn(this.backgroundTimer);
      this.backgroundTimer = null;
    }
  }

  teamConfig() {
    const settings = this.settingsProvider ? (this.settingsProvider() || {}) : {};
    const team = settings.team || {};
    const members = Array.isArray(team.members)
      ? team.members
        .map((member) => ({
          name: String(member?.name || member?.githubUsername || '').trim(),
          githubUsername: String(member?.githubUsername || '').trim()
        }))
        .filter((member) => member.githubUsername)
      : [];
    const repos = Array.isArray(team.repos)
      ? team.repos.map((repo) => String(repo || '').trim()).filter(Boolean)
      : [];
    return { members, repos };
  }

  clampDays(value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) return DEFAULT_WINDOW_DAYS;
    return Math.min(MAX_WINDOW_DAYS, Math.max(1, parsed));
  }

  localDateKey(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  sinceDateKey(days) {
    const start = new Date(this.now());
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));
    return this.localDateKey(start);
  }

  bucketKey(username, repos) {
    return JSON.stringify([username, repos]);
  }

  async activity({ days, authors, refresh = false } = {}) {
    const config = this.teamConfig();
    const requestedAuthors = String(authors || '')
      .split(',')
      .map((author) => author.trim())
      .filter(Boolean);
    const members = requestedAuthors.length
      ? requestedAuthors.map((username) => {
        const known = config.members.find((member) => member.githubUsername === username);
        return known || { name: username, githubUsername: username };
      })
      : config.members;
    const windowDays = this.clampDays(days ?? DEFAULT_WINDOW_DAYS);
    const since = this.sinceDateKey(windowDays);

    // One member's flaky/rate-limited `gh` call must not blank out everyone
    // else's report, so each member is refreshed and degraded independently.
    const memberResults = await Promise.all(members.map((member) =>
      this.refreshMember({ member, repos: config.repos, force: refresh })
        .then(({ prBucket, commitBucket }) => this.assembleMember({ member, prBucket, commitBucket, since }))
        .catch((error) => {
          logger.error('Team activity lookup failed for member', {
            member: member.githubUsername,
            error: error.message
          });
          return {
            name: member.name || member.githubUsername,
            githubUsername: member.githubUsername,
            incomplete: true,
            error: 'Lookup failed. Is `gh` authenticated?',
            totals: { prsOpened: 0, prsMerged: 0, commits: 0, tickets: 0, medianCycleHours: null },
            days: [],
            timeline: []
          };
        })));

    return {
      ok: true,
      generatedAt: this.now().toISOString(),
      windowDays,
      since,
      members: memberResults
    };
  }

  // Pulls only what changed since the last successful fetch and merges it
  // into the member's running store, instead of re-asking GitHub for the
  // full 31-day window on every request. First call for a member does a
  // one-time full backfill; every call after that is a small delta.
  async refreshMember({ member, repos, force = false }) {
    const key = this.bucketKey(member.githubUsername, repos);
    const pending = this.fetchInFlight.get(key);
    if (pending) return pending;

    const existingPr = this.prBuckets.get(key);
    const existingCommit = this.commitBuckets.get(key);
    const hasData = Boolean(existingPr && existingCommit && existingPr.cursor);

    // Data already exists and nobody asked to force it: the background
    // timer owns freshness here, so a normal page view reads whatever's
    // cached instead of firing a live gh call on every request.
    if (hasData && !force) {
      return { prBucket: existingPr, commitBucket: existingCommit };
    }
    // A forced refresh still respects a minimum gap, so mashing the UI's
    // Refresh button can't retrigger the same rate limit a live-per-request
    // design used to hit.
    if (hasData && force && this.nowMs() - existingPr.lastFetchAt < MIN_MANUAL_REFRESH_GAP_MS) {
      return { prBucket: existingPr, commitBucket: existingCommit };
    }

    const fetchPromise = (async () => {
      const fetchStartedAt = this.now();
      const [prResult, commitResult] = await Promise.all([
        this.fetchDelta({ bucket: existingPr, kind: 'pr', member, repos, fetchStartedAt }),
        this.fetchDelta({ bucket: existingCommit, kind: 'commit', member, repos, fetchStartedAt })
      ]);
      this.prBuckets.set(key, prResult);
      this.commitBuckets.set(key, commitResult);
      return { prBucket: prResult, commitBucket: commitResult };
    })();
    this.fetchInFlight.set(key, fetchPromise);

    try {
      return await fetchPromise;
    } finally {
      if (this.fetchInFlight.get(key) === fetchPromise) this.fetchInFlight.delete(key);
    }
  }

  async fetchDelta({ bucket, kind, member, repos, fetchStartedAt }) {
    const current = bucket || emptyBucket();
    const isBackfill = !current.cursor;
    const since = isBackfill
      ? this.sinceDateKey(MAX_WINDOW_DAYS)
      : new Date(current.cursor.getTime() - INCREMENTAL_OVERLAP_MS).toISOString();

    const search = kind === 'pr'
      ? await this.searchPullRequests({ username: member.githubUsername, since, repos })
      : await this.searchCommits({ username: member.githubUsername, since, repos });

    const nextItems = new Map(current.items);
    search.items.forEach((item) => nextItems.set(kind === 'pr' ? `${item.repo}#${item.number}` : item.sha, item));

    // Bound memory: nothing older than the max window is ever displayed.
    const evictBefore = this.sinceDateKey(MAX_WINDOW_DAYS);
    const relevantDateKey = kind === 'pr'
      ? (item) => this.localDateKey(item.mergedAt || item.createdAt)
      : (item) => this.localDateKey(item.authoredAt);
    [...nextItems.entries()].forEach(([id, item]) => {
      const dateKey = relevantDateKey(item);
      if (dateKey && dateKey < evictBefore) nextItems.delete(id);
    });

    // floorDateKey only ever moves backward on the first backfill — an
    // incremental pull extends coverage forward in time, it can't fill in a
    // gap behind the existing floor.
    let floorDateKey = current.floorDateKey;
    if (isBackfill) {
      floorDateKey = search.incomplete
        ? this.oldestDateKey(search.items, kind)
        : this.sinceDateKey(MAX_WINDOW_DAYS);
    } else if (search.incomplete) {
      logger.error('Incremental team activity pull hit the search page cap — coverage floor unchanged', {
        member: member.githubUsername,
        kind
      });
    }

    return { items: nextItems, cursor: fetchStartedAt, floorDateKey, lastFetchAt: this.nowMs() };
  }

  // null means "no guaranteed coverage at all" — a capped fetch that
  // happened to return zero usable items must not be read as full coverage.
  oldestDateKey(items, kind) {
    const dateOf = kind === 'pr'
      ? (item) => item.mergedAt || item.createdAt
      : (item) => item.authoredAt;
    const keys = items.map((item) => this.localDateKey(dateOf(item))).filter(Boolean).sort();
    return keys.length ? keys[0] : null;
  }

  repoQualifier(repos) {
    return repos.map((repo) => `repo:${repo}`).join(' ');
  }

  async searchPullRequests({ username, since, repos }) {
    const query = [`type:pr`, `author:${username}`, `updated:>=${since}`, this.repoQualifier(repos)]
      .filter(Boolean)
      .join(' ');
    const payload = await this.ghJson([
      'api', 'search/issues', '--method', 'GET',
      '-f', `q=${query}`,
      '-f', `per_page=${SEARCH_PAGE_LIMIT}`,
      // Without an explicit sort, GitHub ranks by relevance, so a capped
      // page is not reliably "the most recent N" — sorting by update
      // recency makes the cap predictable and keeps the newest work first.
      '-f', 'sort=updated'
    ]);
    const items = Array.isArray(payload?.items) ? payload.items : [];
    return {
      incomplete: Boolean(payload?.incomplete_results) || Number(payload?.total_count || 0) > items.length,
      items: items.map((item) => ({
        number: item.number,
        title: item.title || '',
        url: item.html_url || '',
        repo: this.repoFromUrl(item.repository_url || item.html_url),
        state: item.pull_request?.merged_at ? 'merged' : item.state,
        createdAt: item.created_at || null,
        mergedAt: item.pull_request?.merged_at || null,
        tickets: this.trelloLinks(`${item.title || ''}\n${item.body || ''}`)
      }))
    };
  }

  async searchCommits({ username, since, repos }) {
    const query = [`author:${username}`, `author-date:>=${since}`, this.repoQualifier(repos)]
      .filter(Boolean)
      .join(' ');
    const payload = await this.ghJson([
      'api', 'search/commits', '--method', 'GET',
      '-f', `q=${query}`,
      '-f', `per_page=${SEARCH_PAGE_LIMIT}`,
      '-f', 'sort=author-date'
    ]);
    const items = Array.isArray(payload?.items) ? payload.items : [];
    return {
      incomplete: Boolean(payload?.incomplete_results) || Number(payload?.total_count || 0) > items.length,
      items: items.map((item) => ({
        sha: item.sha,
        repo: item.repository?.full_name || this.repoFromUrl(item.html_url),
        authoredAt: item.commit?.author?.date || null,
        message: String(item.commit?.message || '').split('\n')[0]
      }))
    };
  }

  repoFromUrl(url) {
    // API URLs look like api.github.com/repos/<owner>/<name>; web URLs like
    // github.com/<owner>/<name>/... — check the API shape first or the
    // hostname match would capture "repos/<owner>" as the repo.
    const text = String(url || '');
    const match = text.match(/\/repos\/([^/]+\/[^/#?]+)/) || text.match(/github\.com\/([^/]+\/[^/#?]+)/);
    return match ? match[1] : '';
  }

  trelloLinks(text) {
    const matches = String(text || '').match(TRELLO_CARD_PATTERN) || [];
    return [...new Set(matches)];
  }

  assembleMember({ member, prBucket, commitBucket, since }) {
    const prItems = [...prBucket.items.values()];
    const commitItems = [...commitBucket.items.values()];
    // Coverage, not "this one call got capped": true only when the window
    // being asked for reaches further back than what the accumulated store
    // can guarantee is complete. No floor at all (a capped fetch that
    // returned nothing usable) means no guaranteed coverage, full stop.
    const incomplete = !prBucket.floorDateKey || !commitBucket.floorDateKey ||
      since < prBucket.floorDateKey || since < commitBucket.floorDateKey;

    const days = new Map();
    const inWindow = (dateKey) => dateKey && dateKey >= since;
    const dayEntry = (dateKey) => {
      if (!days.has(dateKey)) {
        days.set(dateKey, { date: dateKey, prsOpened: [], prsMerged: [], commitCount: 0, commitRepos: [], tickets: [] });
      }
      return days.get(dateKey);
    };

    prItems.forEach((pr) => {
      const openedKey = this.localDateKey(pr.createdAt);
      if (inWindow(openedKey)) dayEntry(openedKey).prsOpened.push(pr);
      const mergedKey = this.localDateKey(pr.mergedAt);
      if (inWindow(mergedKey)) dayEntry(mergedKey).prsMerged.push(pr);
      const targetKey = [mergedKey, openedKey].find(inWindow);
      if (targetKey && pr.tickets.length) {
        const entry = dayEntry(targetKey);
        entry.tickets = [...new Set([...entry.tickets, ...pr.tickets])];
      }
    });

    commitItems.forEach((commit) => {
      const dateKey = this.localDateKey(commit.authoredAt);
      if (!inWindow(dateKey)) return;
      const entry = dayEntry(dateKey);
      entry.commitCount += 1;
      if (commit.repo && !entry.commitRepos.includes(commit.repo)) entry.commitRepos.push(commit.repo);
    });

    const orderedDays = [...days.values()].sort((a, b) => b.date.localeCompare(a.date));

    // A flat, undated-bucket view of the same PRs for a timeline/Gantt render,
    // where a PR is one bar from createdAt to mergedAt (or to "now" if still
    // open) rather than two separate day-bucket entries.
    const timeline = prItems
      .filter((pr) => inWindow(this.localDateKey(pr.createdAt)) || inWindow(this.localDateKey(pr.mergedAt)))
      .map((pr) => ({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        repo: pr.repo,
        state: pr.state,
        createdAt: pr.createdAt,
        mergedAt: pr.mergedAt,
        cycleHours: pr.mergedAt ? (new Date(pr.mergedAt) - new Date(pr.createdAt)) / 3600000 : null
      }))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    const cycleHoursInWindow = timeline
      .filter((pr) => inWindow(this.localDateKey(pr.mergedAt)) && Number.isFinite(pr.cycleHours))
      .map((pr) => pr.cycleHours)
      .sort((a, b) => a - b);
    const medianCycleHours = cycleHoursInWindow.length
      ? cycleHoursInWindow[Math.floor((cycleHoursInWindow.length - 1) / 2)]
      : null;

    return {
      name: member.name || member.githubUsername,
      githubUsername: member.githubUsername,
      incomplete,
      totals: {
        prsOpened: prItems.filter((pr) => inWindow(this.localDateKey(pr.createdAt))).length,
        prsMerged: prItems.filter((pr) => inWindow(this.localDateKey(pr.mergedAt))).length,
        commits: commitItems.filter((commit) => inWindow(this.localDateKey(commit.authoredAt))).length,
        tickets: [...new Set(prItems.flatMap((pr) => pr.tickets))].length,
        medianCycleHours
      },
      days: orderedDays,
      timeline
    };
  }
}

module.exports = { TeamActivityService, DEFAULT_WINDOW_DAYS, MAX_WINDOW_DAYS };
