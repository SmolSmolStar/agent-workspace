/**
 * Model/Effort Picker - hover/click dropdown on the terminal-header model
 * badge. Lets you swap a running session's model + effort for THIS SESSION
 * ONLY, without touching your saved default. Backed by /api/agents/model-catalog
 * (per-provider models + valid efforts) and /api/sessions/:id/switch-model
 * (Claude only for now - see PLANS/2026-08-29/MODEL_EFFORT_PICKER_PLAN.md).
 */

class ModelEffortPicker {
  constructor(orchestrator) {
    this.orchestrator = orchestrator;
    this.catalog = null;
    this.catalogLoadedAt = 0;
    this.CATALOG_CLIENT_CACHE_MS = 5 * 60 * 1000;
    this.panelEl = null;
    this.openSessionId = null;
    this.hoverOpenTimers = new WeakMap();
    this.flyoutEl = null;
    this.boundOutsideClick = (e) => {
      const insidePanel = this.panelEl?.contains(e.target);
      const insideFlyout = this.flyoutEl?.contains(e.target);
      if (!insidePanel && !insideFlyout && e.target !== this.currentAnchor) {
        this.close();
      }
    };
    this.boundEscape = (e) => {
      if (e.key === 'Escape') this.close();
    };
  }

  isTouchDevice() {
    return typeof window.matchMedia === 'function' && window.matchMedia('(hover: none)').matches;
  }

  /** Wire hover/click/keyboard on a rendered .terminal-model-badge element. */
  attachTrigger(badgeEl, sessionId) {
    if (!badgeEl || badgeEl.dataset.pickerAttached === '1') return;
    badgeEl.dataset.pickerAttached = '1';
    badgeEl.classList.add('model-badge-trigger');
    badgeEl.setAttribute('role', 'button');
    badgeEl.setAttribute('tabindex', '0');
    // Don't stomp the tooltip here - renderSessionModelBadge sets el.title to
    // the model/effort source explanation on every render, after this runs.
    // The trigger affordance comes from the CSS chevron + pointer cursor.

    badgeEl.addEventListener('mouseenter', () => {
      if (this.isTouchDevice()) return;
      const timer = setTimeout(() => this.open(badgeEl, sessionId), 150);
      this.hoverOpenTimers.set(badgeEl, timer);
    });
    badgeEl.addEventListener('mouseleave', () => {
      const timer = this.hoverOpenTimers.get(badgeEl);
      if (timer) clearTimeout(timer);
    });
    badgeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.openSessionId === sessionId) this.close();
      else this.open(badgeEl, sessionId);
    });
    badgeEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.open(badgeEl, sessionId);
      }
    });
  }

  async ensureCatalog(force = false) {
    const now = Date.now();
    if (!force && this.catalog && (now - this.catalogLoadedAt) < this.CATALOG_CLIENT_CACHE_MS) {
      return this.catalog;
    }
    try {
      const res = await fetch('/api/agents/model-catalog');
      const payload = await res.json().catch(() => null);
      if (payload?.ok) {
        this.catalog = payload;
        this.catalogLoadedAt = now;
      }
    } catch {
      // Serve whatever we already have; the panel shows a stale/error hint.
    }
    return this.catalog;
  }

  resolveProviderId(sessionId) {
    const session = this.orchestrator.sessions?.get?.(sessionId);
    const runningAgent = String(session?.agent || '').trim().toLowerCase();
    const sessionType = String(session?.type || '').trim().toLowerCase();
    if (runningAgent === 'codex' || (!runningAgent && sessionType === 'codex')) return 'codex';
    if (runningAgent === 'grok') return 'grok';
    return 'claude';
  }

  resolveCurrentConfig(sessionId, providerId) {
    if (providerId === 'grok') return this.orchestrator.modelConfigGrok || {};
    if (providerId === 'codex') return this.orchestrator.modelConfigCodex || {};
    return this.orchestrator.modelConfigBySession?.get?.(sessionId)?.claude || {};
  }

  async open(anchorEl, sessionId) {
    this.close();
    this.openSessionId = sessionId;
    this.currentAnchor = anchorEl;

    const providerId = this.resolveProviderId(sessionId);
    await this.ensureCatalog();
    this.render(anchorEl, sessionId, providerId);

    setTimeout(() => {
      document.addEventListener('mousedown', this.boundOutsideClick);
      document.addEventListener('keydown', this.boundEscape);
    }, 0);
  }

  close() {
    this.hideFlyout();
    if (this.panelEl) {
      this.panelEl.remove();
      this.panelEl = null;
    }
    this.openSessionId = null;
    this.currentAnchor = null;
    document.removeEventListener('mousedown', this.boundOutsideClick);
    document.removeEventListener('keydown', this.boundEscape);
  }

  hideFlyout() {
    if (this.flyoutEl) {
      this.flyoutEl.remove();
      this.flyoutEl = null;
    }
  }

  // Renders the effort flyout as a sibling of the panel (fixed-positioned,
  // computed from the row's own rect) instead of nesting it inside the
  // scrolling model list - see the comment in renderModelRow() for why.
  showFlyout(panel, row, sessionId, providerId) {
    const modelId = row.dataset.modelId;
    if (this.flyoutEl?.dataset.forRow === modelId) return;
    this.hideFlyout();

    let efforts = [];
    try {
      efforts = JSON.parse(row.dataset.efforts || '[]');
    } catch {
      efforts = [];
    }
    if (!efforts.length) return;

    const flyout = document.createElement('div');
    flyout.className = 'model-effort-picker-efforts-flyout';
    flyout.dataset.forRow = modelId;
    flyout.innerHTML = efforts
      .map((e) => `<button type="button" class="model-effort-picker-effort" data-effort="${this.escape(e)}">${this.escape(e)}</button>`)
      .join('');

    document.body.appendChild(flyout);
    const rowRect = row.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const flyoutWidth = flyout.offsetWidth || 100;
    let left = panelRect.right + 4;
    if (left + flyoutWidth > window.innerWidth - 8) left = Math.max(8, panelRect.left - flyoutWidth - 4);
    flyout.style.left = `${left}px`;
    flyout.style.top = `${rowRect.top}px`;

    flyout.querySelectorAll('.model-effort-picker-effort').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.commit(sessionId, providerId, { model: modelId, effort: btn.dataset.effort });
      });
    });

    this.flyoutEl = flyout;
  }

  render(anchorEl, sessionId, providerId) {
    const provider = this.catalog?.providers?.[providerId];
    const current = this.resolveCurrentConfig(sessionId, providerId);
    const currentModelId = this.normalizeCurrentModelId(current.model, provider);
    const currentEffort = String(current.effortLevel || '').trim().toLowerCase();

    const panel = document.createElement('div');
    panel.className = 'model-effort-picker';
    panel.setAttribute('role', 'menu');

    if (!provider || !provider.models?.length) {
      panel.innerHTML = `
        <div class="model-effort-picker-empty">
          ${this.catalog?.lastError ? `Catalog error: ${this.escape(this.catalog.lastError)}` : 'No models known for this provider yet.'}
        </div>
        ${this.renderFooter()}
      `;
    } else {
      panel.innerHTML = `
        <div class="model-effort-picker-body">
          <div class="model-effort-picker-models" role="group" aria-label="Model">
            ${provider.models.map((m) => this.renderModelRow(m, m.id === currentModelId)).join('')}
          </div>
        </div>
        ${this.renderFooter()}
      `;
    }

    document.body.appendChild(panel);
    this.panelEl = panel;
    this.positionPanel(panel, anchorEl);
    this.wireEvents(panel, provider, sessionId, providerId, currentModelId, currentEffort);
  }

  normalizeCurrentModelId(rawModel, provider) {
    // Claude's resolved config can carry a dated/tagged id like
    // "claude-sonnet-5[1m]" even though the catalog keys models by alias
    // ("sonnet") - match on prefix so the current model still highlights.
    const raw = String(rawModel || '').toLowerCase();
    if (!raw || !provider?.models?.length) return null;
    const exact = provider.models.find((m) => m.id.toLowerCase() === raw);
    if (exact) return exact.id;
    const byPrefix = provider.models.find((m) => raw.includes(m.id.toLowerCase()));
    return byPrefix?.id || null;
  }

  renderModelRow(model, isCurrent) {
    const effortChips = (model.efforts || [])
      .map((e) => `<button type="button" class="model-effort-picker-effort" data-effort="${this.escape(e)}">${this.escape(e)}</button>`)
      .join('');
    // The effort flyout is NOT nested here — .model-effort-picker-body
    // scrolls (overflow-y: auto), and per the CSS overflow spec pairing any
    // axis with 'auto' forces the other axis to compute as 'auto' too, so a
    // nested absolutely-positioned flyout would get clipped. It's rendered
    // as a sibling of the scroll container instead; see showFlyout().
    return `
      <div class="model-effort-picker-row ${isCurrent ? 'is-current' : ''}" data-model-id="${this.escape(model.id)}" data-efforts='${this.escape(JSON.stringify(model.efforts || []))}'>
        <button type="button" class="model-effort-picker-model" data-model-id="${this.escape(model.id)}">
          ${isCurrent ? '<span class="model-effort-picker-check">&#10003;</span>' : ''}
          <span class="model-effort-picker-model-label">${this.escape(model.label)}</span>
          <span class="model-effort-picker-expand" data-expand-toggle title="Effort options">&#9656;</span>
        </button>
      </div>
    `;
  }

  renderFooter() {
    const stamp = this.catalog?.lastLoadedAt ? new Date(this.catalog.lastLoadedAt).toLocaleTimeString() : 'never';
    return `
      <div class="model-effort-picker-footer">
        <span class="model-effort-picker-stamp">Catalog: ${this.escape(stamp)}</span>
        <button type="button" class="model-effort-picker-refresh">Refresh</button>
      </div>
    `;
  }

  positionPanel(panel, anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    const panelWidth = panel.offsetWidth || 260;
    const viewportWidth = window.innerWidth;
    let left = rect.left;
    if (left + panelWidth > viewportWidth - 8) left = Math.max(8, viewportWidth - panelWidth - 8);
    panel.style.left = `${left}px`;
    panel.style.top = `${rect.bottom + 4}px`;
  }

  wireEvents(panel, provider, sessionId, providerId, currentModelId, currentEffort) {
    panel.querySelectorAll('.model-effort-picker-model').forEach((btn) => {
      const row = btn.closest('.model-effort-picker-row');

      btn.addEventListener('click', (e) => {
        // The expand chevron toggles the effort flyout (works on touch,
        // where :hover never fires) instead of committing the model switch.
        if (e.target.closest('[data-expand-toggle]')) {
          e.stopPropagation();
          if (this.flyoutEl && this.flyoutEl.dataset.forRow === row.dataset.modelId) this.hideFlyout();
          else this.showFlyout(panel, row, sessionId, providerId);
          return;
        }
        const modelId = btn.dataset.modelId;
        this.commit(sessionId, providerId, { model: modelId });
      });

      row.addEventListener('mouseenter', () => {
        if (this.isTouchDevice()) return;
        this.showFlyout(panel, row, sessionId, providerId);
      });
    });

    panel.querySelector('.model-effort-picker-refresh')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Refreshing…';
      try {
        const res = await fetch('/api/agents/model-catalog/refresh', { method: 'POST' });
        const payload = await res.json().catch(() => null);
        if (payload?.ok) {
          this.catalog = payload;
          this.catalogLoadedAt = Date.now();
        }
      } catch {
        // leave stale catalog in place
      }
      this.render(this.currentAnchor, sessionId, providerId);
    });
  }

  async commit(sessionId, providerId, { model, effort }) {
    this.orchestrator.showToast?.(
      `Switching ${effort ? `to ${effort} effort` : 'model'}${model ? ` (${model})` : ''} for this session only…`,
      'info'
    );
    this.close();
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/switch-model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, effort })
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.ok) {
        const reason = this.describeSwitchError(payload?.error, providerId);
        this.orchestrator.showToast?.(reason, 'error');
        return;
      }
      this.orchestrator.showToast?.('Switched for this session. Your saved default is unchanged.', 'success');
      this.orchestrator.refreshSessionModelBadges?.({ force: true });
    } catch (error) {
      this.orchestrator.showToast?.(`Failed to switch model: ${error.message}`, 'error');
    }
  }

  describeSwitchError(error, providerId) {
    if (error === 'SESSION_BUSY') return 'Session is busy right now, try again once it finishes.';
    if (error === 'UNSUPPORTED_SESSION_TYPE') {
      return `Session-only switching isn't available for ${providerId} yet.`;
    }
    if (error === 'SESSION_NOT_FOUND') return 'Session not found (did it close?).';
    return `Failed to switch model${error ? `: ${error}` : ''}.`;
  }

  escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c]));
  }
}

window.ModelEffortPicker = ModelEffortPicker;
