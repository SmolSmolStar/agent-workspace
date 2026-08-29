const { FlowVisibilityService } = require('../../server/flowVisibilityService');

const NOW = Date.parse('2026-08-29T00:00:00Z');
const DAY = 86400000;

function daysAgoIso(days) {
  return new Date(NOW - days * DAY).toISOString();
}

function unixDaysAgo(days) {
  return Math.floor((NOW - days * DAY) / 1000);
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
    // Session records carry no repository field, which is why WIP-by-repo is
    // read from worktrees instead.
    sessionProvider: () => [
      { id: 'alpha-work1-claude', status: 'busy' },
      { id: 'beta-work1-claude', status: 'idle' }
    ],
    taskRecordProvider: () => [
      { id: 'a', tier: 1 },
      { id: 'b', tier: 1 },
      { id: 'c', tier: 3 },
      { id: 'd' }
    ],
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
            'fix(term): stop the flicker',
            'revert: back out the cache',
            'feat(work): add the panel',
            'chore: bump deps'
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
          createdAt: daysAgoIso(40),
          updatedAt: daysAgoIso(30),
          mergeable: 'CONFLICTING',
          isDraft: false
        },
        {
          number: 11,
          title: 'Fresh work',
          url: 'https://example.test/11',
          createdAt: daysAgoIso(2),
          updatedAt: daysAgoIso(1),
          mergeable: 'MERGEABLE',
          isDraft: true
        }
      ])
    }),
    ...overrides
  });
}

function thief(report, key) {
  return report.thieves.find((entry) => entry.key === key);
}

function metric(entry, label) {
  return entry.metrics.find((m) => m.label === label)?.value;
}

describe('FlowVisibilityService', () => {
  test('dedupes repositories by path and counts their distinct worktrees', async () => {
    const report = await makeService().report({ days: 30 });

    expect(report.repoCount).toBe(2);
    const alpha = report.repos.find((repo) => repo.name === 'alpha');
    expect(alpha.worktreeCount).toBe(2);
  });

  test('counts open PRs and live sessions as work in progress', async () => {
    const report = await makeService().report({ days: 30 });
    const wip = thief(report, 'wip');

    expect(metric(wip, 'Open PRs')).toBe(4);
    expect(metric(wip, 'Live sessions')).toBe(2);
    expect(metric(wip, 'Worktrees open')).toBe(3);
    expect(report.sessions).toEqual({ total: 2, busy: 1, available: true });
  });

  test('flags idle PRs and branches past the aging thresholds', async () => {
    const report = await makeService().report({ days: 30 });
    const neglected = thief(report, 'neglected');

    expect(metric(neglected, 'PRs idle 14d+')).toBe(2);
    expect(metric(neglected, 'Branches stale 90d+')).toBe(2);
    // origin/HEAD is a symbolic pointer, not a branch someone left behind.
    expect(metric(neglected, 'Remote branches')).toBe(4);
    expect(neglected.evidence[0].url).toBe('https://example.test/10');
  });

  test('reads reactive versus feature share from conventional commit types', async () => {
    const report = await makeService().report({ days: 30 });
    const unplanned = thief(report, 'unplanned');

    // fix + revert are reactive, feat is planned, chore is neither.
    expect(metric(unplanned, 'Reactive commits')).toBe(4);
    expect(metric(unplanned, 'Feature commits')).toBe(2);
    expect(metric(unplanned, 'Reactive share (%)')).toBe(67);
  });

  test('reports the top-tier share so a flat ranking is visible', async () => {
    const report = await makeService().report({ days: 30 });
    const conflicting = thief(report, 'conflicting');

    expect(metric(conflicting, 'Top-tier share (%)')).toBe(67);
    expect(metric(conflicting, 'Untiered records')).toBe(1);
  });

  test('counts PRs that cannot merge as a dependency signal', async () => {
    const report = await makeService().report({ days: 30 });
    const dependencies = thief(report, 'dependencies');

    expect(metric(dependencies, 'Conflicting PRs')).toBe(2);
    expect(metric(dependencies, 'Draft PRs')).toBe(2);
  });

  test('a repo with no primary checkout is reported, not silently dropped', async () => {
    const service = makeService({ pathExists: () => false });
    const report = await service.report({ days: 30 });

    expect(report.coverage.skippedNoGit.sort()).toEqual(['alpha', 'beta']);
    expect(metric(thief(report, 'wip'), 'Open PRs')).toBe(0);
    // A missing checkout must not read as a confirmed zero.
    expect(thief(report, 'wip').evidence[0].detail).toContain('no git checkout found');
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
    const report = await service.report({ days: 30 });

    expect(report.repos.map((repo) => repo.name).sort()).toEqual(['archive/zoo', 'games/zoo']);
  });

  test('names the repos gh could not answer for instead of showing them as zero', async () => {
    const service = makeService({ gh: async () => ({ ok: false, error: 'gh: not found' }) });
    const report = await service.report({ days: 30 });

    expect(report.coverage.missingPrData.sort()).toEqual(['alpha', 'beta']);
    expect(report.repos.every((repo) => repo.prDataAvailable === false)).toBe(true);
  });

  test('a second read inside the cache window reuses the first report', async () => {
    const gh = jest.fn(async () => ({ ok: true, stdout: '[]' }));
    const service = makeService({ gh });

    await service.report({ days: 30 });
    const callsAfterFirst = gh.mock.calls.length;
    const second = await service.report({ days: 30 });

    expect(second.cached).toBe(true);
    expect(gh.mock.calls.length).toBe(callsAfterFirst);
  });

  test('a manual refresh inside the throttle floor serves the cached report', async () => {
    const gh = jest.fn(async () => ({ ok: true, stdout: '[]' }));
    const service = makeService({ gh });

    await service.report({ days: 30, refresh: true });
    const callsAfterFirst = gh.mock.calls.length;
    const second = await service.report({ days: 30, refresh: true });

    expect(second.throttled).toBe(true);
    expect(gh.mock.calls.length).toBe(callsAfterFirst);
  });

  test('the window is clamped instead of passed through to git', async () => {
    const service = makeService();
    expect(service.normalizeWindow('9999')).toBe(180);
    expect(service.normalizeWindow('0')).toBe(1);
    expect(service.normalizeWindow('nonsense')).toBe(30);
  });
});
