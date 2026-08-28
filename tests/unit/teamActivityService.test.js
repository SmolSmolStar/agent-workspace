const { TeamActivityService } = require('../../server/teamActivityService');

const NOW = new Date('2026-08-28T12:00:00');

const prPayload = (items, extra = {}) => ({ total_count: items.length, incomplete_results: false, items, ...extra });

const searchResponder = ({ prs = [], commits = [] } = {}) => (args) => {
  const query = args.find((arg) => arg.startsWith('q='));
  if (args.includes('search/issues')) return Promise.resolve(prPayload(prs, { query }));
  if (args.includes('search/commits')) return Promise.resolve(prPayload(commits, { query }));
  return Promise.reject(new Error(`unexpected gh args: ${args.join(' ')}`));
};

const service = (overrides = {}) => new TeamActivityService({
  now: () => new Date(NOW),
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
    expect(member.totals).toEqual({ prsOpened: 1, prsMerged: 1, commits: 2, tickets: 1 });

    const mergedDay = member.days.find((day) => day.prsMerged.length);
    expect(mergedDay.prsMerged[0].number).toBe(12);
    expect(mergedDay.prsMerged[0].state).toBe('merged');
    expect(mergedDay.commitCount).toBe(2);
    expect(mergedDay.commitRepos).toEqual(['web3dev1337/box2d-luau']);
    expect(mergedDay.tickets).toEqual(['https://trello.com/c/abc123']);

    const openedDay = member.days.find((day) => day.prsOpened.length);
    expect(openedDay.prsOpened[0].tickets).toEqual(['https://trello.com/c/abc123']);
    expect(mergedDay.date > openedDay.date).toBe(true);
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
    await subject.activity({ days: 7 });
    expect(calls).toBe(2); // one PR search + one commit search, once

    await subject.activity({ days: 7, refresh: true });
    expect(calls).toBe(4);
  });

  test('clamps the window and scopes queries to configured repos', async () => {
    const queries = [];
    const subject = new TeamActivityService({
      now: () => new Date(NOW),
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
});
