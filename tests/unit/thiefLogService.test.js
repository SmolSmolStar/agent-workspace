const fs = require('fs');
const os = require('os');
const path = require('path');

const { ThiefLogService } = require('../../server/thiefLogService');

function tmpFile(name) {
  return path.join(os.tmpdir(), `orchestrator-thief-log-${Date.now()}-${Math.random().toString(16).slice(2)}`, name);
}

describe('ThiefLogService', () => {
  test('rejects a thief it does not know', () => {
    const log = new ThiefLogService({ filePath: tmpFile('log.json') });
    expect(() => log.add({ thief: 'gremlins', title: 'x' })).toThrow(/Unknown thief/);
  });

  test('rejects an entry with no title, because a countless tally is useless', () => {
    const log = new ThiefLogService({ filePath: tmpFile('log.json') });
    expect(() => log.add({ thief: 'unplanned', title: '   ' })).toThrow(/needs a title/);
  });

  test('drops a kind that does not belong to the chosen thief', () => {
    const log = new ThiefLogService({ filePath: tmpFile('log.json') });
    const entry = log.add({ thief: 'unplanned', kind: 'zombie-project', title: 'Paged at 3am' });
    expect(entry.kind).toBeNull();
  });

  test('keeps a kind the book lists for that thief', () => {
    const log = new ThiefLogService({ filePath: tmpFile('log.json') });
    const entry = log.add({ thief: 'dependencies', kind: 'discovered-task', title: 'Create the Roblox groups' });
    expect(entry.kind).toBe('discovered-task');
  });

  test('an entry survives a restart', () => {
    const filePath = tmpFile('log.json');
    new ThiefLogService({ filePath }).add({ thief: 'unplanned', title: 'Interrupted', minutes: 30 });

    const reopened = new ThiefLogService({ filePath });
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.list()[0].minutes).toBe(30);
  });

  test('a corrupt log reads as empty instead of throwing', () => {
    const filePath = tmpFile('log.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'not json at all');
    expect(new ThiefLogService({ filePath }).list()).toEqual([]);
  });

  test('an untimed entry still counts once in the tally', () => {
    const log = new ThiefLogService({ filePath: tmpFile('log.json') });
    log.add({ thief: 'unplanned', title: 'Timed', minutes: 45 });
    log.add({ thief: 'unplanned', title: 'Untimed' });

    const summary = log.summary();
    expect(summary.byThief.unplanned.count).toBe(2);
    expect(summary.byThief.unplanned.minutes).toBe(45);
    expect(summary.byThief.unplanned.timedCount).toBe(1);
  });

  test('a zero or negative duration is stored as unknown, not as zero minutes', () => {
    const log = new ThiefLogService({ filePath: tmpFile('log.json') });
    expect(log.add({ thief: 'unplanned', title: 'A', minutes: 0 }).minutes).toBeNull();
    expect(log.add({ thief: 'unplanned', title: 'B', minutes: -5 }).minutes).toBeNull();
  });

  test('remove reports whether it removed anything', () => {
    const log = new ThiefLogService({ filePath: tmpFile('log.json') });
    const entry = log.add({ thief: 'wip', title: 'Switched context again' });
    expect(log.remove(entry.id)).toBe(true);
    expect(log.remove(entry.id)).toBe(false);
  });

  test('every thief gets a bucket even with nothing logged', () => {
    const summary = new ThiefLogService({ filePath: tmpFile('log.json') }).summary();
    expect(Object.keys(summary.byThief).sort())
      .toEqual(['conflicting', 'dependencies', 'neglected', 'unplanned', 'wip']);
    expect(summary.total).toBe(0);
  });

  test('weekly counts land on the requested week keys', () => {
    const log = new ThiefLogService({ filePath: tmpFile('log.json') });
    const entry = log.add({ thief: 'dependencies', title: 'Discovered a blocker' });
    const weekStart = new Date(require('../../server/flowMetrics')
      .startOfWeekMs(Date.parse(entry.createdAt))).toISOString().slice(0, 10);

    const series = log.weeklyCounts({ weekStarts: ['1999-01-04', weekStart] });
    expect(series.dependencies[1]).toBe(1);
    expect(series.dependencies[0]).toBe(0);
  });
});
