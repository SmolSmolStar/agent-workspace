const ATLAS_PORTFOLIO_LIMITS = new Set([10, 25, 50]);

function atlasPortfolioText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

class AtlasPortfolioUI {
  constructor(orchestrator) {
    this.orchestrator = orchestrator;
    this.renderer = new window.AtlasPortfolioRenderer();
    this.modalId = 'atlas-portfolio-modal';
    this.visible = false;
    this.query = '';
    this.kind = '';
    this.platform = '';
    this.limit = 10;
    this.includeRemote = false;
    this.includeForks = false;
    this.includeArchived = false;
    this.report = null;
    this.loading = false;
    this.error = '';
    this.requestSequence = 0;
    this.abortController = null;
    this.escapeHandler = null;
  }

  buildRequestPath() {
    const params = new URLSearchParams();
    params.set('limit', String(ATLAS_PORTFOLIO_LIMITS.has(this.limit) ? this.limit : 10));
    params.set('maxExamples', '4');
    params.set('includeRemote', this.includeRemote ? 'true' : 'false');
    params.set('includeForks', this.includeForks ? 'true' : 'false');
    params.set('includeArchived', this.includeArchived ? 'true' : 'false');
    if (this.query) params.set('q', this.query);
    if (this.kind) params.set('kind', this.kind);
    if (this.platform) params.set('platform', this.platform);
    return `/api/atlas/portfolio?${params.toString()}`;
  }

  createModal() {
    const modal = document.createElement('div');
    modal.id = this.modalId;
    modal.className = 'modal hidden atlas-portfolio-modal';
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header atlas-portfolio-header">
          <div class="atlas-portfolio-header-side">
            <button type="button" class="atlas-portfolio-secondary-button" data-atlas-back>Back to projects</button>
          </div>
          <div class="atlas-portfolio-title">
            <h3>Repository evidence</h3>
            <p>Measured history, code signals, and representative paths from Repo Atlas.</p>
          </div>
          <div class="atlas-portfolio-header-side atlas-portfolio-header-right">
            <button type="button" class="close-btn" data-atlas-close aria-label="Close">✕</button>
          </div>
        </div>
        <form class="atlas-portfolio-toolbar" data-atlas-form>
          <label class="atlas-portfolio-field atlas-portfolio-search">
            <span>Search</span>
            <input type="search" data-atlas-query placeholder="Name, summary, tag, or topic" autocomplete="off" />
          </label>
          <label class="atlas-portfolio-field">
            <span>Kind</span>
            <select data-atlas-kind>
              <option value="">All kinds</option>
              <option value="game">Game</option>
              <option value="tool">Tool</option>
              <option value="website">Website</option>
              <option value="library">Library</option>
              <option value="experiment">Experiment</option>
              <option value="writing">Writing</option>
              <option value="reference">Reference</option>
            </select>
          </label>
          <label class="atlas-portfolio-field">
            <span>Platform</span>
            <input type="text" data-atlas-platform placeholder="Roblox" autocomplete="off" />
          </label>
          <label class="atlas-portfolio-field atlas-portfolio-limit">
            <span>Repositories</span>
            <select data-atlas-limit>
              <option value="10">10</option>
              <option value="25">25</option>
              <option value="50">50</option>
            </select>
          </label>
          <div class="atlas-portfolio-options">
            <label><input type="checkbox" data-atlas-remote /> Include remote-only</label>
            <label><input type="checkbox" data-atlas-forks /> Include forks</label>
            <label><input type="checkbox" data-atlas-archived /> Include archived</label>
          </div>
          <button type="submit" class="atlas-portfolio-run-button">Generate report</button>
        </form>
        <div class="atlas-portfolio-status" data-atlas-status aria-live="polite"></div>
        <div class="atlas-portfolio-results" data-atlas-results></div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.querySelector('[data-atlas-close]')?.addEventListener('click', () => this.hide());
    modal.querySelector('[data-atlas-back]')?.addEventListener('click', async () => {
      this.hide();
      await this.orchestrator?.projectsBoardUI?.show?.();
    });
    modal.querySelector('[data-atlas-form]')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      this.readControls();
      await this.refresh();
    });
    modal.addEventListener('click', (event) => {
      if (event.target === modal) this.hide();
    });
  }

  readControls() {
    const modal = document.getElementById(this.modalId);
    if (!modal) return;
    this.query = atlasPortfolioText(modal.querySelector('[data-atlas-query]')?.value);
    this.kind = atlasPortfolioText(modal.querySelector('[data-atlas-kind]')?.value).toLowerCase();
    this.platform = atlasPortfolioText(modal.querySelector('[data-atlas-platform]')?.value).toLowerCase();
    const limit = Number(modal.querySelector('[data-atlas-limit]')?.value);
    this.limit = ATLAS_PORTFOLIO_LIMITS.has(limit) ? limit : 10;
    this.includeRemote = modal.querySelector('[data-atlas-remote]')?.checked === true;
    this.includeForks = modal.querySelector('[data-atlas-forks]')?.checked === true;
    this.includeArchived = modal.querySelector('[data-atlas-archived]')?.checked === true;
  }

  async show() {
    if (!document.getElementById(this.modalId)) this.createModal();
    const modal = document.getElementById(this.modalId);
    if (!modal) return;
    modal.classList.remove('hidden');
    this.visible = true;
    if (!this.escapeHandler) {
      this.escapeHandler = (event) => {
        if (event.key === 'Escape') this.hide();
      };
      document.addEventListener('keydown', this.escapeHandler);
    }
    if (this.report) this.render();
    else await this.refresh();
  }

  hide() {
    document.getElementById(this.modalId)?.classList.add('hidden');
    this.visible = false;
    this.abortController?.abort();
    this.abortController = null;
    if (this.escapeHandler) {
      document.removeEventListener('keydown', this.escapeHandler);
      this.escapeHandler = null;
    }
  }

  async refresh() {
    const requestId = ++this.requestSequence;
    this.abortController?.abort();
    this.abortController = typeof AbortController === 'function' ? new AbortController() : null;
    this.loading = true;
    this.error = '';
    this.render();

    try {
      const response = await fetch(this.buildRequestPath(), {
        signal: this.abortController?.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.ok || !data?.report) {
        throw new Error(atlasPortfolioText(data?.error) || 'Repository evidence report failed.');
      }
      if (requestId !== this.requestSequence) return;
      this.report = data.report;
      this.loading = false;
      this.render();
    } catch (error) {
      if (error?.name === 'AbortError' || requestId !== this.requestSequence) return;
      this.loading = false;
      this.error = atlasPortfolioText(error?.message) || 'Repository evidence report failed.';
      this.render();
      this.orchestrator?.showToast?.(this.error, 'error');
    }
  }

  render() {
    const modal = document.getElementById(this.modalId);
    if (!modal) return;
    const status = modal.querySelector('[data-atlas-status]');
    const results = modal.querySelector('[data-atlas-results]');
    if (!status || !results) return;

    if (this.loading) {
      status.textContent = 'Inspecting local repository history and code signals.';
      results.innerHTML = '<div class="atlas-portfolio-loading">Generating evidence report…</div>';
      return;
    }
    if (this.error) {
      status.textContent = this.error;
      results.innerHTML = '<div class="atlas-portfolio-error">The report did not complete. Adjust the filters or retry.</div>';
      return;
    }
    if (!this.report) {
      status.textContent = 'Generate a report to inspect matching repositories.';
      results.innerHTML = '';
      return;
    }

    const count = this.renderer.number(this.report.repositoryCount);
    const eligible = this.renderer.number(this.report.eligibleCount);
    status.textContent = `${count} of ${eligible} matching repositories analyzed. Checkout paths stay local.`;
    results.innerHTML = this.renderer.renderReportHtml(this.report);
  }
}

window.AtlasPortfolioUI = AtlasPortfolioUI;
