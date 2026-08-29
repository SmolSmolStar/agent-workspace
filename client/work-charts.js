// SVG builders for the Work page. No external chart library.

const SVG_NS = 'http://www.w3.org/2000/svg';

const THIEF_COLORS = {
  wip: '#c86bd8',
  dependencies: '#e07a3c',
  unplanned: '#e0c020',
  conflicting: '#4bb3e0',
  neglected: '#4fb477'
};

function el(name, attrs = {}, text = null) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    node.setAttribute(key, String(value));
  }
  if (text !== null) node.textContent = String(text);
  return node;
}

function svgRoot(width, height) {
  const svg = el('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width: '100%',
    height,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img'
  });
  return svg;
}

function niceMax(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  return Math.ceil(value / magnitude) * magnitude;
}

function axes(svg, { left, right, top, bottom, max, ticks = 4 }) {
  svg.appendChild(el('line', { x1: left, y1: top, x2: left, y2: bottom, class: 'axis-line' }));
  svg.appendChild(el('line', { x1: left, y1: bottom, x2: right, y2: bottom, class: 'axis-line' }));
  for (let i = 0; i <= ticks; i += 1) {
    const value = (max / ticks) * i;
    const y = bottom - ((bottom - top) * i) / ticks;
    svg.appendChild(el('line', { x1: left, y1: y, x2: right, y2: y, class: 'grid-line' }));
    svg.appendChild(el('text', { x: left - 8, y: y + 4, 'text-anchor': 'end', class: 'tick' },
      Math.round(value)));
  }
}

// Figure 45. One bar per thief, worst first.
function timeThiefOGram(thieves, { width = 780, height = 300 } = {}) {
  const svg = svgRoot(width, height);
  const left = 48;
  const right = width - 16;
  const top = 16;
  const bottom = height - 58;
  const sorted = [...thieves].sort((a, b) => (b.tally || 0) - (a.tally || 0));
  const max = niceMax(Math.max(...sorted.map((t) => t.tally || 0), 1));

  axes(svg, { left, right, top, bottom, max });

  const slot = (right - left) / sorted.length;
  const barWidth = Math.min(96, slot * 0.62);

  sorted.forEach((thief, index) => {
    const x = left + slot * index + (slot - barWidth) / 2;
    const value = thief.tally || 0;
    const barHeight = ((bottom - top) * value) / max;
    svg.appendChild(el('rect', {
      x, y: bottom - barHeight, width: barWidth, height: barHeight,
      fill: THIEF_COLORS[thief.key] || '#7a8596',
      'fill-opacity': thief.source === 'logged' && value === 0 ? 0.18 : 0.85,
      stroke: THIEF_COLORS[thief.key] || '#7a8596',
      'stroke-dasharray': thief.source === 'logged' ? '4 3' : null,
      rx: 2
    }));
    svg.appendChild(el('text', {
      x: x + barWidth / 2, y: bottom - barHeight - 7, 'text-anchor': 'middle', class: 'bar-value'
    }, value));

    const words = thief.title.split(' ');
    words.forEach((word, line) => {
      svg.appendChild(el('text', {
        x: x + barWidth / 2, y: bottom + 18 + line * 13, 'text-anchor': 'middle', class: 'bar-label'
      }, word));
    });
  });

  return svg;
}

// Figure 47. Small multiples, one thief per panel.
function balancedScorecard(weeks, series, { width = 780, panelHeight = 96 } = {}) {
  const keys = Object.keys(series);
  const columns = 2;
  const rows = Math.ceil(keys.length / columns);
  const panelWidth = width / columns;
  const svg = svgRoot(width, rows * panelHeight + 12);

  keys.forEach((key, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const originX = column * panelWidth + 44;
    const originY = row * panelHeight + 16;
    const plotWidth = panelWidth - 60;
    const plotHeight = panelHeight - 42;
    const values = series[key];
    const max = niceMax(Math.max(...values, 1));

    svg.appendChild(el('text', { x: originX - 36, y: originY - 3, class: 'panel-title' },
      key.toUpperCase()));
    svg.appendChild(el('line', {
      x1: originX, y1: originY + plotHeight, x2: originX + plotWidth, y2: originY + plotHeight, class: 'axis-line'
    }));

    const slot = plotWidth / Math.max(values.length, 1);
    values.forEach((value, i) => {
      const barHeight = (plotHeight * value) / max;
      svg.appendChild(el('rect', {
        x: originX + slot * i + slot * 0.15,
        y: originY + plotHeight - barHeight,
        width: slot * 0.7,
        height: barHeight,
        fill: THIEF_COLORS[key] || '#7a8596',
        'fill-opacity': 0.85,
        rx: 1
      }));
    });
    svg.appendChild(el('text', { x: originX - 6, y: originY + 8, 'text-anchor': 'end', class: 'tick' }, max));
    if (weeks.length) {
      svg.appendChild(el('text', {
        x: originX, y: originY + plotHeight + 14, class: 'tick'
      }, weeks[0].weekStart.slice(5)));
      svg.appendChild(el('text', {
        x: originX + plotWidth, y: originY + plotHeight + 14, 'text-anchor': 'end', class: 'tick'
      }, weeks[weeks.length - 1].weekStart.slice(5)));
    }
  });

  return svg;
}

// Figure 48. Stacked bands: merged below, still open above.
function cumulativeFlowDiagram(weeks, { width = 780, height = 300 } = {}) {
  const svg = svgRoot(width, height);
  const left = 48;
  const right = width - 100;
  const top = 16;
  const bottom = height - 42;
  if (!weeks.length) return svg;

  let cumulativeMerged = 0;
  const points = weeks.map((week) => {
    cumulativeMerged += week.merged;
    return { weekStart: week.weekStart, closed: cumulativeMerged, open: week.openAtEnd };
  });
  const max = niceMax(Math.max(...points.map((p) => p.closed + p.open), 1));

  axes(svg, { left, right, top, bottom, max });

  const scaleX = (i) => left + ((right - left) * i) / Math.max(points.length - 1, 1);
  const scaleY = (value) => bottom - ((bottom - top) * value) / max;

  const band = (lower, upper, fill) => {
    const forward = points.map((p, i) => `${scaleX(i)},${scaleY(upper(p))}`);
    const back = points.map((p, i) => `${scaleX(i)},${scaleY(lower(p))}`).reverse();
    svg.appendChild(el('polygon', {
      points: [...forward, ...back].join(' '), fill, 'fill-opacity': 0.85
    }));
  };

  band(() => 0, (p) => p.closed, '#5a6473');
  band((p) => p.closed, (p) => p.closed + p.open, '#4bb3e0');

  [['Closed', '#5a6473', 0], ['WIP', '#4bb3e0', 22]].forEach(([label, color, offset]) => {
    svg.appendChild(el('rect', { x: right + 14, y: top + offset, width: 14, height: 14, fill: color, rx: 2 }));
    svg.appendChild(el('text', { x: right + 34, y: top + offset + 12, class: 'bar-label' }, label));
  });

  svg.appendChild(el('text', { x: left, y: bottom + 16, class: 'tick' }, points[0].weekStart.slice(5)));
  svg.appendChild(el('text', {
    x: right, y: bottom + 16, 'text-anchor': 'end', class: 'tick'
  }, points[points.length - 1].weekStart.slice(5)));

  return svg;
}

// Figure 40. WIP at each week's end, aged portion darkened.
function wipReport(weeks, { width = 780, height = 250 } = {}) {
  const svg = svgRoot(width, height);
  const left = 48;
  const right = width - 16;
  const top = 16;
  const bottom = height - 44;
  const max = niceMax(Math.max(...weeks.map((w) => w.openAtEnd), 1));

  axes(svg, { left, right, top, bottom, max });

  const slot = (right - left) / Math.max(weeks.length, 1);
  weeks.forEach((week, index) => {
    const x = left + slot * index + slot * 0.15;
    const barWidth = slot * 0.7;
    const totalHeight = ((bottom - top) * week.openAtEnd) / max;
    const agedHeight = ((bottom - top) * week.agedAtEnd) / max;

    svg.appendChild(el('rect', {
      x, y: bottom - totalHeight, width: barWidth, height: totalHeight,
      fill: '#4bb3e0', 'fill-opacity': 0.45, rx: 1
    }));
    svg.appendChild(el('rect', {
      x, y: bottom - agedHeight, width: barWidth, height: agedHeight,
      fill: '#4fb477', 'fill-opacity': 0.9, rx: 1
    }));
    if (index === weeks.length - 1 || index % Math.ceil(weeks.length / 8) === 0) {
      svg.appendChild(el('text', {
        x: x + barWidth / 2, y: bottom + 15, 'text-anchor': 'middle', class: 'tick'
      }, week.weekStart.slice(5)));
    }
  });

  return svg;
}

// Throughput per week, with the mean drawn across it.
function throughputChart(perWeek, meanPerWeek, { width = 780, height = 230 } = {}) {
  const svg = svgRoot(width, height);
  const left = 48;
  const right = width - 16;
  const top = 16;
  const bottom = height - 44;
  const max = niceMax(Math.max(...perWeek.map((w) => Math.max(w.merged, w.opened)), 1));

  axes(svg, { left, right, top, bottom, max });

  const slot = (right - left) / Math.max(perWeek.length, 1);
  perWeek.forEach((week, index) => {
    const x = left + slot * index + slot * 0.12;
    const barWidth = slot * 0.34;
    const mergedHeight = ((bottom - top) * week.merged) / max;
    const openedHeight = ((bottom - top) * week.opened) / max;
    svg.appendChild(el('rect', {
      x, y: bottom - openedHeight, width: barWidth, height: openedHeight,
      fill: '#e0c020', 'fill-opacity': 0.75, rx: 1
    }));
    svg.appendChild(el('rect', {
      x: x + barWidth + 2, y: bottom - mergedHeight, width: barWidth, height: mergedHeight,
      fill: '#4fb477', 'fill-opacity': 0.9, rx: 1
    }));
  });

  if (Number.isFinite(meanPerWeek)) {
    const y = bottom - ((bottom - top) * meanPerWeek) / max;
    svg.appendChild(el('line', {
      x1: left, y1: y, x2: right, y2: y, stroke: '#ffd685', 'stroke-width': 1.5, 'stroke-dasharray': '6 4'
    }));
    svg.appendChild(el('text', { x: right, y: y - 6, 'text-anchor': 'end', class: 'bar-label' },
      `mean ${meanPerWeek}/wk`));
  }

  [['Opened', '#e0c020', left], ['Merged', '#4fb477', left + 90]].forEach(([label, color, x]) => {
    svg.appendChild(el('rect', { x, y: bottom + 20, width: 12, height: 12, fill: color, rx: 2 }));
    svg.appendChild(el('text', { x: x + 18, y: bottom + 30, class: 'bar-label' }, label));
  });

  return svg;
}

// Net flow: the backlog line. Climbing means arrivals outrun departures.
function netFlowChart(netFlow, { width = 780, height = 200 } = {}) {
  const svg = svgRoot(width, height);
  const left = 48;
  const right = width - 16;
  const top = 16;
  const bottom = height - 34;
  if (!netFlow.length) return svg;

  const values = netFlow.map((point) => point.cumulative);
  const max = niceMax(Math.max(...values, 1));
  const min = Math.min(...values, 0);
  const span = max - min || 1;

  const scaleX = (i) => left + ((right - left) * i) / Math.max(netFlow.length - 1, 1);
  const scaleY = (value) => bottom - ((bottom - top) * (value - min)) / span;

  svg.appendChild(el('line', { x1: left, y1: scaleY(0), x2: right, y2: scaleY(0), class: 'axis-line' }));
  svg.appendChild(el('polyline', {
    points: netFlow.map((point, i) => `${scaleX(i)},${scaleY(point.cumulative)}`).join(' '),
    fill: 'none', stroke: '#e07a3c', 'stroke-width': 2.5
  }));

  const last = netFlow[netFlow.length - 1];
  svg.appendChild(el('text', {
    x: right, y: scaleY(last.cumulative) - 8, 'text-anchor': 'end', class: 'bar-value'
  }, `${last.cumulative > 0 ? '+' : ''}${last.cumulative}`));
  svg.appendChild(el('text', { x: left, y: scaleY(0) - 6, class: 'tick' }, 'break even'));

  return svg;
}

// Figure 41, with this machine's rho marked on the curve.
function queuingCurve(rho, { width = 380, height = 230 } = {}) {
  const svg = svgRoot(width, height);
  const left = 44;
  const right = width - 16;
  const top = 16;
  const bottom = height - 34;
  const maxN = 20;

  svg.appendChild(el('line', { x1: left, y1: top, x2: left, y2: bottom, class: 'axis-line' }));
  svg.appendChild(el('line', { x1: left, y1: bottom, x2: right, y2: bottom, class: 'axis-line' }));

  const points = [];
  for (let i = 0; i <= 96; i += 1) {
    const r = i / 100;
    const n = Math.min(maxN, (r * r) / (1 - r * r));
    points.push(`${left + (right - left) * r},${bottom - ((bottom - top) * n) / maxN}`);
  }
  svg.appendChild(el('polyline', { points: points.join(' '), fill: 'none', stroke: '#c86bd8', 'stroke-width': 2.5 }));

  if (Number.isFinite(rho)) {
    const clamped = Math.min(rho, 1);
    const x = left + (right - left) * clamped;
    svg.appendChild(el('line', {
      x1: x, y1: top, x2: x, y2: bottom, stroke: '#ff9d9d', 'stroke-width': 2, 'stroke-dasharray': '5 4'
    }));
    svg.appendChild(el('text', {
      x: Math.min(x + 6, right - 4), y: top + 14, 'text-anchor': x > width - 90 ? 'end' : 'start', class: 'bar-value'
    }, `you: ${rho}`));
  }

  svg.appendChild(el('text', { x: left, y: bottom + 16, class: 'tick' }, '0'));
  svg.appendChild(el('text', { x: right, y: bottom + 16, 'text-anchor': 'end', class: 'tick' }, 'utilization 1.0'));
  svg.appendChild(el('text', { x: left - 8, y: top + 8, 'text-anchor': 'end', class: 'tick' }, maxN));

  return svg;
}

if (typeof window !== 'undefined') {
  window.WorkCharts = {
    THIEF_COLORS,
    timeThiefOGram,
    balancedScorecard,
    cumulativeFlowDiagram,
    wipReport,
    throughputChart,
    netFlowChart,
    queuingCurve
  };
}
