const { TeamActivityService } = require('../../server/teamActivityService');

const NOW = new Date('2026-08-28T12:00:00');

const prPayload = (items, extra = {}) => ({ total_count: items.length, incomplete_results: false, items, ...extra });

const searchResponder = ({ prs = [], commits = [] } = {}) => (args) => {
  const query = args.find((arg) => arg.startsWith('q='));
  if (args.includes('search/issues')) return Promise.resolve(prPayload(prs, { query }));
  if (args.includes('search/commits')) return Promise.resolve(prPayload(commits, { query }));
  return Promise.reject(new Error(`unexpected gh args: ${args.join(' ')}`));
};

// Real Date.now() is used for the anti-mash gap by default, which is exactly
// right for the app but makes a fast test suite always look "too soon" —
// so tests that need the gap to have elapsed inject a monotonically
// advancing nowMs instead of sleeping.
const advancingClock = (stepMs = 25000) => {
  let value = 0;
  return () => { value += stepMs; return value; };
};

const service = (overrides = {}) => new TeamActivityService({
  now: () => new Date(NOW),
  nowMs: advancingClock(),
  settingsProvider: () => ({ team: { members: [{ name: 'Ganga', githubUsername: 'gamesganga79-dot' }] } }),
  ghJson: searchResponder(),
  ...overrides
});

describe('TeamActivityService', () => {
  test('groups PRs and commits into per-day rows for each member', async () => {
    const subject = service({
      ghJson: searchResponder({
        prs: [{
          number: 12,
          title: 'fix: reminder times survive restarts',
          html_url: 'https://github.com/web3dev1337/box2d-luau/pull/12',
          repository_url: 'https://api.github.com/repos/web3dev1337/box2d-luau',
          state: 'closed',
          created_at: '2026-08-26T09:00:00Z',
          body: 'Card: https://trello.com/c/abc123',
          pull_request: { merged_at: '2026-08-27T10:00:00Z' }
        }],
        commits: [
          { sha: 'a1', repository: { full_name: 'web3dev1337/box2d-luau' }, commit: { author: { date: '2026-08-27T08:00:00Z' }, message: 'one\nbody' } },
          { sha: 'a2', repository: { full_name: 'web3dev1337/box2d-luau' }, commit: { author: { date: '2026-08-27T09:00:00Z' }, message: 'two' } }
        ]
      })
    });

    const result = await subject.activity({ days: 7 });
    const member = result.members[0];

    expect(member.githubUsername).toBe('gamesganga79-dot');
    expect(member.totals).toEqual({ prsOpened: 1, prsMerged: 1, commits: 2, tickets: 1, medianCycleHours: 25 });
    expect(member.incomplete).toBe(false);

    const mergedDay = member.days.find((day) => day.prsMerged.length);
    expect(mergedDay.prsMerged[0].number).toBe(12);
    expect(mergedDay.prsMerged[0].state).toBe('merged');
    expect(mergedDay.commitCount).toBe(2);
    expect(mergedDay.commitRepos).toEqual(['web3dev1337/box2d-luau']);
    expect(mergedDay.tickets).toEqual(['https://trello.com/c/abc123']);

    const openedDay = member.days.find((day) => day.prsOpened.length);
    expect(openedDay.prsOpened[0].tickets).toEqual(['https://trello.com/c/abc123']);
    expect(mergedDay.date > openedDay.date).toBe(true);

    expect(member.timeline).toHaveLength(1);
    expect(member.timeline[0]).toMatchObject({
      number: 12,
      createdAt: '2026-08-26T09:00:00Z',
      mergedAt: '2026-08-27T10:00:00Z',
      cycleHours: 25
    });
  });

  test('events before the window never create day rows', async () => {
    const subject = service({
      ghJson: searchResponder({
        prs: [{
          number: 3,
          title: 'old PR still getting comments',
          html_url: 'https://github.com/o/r/pull/3',
          repository_url: 'https://api.github.com/repos/o/r',
          state: 'open',
          created_at: '2026-01-01T09:00:00Z',
          body: '',
          pull_request: {}
        }]
      })
    });

    const result = await subject.activity({ days: 7 });
    expect(result.members[0].days).toEqual([]);
    expect(result.members[0].totals.prsOpened).toBe(0);
    expect(result.members[0].timeline).toEqual([]);
  });

  test('median cycle time is the middle value, and an open PR carries no cycle time', async () => {
    const subject = service({
      ghJson: searchResponder({
        prs: [
          {
            number: 1,
            title: 'fast one',
            html_url: 'https://github.com/o/r/pull/1',
            repository_url: 'https://api.github.com/repos/o/r',
            state: 'closed',
            created_at: '2026-08-27T00:00:00Z',
            body: '',
            pull_request: { merged_at: '2026-08-27T02:00:00Z' } // 2h
          },
          {
            number: 2,
            title: 'slow one',
            html_url: 'https://github.com/o/r/pull/2',
            repository_url: 'https://api.github.com/repos/o/r',
            state: 'closed',
            created_at: '2026-08-26T00:00:00Z',
            body: '',
            pull_request: { merged_at: '2026-08-27T00:00:00Z' } // 24h
          },
          {
            number: 3,
            title: 'still open',
            html_url: 'https://github.com/o/r/pull/3',
            repository_url: 'https://api.github.com/repos/o/r',
            state: 'open',
            created_at: '2026-08-27T00:00:00Z',
            body: '',
            pull_request: {}
          }
        ]
      })
    });

    const result = await subject.activity({ days: 7 });
    const member = result.members[0];

    expect(member.totals.medianCycleHours).toBe(2);
    const openPr = member.timeline.find((pr) => pr.number === 3);
    expect(openPr.mergedAt).toBeNull();
    expect(openPr.cycleHours).toBeNull();
  });

  test('flags partial results instead of silently truncating', async () => {
    const subject = service({
      ghJson: (args) => Promise.resolve(args.includes('search/issues')
        ? { total_count: 250, incomplete_results: false, items: [] }
        : prPayload([]))
    });

    const result = await subject.activity({ days: 7 });
    expect(result.members[0].incomplete).toBe(true);
  });

  test('caches results and coalesces concurrent identical requests', async () => {
    let calls = 0;
    const subject = service({
      ghJson: (args) => {
        calls += 1;
        return searchResponder()(args);
      }
    });

    await Promise.all([subject.activity({ days: 7 }), subject.activity({ days: 7 })]);
    expect(calls).toBe(2); // one PR search + one commit search, once

    // A normal (non-forced) request after data already exists must never
    // fire another live call — the background timer owns freshness now.
    await subject.activity({ days: 7 });
    expect(calls).toBe(2);

    await subject.activity({ days: 7, refresh: true });
    expect(calls).toBe(4);
  });

  test('a forced refresh still respects the anti-mash gap', async () => {
    let calls = 0;
    const subject = service({
      nowMs: () => 1000, // frozen clock — every call looks like it happened at the same instant
      ghJson: (args) => { calls += 1; return searchResponder()(args); }
    });

    await subject.activity({ days: 7 }); // first-ever fetch, always happens
    expect(calls).toBe(2);

    await subject.activity({ days: 7, refresh: true }); // clock hasn't moved
    expect(calls).toBe(2); // throttled, not refetched
  });

  test('a second pull asks for what changed since the last one, not the full window again', async () => {
    const queries = [];
    const subject = service({
      ghJson: (args) => {
        queries.push(args.find((arg) => arg.startsWith('q=')));
        return searchResponder()(args);
      }
    });
    const sinceArg = (query) => query.match(/updated:>=(\S+)/)[1];

    await subject.activity({ days: 7 });
    expect(sinceArg(queries[0])).not.toContain('T'); // full 31-day backfill, date-only cutoff

    await subject.activity({ days: 7, refresh: true });
    const secondQuery = queries[queries.length - 2]; // PR query of the second round
    expect(sinceArg(secondQuery)).toContain('T'); // incremental, full timestamp cutoff
    expect(secondQuery).not.toBe(queries[0]);
  });

  test('clamps the window and scopes queries to configured repos', async () => {
    const queries = [];
    const subject = new TeamActivityService({
      now: () => new Date(NOW),
      nowMs: advancingClock(),
      settingsProvider: () => ({
        team: {
          members: [{ name: 'Astro', githubUsername: 'astr0x316' }],
          repos: ['web3dev1337/box2d-luau']
        }
      }),
      ghJson: (args) => {
        queries.push(args.find((arg) => arg.startsWith('q=')));
        return searchResponder()(args);
      }
    });

    const result = await subject.activity({ days: 500 });
    expect(result.windowDays).toBe(31);
    expect(queries[0]).toContain('author:astr0x316');
    expect(queries[0]).toContain('repo:web3dev1337/box2d-luau');
  });

  test('authors query overrides the configured team', async () => {
    const subject = service();
    const result = await subject.activity({ days: 7, authors: 'astr0x316, AnrokX' });
    expect(result.members.map((member) => member.githubUsername)).toEqual(['astr0x316', 'AnrokX']);
  });

  test('repo names parse from both API and web GitHub URLs', () => {
    const subject = service();
    expect(subject.repoFromUrl('https://api.github.com/repos/web3dev1337/ai-claude-standards')).toBe('web3dev1337/ai-claude-standards');
    expect(subject.repoFromUrl('https://github.com/web3dev1337/box2d-luau/pull/12')).toBe('web3dev1337/box2d-luau');
    expect(subject.repoFromUrl('')).toBe('');
  });

  test('empty team produces an empty, valid digest', async () => {
    const subject = service({ settingsProvider: () => ({}) });
    const result = await subject.activity({});
    expect(result.ok).toBe(true);
    expect(result.members).toEqual([]);
  });

  test('one member failing does not blank out the rest of the team', async () => {
    const subject = new TeamActivityService({
      now: () => new Date(NOW),
      nowMs: advancingClock(),
      settingsProvider: () => ({
        team: {
          members: [
            { name: 'Broken', githubUsername: 'broken-user' },
            { name: 'Ganga', githubUsername: 'gamesganga79-dot' }
          ]
        }
      }),
      ghJson: (args) => {
        const query = args.find((arg) => arg.startsWith('q='));
        if (query && query.includes('broken-user')) return Promise.reject(new Error('gh timed out'));
        return searchResponder()(args);
      }
    });

    const result = await subject.activity({ days: 7 });
    expect(result.ok).toBe(true);

    const broken = result.members.find((member) => member.githubUsername === 'broken-user');
    expect(broken.incomplete).toBe(true);
    expect(broken.error).toBeTruthy();
    expect(broken.days).toEqual([]);

    const ganga = result.members.find((member) => member.githubUsername === 'gamesganga79-dot');
    expect(ganga.error).toBeUndefined();
    expect(ganga.totals.commits).toBe(0);
  });

  test('a member who failed once recovers on the next background pull, not stuck forever', async () => {
    let shouldFail = true;
    const subject = new TeamActivityService({
      now: () => new Date(NOW),
      nowMs: advancingClock(),
      settingsProvider: () => ({ team: { members: [{ name: 'Flaky', githubUsername: 'flaky-user' }] } }),
      ghJson: (args) => (shouldFail ? Promise.reject(new Error('rate limited')) : searchResponder()(args))
    });

    const first = await subject.activity({ days: 7 });
    expect(first.members[0].error).toBeTruthy();

    shouldFail = false;
    const second = await subject.activity({ days: 7, refresh: true });
    expect(second.members[0].error).toBeUndefined();
  });

  test('startBackgroundRefresh pulls every configured member on its own schedule, without a real timer', () => {
    let intervalCallback = null;
    let intervalMs = null;
    const fakeTimer = { id: 'fake' };
    const subject = service({
      settingsProvider: () => ({
        team: { members: [{ name: 'Ganga', githubUsername: 'gamesganga79-dot' }, { name: 'Astro', githubUsername: 'astr0x316' }] }
      }),
      setIntervalFn: (fn, ms) => { intervalCallback = fn; intervalMs = ms; return fakeTimer; },
      clearIntervalFn: jest.fn()
    });
    const refreshSpy = jest.spyOn(subject, 'refreshMember').mockResolvedValue({});

    subject.startBackgroundRefresh();

    expect(typeof intervalCallback).toBe('function');
    expect(intervalMs).toBeGreaterThan(0);
    // Warms immediately on start, doesn't wait a full interval for the first pull.
    expect(refreshSpy).toHaveBeenCalledTimes(2);

    intervalCallback();
    expect(refreshSpy).toHaveBeenCalledTimes(4);

    subject.stopBackgroundRefresh();
    expect(subject.clearIntervalFn).toHaveBeenCalledWith(fakeTimer);

    const beforeRestart = refreshSpy.mock.calls.length;
    subject.startBackgroundRefresh();
    expect(refreshSpy.mock.calls.length).toBe(beforeRestart + 2); // warms once on restart

    // Idempotent — calling it again while already running must not start a
    // second interval or fire a second immediate warm-up.
    const afterRestart = refreshSpy.mock.calls.length;
    subject.startBackgroundRefresh();
    expect(refreshSpy.mock.calls.length).toBe(afterRestart);
  });
});
