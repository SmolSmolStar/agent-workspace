const metrics = require('../../server/flowMetrics');

const NOW = Date.parse('2026-08-29T00:00:00Z');
const DAY = 86400000;

function pr(overrides = {}) {
  return {
    repo: 'alpha',
    number: 1,
    title: 'A change',
    url: 'https://example.test/1',
    state: 'open',
    isDraft: false,
    conflicting: false,
    createdMs: NOW - 10 * DAY,
    updatedMs: NOW - 1 * DAY,
    closedMs: NaN,
    mergedMs: NaN,
    ...overrides
  };
}

describe('buildWeeklyFlow', () => {
  test('counts an item as open in every week between proposal and merge', () => {
    const weeks = metrics.buildWeeklyFlow({
      pullRequests: [pr({ createdMs: NOW - 21 * DAY, mergedMs: NOW - 2 * DAY, state: 'merged' })],
      nowMs: NOW,
      windowDays: 28,
      agingDays: 14
    });

    const openWeeks = weeks.filter((week) => week.openAtEnd > 0);
    expect(openWeeks.length).toBeGreaterThanOrEqual(2);
    expect(weeks.reduce((sum, week) => sum + week.merged, 0)).toBe(1);
    expect(weeks.reduce((sum, week) => sum + week.opened, 0)).toBe(1);
  });

  test('a closed-unmerged item is abandoned, never merged', () => {
    const weeks = metrics.buildWeeklyFlow({
      pullRequests: [pr({ createdMs: NOW - 20 * DAY, closedMs: NOW - 3 * DAY, state: 'closed' })],
      nowMs: NOW,
      windowDays: 28,
      agingDays: 14
    });

    expect(weeks.reduce((sum, week) => sum + week.abandoned, 0)).toBe(1);
    expect(weeks.reduce((sum, week) => sum + week.merged, 0)).toBe(0);
  });

  test('aged count only picks up items already past the threshold that week', () => {
    const weeks = metrics.buildWeeklyFlow({
      pullRequests: [pr({ createdMs: NOW - 40 * DAY })],
      nowMs: NOW,
      windowDays: 42,
      agingDays: 14
    });

    expect(weeks[0].agedAtEnd).toBe(0);
    expect(weeks[weeks.length - 1].agedAtEnd).toBe(1);
  });

  test('repos touched counts distinct repos per week, not commits', () => {
    const weeks = metrics.buildWeeklyFlow({
      pullRequests: [],
      commits: [
        { timeMs: NOW - 1 * DAY, subject: 'feat: a', repo: 'alpha' },
        { timeMs: NOW - 1 * DAY, subject: 'feat: b', repo: 'alpha' },
        { timeMs: NOW - 1 * DAY, subject: 'feat: c', repo: 'beta' }
      ],
      nowMs: NOW,
      windowDays: 14,
      agingDays: 14
    });

    expect(weeks[weeks.length - 1].reposTouched).toBe(2);
  });
});

describe('buildBoard', () => {
  test('splits open items by draft and review idleness', () => {
    const board = metrics.buildBoard({
      pullRequests: [
        pr({ number: 1, isDraft: true }),
        pr({ number: 2, updatedMs: NOW - 10 * DAY }),
        pr({ number: 3, updatedMs: NOW - 1 * DAY }),
        pr({ number: 4, state: 'merged', mergedMs: NOW - 2 * DAY })
      ],
      branchesWithoutPr: 5,
      nowMs: NOW,
      reviewIdleDays: 3
    });

    const byKey = Object.fromEntries(board.columns.map((column) => [column.key, column.count]));
    expect(byKey).toEqual({ branch: 5, draft: 1, active: 1, waiting: 1, merged: 1 });
  });

  test('a stage is only the pit when it outweighs the others combined', () => {
    const balanced = metrics.buildBoard({
      pullRequests: [pr({ number: 1 }), pr({ number: 2, isDraft: true })],
      branchesWithoutPr: 1,
      nowMs: NOW
    });
    expect(balanced.pit).toBeNull();

    const lopsided = metrics.buildBoard({
      pullRequests: [pr({ number: 1 })],
      branchesWithoutPr: 40,
      nowMs: NOW
    });
    expect(lopsided.pit).toBe('branch');
  });
});

describe('buildAgingReport', () => {
  test('marks only the rows idle longer than the average', () => {
    const aging = metrics.buildAgingReport({
      pullRequests: [
        pr({ number: 1, updatedMs: NOW - 100 * DAY }),
        pr({ number: 2, updatedMs: NOW - 1 * DAY }),
        pr({ number: 3, updatedMs: NOW - 1 * DAY })
      ],
      nowMs: NOW
    });

    expect(aging.averageIdleDays).toBe(34);
    expect(aging.rows[0].idleDays).toBe(100);
    expect(aging.rows.filter((row) => row.overAverage)).toHaveLength(1);
  });
});

describe('buildQueueModel', () => {
  test('rho below one yields a finite queue length', () => {
    const model = metrics.buildQueueModel({ weeks: [{ opened: 8, merged: 10 }] });
    expect(model.rho).toBe(0.8);
    expect(model.queueLength).toBeGreaterThan(0);
  });

  test('arrivals outrunning departures leave the queue length undefined, not huge', () => {
    const model = metrics.buildQueueModel({ weeks: [{ opened: 20, merged: 10 }] });
    expect(model.rho).toBe(2);
    expect(model.queueLength).toBeNull();
  });

  test('no merges at all is unknown rather than infinite', () => {
    expect(metrics.buildQueueModel({ weeks: [{ opened: 5, merged: 0 }] }).rho).toBeNull();
  });
});

describe('buildThroughput', () => {
  test('net flow carries the backlog forward across weeks', () => {
    const weeks = [
      { weekStart: '2026-08-03', opened: 10, merged: 4, abandoned: 0 },
      { weekStart: '2026-08-10', opened: 8, merged: 6, abandoned: 1 },
      { weekStart: '2026-08-17', opened: 2, merged: 9, abandoned: 0 }
    ];
    const throughput = metrics.buildThroughput({ weeks });

    expect(throughput.netFlow.map((point) => point.cumulative)).toEqual([6, 7, 0]);
    expect(throughput.backlogDelta).toBe(0);
    expect(throughput.meanPerWeek).toBe(6.3);
  });

  test('trend compares the recent half against the older half', () => {
    const weeks = [
      { weekStart: 'a', opened: 0, merged: 2, abandoned: 0 },
      { weekStart: 'b', opened: 0, merged: 2, abandoned: 0 },
      { weekStart: 'c', opened: 0, merged: 6, abandoned: 0 },
      { weekStart: 'd', opened: 0, merged: 6, abandoned: 0 }
    ];
    expect(metrics.buildThroughput({ weeks }).trend).toBe(4);
  });
});

describe('buildVisibilityGrid', () => {
  test('sorts commit types into the four quadrants and leaves untyped ones out', () => {
    const grid = metrics.buildVisibilityGrid({
      commits: [
        { subject: 'feat: new thing' },
        { subject: 'fix: broken thing' },
        { subject: 'refactor: tidy' },
        { subject: 'chore: bump' },
        { subject: 'no type here' }
      ]
    });

    const byKey = Object.fromEntries(grid.quadrants.map((q) => [q.key, q.count]));
    expect(byKey).toEqual({ feature: 1, bug: 1, architecture: 1, debt: 1 });
    expect(grid.untyped).toBe(1);
  });

  test('technical debt is the invisible negative-value quadrant', () => {
    const grid = metrics.buildVisibilityGrid({ commits: [] });
    const debt = grid.quadrants.find((q) => q.key === 'debt');
    expect(debt.visible).toBe(false);
    expect(debt.positive).toBe(false);
  });
});
