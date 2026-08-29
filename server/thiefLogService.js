const fs = require('fs');
const path = require('path');

// Unplanned work and unknown dependencies leave no git trace, so they get logged, not inferred.

const THIEVES = ['unplanned', 'dependencies', 'conflicting', 'neglected', 'wip'];

// The kinds the book names per thief.
const KINDS = {
  unplanned: ['interruption', 'expedite', 'incident', 'drive-by', 'rework'],
  dependencies: ['discovered-task', 'waiting-on-person', 'waiting-on-service', 'access-or-permission', 'coupled-change'],
  conflicting: ['pulled-sideways', 'everything-is-priority-one', 'reprioritized-mid-flight'],
  neglected: ['aged-into-emergency', 'nobody-picked-it-up', 'zombie-project'],
  wip: ['context-switch', 'started-while-blocked']
};

const MAX_ENTRIES = 5000;
const MAX_FIELD_LENGTH = 500;

function nowIso() {
  return new Date().toISOString();
}

function clean(value, max = MAX_FIELD_LENGTH) {
  const text = String(value ?? '').trim();
  return text.length > max ? text.slice(0, max) : text;
}

class ThiefLogService {
  constructor({ filePath, now = () => Date.now() } = {}) {
    this.filePath = filePath || path.join(
      process.env.AGENT_WORKSPACE_DIR || path.join(require('os').homedir(), '.agent-workspace'),
      'flow-thief-log.json'
    );
    this.now = now;
    this.entries = this.load();
  }

  static getInstance(options) {
    if (!ThiefLogService.instance) {
      ThiefLogService.instance = new ThiefLogService(options);
    }
    return ThiefLogService.instance;
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return Array.isArray(parsed?.entries) ? parsed.entries : [];
    } catch {
      // A corrupt log must not take the page down.
      return [];
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ version: 1, entries: this.entries }, null, 2));
      fs.renameSync(tempPath, this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  catalog() {
    return { thieves: THIEVES, kinds: KINDS };
  }

  add({ thief, kind, title, repo, minutes, notes } = {}) {
    const normalizedThief = String(thief || '').trim();
    if (!THIEVES.includes(normalizedThief)) {
      throw new Error(`Unknown thief: ${thief}`);
    }
    const cleanTitle = clean(title);
    if (!cleanTitle) throw new Error('An entry needs a title');

    const parsedMinutes = Number.parseInt(minutes, 10);
    const entry = {
      id: `thief-${this.now()}-${Math.floor(Math.random() * 1e6).toString(36)}`,
      thief: normalizedThief,
      kind: (KINDS[normalizedThief] || []).includes(kind) ? kind : null,
      title: cleanTitle,
      repo: clean(repo, 120) || null,
      minutes: Number.isFinite(parsedMinutes) && parsedMinutes > 0 ? parsedMinutes : null,
      notes: clean(notes) || null,
      createdAt: nowIso()
    };

    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES);
    }
    this.save();
    return entry;
  }

  remove(id) {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.id !== id);
    if (this.entries.length === before) return false;
    this.save();
    return true;
  }

  list({ sinceMs = null } = {}) {
    if (!Number.isFinite(sinceMs)) return [...this.entries];
    return this.entries.filter((entry) => Date.parse(entry.createdAt) >= sinceMs);
  }

  // Figure 45. An untimed entry still counts once.
  summary({ sinceMs = null } = {}) {
    const entries = this.list({ sinceMs });
    const byThief = {};
    for (const thief of THIEVES) byThief[thief] = { count: 0, minutes: 0, timedCount: 0 };

    for (const entry of entries) {
      const bucket = byThief[entry.thief];
      if (!bucket) continue;
      bucket.count += 1;
      if (Number.isFinite(entry.minutes)) {
        bucket.minutes += entry.minutes;
        bucket.timedCount += 1;
      }
    }

    return { total: entries.length, byThief };
  }

  // Figure 47, on the same week keys as the derived series.
  weeklyCounts({ weekStarts = [] } = {}) {
    const series = {};
    for (const thief of THIEVES) series[thief] = weekStarts.map(() => 0);

    const weekIndex = new Map(weekStarts.map((week, index) => [week, index]));
    for (const entry of this.entries) {
      const createdMs = Date.parse(entry.createdAt);
      if (!Number.isFinite(createdMs)) continue;
      const key = new Date(require('./flowMetrics').startOfWeekMs(createdMs)).toISOString().slice(0, 10);
      const index = weekIndex.get(key);
      if (index === undefined) continue;
      if (series[entry.thief]) series[entry.thief][index] += 1;
    }
    return series;
  }
}

module.exports = { ThiefLogService, THIEVES, KINDS };
