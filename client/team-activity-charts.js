// SVG chart builders for the team activity report. Plain functions, no
// dependencies — exposed on window.TeamActivityCharts. Palette + mark specs
// follow the dataviz skill: fixed categorical hue order, thin marks, hairline
// gridlines, selective labels, hover tooltips via native <title>.
(() => {
  const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));

  const colorFor = (index) => SERIES[index % SERIES.length];

  const niceCeil = (value) => {
    if (value <= 0) return 1;
    const magnitude = 10 ** Math.floor(Math.log10(value));
    const steps = [1, 2, 5, 10];
    const step = steps.find((s) => value <= s * magnitude) || 10;
    return step * magnitude;
  };

  // Rounded-top, square-baseline bar path — the standard column mark spec.
  const columnPath = (x, y, w, h, r) => {
    const radius = Math.max(0, Math.min(r, w / 2, h));
    if (h <= 0) return '';
    return `M${x},${y + h} L${x},${y + radius} Q${x},${y} ${x + radius},${y} ` +
      `L${x + w - radius},${y} Q${x + w},${y} ${x + w},${y + radius} L${x + w},${y + h} Z`;
  };

  function renderLegend(members) {
    return `<div class="legend">${members.map((m, i) =>
      `<span><span class="swatch" style="background:${colorFor(i)}"></span>${esc(m.name)}</span>`).join('')}</div>`;
  }

  function formatHours(hours) {
    if (hours === null || hours === undefined) return '—';
    if (hours < 1) return `${Math.round(hours * 60)}m`;
    if (hours < 48) return `${Math.round(hours)}h`;
    return `${(hours / 24).toFixed(1)}d`;
  }

  function renderStatCards(members) {
    const cards = members.map((member, i) => {
      const t = member.totals;
      return `<div class="stat-card" style="border-left-color:${colorFor(i)}">
        <div class="name">${esc(member.name)}${member.error ? ' <span class="member-error" title="' + esc(member.error) + '">⚠</span>' : ''}</div>
        <div class="grid">
          <div><div class="value">${t.prsOpened}</div><div class="label">PRs opened</div></div>
          <div><div class="value">${t.prsMerged}</div><div class="label">PRs merged</div></div>
          <div><div class="value">${t.commits}</div><div class="label">Commits</div></div>
          <div><div class="value">${formatHours(t.medianCycleHours)}</div><div class="label">Median cycle time</div></div>
        </div>
      </div>`;
    }).join('');
    return `<div class="stat-cards">${cards}</div>`;
  }

  // Grouped bar chart: one date cluster per day in the window, one bar per
  // member, height = that member's commit count that day.
  function renderBarChart(members, dates) {
    if (!dates.length) return '<div class="note">No data to chart.</div>';
    const width = 1200;
    const height = 280;
    const margin = { top: 16, right: 16, bottom: 34, left: 40 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    const byMemberDate = members.map((member) => {
      const map = new Map(member.days.map((d) => [d.date, d.commitCount]));
      return dates.map((date) => map.get(date) || 0);
    });
    const maxValue = niceCeil(Math.max(1, ...byMemberDate.flat()));

    const groupWidth = innerW / dates.length;
    const barGap = 2;
    const barWidth = Math.min(24, (groupWidth - barGap * (members.length + 1)) / members.length);
    const labelStep = Math.max(1, Math.ceil(dates.length / 10));

    const yTicks = [0, maxValue / 2, maxValue];
    const gridlines = yTicks.map((tick) => {
      const y = margin.top + innerH - (tick / maxValue) * innerH;
      return `<line class="axis-line" x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" />` +
        `<text x="${margin.left - 8}" y="${y + 3}" text-anchor="end">${Math.round(tick)}</text>`;
    }).join('');

    const bars = dates.map((date, dateIndex) => {
      const groupX = margin.left + dateIndex * groupWidth;
      const barsForGroup = byMemberDate.map((series, memberIndex) => {
        const value = series[dateIndex];
        const barH = (value / maxValue) * innerH;
        const x = groupX + barGap + memberIndex * (barWidth + barGap);
        const y = margin.top + innerH - barH;
        const title = `${esc(members[memberIndex].name)}: ${value} commit${value === 1 ? '' : 's'} on ${esc(date)}`;
        if (barH <= 0) return '';
        return `<path d="${columnPath(x, y, barWidth, barH, 4)}" fill="${colorFor(memberIndex)}"><title>${title}</title></path>`;
      }).join('');
      const label = dateIndex % labelStep === 0
        ? `<text x="${groupX + groupWidth / 2}" y="${height - margin.bottom + 16}" text-anchor="middle">${esc(date.slice(5))}</text>`
        : '';
      return barsForGroup + label;
    }).join('');

    return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Commits per day by team member">
      ${gridlines}${bars}
    </svg>`;
  }

  // Gantt-style PR timeline: one row block per member, one horizontal
  // segment per PR from opened to merged (or to "now" while still open,
  // rendered lighter/dashed since it has no end yet). Overlapping PRs within
  // a member stack into extra lanes via greedy interval packing.
  function renderGantt(members, sinceIso, nowIso) {
    const sinceMs = new Date(`${sinceIso}T00:00:00`).getTime();
    const nowMs = new Date(nowIso).getTime();
    const domain = Math.max(nowMs - sinceMs, 3600000);
    const width = 1200;
    const margin = { top: 24, right: 16, bottom: 24, left: 130 };
    const innerW = width - margin.left - margin.right;
    const rowH = 22;
    const rowGap = 4;
    const memberGap = 14;

    const x = (ms) => margin.left + ((ms - sinceMs) / domain) * innerW;

    let cursorY = margin.top;
    const blocks = members.map((member, memberIndex) => {
      const lanes = []; // last end ms per lane
      const items = member.timeline.slice(0, 25).map((pr) => {
        const startMs = Math.max(new Date(pr.createdAt).getTime(), sinceMs);
        const endMs = pr.mergedAt ? new Date(pr.mergedAt).getTime() : nowMs;
        let lane = lanes.findIndex((laneEnd) => laneEnd <= startMs);
        if (lane === -1) { lane = lanes.length; lanes.push(0); }
        lanes[lane] = endMs;
        return { pr, lane, startMs, endMs };
      });
      const laneCount = Math.max(1, lanes.length);
      const blockTop = cursorY;
      const label = `<text x="${margin.left - 10}" y="${blockTop + rowH / 2 + 4}" text-anchor="end">` +
        `<tspan fill="${colorFor(memberIndex)}">●</tspan> ${esc(member.name)}</text>`;
      const bars = items.map(({ pr, lane, startMs, endMs }) => {
        const y = blockTop + lane * (rowH + rowGap);
        const barX = x(startMs);
        const barW = Math.max(3, x(endMs) - barX);
        const open = !pr.mergedAt;
        const title = `${esc(pr.repo)}#${esc(pr.number)} ${esc(pr.title)} — ` +
          `${open ? 'still open' : `merged, cycle ${esc(formatHours(pr.cycleHours))}`}`;
        return `<a href="${esc(pr.url)}" target="_blank" rel="noopener">` +
          `<rect x="${barX}" y="${y}" width="${barW}" height="${rowH - 4}" rx="6" ` +
          `fill="${colorFor(memberIndex)}" opacity="${open ? 0.45 : 1}" ` +
          `stroke="var(--bg)" stroke-width="2"${open ? ' stroke-dasharray="3,2"' : ''}>` +
          `<title>${title}</title></rect></a>`;
      }).join('');
      const overflow = member.timeline.length > 25
        ? `<text x="${margin.left}" y="${blockTop + laneCount * (rowH + rowGap) + 10}">+${member.timeline.length - 25} more not shown — see table below</text>`
        : '';
      cursorY = blockTop + laneCount * (rowH + rowGap) + memberGap + (member.timeline.length > 25 ? 16 : 0);
      return label + bars + overflow;
    }).join('');

    const totalHeight = cursorY + margin.bottom;
    const nowX = x(nowMs);
    const axis = `<line class="axis-line" x1="${margin.left}" y1="${margin.top - 10}" x2="${margin.left}" y2="${totalHeight - margin.bottom}" />` +
      `<line x1="${nowX}" y1="${margin.top - 10}" x2="${nowX}" y2="${totalHeight - margin.bottom}" stroke="var(--accent-warm)" stroke-width="1" stroke-dasharray="3,2" />` +
      `<text x="${nowX}" y="${margin.top - 14}" text-anchor="middle">now</text>` +
      `<text x="${margin.left}" y="${totalHeight - margin.bottom + 16}" text-anchor="start">${esc(sinceIso)}</text>` +
      `<text x="${width - margin.right}" y="${totalHeight - margin.bottom + 16}" text-anchor="end">${esc(nowIso.slice(0, 10))}</text>`;

    if (!members.some((m) => m.timeline.length)) {
      return '<div class="note">No PRs in this window to chart.</div>';
    }

    return `<svg viewBox="0 0 ${width} ${totalHeight}" width="100%" role="img" aria-label="PR timeline by team member">
      ${axis}${blocks}
    </svg>`;
  }

  window.TeamActivityCharts = { colorFor, renderLegend, renderStatCards, renderBarChart, renderGantt, formatHours };
})();
