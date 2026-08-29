// The Work panel: this machine's flow, read through the five thieves of time
// (DeGrandis, "Making Work Visible"). Everything on screen is computed on the
// server from local git/gh/session state at request time.
class WorkPanel {
  constructor(orchestrator) {
    this.orchestrator = orchestrator;
    this.serverUrl = window.location.origin;
    this.windowDays = this.loadWindowDays();
    this.report = null;
    this.loading = false;
    this.error = null;
    this.openThief = null;
    this._keyHandler = null;
  }

  loadWindowDays() {
    try {
      const stored = Number.parseInt(localStorage.getItem('workPanel.windowDays'), 10);
      return Number.isFinite(stored) ? stored : 30;
    } catch {
      return 30;
    }
  }

  saveWindowDays(days) {
    try {
      localStorage.setItem('workPanel.windowDays', String(days));
    } catch {
      // A blocked localStorage only costs the remembered window.
    }
  }

  isOpen() {
    return !!document.getElementById('work-panel');
  }

  toggle() {
    if (this.isOpen()) this.close();
    else this.show();
  }

  close() {
    document.getElementById('work-panel')?.remove();
    if (this._keyHandler) {
      document.removeEventListener('keydown', this._keyHandler);
      this._keyHandler = null;
    }
  }

  async show() {
    this.renderShell();
    await this.refresh();
  }

  renderShell() {
    this.close();

    const modal = document.createElement('div');
    modal.id = 'work-panel';
    modal.className = 'modal work-modal';
    modal.innerHTML = `
      <div class="modal-content work-content">
        <div class="work-header">
          <h2>🕵️ Work</h2>
          <div class="work-controls">
            <label for="work-window">Window</label>
            <select id="work-window">
              <option value="7">7 days</option>
              <option value="14">14 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
            </select>
            <button class="btn-secondary" id="work-refresh">🔄 Refresh</button>
            <button class="close-btn" id="work-close">×</button>
          </div>
        </div>
        <div class="work-meta" id="work-meta"></div>
        <div class="work-body" id="work-body"></div>
      </div>
    `;
    document.body.appendChild(modal);

    const select = modal.querySelector('#work-window');
    select.value = String(this.windowDays);
    select.addEventListener('change', () => {
      this.windowDays = Number.parseInt(select.value, 10) || 30;
      this.saveWindowDays(this.windowDays);
      this.refresh();
    });

    modal.querySelector('#work-refresh').addEventListener('click', () => this.refresh({ force: true }));
    modal.querySelector('#work-close').addEventListener('click', () => this.close());
    modal.addEventListener('click', (event) => {
      if (event.target === modal) this.close();
      const card = event.target.closest('[data-thief]');
      if (card) this.toggleThief(card.dataset.thief);
    });

    this._keyHandler = (event) => {
      if (event.key === 'Escape') this.close();
    };
    document.addEventListener('keydown', this._keyHandler);
  }

  async refresh({ force = false } = {}) {
    if (!this.isOpen()) return;
    this.loading = true;
    this.error = null;
    this.renderBody();

    try {
      const params = new URLSearchParams({ days: String(this.windowDays) });
      if (force) params.set('refresh', '1');
      const response = await fetch(`${this.serverUrl}/api/flow/report?${params}`);
      const payload = await response.json();
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || `Request failed (${response.status})`);
      }
      this.report = payload;
    } catch (error) {
      this.error = error.message;
    } finally {
      this.loading = false;
      this.renderBody();
    }
  }

  toggleThief(key) {
    this.openThief = this.openThief === key ? null : key;
    this.renderBody();
  }

  renderBody() {
    const body = document.getElementById('work-body');
    const meta = document.getElementById('work-meta');
    if (!body || !meta) return;

    if (this.loading && !this.report) {
      meta.textContent = 'Building report…';
      body.innerHTML = '<div class="work-empty">Reading local git, PR, and session state…</div>';
      return;
    }

    if (this.error) {
      meta.textContent = '';
      body.innerHTML = `<div class="work-error">${this.escape(this.error)}</div>`;
      return;
    }

    if (!this.report) {
      meta.textContent = '';
      body.innerHTML = '<div class="work-empty">No report yet.</div>';
      return;
    }

    const generated = new Date(this.report.generatedAt).toLocaleString();
    const staleness = this.report.cached ? ` · cached ${Math.round((this.report.ageMs || 0) / 60000)}m` : '';
    const throttled = this.report.throttled ? ' · refresh throttled' : '';
    meta.textContent = `${this.report.repoCount} repos · ${this.report.windowDays}-day window · built ${generated}${staleness}${throttled}`;

    body.innerHTML = `
      <div class="work-thieves">
        ${(this.report.thieves || []).map((thief) => this.renderThief(thief)).join('')}
      </div>
      ${this.renderRepoTable()}
      ${this.renderCoverage()}
    `;
  }

  renderThief(thief) {
    const open = this.openThief === thief.key;
    const metrics = (thief.metrics || [])
      .map((metric) => `
        <div class="work-metric">
          <div class="work-metric-value">${this.formatValue(metric.value)}</div>
          <div class="work-metric-label">${this.escape(metric.label)}</div>
        </div>`)
      .join('');

    const evidence = (thief.evidence || []).length
      ? `<ul class="work-evidence">${thief.evidence.map((item) => `
          <li>
            ${item.url
              ? `<a href="${this.escape(item.url)}" target="_blank" rel="noopener">${this.escape(item.label)}</a>`
              : `<span class="work-evidence-label">${this.escape(item.label)}</span>`}
            <span class="work-evidence-detail">${this.escape(item.detail || '')}</span>
          </li>`).join('')}</ul>`
      : '<div class="work-evidence-empty">Nothing to show for this thief right now.</div>';

    return `
      <section class="work-thief ${open ? 'open' : ''}">
        <button class="work-thief-head" data-thief="${this.escape(thief.key)}">
          <span class="work-thief-title">${this.escape(thief.title)}</span>
          <span class="work-thief-headline">${this.escape(thief.headline)}</span>
          <span class="work-thief-caret">${open ? '▾' : '▸'}</span>
        </button>
        <div class="work-metrics">${metrics}</div>
        ${open ? `<div class="work-thief-detail">${evidence}</div>` : ''}
      </section>
    `;
  }

  renderRepoTable() {
    const repos = this.report.repos || [];
    if (!repos.length) {
      return '<div class="work-empty">No repositories are attached to a workspace right now.</div>';
    }
    const rows = repos.map((repo) => `
      <tr>
        <td>${this.escape(repo.name)}</td>
        <td class="num">${this.formatValue(repo.worktreeCount)}</td>
        <td class="num">${repo.prDataAvailable ? this.formatValue(repo.openPrs) : '—'}</td>
        <td class="num">${this.formatValue(repo.staleBranches)}</td>
        <td class="num">${this.formatValue(repo.remoteBranches)}</td>
        <td class="num">${this.formatValue(repo.reactiveCommits)}</td>
        <td class="num">${this.formatValue(repo.featureCommits)}</td>
      </tr>`).join('');

    return `
      <details class="work-detail-block">
        <summary>Per repository (${repos.length})</summary>
        <table class="work-table">
          <thead>
            <tr>
              <th>Repository</th>
              <th class="num">Worktrees</th>
              <th class="num">Open PRs</th>
              <th class="num">Stale branches</th>
              <th class="num">Branches</th>
              <th class="num">Reactive</th>
              <th class="num">Feature</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </details>
    `;
  }

  renderCoverage() {
    const coverage = this.report.coverage || {};
    const notes = [];
    if ((coverage.skippedNoGit || []).length) {
      notes.push(`No git checkout found for: ${coverage.skippedNoGit.join(', ')}.`);
    }
    if ((coverage.missingPrData || []).length) {
      notes.push(`No PR data (gh unavailable or no GitHub remote) for: ${coverage.missingPrData.join(', ')}.`);
    }
    if (this.report.repoCount >= (coverage.maxRepos || Infinity)) {
      notes.push(`Capped at ${coverage.maxRepos} repositories; repos beyond that are not counted.`);
    }
    if (!notes.length) return '';
    return `<div class="work-coverage">${notes.map((n) => `<div>${this.escape(n)}</div>`).join('')}</div>`;
  }

  formatValue(value) {
    if (value === null || value === undefined) return '—';
    return this.escape(String(value));
  }

  escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[char]);
  }
}

if (typeof window !== 'undefined') {
  window.WorkPanel = WorkPanel;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { WorkPanel };
}
