const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const winston = require('winston');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/flow-visibility.log' }),
    new winston.transports.Console({ format: winston.format.simple() })
  ]
});

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 180;
const STALE_BRANCH_DAYS = 90;
const AGING_PR_DAYS = 14;
const REFRESH_INTERVAL_MS = Number(process.env.ORCHESTRATOR_FLOW_CACHE_TTL_MS || 600000);
const MIN_MANUAL_REFRESH_GAP_MS = 30000;
const MAX_REPOS = Number(process.env.ORCHESTRATOR_FLOW_MAX_REPOS || 40);
const REPO_CONCURRENCY = 4;
const GIT_TIMEOUT_MS = 15000;
const GH_TIMEOUT_MS = 20000;
const PR_PAGE_LIMIT = 100;

const DAY_MS = 86400000;

// A commit subject counts as unplanned when its conventional-commit type is
// reactive rather than additive. `revert` is the strongest signal of all: the
// work it undoes was already paid for once.
const UNPLANNED_TYPES = new Set(['fix', 'hotfix', 'revert', 'bug']);
const PLANNED_TYPES = new Set(['feat', 'feature']);

const THIEF_KEYS = ['wip', 'neglected', 'unplanned', 'conflicting', 'dependencies'];

function runCommand(command, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, error: error.message, stderr: String(stderr || ''), stdout: '' });
          return;
        }
        resolve({ ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
  });
}

function defaultGit(args, cwd) {
  return runCommand('git', args, cwd, GIT_TIMEOUT_MS);
}

function defaultGh(args, cwd) {
  return runCommand('gh', args, cwd, GH_TIMEOUT_MS);
}

function daysBetween(fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  return Math.max(0, Math.round((toMs - fromMs) / DAY_MS));
}

function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function commitType(subject) {
  const match = /^([a-z]+)(\([^)]*\))?!?:/i.exec(String(subject || '').trim());
  if (!match) return null;
  return match[1].toLowerCase();
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

// The five thieves of time (DeGrandis, "Making Work Visible") measured against
// what this machine actually has: worktrees, sessions, branches, PRs, commits
// and task records. Every number is derived locally at request time — nothing
// about a repo, a branch or a session is ever persisted or shipped anywhere.
class FlowVisibilityService {
  constructor({
    workspaceProvider = () => [],
    sessionProvider = () => [],
    taskRecordProvider = () => [],
    git = defaultGit,
    gh = defaultGh,
    pathExists = (target) => fs.existsSync(target),
    now = () => Date.now(),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval
  } = {}) {
    this.workspaceProvider = workspaceProvider;
    this.sessionProvider = sessionProvider;
    this.taskRecordProvider = taskRecordProvider;
    this.git = git;
    this.gh = gh;
    this.pathExists = pathExists;
    this.now = now;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;

    this.cache = new Map(); // windowDays -> { report, builtAt }
    this.inFlight = new Map();
    this.lastManualRefreshAt = 0;
    this.backgroundTimer = null;
  }

  static getInstance(options) {
    if (!FlowVisibilityService.instance) {
      FlowVisibilityService.instance = new FlowVisibilityService(options);
    }
    return FlowVisibilityService.instance;
  }

  startBackgroundRefresh(windowDays = DEFAULT_WINDOW_DAYS) {
    if (this.backgroundTimer) return;
    const tick = () => {
      this.report({ days: windowDays, refresh: true, background: true })
        .catch((error) => logger.warn('Flow background refresh failed', { error: error.message }));
    };
    this.backgroundTimer = this.setIntervalFn(tick, REFRESH_INTERVAL_MS);
    if (this.backgroundTimer?.unref) this.backgroundTimer.unref();
    tick();
  }

  stopBackgroundRefresh() {
    if (!this.backgroundTimer) return;
    this.clearIntervalFn(this.backgroundTimer);
    this.backgroundTimer = null;
  }

  normalizeWindow(days) {
    const parsed = Number.parseInt(days, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_WINDOW_DAYS;
    return Math.min(MAX_WINDOW_DAYS, Math.max(1, parsed));
  }

  // A repo directory in this layout holds worktree siblings (master/, work1/,
  // …), so the git commands have to run inside the primary checkout.
  resolvePrimaryDir(repoPath) {
    for (const candidate of ['master', 'main']) {
      const target = path.join(repoPath, candidate);
      if (this.pathExists(path.join(target, '.git'))) return target;
    }
    if (this.pathExists(path.join(repoPath, '.git'))) return repoPath;
    return null;
  }

  // Every repo the orchestrator currently has a terminal for, deduped by path.
  // Worktree counts come from the same pass because a repo carrying many
  // simultaneous worktrees is itself a WIP signal.
  collectRepos() {
    const byPath = new Map();
    let workspaces = [];
    try {
      workspaces = this.workspaceProvider() || [];
    } catch (error) {
      logger.warn('Flow report could not list workspaces', { error: error.message });
      return [];
    }

    for (const workspace of workspaces) {
      for (const terminal of workspace?.terminals || []) {
        const repoPath = terminal?.repository?.path;
        if (!repoPath) continue;
        if (!byPath.has(repoPath)) {
          byPath.set(repoPath, {
            name: terminal.repository.name || path.basename(repoPath),
            path: repoPath,
            worktrees: new Set(),
            workspaces: new Set()
          });
        }
        const entry = byPath.get(repoPath);
        if (terminal.worktree) entry.worktrees.add(terminal.worktree);
        if (workspace?.id) entry.workspaces.add(workspace.id);
      }
    }

    const entries = Array.from(byPath.values());

    // Two checkouts can legitimately carry the same repo name. Showing both as
    // bare "zoo-game" reads as a double-count, so a repeated name gets its
    // parent directory prepended.
    const nameCounts = new Map();
    for (const entry of entries) {
      nameCounts.set(entry.name, (nameCounts.get(entry.name) || 0) + 1);
    }

    return entries
      .map((entry) => ({
        name: nameCounts.get(entry.name) > 1
          ? `${path.basename(path.dirname(entry.path))}/${entry.name}`
          : entry.name,
        path: entry.path,
        worktreeCount: entry.worktrees.size,
        workspaceCount: entry.workspaces.size
      }))
      .sort((a, b) => b.worktreeCount - a.worktreeCount)
      .slice(0, MAX_REPOS);
  }

  async collectBranchAging(primaryDir, nowMs) {
    const result = await this.git(
      ['for-each-ref', '--format=%(refname:short)%09%(committerdate:unix)', 'refs/remotes/origin'],
      primaryDir
    );
    if (!result.ok) return { total: 0, stale: 0, oldestDays: null, available: false };

    let total = 0;
    let stale = 0;
    let oldestDays = null;
    for (const line of result.stdout.split('\n')) {
      const [refName, unix] = line.split('\t');
      if (!refName || !unix) continue;
      if (/\/HEAD$/.test(refName)) continue;
      const ageDays = daysBetween(Number(unix) * 1000, nowMs);
      if (ageDays === null) continue;
      total += 1;
      if (ageDays >= STALE_BRANCH_DAYS) stale += 1;
      if (oldestDays === null || ageDays > oldestDays) oldestDays = ageDays;
    }
    return { total, stale, oldestDays, available: true };
  }

  async collectCommitMix(primaryDir, windowDays) {
    const result = await this.git(
      ['log', `--since=${windowDays}.days.ago`, '--no-merges', '--format=%s'],
      primaryDir
    );
    if (!result.ok) return { planned: 0, unplanned: 0, other: 0, available: false };

    let planned = 0;
    let unplanned = 0;
    let other = 0;
    for (const line of result.stdout.split('\n')) {
      if (!line.trim()) continue;
      const type = commitType(line);
      if (type && UNPLANNED_TYPES.has(type)) unplanned += 1;
      else if (type && PLANNED_TYPES.has(type)) planned += 1;
      else other += 1;
    }
    return { planned, unplanned, other, available: true };
  }

  async collectOpenPullRequests(primaryDir, nowMs) {
    const result = await this.gh(
      ['pr', 'list', '--state', 'open', '--limit', String(PR_PAGE_LIMIT), '--json',
        'number,title,url,createdAt,updatedAt,mergeable,isDraft'],
      primaryDir
    );
    if (!result.ok) {
      return { available: false, reason: 'gh unavailable or repo not on GitHub', items: [] };
    }

    let parsed;
    try {
      parsed = JSON.parse(result.stdout || '[]');
    } catch (error) {
      return { available: false, reason: 'unreadable gh output', items: [] };
    }
    if (!Array.isArray(parsed)) return { available: false, reason: 'unexpected gh output', items: [] };

    const items = parsed.map((pr) => {
      const createdMs = Date.parse(pr.createdAt);
      const updatedMs = Date.parse(pr.updatedAt);
      return {
        number: pr.number,
        title: pr.title,
        url: pr.url,
        isDraft: !!pr.isDraft,
        conflicting: pr.mergeable === 'CONFLICTING',
        ageDays: daysBetween(createdMs, nowMs),
        idleDays: daysBetween(updatedMs, nowMs)
      };
    });
    return { available: true, items };
  }

  async inspectRepo(repo, windowDays, nowMs) {
    const primaryDir = this.resolvePrimaryDir(repo.path);
    if (!primaryDir) {
      return { ...repo, gitAvailable: false, prs: { available: false, items: [] } };
    }

    const [branches, commits, prs] = await Promise.all([
      this.collectBranchAging(primaryDir, nowMs),
      this.collectCommitMix(primaryDir, windowDays),
      this.collectOpenPullRequests(primaryDir, nowMs)
    ]);

    return { ...repo, gitAvailable: true, branches, commits, prs };
  }

  // Sessions the orchestrator believes are alive. This is WIP measured at the
  // only place it is genuinely started-but-unfinished: a running agent.
  summarizeSessions() {
    let sessions = [];
    try {
      sessions = this.sessionProvider() || [];
    } catch (error) {
      logger.warn('Flow report could not list sessions', { error: error.message });
      return { total: 0, busy: 0, available: false };
    }

    let busy = 0;
    for (const session of sessions) {
      const status = String(session?.status || '').toLowerCase();
      if (status === 'busy' || status === 'working' || status === 'running') busy += 1;
    }
    return { total: sessions.length, busy, available: true };
  }

  // Tiers exist so that not everything can be first. When almost every record
  // carries the top tier, the ranking has stopped ranking.
  summarizeTiers() {
    let records = [];
    try {
      records = this.taskRecordProvider() || [];
    } catch (error) {
      logger.warn('Flow report could not list task records', { error: error.message });
      return { total: 0, byTier: {}, untiered: 0, topTierShare: null, available: false };
    }

    const byTier = {};
    let untiered = 0;
    for (const record of records) {
      const tier = Number.parseInt(record?.tier, 10);
      if (!Number.isFinite(tier)) {
        untiered += 1;
        continue;
      }
      byTier[tier] = (byTier[tier] || 0) + 1;
    }
    const tiered = Object.values(byTier).reduce((sum, n) => sum + n, 0);
    const topTierShare = tiered ? Math.round(((byTier[1] || 0) / tiered) * 100) : null;
    return { total: records.length, byTier, untiered, topTierShare, available: true };
  }

  buildThieves({ repos, sessions, tiers }) {
    const openPrs = repos.flatMap((repo) =>
      (repo.prs?.items || []).map((pr) => ({ ...pr, repo: repo.name })));
    const prAvailableRepos = repos.filter((repo) => repo.prs?.available);
    const loadedRepos = repos.filter((repo) => repo.worktreeCount > 0);

    const aging = openPrs
      .filter((pr) => Number.isFinite(pr.idleDays) && pr.idleDays >= AGING_PR_DAYS)
      .sort((a, b) => b.idleDays - a.idleDays);

    const staleBranches = repos.reduce((sum, repo) => sum + (repo.branches?.stale || 0), 0);
    const totalBranches = repos.reduce((sum, repo) => sum + (repo.branches?.total || 0), 0);

    const planned = repos.reduce((sum, repo) => sum + (repo.commits?.planned || 0), 0);
    const unplanned = repos.reduce((sum, repo) => sum + (repo.commits?.unplanned || 0), 0);
    const unplannedShare = (planned + unplanned)
      ? Math.round((unplanned / (planned + unplanned)) * 100)
      : null;

    const conflicting = openPrs.filter((pr) => pr.conflicting);

    return [
      {
        key: 'wip',
        title: 'Too much WIP',
        headline: `${openPrs.length} open PRs across ${prAvailableRepos.length} repos`,
        metrics: [
          { label: 'Open PRs', value: openPrs.length },
          { label: 'Live sessions', value: sessions.total },
          { label: 'Repos loaded at once', value: loadedRepos.length },
          { label: 'Worktrees open', value: repos.reduce((sum, r) => sum + r.worktreeCount, 0) }
        ],
        evidence: loadedRepos
          .slice(0, 10)
          .map((repo) => {
            // "0 open PRs" and "we could not ask" are different claims.
            const prPart = repo.prs?.available
              ? `${repo.prs.items.length} open PR(s)`
              : (repo.gitAvailable ? 'PR count unknown' : 'no git checkout found');
            return {
              label: repo.name,
              detail: `${repo.worktreeCount} worktree(s), ${prPart}`
            };
          })
      },
      {
        key: 'neglected',
        title: 'Neglected work',
        headline: aging.length
          ? `${aging.length} PRs untouched for ${AGING_PR_DAYS}+ days, oldest idle ${aging[0].idleDays}d`
          : 'No open PR has been idle past the aging threshold',
        metrics: [
          { label: `PRs idle ${AGING_PR_DAYS}d+`, value: aging.length },
          { label: 'Median PR age (days)', value: median(openPrs.map((pr) => pr.ageDays)) },
          { label: `Branches stale ${STALE_BRANCH_DAYS}d+`, value: staleBranches },
          { label: 'Remote branches', value: totalBranches }
        ],
        evidence: aging.slice(0, 10).map((pr) => ({
          label: `${pr.repo} #${pr.number}`,
          detail: `idle ${pr.idleDays}d, open ${pr.ageDays}d — ${pr.title}`,
          url: pr.url
        }))
      },
      {
        key: 'unplanned',
        title: 'Unplanned work',
        headline: unplannedShare === null
          ? 'No conventional-commit history in the window'
          : `${unplannedShare}% of typed commits were reactive`,
        metrics: [
          { label: 'Reactive commits', value: unplanned },
          { label: 'Feature commits', value: planned },
          { label: 'Reactive share (%)', value: unplannedShare }
        ],
        evidence: repos
          .filter((repo) => (repo.commits?.unplanned || 0) > 0)
          .sort((a, b) => b.commits.unplanned - a.commits.unplanned)
          .slice(0, 10)
          .map((repo) => ({
            label: repo.name,
            detail: `${repo.commits.unplanned} reactive vs ${repo.commits.planned} feature`
          }))
      },
      {
        key: 'conflicting',
        title: 'Conflicting priorities',
        headline: tiers.topTierShare === null
          ? `${loadedRepos.length} repos carry open worktrees at the same time`
          : `${tiers.topTierShare}% of tiered work claims the top tier`,
        metrics: [
          { label: 'Repos in flight', value: loadedRepos.length },
          { label: 'Tracked task records', value: tiers.total },
          { label: 'Untiered records', value: tiers.untiered },
          { label: 'Top-tier share (%)', value: tiers.topTierShare }
        ],
        evidence: Object.entries(tiers.byTier)
          .sort((a, b) => Number(a[0]) - Number(b[0]))
          .map(([tier, count]) => ({ label: `Tier ${tier}`, detail: `${count} record(s)` }))
      },
      {
        key: 'dependencies',
        title: 'Unknown dependencies',
        headline: conflicting.length
          ? `${conflicting.length} open PRs cannot merge without a rebase`
          : 'No open PR is currently blocked on a conflict',
        metrics: [
          { label: 'Conflicting PRs', value: conflicting.length },
          { label: 'Draft PRs', value: openPrs.filter((pr) => pr.isDraft).length },
          { label: 'Repos without PR data', value: repos.length - prAvailableRepos.length }
        ],
        evidence: conflicting.slice(0, 10).map((pr) => ({
          label: `${pr.repo} #${pr.number}`,
          detail: `conflicting, open ${pr.ageDays}d — ${pr.title}`,
          url: pr.url
        }))
      }
    ];
  }

  async build(windowDays) {
    const nowMs = this.now();
    const repoList = this.collectRepos();
    const repos = await mapWithConcurrency(
      repoList,
      REPO_CONCURRENCY,
      (repo) => this.inspectRepo(repo, windowDays, nowMs)
    );

    const sessions = this.summarizeSessions();
    const tiers = this.summarizeTiers();
    const thieves = this.buildThieves({ repos, sessions, tiers });

    const skipped = repos.filter((repo) => !repo.gitAvailable).map((repo) => repo.name);
    const withoutPrData = repos.filter((repo) => repo.gitAvailable && !repo.prs?.available)
      .map((repo) => repo.name);

    return {
      ok: true,
      generatedAt: new Date(nowMs).toISOString(),
      windowDays,
      thresholds: { staleBranchDays: STALE_BRANCH_DAYS, agingPrDays: AGING_PR_DAYS },
      repoCount: repos.length,
      coverage: {
        maxRepos: MAX_REPOS,
        skippedNoGit: skipped,
        missingPrData: withoutPrData
      },
      sessions,
      tiers,
      thieves,
      repos: repos.map((repo) => ({
        name: repo.name,
        worktreeCount: repo.worktreeCount,
        workspaceCount: repo.workspaceCount,
        openPrs: (repo.prs?.items || []).length,
        prDataAvailable: !!repo.prs?.available,
        staleBranches: repo.branches?.stale ?? null,
        remoteBranches: repo.branches?.total ?? null,
        reactiveCommits: repo.commits?.unplanned ?? null,
        featureCommits: repo.commits?.planned ?? null
      }))
    };
  }

  async report({ days, refresh = false, background = false } = {}) {
    const windowDays = this.normalizeWindow(days);
    const cached = this.cache.get(windowDays);
    const nowMs = this.now();

    if (!refresh && cached && (nowMs - cached.builtAt) < REFRESH_INTERVAL_MS) {
      return { ...cached.report, cached: true, ageMs: nowMs - cached.builtAt };
    }

    // Mashing Refresh must not turn into a burst of `gh` calls; serve the last
    // good report until the floor has passed.
    if (refresh && !background && cached && (nowMs - this.lastManualRefreshAt) < MIN_MANUAL_REFRESH_GAP_MS) {
      return { ...cached.report, cached: true, throttled: true, ageMs: nowMs - cached.builtAt };
    }
    if (refresh && !background) this.lastManualRefreshAt = nowMs;

    if (this.inFlight.has(windowDays)) return this.inFlight.get(windowDays);

    const promise = this.build(windowDays)
      .then((report) => {
        this.cache.set(windowDays, { report, builtAt: this.now() });
        return { ...report, cached: false, ageMs: 0 };
      })
      .finally(() => {
        this.inFlight.delete(windowDays);
      });

    this.inFlight.set(windowDays, promise);
    return promise;
  }
}

module.exports = {
  FlowVisibilityService,
  THIEF_KEYS,
  DEFAULT_WINDOW_DAYS,
  STALE_BRANCH_DAYS,
  AGING_PR_DAYS
};
