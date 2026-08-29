/**
 * Model/effort picker: Harness -> Model -> Effort -> Tier hover dropdown.
 * Same-harness picks swap the session in place. Different-harness picks
 * restart, so they're only allowed when nothing's running yet.
 */

const MODEL_PICKER_HARNESSES = [
  { id: 'claude', label: 'Claude', logo: 'assets/providers/claude.svg' },
  { id: 'codex', label: 'Codex', logo: 'assets/providers/codex.png' },
  { id: 'grok', label: 'Grok', logo: 'assets/providers/grok.svg' }
];

const MODEL_PICKER_CLOSE_DELAY_MS = 350;

class ModelEffortPicker {
  constructor(orchestrator) {
    this.orchestrator = orchestrator;
    this.catalog = null;
    this.catalogLoadedAt = 0;
    this.CATALOG_CLIENT_CACHE_MS = 5 * 60 * 1000;
    this.agentConfigs = null;

    this.panelEl = null;
    this.flyouts = { model: null, effort: null, tier: null };
    this.openTarget = null;
    this.currentAnchor = null;
    this.currentProviderId = null;
    this.currentHasLiveAgent = false;
    this.closeTimer = null;
    this.hoverOpenTimers = new WeakMap();

    this.boundOutsideClick = (e) => {
      const els = [this.panelEl, this.flyouts.model, this.flyouts.effort, this.flyouts.tier];
      const inside = els.some((el) => el?.contains(e.target));
      if (!inside && e.target !== this.currentAnchor) this.close();
    };
    this.boundEscape = (e) => {
      if (e.key === 'Escape') this.close();
    };
  }

  normalizeTarget(target) {
    if (typeof target === 'string') return { kind: 'session', id: target };
    return { kind: target?.kind || 'session', id: target?.id };
  }

  isTouchDevice() {
    return typeof window.matchMedia === 'function' && window.matchMedia('(hover: none)').matches;
  }

  /**
   * Wire hover/click/keyboard on a rendered .terminal-model-badge element.
   * `target` is either a worktree sessionId string, or { kind: 'commander', id: instanceId }.
   */
  attachTrigger(badgeEl, target) {
    if (!badgeEl || badgeEl.dataset.pickerAttached === '1') return;
    badgeEl.dataset.pickerAttached = '1';
    badgeEl.classList.add('model-badge-trigger');
    badgeEl.setAttribute('role', 'button');
    badgeEl.setAttribute('tabindex', '0');
    // No title attribute here - the dropdown itself is the explanation.
    this.registerHoverable(badgeEl);

    const t = this.normalizeTarget(target);
    const isOpenForThisTarget = () => this.openTarget?.kind === t.kind && this.openTarget?.id === t.id;

    badgeEl.addEventListener('mouseenter', () => {
      if (this.isTouchDevice()) return;
      const timer = setTimeout(() => this.open(badgeEl, t), 150);
      this.hoverOpenTimers.set(badgeEl, timer);
    });
    badgeEl.addEventListener('mouseleave', () => {
      const timer = this.hoverOpenTimers.get(badgeEl);
      if (timer) clearTimeout(timer);
    });
    badgeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isOpenForThisTarget()) this.close();
      else this.open(badgeEl, t);
    });
    badgeEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.open(badgeEl, t);
      }
    });
  }

  // Auto-closes shortly after the mouse leaves every part of the picker.
  registerHoverable(el) {
    if (!el || el.dataset.pickerHoverable === '1') return;
    el.dataset.pickerHoverable = '1';
    el.addEventListener('mouseenter', () => this.cancelCloseTimer());
    el.addEventListener('mouseleave', () => this.armCloseTimer());
  }

  cancelCloseTimer() {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  }

  armCloseTimer() {
    // Touch has no real hover; rely on tap-outside/Escape instead.
    if (this.isTouchDevice()) return;
    this.cancelCloseTimer();
    this.closeTimer = setTimeout(() => this.close(), MODEL_PICKER_CLOSE_DELAY_MS);
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

  // Default launch flags per harness, for the fresh-start path below.
  async ensureAgentConfigs() {
    if (this.agentConfigs) return this.agentConfigs;
    try {
      const res = await fetch('/api/agents');
      if (res.ok) this.agentConfigs = await res.json();
    } catch {
      this.agentConfigs = null;
    }
    return this.agentConfigs;
  }

  resolveProviderId(sessionId) {
    const session = this.orchestrator.sessions?.get?.(sessionId);
    const runningAgent = String(session?.agent || '').trim().toLowerCase();
    const sessionType = String(session?.type || '').trim().toLowerCase();
    if (runningAgent === 'codex' || (!runningAgent && sessionType === 'codex')) return 'codex';
    if (runningAgent === 'grok') return 'grok';
    return 'claude';
  }

  resolveSessionConfig(sessionId, providerId) {
    if (providerId === 'grok') return this.orchestrator.modelConfigGrok || {};
    if (providerId === 'codex') return this.orchestrator.modelConfigCodex || {};
    return this.orchestrator.modelConfigBySession?.get?.(sessionId)?.claude || {};
  }

  /** Whether an agent is actually running for this target right now. */
  async resolveHasLiveAgent(target) {
    if (target.kind === 'commander') {
      try {
        const res = await fetch(`/api/commander/status?instance=${encodeURIComponent(target.id)}`);
        const status = await res.json().catch(() => null);
        return !!status?.provider;
      } catch {
        return true; // unknown - fail safe, refuse rather than risk it
      }
    }
    const session = this.orchestrator.sessions?.get?.(target.id);
    return !!session?.agent && session?.status !== 'no-agent';
  }

  /** Resolve { providerId, config } for either a worktree session or a Commander instance. */
  async resolveCurrentState(target) {
    if (target.kind === 'commander') {
      try {
        const res = await fetch(`/api/commander/model-config?instance=${encodeURIComponent(target.id)}`);
        const payload = await res.json().catch(() => null);
        if (payload?.ok) return { providerId: payload.provider || 'claude', config: payload };
      } catch {
        // fall through to the claude-default below
      }
      return { providerId: 'claude', config: {} };
    }
    const providerId = this.resolveProviderId(target.id);
    return { providerId, config: this.resolveSessionConfig(target.id, providerId) };
  }

  async open(anchorEl, target) {
    const t = this.normalizeTarget(target);
    this.close();
    this.openTarget = t;
    this.currentAnchor = anchorEl;
    this.cancelCloseTimer();

    await Promise.all([this.ensureCatalog(), this.ensureAgentConfigs()]);
    const [{ providerId, config }, hasLiveAgent] = await Promise.all([
      this.resolveCurrentState(t),
      this.resolveHasLiveAgent(t)
    ]);
    this.currentProviderId = providerId;
    this.currentHasLiveAgent = hasLiveAgent;

    this.renderHarnessPanel(anchorEl, t, providerId, config);

    setTimeout(() => {
      document.addEventListener('mousedown', this.boundOutsideClick);
      document.addEventListener('keydown', this.boundEscape);
    }, 0);
  }

  close() {
    this.cancelCloseTimer();
    this.hideFlyoutsFrom('model');
    if (this.panelEl) {
      this.panelEl.remove();
      this.panelEl = null;
    }
    this.openTarget = null;
    this.currentAnchor = null;
    document.removeEventListener('mousedown', this.boundOutsideClick);
    document.removeEventListener('keydown', this.boundEscape);
  }

  // Closes the given level and everything deeper than it.
  hideFlyoutsFrom(level) {
    const order = ['model', 'effort', 'tier'];
    const start = order.indexOf(level);
    if (start === -1) return;
    for (let i = start; i < order.length; i += 1) {
      const key = order[i];
      if (this.flyouts[key]) {
        this.flyouts[key].remove();
        this.flyouts[key] = null;
      }
    }
  }

  // --- Level 0: harness ---------------------------------------------------

  renderHarnessPanel(anchorEl, target, currentProviderId, currentConfig) {
    const panel = document.createElement('div');
    panel.className = 'model-effort-picker';
    panel.setAttribute('role', 'menu');
    panel.innerHTML = `
      <div class="model-effort-picker-body">
        <div class="model-effort-picker-models" role="group" aria-label="Harness">
          ${MODEL_PICKER_HARNESSES.map((h) => this.renderHarnessRow(h, h.id === currentProviderId)).join('')}
        </div>
      </div>
      ${this.renderFooter()}
    `;
    document.body.appendChild(panel);
    this.panelEl = panel;
    this.registerHoverable(panel);
    this.positionPanel(panel, anchorEl);
    this.wireHarnessEvents(panel, target, currentProviderId, currentConfig);
  }

  renderHarnessRow(harness, isCurrent) {
    return `
      <div class="model-effort-picker-row ${isCurrent ? 'is-current' : ''}" data-harness-id="${this.escape(harness.id)}">
        <button type="button" class="model-effort-picker-model" data-harness-id="${this.escape(harness.id)}">
          ${isCurrent ? '<span class="model-effort-picker-check">&#10003;</span>' : ''}
          <img class="model-effort-picker-harness-logo" src="${this.escape(harness.logo)}" alt="" width="16" height="16">
          <span class="model-effort-picker-model-label">${this.escape(harness.label)}</span>
          <span class="model-effort-picker-expand" data-expand-toggle>&#9656;</span>
        </button>
      </div>
    `;
  }

  wireHarnessEvents(panel, target, currentProviderId, currentConfig) {
    panel.querySelectorAll('.model-effort-picker-row').forEach((row) => {
      const harnessId = row.dataset.harnessId;
      // Harness alone never commits, only opens the model flyout.
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showModelFlyout(panel, row, target, harnessId, currentProviderId, currentConfig);
      });
      row.addEventListener('mouseenter', () => {
        if (this.isTouchDevice()) return;
        this.showModelFlyout(panel, row, target, harnessId, currentProviderId, currentConfig);
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
      const { providerId, config } = await this.resolveCurrentState(target);
      this.currentProviderId = providerId;
      this.renderHarnessPanel(this.currentAnchor, target, providerId, config);
    });
  }

  // --- Level 1: model -------------------------------------------------------

  showModelFlyout(panel, harnessRowEl, target, harnessId, currentProviderId, currentConfig) {
    if (this.flyouts.model?.dataset.forHarness === harnessId) return;
    this.hideFlyoutsFrom('model');

    const provider = this.catalog?.providers?.[harnessId];
    const models = provider?.models || [];
    const currentModelId = harnessId === currentProviderId
      ? this.normalizeCurrentModelId(currentConfig?.model, provider)
      : null;

    const flyout = document.createElement('div');
    flyout.className = 'model-effort-picker-efforts-flyout';
    flyout.dataset.forHarness = harnessId;
    flyout.innerHTML = models.length
      ? models.map((m) => this.renderModelRow(m, m.id === currentModelId)).join('')
      : `<div class="model-effort-picker-empty">No models known for this harness yet.</div>`;

    document.body.appendChild(flyout);
    this.registerHoverable(flyout);
    this.positionFlyout(flyout, panel, harnessRowEl);
    this.flyouts.model = flyout;

    flyout.querySelectorAll('.model-effort-picker-row').forEach((row) => {
      const modelId = row.dataset.modelId;
      const model = models.find((m) => m.id === modelId);
      const btn = row.querySelector('.model-effort-picker-model');

      const hasEfforts = !!(model.efforts && model.efforts.length);

      btn.addEventListener('click', (e) => {
        if (hasEfforts && e.target.closest('[data-expand-toggle]')) {
          e.stopPropagation();
          this.showEffortFlyout(flyout, row, target, harnessId, model, currentProviderId, currentConfig);
          return;
        }
        const defaultEffort = hasEfforts ? (model.efforts.includes('high') ? 'high' : model.efforts[0]) : undefined;
        this.handleCommit(target, harnessId, currentProviderId, { model: modelId, effort: defaultEffort });
      });
      if (hasEfforts) {
        row.addEventListener('mouseenter', () => {
          if (this.isTouchDevice()) return;
          this.showEffortFlyout(flyout, row, target, harnessId, model, currentProviderId, currentConfig);
        });
      }
    });
  }

  renderModelRow(model, isCurrent) {
    const hasEfforts = !!(model.efforts && model.efforts.length);
    return `
      <div class="model-effort-picker-row ${isCurrent ? 'is-current' : ''}" data-model-id="${this.escape(model.id)}">
        <button type="button" class="model-effort-picker-model" data-model-id="${this.escape(model.id)}">
          ${isCurrent ? '<span class="model-effort-picker-check">&#10003;</span>' : ''}
          <span class="model-effort-picker-model-label">${this.escape(model.label)}</span>
          ${hasEfforts ? '<span class="model-effort-picker-expand" data-expand-toggle>&#9656;</span>' : ''}
        </button>
      </div>
    `;
  }

  // --- Level 2: effort --------------------------------------------------

  showEffortFlyout(modelFlyoutEl, modelRowEl, target, harnessId, model, currentProviderId, currentConfig) {
    if (this.flyouts.effort?.dataset.forModel === model.id) return;
    this.hideFlyoutsFrom('effort');

    const isCurrentModel = harnessId === currentProviderId
      && this.normalizeCurrentModelId(currentConfig?.model, this.catalog?.providers?.[harnessId]) === model.id;
    const currentEffort = isCurrentModel ? String(currentConfig?.effortLevel || '').trim().toLowerCase() : null;

    const flyout = document.createElement('div');
    flyout.className = 'model-effort-picker-efforts-flyout';
    flyout.dataset.forModel = model.id;
    flyout.innerHTML = (model.efforts || [])
      .map((e) => this.renderEffortRow(e, e === currentEffort, !!(model.tiers && model.tiers.length)))
      .join('');

    document.body.appendChild(flyout);
    this.registerHoverable(flyout);
    this.positionFlyout(flyout, modelFlyoutEl, modelRowEl);
    this.flyouts.effort = flyout;

    flyout.querySelectorAll('.model-effort-picker-row').forEach((row) => {
      const effortId = row.dataset.effort;
      const btn = row.querySelector('.model-effort-picker-effort, .model-effort-picker-model');

      btn.addEventListener('click', (e) => {
        if (e.target.closest('[data-expand-toggle]')) {
          e.stopPropagation();
          this.showTierFlyout(flyout, row, target, harnessId, model, effortId, currentProviderId, currentConfig);
          return;
        }
        this.handleCommit(target, harnessId, currentProviderId, { model: model.id, effort: effortId });
      });
      if (model.tiers && model.tiers.length) {
        row.addEventListener('mouseenter', () => {
          if (this.isTouchDevice()) return;
          this.showTierFlyout(flyout, row, target, harnessId, model, effortId, currentProviderId, currentConfig);
        });
      }
    });
  }

  renderEffortRow(effortId, isCurrent, hasTiers) {
    return `
      <div class="model-effort-picker-row ${isCurrent ? 'is-current' : ''}" data-effort="${this.escape(effortId)}">
        <button type="button" class="model-effort-picker-effort" data-effort="${this.escape(effortId)}">
          ${isCurrent ? '<span class="model-effort-picker-check">&#10003;</span>' : ''}
          <span class="model-effort-picker-model-label">${this.escape(effortId)}</span>
          ${hasTiers ? '<span class="model-effort-picker-expand" data-expand-toggle>&#9656;</span>' : ''}
        </button>
      </div>
    `;
  }

  // --- Level 3: tier (Codex priority/fast, only when a model offers one) ---

  showTierFlyout(effortFlyoutEl, effortRowEl, target, harnessId, model, effortId, currentProviderId, currentConfig) {
    if (this.flyouts.tier?.dataset.forEffort === effortId) return;
    this.hideFlyoutsFrom('tier');

    const tiers = model.tiers || [];
    if (!tiers.length) return;

    const flyout = document.createElement('div');
    flyout.className = 'model-effort-picker-efforts-flyout';
    flyout.dataset.forEffort = effortId;
    flyout.innerHTML = tiers.map((t) => `
      <div class="model-effort-picker-row" data-tier="${this.escape(t.id)}">
        <button type="button" class="model-effort-picker-effort" data-tier="${this.escape(t.id)}">
          <span class="model-effort-picker-model-label">${this.escape(t.label)}</span>
        </button>
      </div>
    `).join('');

    document.body.appendChild(flyout);
    this.registerHoverable(flyout);
    this.positionFlyout(flyout, effortFlyoutEl, effortRowEl);
    this.flyouts.tier = flyout;

    flyout.querySelectorAll('[data-tier]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.handleCommit(target, harnessId, currentProviderId, {
          model: model.id,
          effort: effortId,
          tier: btn.dataset.tier
        });
      });
    });
  }

  // --- shared -------------------------------------------------------------

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

  // Flyout to the right (or left if no room), vertically centered on the row.
  positionFlyout(flyout, anchorEl, rowEl) {
    const anchorRect = anchorEl.getBoundingClientRect();
    const rowRect = rowEl.getBoundingClientRect();
    const flyoutWidth = flyout.offsetWidth || 140;
    const flyoutHeight = flyout.offsetHeight || 80;

    let left = anchorRect.right + 4;
    if (left + flyoutWidth > window.innerWidth - 8) left = Math.max(8, anchorRect.left - flyoutWidth - 4);

    let top = rowRect.top + rowRect.height / 2 - flyoutHeight / 2;
    top = Math.max(8, Math.min(top, window.innerHeight - flyoutHeight - 8));

    flyout.style.left = `${left}px`;
    flyout.style.top = `${top}px`;
  }

  normalizeCurrentModelId(rawModel, provider) {
    // Match by prefix - resolved ids can carry a tag like "[1m]".
    const raw = String(rawModel || '').toLowerCase();
    if (!raw || !provider?.models?.length) return null;
    const exact = provider.models.find((m) => m.id.toLowerCase() === raw);
    if (exact) return exact.id;
    const byPrefix = provider.models.find((m) => raw.includes(m.id.toLowerCase()));
    return byPrefix?.id || null;
  }

  // Routes to a same-harness switch, a fresh start, or a refusal.
  async handleCommit(target, harnessId, currentProviderId, { model, effort, tier }) {
    this.close();

    if (!this.currentHasLiveAgent) {
      await this.startFresh(target, harnessId, { model, effort, tier });
      return;
    }

    if (harnessId === currentProviderId) {
      await this.commit(target, harnessId, { model, effort });
      return;
    }

    const harnessLabel = MODEL_PICKER_HARNESSES.find((h) => h.id === harnessId)?.label || harnessId;
    const currentLabel = MODEL_PICKER_HARNESSES.find((h) => h.id === currentProviderId)?.label || currentProviderId;
    this.orchestrator.showToast?.(
      `Stop the running ${currentLabel} first, then use Start Agent to switch to ${harnessLabel}.`,
      'warning'
    );
  }

  async startFresh(target, harnessId, { model, effort, tier }) {
    const harnessLabel = MODEL_PICKER_HARNESSES.find((h) => h.id === harnessId)?.label || harnessId;
    const agent = this.agentConfigs?.find((a) => a.id === harnessId);
    const flags = (agent?.flags || []).filter((f) => f.default).map((f) => f.id);

    this.orchestrator.showToast?.(`Starting ${harnessLabel}…`, 'info');

    if (target.kind === 'commander') {
      try {
        const res = await fetch(`/api/commander/start-agent?instance=${encodeURIComponent(target.id)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: harnessId, mode: 'fresh', model, effort, tier })
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok || payload?.success === false) {
          this.orchestrator.showToast?.(`Failed to start ${harnessLabel}: ${payload?.error || res.statusText}`, 'error');
          return;
        }
        this.orchestrator.commanderPanel?.refreshModelBadge?.(target.id);
      } catch (error) {
        this.orchestrator.showToast?.(`Failed to start ${harnessLabel}: ${error.message}`, 'error');
      }
      return;
    }

    this.orchestrator.startAgentWithConfig(target.id, {
      agentId: harnessId,
      mode: 'fresh',
      flags,
      model,
      effort,
      reasoning: effort,
      tier
    });
  }

  async commit(target, providerId, { model, effort }) {
    this.orchestrator.showToast?.(
      `Switching ${effort ? `to ${effort} effort` : 'model'}${model ? ` (${model})` : ''} for this session only…`,
      'info'
    );
    try {
      const url = target.kind === 'commander'
        ? `/api/commander/switch-model?instance=${encodeURIComponent(target.id)}`
        : `/api/sessions/${encodeURIComponent(target.id)}/switch-model`;
      const res = await fetch(url, {
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
      if (target.kind === 'commander') {
        this.orchestrator.commanderPanel?.refreshModelBadge?.(target.id);
      } else {
        this.orchestrator.refreshSessionModelBadges?.({ force: true });
      }
    } catch (error) {
      this.orchestrator.showToast?.(`Failed to switch model: ${error.message}`, 'error');
    }
  }

  describeSwitchError(error, providerId) {
    if (error === 'SESSION_BUSY') return 'Not ready to switch right now, try again in a moment.';
    if (error === 'UNSUPPORTED_SESSION_TYPE') {
      return `Session-only switching isn't available for ${providerId} yet.`;
    }
    if (error === 'SESSION_NOT_FOUND') return 'Nothing running to switch (start it first).';
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
