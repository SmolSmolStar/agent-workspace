// Renders the Work page into a container. Shared by the standalone
// /work.html and the in-app full-screen panel.

class WorkPage {
  constructor(container, { serverUrl = window.location.origin } = {}) {
    this.container = container;
    this.serverUrl = serverUrl;
    this.windowDays = this.readPref('workPage.windowDays', 90);
    this.report = null;
    this.catalog = null;
    this.entries = [];
    this.error = null;
    this.loading = false;
  }

  readPref(key, fallback) {
    try {
      const value = Number.parseInt(localStorage.getItem(key), 10);
      return Number.isFinite(value) ? value : fallback;
    } catch {
      return fallback;
    }
  }

  writePref(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch {
      // A blocked localStorage only costs the remembered window.
    }
  }

  escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  num(value, suffix = '') {
    if (value === null || value === undefined || Number.isNaN(value)) return '&mdash;';
    return `${this.escape(value)}${suffix}`;
  }

  hours(value) {
    if (!Number.isFinite(value)) return '&mdash;';
    if (value < 48) return `${Math.round(value)}h`;
    return `${Math.round(value / 24)}d`;
  }

  async load({ force = false } = {}) {
    this.loading = true;
    this.error = null;
    this.render();
    try {
      const params = new URLSearchParams({ days: String(this.windowDays) });
      if (force) params.set('refresh', '1');
      const [reportRes, catalogRes, entriesRes] = await Promise.all([
        fetch(`${this.serverUrl}/api/flow/report?${params}`),
        fetch(`${this.serverUrl}/api/flow/thieves/catalog`),
        fetch(`${this.serverUrl}/api/flow/thieves?days=${this.windowDays}`)
      ]);
      const report = await reportRes.json();
      if (!reportRes.ok || report.ok === false) {
        throw new Error(report.error || `Report failed (${reportRes.status})`);
      }
      this.report = report;
      this.catalog = catalogRes.ok ? await catalogRes.json() : null;
      this.entries = entriesRes.ok ? (await entriesRes.json()).entries || [] : [];
    } catch (error) {
      this.error = error.message;
    } finally {
      this.loading = false;
      this.render();
    }
  }

  async logThief(payload) {
    const response = await fetch(`${this.serverUrl}/api/flow/thieves`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const body = await response.json();
    if (!response.ok || body.ok === false) throw new Error(body.error || 'Could not log that');
    await this.load({ force: true });
  }

  async deleteThief(id) {
    await fetch(`${this.serverUrl}/api/flow/thieves/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await this.load({ force: true });
  }

  render() {
    if (this.loading && !this.report) {
      this.container.innerHTML = '<div class="wp-empty">Reading local git, PR and session state...</div>';
      return;
    }
    if (this.error) {
      this.container.innerHTML = `<div class="wp-error">${this.escape(this.error)}</div>`;
      return;
    }
    if (!this.report) {
      this.container.innerHTML = '<div class="wp-empty">No report yet.</div>';
      return;
    }

    this.container.innerHTML = `
      ${this.renderToolbar()}
      ${this.renderOGram()}
      ${this.renderBoard()}
      ${this.renderFlowRow()}
      ${this.renderCfdRow()}
      ${this.renderAging()}
      ${this.renderGridAndLog()}
      ${this.renderCoverage()}
    `;
    this.mountCharts();
    this.bindEvents();
  }

  renderToolbar() {
    const report = this.report;
    const built = new Date(report.generatedAt).toLocaleString();
    const cached = report.cached ? ` &middot; cached ${Math.round((report.ageMs || 0) / 60000)}m` : '';
    return `
      <div class="wp-toolbar">
        <div class="wp-meta">
          ${report.repoCount} repos &middot; ${report.windowDays}-day window &middot; built ${this.escape(built)}${cached}
        </div>
        <div class="wp-toolbar-controls">
          <label for="wp-window">Window</label>
          <select id="wp-window">
            ${[30, 60, 90, 180, 365].map((days) => `
              <option value="${days}" ${days === report.windowDays ? 'selected' : ''}>${days} days</option>`).join('')}
          </select>
          <button class="wp-btn" id="wp-refresh">Refresh</button>
        </div>
      </div>`;
  }

  renderOGram() {
    const thieves = this.report.thieves || [];
    const cards = thieves.map((thief) => `
      <article class="wp-thief-card wp-source-${this.escape(thief.source)}">
        <header>
          <span class="wp-swatch" data-thief="${this.escape(thief.key)}"></span>
          <h3>${this.escape(thief.title)}</h3>
        </header>
        <div class="wp-source-tag">${thief.source === 'derived' ? 'measured' : thief.source === 'logged' ? 'logged by you' : 'part measured'}</div>
        <p class="wp-headline">${this.escape(thief.headline)}</p>
        ${thief.note ? `<p class="wp-note">${this.escape(thief.note)}</p>` : ''}
        <dl class="wp-metrics">
          ${(thief.metrics || []).map((metric) => `
            <div><dt>${this.escape(metric.label)}</dt><dd>${this.num(metric.value)}</dd></div>`).join('')}
        </dl>
      </article>`).join('');

    return `
      <section class="wp-section">
        <div class="wp-section-head">
          <h2>Time Thief O'Gram</h2>
          <p>Which thief took the most, this window. A dashed bar is one only you can see, so an empty bar means untracked, not zero.</p>
        </div>
        <div class="wp-chart" id="wp-ogram"></div>
        <div class="wp-thief-cards">${cards}</div>
      </section>`;
  }

  renderBoard() {
    const board = this.report.board || { columns: [], pit: null };
    const columns = board.columns.map((column) => {
      const isPit = board.pit === column.key;
      const known = Number.isFinite(column.count);
      const cards = known ? Math.min(column.count, 120) : 0;
      return `
        <div class="wp-column ${isPit ? 'wp-pit' : ''}">
          <div class="wp-column-head">
            <span class="wp-column-label">${this.escape(column.label)}</span>
            <span class="wp-column-count">${known ? column.count : '&mdash;'}</span>
          </div>
          <div class="wp-column-note">${known ? this.escape(column.note) : 'not measurable in every repo here'}</div>
          <div class="wp-cards">
            ${new Array(cards).fill('<i></i>').join('')}
            ${known && column.count > cards ? `<span class="wp-more">+${column.count - cards}</span>` : ''}
          </div>
          ${isPit ? '<div class="wp-pit-flag">the pit</div>' : ''}
        </div>`;
    }).join('');

    return `
      <section class="wp-section">
        <div class="wp-section-head">
          <h2>The board</h2>
          <p>Every stage between a pushed branch and a merge. One card per item. The pit is the stage holding more unfinished work than all the others put together.</p>
        </div>
        <div class="wp-board">${columns}</div>
      </section>`;
  }

  renderFlowRow() {
    const flow = this.report.flowTime || {};
    const queue = this.report.queue || {};
    const throughput = this.report.throughput || {};
    const trend = throughput.trend;
    const trendText = trend === null || trend === undefined ? '&mdash;'
      : `${trend > 0 ? '+' : ''}${trend}/wk vs the first half`;

    return `
      <section class="wp-section">
        <div class="wp-section-head">
          <h2>Throughput and flow time</h2>
          <p>What actually finished, and how long it took from proposed to merged with every wait included. There is no burndown here because nothing commits to a fixed scope in a fixed sprint, so the denominator would be invented.</p>
        </div>
        <div class="wp-stat-row">
          <div class="wp-stat"><span class="wp-stat-value">${this.num(throughput.meanPerWeek)}</span><span class="wp-stat-label">Merged per week, mean</span></div>
          <div class="wp-stat"><span class="wp-stat-value">${trendText}</span><span class="wp-stat-label">Throughput trend</span></div>
          <div class="wp-stat"><span class="wp-stat-value">${this.hours(flow.medianHours)}</span><span class="wp-stat-label">Median flow time</span></div>
          <div class="wp-stat"><span class="wp-stat-value">${this.hours(flow.p85Hours)}</span><span class="wp-stat-label">85th percentile</span></div>
          <div class="wp-stat"><span class="wp-stat-value">${this.num(queue.rho)}</span><span class="wp-stat-label">Arrivals per departure</span></div>
        </div>
        <div class="wp-chart" id="wp-throughput"></div>
        <div class="wp-two-col">
          <div>
            <h3>Net flow</h3>
            <p class="wp-note">Opened minus finished, carried forward. A line that only climbs is a queue that never drains.</p>
            <div class="wp-chart" id="wp-netflow"></div>
          </div>
          <div>
            <h3>Queuing theory</h3>
            <p class="wp-note">N = rho squared over one minus rho squared. Wait explodes as utilization nears 1.</p>
            <div class="wp-chart" id="wp-queue"></div>
          </div>
        </div>
      </section>`;
  }

  renderCfdRow() {
    return `
      <section class="wp-section">
        <div class="wp-section-head">
          <h2>Cumulative flow and WIP</h2>
          <p>The band between the lines is work in progress. A widening band means you are starting faster than you are finishing.</p>
        </div>
        <div class="wp-chart" id="wp-cfd"></div>
        <h3>WIP report</h3>
        <p class="wp-note">Open at each week's end. The solid portion is the part already older than ${this.report.thresholds.agingPrDays} days. The last bar covers a partial week.</p>
        <div class="wp-chart" id="wp-wip"></div>
      </section>`;
  }

  renderAging() {
    const aging = this.report.aging || { rows: [] };
    if (!aging.rows.length) {
      return '<section class="wp-section"><div class="wp-section-head"><h2>Aging report</h2></div><div class="wp-empty">Nothing open.</div></section>';
    }
    const worst = aging.rows[0].idleDays || 1;
    const rows = aging.rows.map((row) => `
      <tr class="${row.overAverage ? 'wp-over' : ''}">
        <td>${row.url ? `<a href="${this.escape(row.url)}" target="_blank" rel="noopener">${this.escape(row.repo)} #${row.number}</a>` : this.escape(row.repo)}</td>
        <td class="wp-title-cell">${this.escape(row.title)}</td>
        <td>${this.escape(row.state)}</td>
        <td class="wp-num">${row.idleDays}</td>
        <td class="wp-bar-cell">
          <span class="wp-duration" style="width:${Math.max(2, Math.round((row.idleDays / worst) * 100))}%"></span>
          <span class="wp-average-mark" style="left:${Math.min(100, Math.round((aging.averageIdleDays / worst) * 100))}%"></span>
        </td>
      </tr>`).join('');

    return `
      <section class="wp-section">
        <div class="wp-section-head">
          <h2>Aging report</h2>
          <p>Days with no activity, longest first. The tick is the average; anything past it is an outlier and rows past it are marked.</p>
        </div>
        <div class="wp-legend">
          <span><i class="wp-key-duration"></i> days idle</span>
          <span><i class="wp-key-average"></i> average (${this.num(aging.averageIdleDays)}d)</span>
          <span><i class="wp-key-over"></i> longer than average</span>
        </div>
        <table class="wp-table">
          <thead><tr><th>Item</th><th>Title</th><th>State</th><th class="wp-num">Idle</th><th>Duration vs average</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p class="wp-note">Showing ${aging.rows.length} of ${aging.totalRows} open items.</p>
      </section>`;
  }

  renderGridAndLog() {
    const grid = this.report.visibilityGrid || { quadrants: [], untyped: 0 };
    const quadrantByKey = Object.fromEntries(grid.quadrants.map((q) => [q.key, q]));
    const cell = (key) => {
      const quadrant = quadrantByKey[key] || { label: key, count: 0 };
      return `<div class="wp-quadrant wp-q-${key}">
          <span class="wp-q-label">${this.escape(quadrant.label)}</span>
          <span class="wp-q-count">${quadrant.count}</span>
        </div>`;
    };

    const kinds = this.catalog?.kinds || {};
    const thiefOptions = Object.keys(kinds).map((key) =>
      `<option value="${this.escape(key)}">${this.escape(key)}</option>`).join('');
    const entries = this.entries.slice(0, 12).map((entry) => `
      <li>
        <span class="wp-swatch" data-thief="${this.escape(entry.thief)}"></span>
        <span class="wp-log-title">${this.escape(entry.title)}</span>
        <span class="wp-log-meta">${this.escape(entry.kind || entry.thief)}${entry.minutes ? ` &middot; ${entry.minutes}m` : ''}</span>
        <button class="wp-link-btn" data-delete="${this.escape(entry.id)}">remove</button>
      </li>`).join('');

    return `
      <section class="wp-section wp-two-col">
        <div>
          <div class="wp-section-head">
            <h2>Visibility grid</h2>
            <p>Commits by type. The bottom right is invisible and negative value, which is the quadrant that hurts most.</p>
          </div>
          <div class="wp-grid">
            <span class="wp-axis-top-left">visible</span>
            <span class="wp-axis-top-right">invisible</span>
            ${cell('feature')}${cell('architecture')}
            ${cell('bug')}${cell('debt')}
            <span class="wp-axis-side-top">positive value</span>
            <span class="wp-axis-side-bottom">negative value</span>
          </div>
          <p class="wp-note">${grid.untyped} commits had no conventional type and are left out rather than guessed into a quadrant.</p>
        </div>
        <div>
          <div class="wp-section-head">
            <h2>Log a thief</h2>
            <p>The interruption, the expedite, the task nobody wrote down until it blocked go-live. None of it reaches git, so this is the only record it gets.</p>
          </div>
          <form class="wp-log-form" id="wp-log-form">
            <div class="wp-form-row">
              <select id="wp-log-thief">${thiefOptions}</select>
              <select id="wp-log-kind"></select>
            </div>
            <input id="wp-log-title" type="text" placeholder="What was it? e.g. had to create the Roblox groups before go-live" required>
            <div class="wp-form-row">
              <input id="wp-log-repo" type="text" placeholder="Project (optional)">
              <input id="wp-log-minutes" type="number" min="1" placeholder="Minutes">
              <button type="submit" class="wp-btn wp-btn-primary">Log it</button>
            </div>
          </form>
          <ul class="wp-log-list">${entries || '<li class="wp-note">Nothing logged in this window.</li>'}</ul>
        </div>
      </section>`;
  }

  renderCoverage() {
    const coverage = this.report.coverage || {};
    const notes = [];
    if ((coverage.skippedNoGit || []).length) {
      notes.push(`No git checkout found for: ${coverage.skippedNoGit.join(', ')}.`);
    }
    if ((coverage.missingPrData || []).length) {
      notes.push(`No PR data for: ${coverage.missingPrData.join(', ')}.`);
    }
    if ((coverage.truncatedPrHistory || []).length) {
      notes.push(`PR history hit the fetch cap for: ${coverage.truncatedPrHistory.join(', ')}. Weekly counts understate those.`);
    }
    if (!notes.length) return '';
    return `<section class="wp-section"><div class="wp-coverage">${notes.map((note) => `<div>${this.escape(note)}</div>`).join('')}</div></section>`;
  }

  mountCharts() {
    const charts = window.WorkCharts;
    if (!charts) return;
    const report = this.report;

    const put = (id, node) => {
      const host = this.container.querySelector(`#${id}`);
      if (host && node) host.appendChild(node);
    };

    put('wp-ogram', charts.timeThiefOGram(report.thieves || []));
    put('wp-cfd', charts.cumulativeFlowDiagram(report.weeks || []));
    put('wp-wip', charts.wipReport(report.weeks || []));
    put('wp-throughput', charts.throughputChart(report.throughput?.perWeek || [], report.throughput?.meanPerWeek));
    put('wp-netflow', charts.netFlowChart(report.throughput?.netFlow || []));
    put('wp-queue', charts.queuingCurve(report.queue?.rho));

    for (const swatch of this.container.querySelectorAll('.wp-swatch')) {
      swatch.style.background = charts.THIEF_COLORS[swatch.dataset.thief] || '#7a8596';
    }
  }

  bindEvents() {
    const windowSelect = this.container.querySelector('#wp-window');
    windowSelect?.addEventListener('change', () => {
      this.windowDays = Number.parseInt(windowSelect.value, 10) || 90;
      this.writePref('workPage.windowDays', this.windowDays);
      this.load();
    });

    this.container.querySelector('#wp-refresh')?.addEventListener('click', () => this.load({ force: true }));

    const thiefSelect = this.container.querySelector('#wp-log-thief');
    const kindSelect = this.container.querySelector('#wp-log-kind');
    const syncKinds = () => {
      if (!thiefSelect || !kindSelect) return;
      const kinds = (this.catalog?.kinds || {})[thiefSelect.value] || [];
      kindSelect.innerHTML = kinds.map((kind) => `<option value="${this.escape(kind)}">${this.escape(kind)}</option>`).join('');
    };
    thiefSelect?.addEventListener('change', syncKinds);
    syncKinds();

    this.container.querySelector('#wp-log-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const title = this.container.querySelector('#wp-log-title').value.trim();
      if (!title) return;
      try {
        await this.logThief({
          thief: thiefSelect.value,
          kind: kindSelect.value,
          title,
          repo: this.container.querySelector('#wp-log-repo').value,
          minutes: this.container.querySelector('#wp-log-minutes').value
        });
      } catch (error) {
        this.error = error.message;
        this.render();
      }
    });

    for (const button of this.container.querySelectorAll('[data-delete]')) {
      button.addEventListener('click', () => this.deleteThief(button.dataset.delete));
    }
  }
}

if (typeof window !== 'undefined') window.WorkPage = WorkPage;
