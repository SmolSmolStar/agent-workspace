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

const CACHE_TTL_MS = Number(process.env.ORCHESTRATOR_TEAM_ACTIVITY_CACHE_TTL_MS || 300000);
const DEFAULT_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 31;
const SEARCH_PAGE_LIMIT = 100; // GitHub search API per_page ceiling
const GH_TIMEOUT_MS = 20000;
const TRELLO_CARD_PATTERN = /https?:\/\/trello\.com\/c\/[A-Za-z0-9]+/g;

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

class TeamActivityService {
  constructor({ ghJson = defaultGhJson, settingsProvider = null, now = () => new Date() } = {}) {
    this.ghJson = ghJson;
    this.settingsProvider = settingsProvider;
    this.now = now;
    this.cache = new Map(); // key -> { at, result }
    this.inFlight = new Map(); // key -> Promise<result>
  }

  static getInstance(options) {
    if (!TeamActivityService.instance) {
      TeamActivityService.instance = new TeamActivityService(options);
    }
    return TeamActivityService.instance;
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
    const key = JSON.stringify([since, windowDays, members.map((member) => member.githubUsername), config.repos]);

    if (!refresh) {
      const hit = this.cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;
      const pending = this.inFlight.get(key);
      if (pending) return pending;
    }

    const fetchPromise = this.buildActivity({ members, repos: config.repos, since, windowDays })
      .then((result) => {
        this.cache.set(key, { at: Date.now(), result });
        return result;
      })
      .finally(() => {
        if (this.inFlight.get(key) === fetchPromise) this.inFlight.delete(key);
      });
    this.inFlight.set(key, fetchPromise);
    return fetchPromise;
  }

  async buildActivity({ members, repos, since, windowDays }) {
    // One member's flaky/rate-limited `gh` call must not blank out everyone
    // else's report, so each member is fetched and degraded independently.
    const memberResults = await Promise.all(members.map((member) =>
      this.buildMemberActivity({ member, repos, since }).catch((error) => {
        logger.error('Team activity lookup failed for member', {
          member: member.githubUsername,
          error: error.message
        });
        return {
          name: member.name || member.githubUsername,
          githubUsername: member.githubUsername,
          incomplete: true,
          error: 'Lookup failed. Is `gh` authenticated?',
          totals: { prsOpened: 0, prsMerged: 0, commits: 0, tickets: 0 },
          days: []
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

  async buildMemberActivity({ member, repos, since }) {
    const [prs, commits] = await Promise.all([
      this.searchPullRequests({ username: member.githubUsername, since, repos }),
      this.searchCommits({ username: member.githubUsername, since, repos })
    ]);
    return this.assembleMember({ member, prs, commits, since });
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
      '-f', `per_page=${SEARCH_PAGE_LIMIT}`
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

  assembleMember({ member, prs, commits, since }) {
    const days = new Map();
    // The search window is updated:>=since, so a PR opened months ago can
    // arrive here; only events that happened inside the window get a day row.
    const inWindow = (dateKey) => dateKey && dateKey >= since;
    const dayEntry = (dateKey) => {
      if (!days.has(dateKey)) {
        days.set(dateKey, { date: dateKey, prsOpened: [], prsMerged: [], commitCount: 0, commitRepos: [], tickets: [] });
      }
      return days.get(dateKey);
    };

    prs.items.forEach((pr) => {
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

    commits.items.forEach((commit) => {
      const dateKey = this.localDateKey(commit.authoredAt);
      if (!inWindow(dateKey)) return;
      const entry = dayEntry(dateKey);
      entry.commitCount += 1;
      if (commit.repo && !entry.commitRepos.includes(commit.repo)) entry.commitRepos.push(commit.repo);
    });

    const orderedDays = [...days.values()].sort((a, b) => b.date.localeCompare(a.date));
    return {
      name: member.name || member.githubUsername,
      githubUsername: member.githubUsername,
      incomplete: prs.incomplete || commits.incomplete,
      totals: {
        prsOpened: prs.items.filter((pr) => inWindow(this.localDateKey(pr.createdAt))).length,
        prsMerged: prs.items.filter((pr) => inWindow(this.localDateKey(pr.mergedAt))).length,
        commits: commits.items.filter((commit) => inWindow(this.localDateKey(commit.authoredAt))).length,
        tickets: [...new Set(prs.items.flatMap((pr) => pr.tickets))].length
      },
      days: orderedDays
    };
  }
}

module.exports = { TeamActivityService, DEFAULT_WINDOW_DAYS, MAX_WINDOW_DAYS };
