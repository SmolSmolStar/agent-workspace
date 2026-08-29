const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const winston = require('winston');
const metrics = require('./flowMetrics');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.File({ filename: 'logs/flow-visibility.log' }),
    new winston.transports.Console({ format: winston.format.simple() })
  ]
});

const DEFAULT_WINDOW_DAYS = 90;
const MAX_WINDOW_DAYS = 365;
const STALE_BRANCH_DAYS = 90;
const AGING_PR_DAYS = 14;
const REVIEW_IDLE_DAYS = 3;
const REFRESH_INTERVAL_MS = Number(process.env.ORCHESTRATOR_FLOW_CACHE_TTL_MS || 600000);
const MIN_MANUAL_REFRESH_GAP_MS = 30000;
const FIRST_REFRESH_DELAY_MS = Number(process.env.ORCHESTRATOR_FLOW_FIRST_REFRESH_MS || 20000);
const MAX_REPOS = Number(process.env.ORCHESTRATOR_FLOW_MAX_REPOS || 40);
const REPO_CONCURRENCY = 4;
const GIT_TIMEOUT_MS = 20000;
const GH_TIMEOUT_MS = 40000;
const PR_FETCH_LIMIT = 400;

const DAY_MS = metrics.DAY_MS;

function runCommand(command, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, error: error.message, stderr: String(stderr || ''), stdout: '' });
          return;
        }
        resolve({ ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
  });
}

const defaultGit = (args, cwd) => runCommand('git', args, cwd, GIT_TIMEOUT_MS);
const defaultGh = (args, cwd) => runCommand('gh', args, cwd, GH_TIMEOUT_MS);

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

// Collects local git/gh state for flowMetrics. WIP and neglect are derived; unplanned and dependencies are logged, never inferred.
class FlowVisibilityService {
  constructor({
    workspaceProvider = () => [],
    sessionProvider = () => [],
    taskRecordProvider = () => [],
    thiefLog = null,
    git = defaultGit,
    gh = defaultGh,
    pathExists = (target) => fs.existsSync(target),
    now = () => Date.now(),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    setTimeoutFn = setTimeout
  } = {}) {
    this.workspaceProvider = workspaceProvider;
    this.sessionProvider = sessionProvider;
    this.taskRecordProvider = taskRecordProvider;
    this.thiefLog = thiefLog;
    this.git = git;
    this.gh = gh;
    this.pathExists = pathExists;
    this.now = now;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.setTimeoutFn = setTimeoutFn;

    this.cache = new Map();
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
    // Workspaces are still loading at boot, so the first build waits for them.
    const first = this.setTimeoutFn(tick, FIRST_REFRESH_DELAY_MS);
    if (first?.unref) first.unref();
  }

  stopBackgroundRefresh() {
    if (!this.backgroundTimer) return;
    this.clearIntervalFn(this.backgroundTimer);
    this.backgroundTimer = null;
  }

  normalizeWindow(days) {
    const parsed = Number.parseInt(days, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_WINDOW_DAYS;
    return Math.min(MAX_WINDOW_DAYS, Math.max(7, parsed));
  }

  resolvePrimaryDir(repoPath) {
    for (const candidate of ['master', 'main']) {
      const target = path.join(repoPath, candidate);
      if (this.pathExists(path.join(target, '.git'))) return target;
    }
    if (this.pathExists(path.join(repoPath, '.git'))) return repoPath;
    return null;
  }

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
            worktrees: new Set()
          });
        }
        if (terminal.worktree) byPath.get(repoPath).worktrees.add(terminal.worktree);
      }
    }

    const entries = Array.from(byPath.values());
    const nameCounts = new Map();
    for (const entry of entries) nameCounts.set(entry.name, (nameCounts.get(entry.name) || 0) + 1);

    return entries
      .map((entry) => ({
        name: nameCounts.get(entry.name) > 1
          ? `${path.basename(path.dirname(entry.path))}/${entry.name}`
          : entry.name,
        path: entry.path,
        worktreeCount: entry.worktrees.size
      }))
      .sort((a, b) => b.worktreeCount - a.worktreeCount)
      .slice(0, MAX_REPOS);
  }

  async resolveDefaultRef(primaryDir) {
    const head = await this.git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], primaryDir);
    if (head.ok && head.stdout.trim()) return head.stdout.trim().replace('refs/remotes/', '');
    for (const candidate of ['origin/master', 'origin/main']) {
      const check = await this.git(['rev-parse', '--verify', '--quiet', candidate], primaryDir);
      if (check.ok && check.stdout.trim()) return candidate;
    }
    return null;
  }

  async collectBranches(primaryDir, nowMs) {
    const result = await this.git(
      ['for-each-ref', '--format=%(refname:short)%09%(committerdate:unix)', 'refs/remotes/origin'],
      primaryDir
    );
    if (!result.ok) return { total: 0, stale: 0, unmerged: null, available: false };

    let total = 0;
    let stale = 0;
    for (const line of result.stdout.split('\n')) {
      const [refName, unix] = line.split('\t');
      if (!refName || !unix || /\/HEAD$/.test(refName)) continue;
      total += 1;
      if ((nowMs - Number(unix) * 1000) >= STALE_BRANCH_DAYS * DAY_MS) stale += 1;
    }

    // A merged branch nobody deleted is not unfinished work, so the board only counts unmerged ones.
    let unmerged = null;
    const defaultRef = await this.resolveDefaultRef(primaryDir);
    if (defaultRef) {
      const notMerged = await this.git(
        ['for-each-ref', '--format=%(refname:short)', `--no-merged=${defaultRef}`, 'refs/remotes/origin'],
        primaryDir
      );
      if (notMerged.ok) {
        unmerged = notMerged.stdout.split('\n')
          .filter((line) => line.trim() && !/\/HEAD$/.test(line) && line.trim() !== defaultRef).length;
      }
    }

    return { total, stale, unmerged, available: true };
  }

  async collectCommits(primaryDir, windowDays, repoName) {
    const result = await this.git(
      ['log', `--since=${windowDays}.days.ago`, '--no-merges', '--format=%ct%x09%s'],
      primaryDir
    );
    if (!result.ok) return { commits: [], available: false };

    const commits = [];
    for (const line of result.stdout.split('\n')) {
      const tab = line.indexOf('\t');
      if (tab < 1) continue;
      const timeMs = Number(line.slice(0, tab)) * 1000;
      if (!Number.isFinite(timeMs)) continue;
      commits.push({ timeMs, subject: line.slice(tab + 1), repo: repoName });
    }
    return { commits, available: true };
  }

  async collectPullRequests(primaryDir, repoName, windowDays, nowMs) {
    const since = new Date(nowMs - windowDays * DAY_MS).toISOString().slice(0, 10);
    const result = await this.gh(
      ['pr', 'list', '--state', 'all', '--limit', String(PR_FETCH_LIMIT),
        '--search', `updated:>=${since} sort:updated-desc`,
        '--json', 'number,title,url,state,isDraft,mergeable,createdAt,updatedAt,closedAt,mergedAt'],
      primaryDir
    );
    if (!result.ok) {
      return { available: false, reason: 'gh unavailable or repo not on GitHub', items: [], truncated: false };
    }

    let parsed;
    try {
      parsed = JSON.parse(result.stdout || '[]');
    } catch {
      return { available: false, reason: 'unreadable gh output', items: [], truncated: false };
    }
    if (!Array.isArray(parsed)) {
      return { available: false, reason: 'unexpected gh output', items: [], truncated: false };
    }

    const items = parsed.map((pr) => ({
      repo: repoName,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: String(pr.state || '').toLowerCase(),
      isDraft: !!pr.isDraft,
      conflicting: pr.mergeable === 'CONFLICTING',
      createdMs: Date.parse(pr.createdAt),
      updatedMs: Date.parse(pr.updatedAt),
      closedMs: pr.closedAt ? Date.parse(pr.closedAt) : NaN,
      mergedMs: pr.mergedAt ? Date.parse(pr.mergedAt) : NaN
    }));

    // A full page means older items were cut off; say so rather than draw it anyway.
    return { available: true, items, truncated: parsed.length >= PR_FETCH_LIMIT };
  }

  async inspectRepo(repo, windowDays, nowMs) {
    const primaryDir = this.resolvePrimaryDir(repo.path);
    if (!primaryDir) {
      return { ...repo, gitAvailable: false, prs: { available: false, items: [], truncated: false }, commits: [] };
    }

    const [branches, commits, prs] = await Promise.all([
      this.collectBranches(primaryDir, nowMs),
      this.collectCommits(primaryDir, windowDays, repo.name),
      this.collectPullRequests(primaryDir, repo.name, windowDays, nowMs)
    ]);

    return { ...repo, gitAvailable: true, branches, commits: commits.commits, prs };
  }

  summarizeSessions() {
    let sessions = [];
    try {
      sessions = this.sessionProvider() || [];
    } catch (error) {
      logger.warn('Flow report could not list sessions', { error: error.message });
      return { total: 0, busy: 0, available: false };
    }
    const busy = sessions.filter((session) => {
      const status = String(session?.status || '').toLowerCase();
      return status === 'busy' || status === 'working' || status === 'running';
    }).length;
    return { total: sessions.length, busy, available: true };
  }

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
      if (Number.isFinite(tier)) byTier[tier] = (byTier[tier] || 0) + 1;
      else untiered += 1;
    }
    const tiered = Object.values(byTier).reduce((sum, count) => sum + count, 0);
    return {
      total: records.length,
      byTier,
      untiered,
      topTierShare: tiered ? Math.round(((byTier[1] || 0) / tiered) * 100) : null,
      available: true
    };
  }

  // Figure 45, sources kept apart. An empty logged thief means untracked, never zero.
  buildThieves({ weeks, board, aging, sessions, tiers, openPrs, logSummary }) {
    const latestWeek = weeks[weeks.length - 1] || { openAtEnd: 0, agedAtEnd: 0, reposTouched: 0 };
    const conflictingPrs = openPrs.filter((pr) => pr.conflicting).length;

    return [
      {
        key: 'wip',
        title: 'Too much WIP',
        source: 'derived',
        tally: latestWeek.openAtEnd,
        unit: 'open items',
        headline: `${latestWeek.openAtEnd} items started and not finished`,
        metrics: [
          { label: 'Open pull requests', value: openPrs.length },
          { label: 'Live agent sessions', value: sessions.total },
          { label: 'Waiting on review', value: board.columns.find((c) => c.key === 'waiting')?.count ?? null },
          { label: 'Unmerged branches, no PR', value: board.columns.find((c) => c.key === 'branch')?.count ?? null }
        ]
      },
      {
        key: 'neglected',
        title: 'Neglected work',
        source: 'derived',
        tally: latestWeek.agedAtEnd,
        unit: 'aged items',
        headline: aging.rows.length
          ? `${latestWeek.agedAtEnd} items older than ${AGING_PR_DAYS} days, worst idle ${aging.rows[0].idleDays}d`
          : 'Nothing open has aged past the threshold',
        metrics: [
          { label: `Open past ${AGING_PR_DAYS}d`, value: latestWeek.agedAtEnd },
          { label: 'Average idle (days)', value: aging.averageIdleDays },
          { label: 'Average age (days)', value: aging.averageAgeDays }
        ]
      },
      {
        key: 'unplanned',
        title: 'Unplanned work',
        source: 'logged',
        tally: logSummary.byThief.unplanned.count,
        unit: 'logged interruptions',
        headline: logSummary.byThief.unplanned.count
          ? `${logSummary.byThief.unplanned.count} logged, ${logSummary.byThief.unplanned.minutes} minutes attributed`
          : 'Nothing logged yet, so its real volume is unknown',
        note: 'Interruptions, expedites and incidents leave no commit. This counts what you logged, not what git guessed.',
        metrics: [
          { label: 'Entries logged', value: logSummary.byThief.unplanned.count },
          { label: 'Minutes attributed', value: logSummary.byThief.unplanned.minutes },
          { label: 'Entries with a duration', value: logSummary.byThief.unplanned.timedCount }
        ]
      },
      {
        key: 'conflicting',
        title: 'Conflicting priorities',
        source: 'mixed',
        tally: latestWeek.reposTouched,
        unit: 'repos touched',
        headline: `${latestWeek.reposTouched} repos touched in the last week`,
        note: 'Repo spread is derived. Being pulled sideways off a committed item is logged.',
        metrics: [
          { label: 'Repos touched this week', value: latestWeek.reposTouched },
          { label: 'Tracked task records', value: tiers.total },
          { label: 'Top-tier share (%)', value: tiers.topTierShare },
          { label: 'Logged entries', value: logSummary.byThief.conflicting.count }
        ]
      },
      {
        key: 'dependencies',
        title: 'Unknown dependencies',
        source: 'logged',
        tally: logSummary.byThief.dependencies.count,
        unit: 'logged blockers',
        headline: logSummary.byThief.dependencies.count
          ? `${logSummary.byThief.dependencies.count} logged, ${logSummary.byThief.dependencies.minutes} minutes attributed`
          : 'Nothing logged yet, so its real volume is unknown',
        note: 'The task nobody wrote down until it blocked go-live. Merge conflicts are shown separately because they are code coupling, not this.',
        metrics: [
          { label: 'Entries logged', value: logSummary.byThief.dependencies.count },
          { label: 'Minutes attributed', value: logSummary.byThief.dependencies.minutes },
          { label: 'PRs needing a rebase', value: conflictingPrs }
        ]
      }
    ];
  }

  async build(windowDays) {
    const nowMs = this.now();
    const repos = await mapWithConcurrency(
      this.collectRepos(),
      REPO_CONCURRENCY,
      (repo) => this.inspectRepo(repo, windowDays, nowMs)
    );

    const pullRequests = repos.flatMap((repo) => repo.prs?.items || []);
    const commits = repos.flatMap((repo) => repo.commits || []);
    const openPrs = pullRequests.filter((pr) => pr.state === 'open');
    const openPrBranches = new Set(openPrs.map((pr) => `${pr.repo}#${pr.number}`));
    const remoteBranches = repos.reduce((sum, repo) => sum + (repo.branches?.total || 0), 0);
    const staleBranches = repos.reduce((sum, repo) => sum + (repo.branches?.stale || 0), 0);

    const weeks = metrics.buildWeeklyFlow({
      pullRequests, commits, nowMs, windowDays, agingDays: AGING_PR_DAYS
    });
    const unmergedKnown = repos.every((repo) => !repo.gitAvailable || Number.isFinite(repo.branches?.unmerged));
    const unmergedBranches = repos.reduce((sum, repo) => sum + (repo.branches?.unmerged || 0), 0);
    const board = metrics.buildBoard({
      pullRequests,
      // Bounded at zero: a repo can hold more open PRs than the branch scan saw.
      branchesWithoutPr: unmergedKnown ? Math.max(0, unmergedBranches - openPrBranches.size) : null,
      nowMs,
      reviewIdleDays: REVIEW_IDLE_DAYS
    });
    const aging = metrics.buildAgingReport({ pullRequests, nowMs });
    const flowTime = metrics.buildFlowTime({ pullRequests });
    const queue = metrics.buildQueueModel({ weeks });
    const throughput = metrics.buildThroughput({ weeks });
    const visibilityGrid = metrics.buildVisibilityGrid({ commits });

    const sessions = this.summarizeSessions();
    const tiers = this.summarizeTiers();

    const sinceMs = nowMs - windowDays * DAY_MS;
    const logSummary = this.thiefLog
      ? this.thiefLog.summary({ sinceMs })
      : { total: 0, byThief: { unplanned: { count: 0, minutes: 0, timedCount: 0 }, dependencies: { count: 0, minutes: 0, timedCount: 0 }, conflicting: { count: 0, minutes: 0, timedCount: 0 }, neglected: { count: 0, minutes: 0, timedCount: 0 }, wip: { count: 0, minutes: 0, timedCount: 0 } } };
    const loggedWeekly = this.thiefLog
      ? this.thiefLog.weeklyCounts({ weekStarts: weeks.map((week) => week.weekStart) })
      : null;

    const thieves = this.buildThieves({ weeks, board, aging, sessions, tiers, openPrs, logSummary });

    return {
      ok: true,
      generatedAt: new Date(nowMs).toISOString(),
      windowDays,
      thresholds: { staleBranchDays: STALE_BRANCH_DAYS, agingPrDays: AGING_PR_DAYS, reviewIdleDays: REVIEW_IDLE_DAYS },
      repoCount: repos.length,
      coverage: {
        maxRepos: MAX_REPOS,
        skippedNoGit: repos.filter((repo) => !repo.gitAvailable).map((repo) => repo.name),
        missingPrData: repos.filter((repo) => repo.gitAvailable && !repo.prs?.available).map((repo) => repo.name),
        truncatedPrHistory: repos.filter((repo) => repo.prs?.truncated).map((repo) => repo.name)
      },
      totals: {
        openPrs: openPrs.length,
        remoteBranches,
        staleBranches,
        unmergedBranches: unmergedKnown ? unmergedBranches : null,
        commits: commits.length
      },
      sessions,
      tiers,
      thieves,
      weeks,
      board,
      aging,
      flowTime,
      queue,
      throughput,
      visibilityGrid,
      log: { summary: logSummary, weekly: loggedWeekly },
      repos: repos.map((repo) => ({
        name: repo.name,
        worktreeCount: repo.worktreeCount,
        openPrs: (repo.prs?.items || []).filter((pr) => pr.state === 'open').length,
        prDataAvailable: !!repo.prs?.available,
        staleBranches: repo.branches?.stale ?? null,
        remoteBranches: repo.branches?.total ?? null,
        unmergedBranches: repo.branches?.unmerged ?? null,
        commits: (repo.commits || []).length
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
    if (refresh && !background && cached && (nowMs - this.lastManualRefreshAt) < MIN_MANUAL_REFRESH_GAP_MS) {
      return { ...cached.report, cached: true, throttled: true, ageMs: nowMs - cached.builtAt };
    }
    if (refresh && !background) this.lastManualRefreshAt = nowMs;
    if (this.inFlight.has(windowDays)) return this.inFlight.get(windowDays);

    const promise = this.build(windowDays)
      .then((report) => {
        // A report built before any workspace attached is not worth holding for
        // the full interval, so the next open recomputes instead of showing zeros.
        if (report.repoCount > 0) this.cache.set(windowDays, { report, builtAt: this.now() });
        return { ...report, cached: false, ageMs: 0 };
      })
      .finally(() => this.inFlight.delete(windowDays));

    this.inFlight.set(windowDays, promise);
    return promise;
  }

  // A new log entry must not keep serving stale tallies.
  invalidate() {
    this.cache.clear();
  }
}

module.exports = {
  FlowVisibilityService,
  DEFAULT_WINDOW_DAYS,
  STALE_BRANCH_DAYS,
  AGING_PR_DAYS,
  REVIEW_IDLE_DAYS
};
