// Pure figure math for the Work page. No IO.

const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;

// Figure 4. Untyped commits stay out of the grid rather than being guessed into a quadrant.
const VISIBILITY_QUADRANTS = {
  feature: { label: 'Feature', visible: true, positive: true, types: ['feat', 'feature'] },
  bug: { label: 'Bug', visible: true, positive: false, types: ['fix', 'hotfix', 'bug'] },
  architecture: { label: 'Architecture', visible: false, positive: true, types: ['refactor', 'perf', 'build', 'ci', 'docs'] },
  debt: { label: 'Technical debt', visible: false, positive: false, types: ['chore', 'test', 'style', 'revert', 'deps'] }
};

const TYPE_TO_QUADRANT = new Map();
for (const [key, quadrant] of Object.entries(VISIBILITY_QUADRANTS)) {
  for (const type of quadrant.types) TYPE_TO_QUADRANT.set(type, key);
}

function commitType(subject) {
  const match = /^([a-z]+)(\([^)]*\))?!?:/i.exec(String(subject || '').trim());
  return match ? match[1].toLowerCase() : null;
}

function startOfWeekMs(ms) {
  const date = new Date(ms);
  const day = date.getUTCDay();
  const monday = (day + 6) % 7;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - monday * DAY_MS;
}

function quantile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))));
  return sorted[index];
}

function buildWeekBuckets(nowMs, windowDays) {
  const buckets = [];
  const firstWeek = startOfWeekMs(nowMs - windowDays * DAY_MS);
  const lastWeek = startOfWeekMs(nowMs);
  for (let start = firstWeek; start <= lastWeek; start += WEEK_MS) {
    buckets.push({
      weekStart: new Date(start).toISOString().slice(0, 10),
      startMs: start,
      endMs: Math.min(start + WEEK_MS, nowMs),
      // The newest bucket stops at now, so it covers fewer days than the rest.
      partial: start + WEEK_MS > nowMs,
      opened: 0,
      merged: 0,
      abandoned: 0,
      openAtEnd: 0,
      agedAtEnd: 0,
      reposTouched: 0
    });
  }
  return buckets;
}

// One weekly pass feeding Figures 40, 42 and 48.
function buildWeeklyFlow({ pullRequests, commits = [], nowMs, windowDays, agingDays }) {
  const weeks = buildWeekBuckets(nowMs, windowDays);
  const reposPerWeek = weeks.map(() => new Set());

  for (const pr of pullRequests) {
    const created = pr.createdMs;
    if (!Number.isFinite(created)) continue;
    const finished = Number.isFinite(pr.mergedMs) ? pr.mergedMs
      : (Number.isFinite(pr.closedMs) ? pr.closedMs : null);

    for (let i = 0; i < weeks.length; i += 1) {
      const week = weeks[i];
      if (created >= week.startMs && created < week.startMs + WEEK_MS) week.opened += 1;
      if (Number.isFinite(pr.mergedMs) && pr.mergedMs >= week.startMs && pr.mergedMs < week.startMs + WEEK_MS) {
        week.merged += 1;
      }
      // Closed unmerged: started, then thrown away.
      if (!Number.isFinite(pr.mergedMs) && Number.isFinite(pr.closedMs)
        && pr.closedMs >= week.startMs && pr.closedMs < week.startMs + WEEK_MS) {
        week.abandoned += 1;
      }

      const openAtEnd = created <= week.endMs && (finished === null || finished > week.endMs);
      if (openAtEnd) {
        week.openAtEnd += 1;
        if ((week.endMs - created) >= agingDays * DAY_MS) week.agedAtEnd += 1;
      }
    }
  }

  for (const commit of commits) {
    if (!Number.isFinite(commit.timeMs)) continue;
    for (let i = 0; i < weeks.length; i += 1) {
      const week = weeks[i];
      if (commit.timeMs >= week.startMs && commit.timeMs < week.startMs + WEEK_MS) {
        if (commit.repo) reposPerWeek[i].add(commit.repo);
      }
    }
  }

  weeks.forEach((week, i) => { week.reposTouched = reposPerWeek[i].size; });
  return weeks.map(({ startMs, endMs, ...rest }) => rest);
}

// Figure 27, the Validate Pit.
function buildBoard({ pullRequests, branchesWithoutPr, nowMs, reviewIdleDays = 3 }) {
  const open = pullRequests.filter((pr) => pr.state === 'open');
  const draft = open.filter((pr) => pr.isDraft);
  const ready = open.filter((pr) => !pr.isDraft);
  const waiting = ready.filter((pr) => (nowMs - pr.updatedMs) >= reviewIdleDays * DAY_MS);
  const active = ready.filter((pr) => (nowMs - pr.updatedMs) < reviewIdleDays * DAY_MS);
  const mergedInWindow = pullRequests.filter((pr) => Number.isFinite(pr.mergedMs));

  const columns = [
    { key: 'branch', label: 'Branch, no PR', count: branchesWithoutPr, note: 'unmerged, never proposed' },
    { key: 'draft', label: 'Draft', count: draft.length, note: 'proposed, not offered for review' },
    { key: 'active', label: 'In review', count: active.length, note: `touched in the last ${reviewIdleDays}d` },
    { key: 'waiting', label: 'Waiting', count: waiting.length, note: `no activity for ${reviewIdleDays}d+` },
    { key: 'merged', label: 'Merged', count: mergedInWindow.length, note: 'in this window' }
  ];

  // Only a pit if it outweighs every other unfinished stage combined. A column with an unknown count cannot win.
  const unfinished = columns.filter((column) => column.key !== 'merged' && Number.isFinite(column.count));
  const biggest = unfinished.reduce((worst, column) => (column.count > worst.count ? column : worst), unfinished[0]);
  const others = unfinished.filter((column) => column !== biggest).reduce((sum, column) => sum + column.count, 0);
  const pit = biggest && biggest.count > others && biggest.count > 0 ? biggest.key : null;

  return { columns, pit };
}

// Figure 42, the Aging Report.
function buildAgingReport({ pullRequests, nowMs, limit = 25 }) {
  const open = pullRequests.filter((pr) => pr.state === 'open');
  if (!open.length) return { rows: [], averageIdleDays: null, averageAgeDays: null };

  const rows = open.map((pr) => ({
    repo: pr.repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.isDraft ? 'Draft' : 'In review',
    idleDays: Math.max(0, Math.round((nowMs - pr.updatedMs) / DAY_MS)),
    ageDays: Math.max(0, Math.round((nowMs - pr.createdMs) / DAY_MS))
  }));

  const averageIdleDays = Math.round(rows.reduce((sum, row) => sum + row.idleDays, 0) / rows.length);
  const averageAgeDays = Math.round(rows.reduce((sum, row) => sum + row.ageDays, 0) / rows.length);

  for (const row of rows) row.overAverage = row.idleDays > averageIdleDays;
  rows.sort((a, b) => b.idleDays - a.idleDays);

  return { rows: rows.slice(0, limit), totalRows: rows.length, averageIdleDays, averageAgeDays };
}

// Figures 38 and 39. Waits included.
function buildFlowTime({ pullRequests }) {
  const merged = pullRequests.filter((pr) => Number.isFinite(pr.mergedMs) && Number.isFinite(pr.createdMs));
  const hours = merged.map((pr) => (pr.mergedMs - pr.createdMs) / 3600000);
  return {
    sampleSize: merged.length,
    medianHours: quantile(hours, 0.5),
    p85Hours: quantile(hours, 0.85),
    slowestHours: quantile(hours, 1)
  };
}

// Figure 41. Past rho 1.0 it is a pile, not a queue, so N is undefined.
function buildQueueModel({ weeks }) {
  const opened = weeks.reduce((sum, week) => sum + week.opened, 0);
  const merged = weeks.reduce((sum, week) => sum + week.merged, 0);
  if (!merged) return { rho: null, queueLength: null, opened, merged };

  const rho = opened / merged;
  const queueLength = rho < 1 ? (rho * rho) / (1 - rho * rho) : null;
  return {
    rho: Math.round(rho * 100) / 100,
    queueLength: queueLength === null ? null : Math.round(queueLength * 10) / 10,
    opened,
    merged
  };
}

// Throughput, the honest velocity. Net flow shows whether the queue drains.
function buildThroughput({ weeks }) {
  if (!weeks.length) return { perWeek: [], meanPerWeek: null, trend: null, netFlow: [], backlogDelta: 0 };

  const perWeek = weeks.map((week) => ({ weekStart: week.weekStart, merged: week.merged, opened: week.opened }));
  const meanPerWeek = Math.round((weeks.reduce((sum, week) => sum + week.merged, 0) / weeks.length) * 10) / 10;

  let carried = 0;
  const netFlow = weeks.map((week) => {
    carried += week.opened - week.merged - week.abandoned;
    return { weekStart: week.weekStart, delta: week.opened - week.merged - week.abandoned, cumulative: carried };
  });

  // Half-to-half, not a regression: too few points for a slope to mean anything.
  const half = Math.floor(weeks.length / 2);
  let trend = null;
  if (half > 0) {
    const older = weeks.slice(0, half);
    const newer = weeks.slice(weeks.length - half);
    const olderMean = older.reduce((sum, week) => sum + week.merged, 0) / older.length;
    const newerMean = newer.reduce((sum, week) => sum + week.merged, 0) / newer.length;
    trend = Math.round((newerMean - olderMean) * 10) / 10;
  }

  return { perWeek, meanPerWeek, trend, netFlow, backlogDelta: carried };
}

function buildVisibilityGrid({ commits }) {
  const counts = { feature: 0, bug: 0, architecture: 0, debt: 0 };
  let untyped = 0;

  for (const commit of commits) {
    const quadrant = TYPE_TO_QUADRANT.get(commitType(commit.subject));
    if (quadrant) counts[quadrant] += 1;
    else untyped += 1;
  }

  return {
    quadrants: Object.entries(VISIBILITY_QUADRANTS).map(([key, meta]) => ({
      key,
      label: meta.label,
      visible: meta.visible,
      positive: meta.positive,
      count: counts[key]
    })),
    untyped
  };
}

module.exports = {
  DAY_MS,
  WEEK_MS,
  VISIBILITY_QUADRANTS,
  commitType,
  startOfWeekMs,
  quantile,
  buildWeeklyFlow,
  buildBoard,
  buildAgingReport,
  buildFlowTime,
  buildQueueModel,
  buildThroughput,
  buildVisibilityGrid
};
