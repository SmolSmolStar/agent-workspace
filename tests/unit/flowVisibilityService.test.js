const { FlowVisibilityService } = require('../../server/flowVisibilityService');

const NOW = Date.parse('2026-08-29T00:00:00Z');
const DAY = 86400000;

function daysAgoIso(days) {
  return new Date(NOW - days * DAY).toISOString();
}

function unixDaysAgo(days) {
  return Math.floor((NOW - days * DAY) / 1000);
}

function emptyLogSummary() {
  const byThief = {};
  for (const key of ['unplanned', 'dependencies', 'conflicting', 'neglected', 'wip']) {
    byThief[key] = { count: 0, minutes: 0, timedCount: 0 };
  }
  return { total: 0, byThief };
}

function makeService(overrides = {}) {
  return new FlowVisibilityService({
    now: () => NOW,
    // path.join uses backslashes on Windows, so match either separator.
    pathExists: (target) => /master[\\/]\.git$/.test(target),
    workspaceProvider: () => [{
      id: 'ws',
      terminals: [
        { repository: { name: 'alpha', path: '/repos/alpha' }, worktree: 'work1' },
        { repository: { name: 'alpha', path: '/repos/alpha' }, worktree: 'work2' },
        { repository: { name: 'beta', path: '/repos/beta' }, worktree: 'work1' }
      ]
    }],
    sessionProvider: () => [
      { id: 'alpha-work1-claude', status: 'busy' },
      { id: 'beta-work1-claude', status: 'idle' }
    ],
    taskRecordProvider: () => [{ id: 'a', tier: 1 }, { id: 'b', tier: 1 }, { id: 'c', tier: 3 }, { id: 'd' }],
    thiefLog: {
      summary: () => emptyLogSummary(),
      weeklyCounts: () => ({})
    },
    git: async (args) => {
      if (args[0] === 'for-each-ref') {
        return {
          ok: true,
          stdout: [
            `origin/HEAD\t${unixDaysAgo(1)}`,
            `origin/master\t${unixDaysAgo(2)}`,
            `origin/old-thing\t${unixDaysAgo(120)}`
          ].join('\n')
        };
      }
      if (args[0] === 'log') {
        return {
          ok: true,
          stdout: [
            `${unixDaysAgo(2)}\tfix(term): stop the flicker`,
            `${unixDaysAgo(3)}\tfeat(work): add the panel`,
            `${unixDaysAgo(4)}\tchore: bump deps`
          ].join('\n')
        };
      }
      return { ok: false, error: 'unexpected git call' };
    },
    gh: async () => ({
      ok: true,
      stdout: JSON.stringify([
        {
          number: 10,
          title: 'Stalled work',
          url: 'https://example.test/10',
          state: 'OPEN',
          isDraft: false,
          mergeable: 'CONFLICTING',
          createdAt: daysAgoIso(40),
          updatedAt: daysAgoIso(30),
          closedAt: null,
          mergedAt: null
        },
        {
          number: 11,
          title: 'Shipped work',
          url: 'https://example.test/11',
          state: 'MERGED',
          isDraft: false,
          mergeable: 'MERGEABLE',
          createdAt: daysAgoIso(12),
          updatedAt: daysAgoIso(10),
          closedAt: daysAgoIso(10),
          mergedAt: daysAgoIso(10)
        }
      ])
    }),
    ...overrides
  });
}

// The fixture answers identically for both repos, so per-item counts land at 2.
function thief(report, key) {
  return report.thieves.find((entry) => entry.key === key);
}

function metric(entry, label) {
  return entry.metrics.find((m) => m.label === label)?.value;
}

describe('FlowVisibilityService', () => {
  test('dedupes repositories by path and counts their distinct worktrees', async () => {
    const report = await makeService().report({ days: 90 });
    expect(report.repoCount).toBe(2);
    expect(report.repos.find((repo) => repo.name === 'alpha').worktreeCount).toBe(2);
  });

  test('two checkouts sharing a name are told apart by their parent directory', async () => {
    const service = makeService({
      workspaceProvider: () => [{
        id: 'ws',
        terminals: [
          { repository: { name: 'zoo', path: '/repos/games/zoo' }, worktree: 'work1' },
          { repository: { name: 'zoo', path: '/repos/archive/zoo' }, worktree: 'work1' }
        ]
      }]
    });
    const report = await service.report({ days: 90 });
    expect(report.repos.map((repo) => repo.name).sort()).toEqual(['archive/zoo', 'games/zoo']);
  });

  test('WIP and neglected work are measured, not logged', async () => {
    const report = await makeService().report({ days: 90 });
    expect(thief(report, 'wip').source).toBe('derived');
    expect(thief(report, 'neglected').source).toBe('derived');
    expect(metric(thief(report, 'wip'), 'Open pull requests')).toBe(2);
    expect(metric(thief(report, 'wip'), 'Live agent sessions')).toBe(2);
  });

  test('unplanned work is never inferred from commit prefixes', async () => {
    const report = await makeService().report({ days: 90 });
    const unplanned = thief(report, 'unplanned');

    // The fixture contains a `fix:` commit. It must not become an interruption.
    expect(unplanned.source).toBe('logged');
    expect(unplanned.tally).toBe(0);
    expect(unplanned.headline).toContain('unknown');
  });

  test('unknown dependencies stay empty until logged, with conflicts kept separate', async () => {
    const report = await makeService().report({ days: 90 });
    const dependencies = thief(report, 'dependencies');

    expect(dependencies.source).toBe('logged');
    expect(dependencies.tally).toBe(0);
    // The conflicting PR is reported, but as code coupling, not as this thief's tally.
    expect(metric(dependencies, 'PRs needing a rebase')).toBe(2);
  });

  test('logged entries drive the tallies for the two invisible thieves', async () => {
    const summary = emptyLogSummary();
    summary.byThief.unplanned = { count: 3, minutes: 95, timedCount: 2 };
    summary.byThief.dependencies = { count: 2, minutes: 40, timedCount: 1 };

    const service = makeService({
      thiefLog: { summary: () => ({ ...summary, total: 5 }), weeklyCounts: () => ({}) }
    });
    const report = await service.report({ days: 90 });

    expect(thief(report, 'unplanned').tally).toBe(3);
    expect(metric(thief(report, 'unplanned'), 'Minutes attributed')).toBe(95);
    expect(thief(report, 'dependencies').tally).toBe(2);
  });

  test('a merged pull request produces flow time and throughput', async () => {
    const report = await makeService().report({ days: 90 });
    expect(report.flowTime.sampleSize).toBe(2);
    expect(report.flowTime.medianHours).toBeCloseTo(48, 0);
    expect(report.throughput.perWeek.reduce((sum, week) => sum + week.merged, 0)).toBe(2);
  });

  test('the board separates waiting review from active review', async () => {
    const report = await makeService().report({ days: 90 });
    const byKey = Object.fromEntries(report.board.columns.map((column) => [column.key, column.count]));
    expect(byKey.waiting).toBe(2);
    expect(byKey.active).toBe(0);
    expect(byKey.merged).toBe(2);
  });

  test('a repo with no primary checkout is reported, not silently dropped', async () => {
    const report = await makeService({ pathExists: () => false }).report({ days: 90 });
    expect(report.coverage.skippedNoGit.sort()).toEqual(['alpha', 'beta']);
    expect(report.totals.openPrs).toBe(0);
  });

  test('names the repos gh could not answer for instead of showing them as zero', async () => {
    const service = makeService({ gh: async () => ({ ok: false, error: 'gh: not found' }) });
    const report = await service.report({ days: 90 });
    expect(report.coverage.missingPrData.sort()).toEqual(['alpha', 'beta']);
    expect(report.repos.every((repo) => repo.prDataAvailable === false)).toBe(true);
  });

  test('a full page of PR history is flagged as truncated', async () => {
    const page = new Array(400).fill(null).map((_, index) => ({
      number: index, title: 't', url: 'u', state: 'MERGED', isDraft: false, mergeable: 'MERGEABLE',
      createdAt: daysAgoIso(5), updatedAt: daysAgoIso(4), closedAt: daysAgoIso(4), mergedAt: daysAgoIso(4)
    }));
    const service = makeService({ gh: async () => ({ ok: true, stdout: JSON.stringify(page) }) });
    const report = await service.report({ days: 90 });
    expect(report.coverage.truncatedPrHistory.sort()).toEqual(['alpha', 'beta']);
  });

  test('a second read inside the cache window reuses the first report', async () => {
    const gh = jest.fn(async () => ({ ok: true, stdout: '[]' }));
    const service = makeService({ gh });
    await service.report({ days: 90 });
    const calls = gh.mock.calls.length;
    expect((await service.report({ days: 90 })).cached).toBe(true);
    expect(gh.mock.calls.length).toBe(calls);
  });

  test('logging a thief invalidates the cached report', async () => {
    const gh = jest.fn(async () => ({ ok: true, stdout: '[]' }));
    const service = makeService({ gh });
    await service.report({ days: 90 });
    const calls = gh.mock.calls.length;
    service.invalidate();
    await service.report({ days: 90 });
    expect(gh.mock.calls.length).toBeGreaterThan(calls);
  });

  test('the window is clamped instead of passed through to git', async () => {
    const service = makeService();
    expect(service.normalizeWindow('9999')).toBe(365);
    expect(service.normalizeWindow('1')).toBe(7);
    expect(service.normalizeWindow('nonsense')).toBe(90);
  });
});
