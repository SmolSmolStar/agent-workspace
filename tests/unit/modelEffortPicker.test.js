const fs = require('fs');
const path = require('path');
const vm = require('vm');

// client/model-effort-picker.js is a browser script (assigns
// window.ModelEffortPicker at the top level), so evaluate it in a sandbox
// instead of require()-ing it, same pattern as commanderPanel.mouseFilter.test.js.
const loadModelEffortPickerClass = () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'model-effort-picker.js'), 'utf8');
  const sandbox = { window: { location: { origin: 'http://localhost' } }, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.window.ModelEffortPicker;
};

describe('ModelEffortPicker pure logic', () => {
  let ModelEffortPicker;
  let picker;

  beforeAll(() => {
    ModelEffortPicker = loadModelEffortPickerClass();
  });

  beforeEach(() => {
    picker = new ModelEffortPicker({ sessions: new Map(), modelConfigBySession: new Map() });
  });

  describe('normalizeTarget', () => {
    test('wraps a bare sessionId string as a session target (back-compat)', () => {
      expect(picker.normalizeTarget('work1-claude')).toEqual({ kind: 'session', id: 'work1-claude' });
    });

    test('passes a commander target through unchanged', () => {
      expect(picker.normalizeTarget({ kind: 'commander', id: 'cmd-2' })).toEqual({ kind: 'commander', id: 'cmd-2' });
    });

    test('defaults to kind session when kind is missing from an object target', () => {
      expect(picker.normalizeTarget({ id: 'work1-claude' })).toEqual({ kind: 'session', id: 'work1-claude' });
    });
  });

  describe('resolveProviderId', () => {
    test('reads the running agent off orchestrator.sessions', () => {
      picker.orchestrator.sessions.set('work1-claude', { agent: 'codex' });
      expect(picker.resolveProviderId('work1-claude')).toBe('codex');
    });

    test('falls back to session.type when no agent is set yet', () => {
      picker.orchestrator.sessions.set('work1-claude', { type: 'codex' });
      expect(picker.resolveProviderId('work1-claude')).toBe('codex');
    });

    test('defaults to claude for grok and unknown sessions', () => {
      picker.orchestrator.sessions.set('work1-claude', { agent: 'grok' });
      expect(picker.resolveProviderId('work1-claude')).toBe('grok');
      expect(picker.resolveProviderId('unknown-session')).toBe('claude');
    });
  });

  describe('resolveSessionConfig', () => {
    test('reads the global codex/grok config, and the per-session claude config', () => {
      picker.orchestrator.modelConfigGrok = { model: 'grok-4.6' };
      picker.orchestrator.modelConfigCodex = { model: 'gpt-5.3-codex' };
      picker.orchestrator.modelConfigBySession.set('work1-claude', { claude: { model: 'opus' } });

      expect(picker.resolveSessionConfig('any', 'grok')).toEqual({ model: 'grok-4.6' });
      expect(picker.resolveSessionConfig('any', 'codex')).toEqual({ model: 'gpt-5.3-codex' });
      expect(picker.resolveSessionConfig('work1-claude', 'claude')).toEqual({ model: 'opus' });
    });
  });

  describe('renderModelRow', () => {
    test('shows the expand chevron for a model with effort levels', () => {
      const html = picker.renderModelRow({ id: 'opus', label: 'Opus 5', efforts: ['low', 'high'] }, false);
      expect(html).toContain('data-expand-toggle');
    });

    test('omits the expand chevron for a model with no effort levels (e.g. Haiku)', () => {
      const html = picker.renderModelRow({ id: 'haiku', label: 'Haiku 4.5', efforts: [] }, false);
      expect(html).not.toContain('data-expand-toggle');
    });
  });

  describe('normalizeCurrentModelId', () => {
    const provider = { models: [{ id: 'opus' }, { id: 'sonnet' }] };

    test('matches an exact catalog id', () => {
      expect(picker.normalizeCurrentModelId('sonnet', provider)).toBe('sonnet');
    });

    test('matches a dated/tagged resolved model by substring ("claude-sonnet-5[1m]")', () => {
      expect(picker.normalizeCurrentModelId('claude-sonnet-5[1m]', provider)).toBe('sonnet');
    });

    test('does not cross-match a different catalog entry ("opus" never matches a sonnet id)', () => {
      expect(picker.normalizeCurrentModelId('claude-sonnet-5[1m]', provider)).not.toBe('opus');
    });

    test('returns null for an empty/unknown model or provider', () => {
      expect(picker.normalizeCurrentModelId('', provider)).toBe(null);
      expect(picker.normalizeCurrentModelId('opus', null)).toBe(null);
    });
  });

  describe('describeSwitchError', () => {
    test('gives a friendly message per error code', () => {
      expect(picker.describeSwitchError('SESSION_BUSY')).toMatch(/not ready/i);
      expect(picker.describeSwitchError('SESSION_NOT_FOUND')).toMatch(/nothing running/i);
      expect(picker.describeSwitchError('UNSUPPORTED_SESSION_TYPE', 'codex')).toMatch(/codex/);
    });

    test('falls back to a generic message for an unknown error', () => {
      expect(picker.describeSwitchError('WEIRD_ERROR')).toContain('WEIRD_ERROR');
    });
  });

  describe('escape', () => {
    test('escapes HTML-significant characters', () => {
      expect(picker.escape(`<script>"'&`)).toBe('&lt;script&gt;&quot;&#39;&amp;');
    });

    test('coerces null/undefined to an empty string', () => {
      expect(picker.escape(null)).toBe('');
      expect(picker.escape(undefined)).toBe('');
    });
  });

  describe('handleCommit routing', () => {
    const target = { kind: 'session', id: 'work1-claude' };

    beforeEach(() => {
      // close() touches panelEl/flyouts (all null on a bare instance) and
      // DOM listeners - harmless no-op, but stub it so these tests only
      // exercise the routing decision, not the close mechanics.
      picker.close = jest.fn();
      picker.commit = jest.fn();
      picker.startFresh = jest.fn();
      picker.orchestrator.showToast = jest.fn();
    });

    test('nothing running -> always fresh-starts, regardless of harness match', async () => {
      picker.currentHasLiveAgent = false;
      picker.currentProviderId = 'claude';
      await picker.handleCommit(target, 'codex', 'claude', { model: 'gpt-5.6-luna', effort: 'medium' });

      expect(picker.startFresh).toHaveBeenCalledWith(target, 'codex', { model: 'gpt-5.6-luna', effort: 'medium' });
      expect(picker.commit).not.toHaveBeenCalled();
      expect(picker.orchestrator.showToast).not.toHaveBeenCalled();
    });

    test('same harness + something running -> non-destructive commit', async () => {
      picker.currentHasLiveAgent = true;
      await picker.handleCommit(target, 'claude', 'claude', { model: 'opus', effort: 'high' });

      expect(picker.commit).toHaveBeenCalledWith(target, 'claude', { model: 'opus', effort: 'high' });
      expect(picker.startFresh).not.toHaveBeenCalled();
    });

    test('different harness + something running -> refuses, names both harnesses', async () => {
      picker.currentHasLiveAgent = true;
      await picker.handleCommit(target, 'codex', 'claude', { model: 'gpt-5.6-luna', effort: 'medium' });

      expect(picker.commit).not.toHaveBeenCalled();
      expect(picker.startFresh).not.toHaveBeenCalled();
      const [message, level] = picker.orchestrator.showToast.mock.calls[0];
      expect(message).toMatch(/Claude/);
      expect(message).toMatch(/Codex/);
      expect(level).toBe('warning');
    });
  });

  describe('hideFlyoutsFrom', () => {
    test('removes the given level and everything deeper, leaves earlier levels alone', () => {
      const remove = () => jest.fn();
      picker.flyouts.model = { remove: remove() };
      picker.flyouts.effort = { remove: remove() };
      picker.flyouts.tier = { remove: remove() };

      picker.hideFlyoutsFrom('effort');

      expect(picker.flyouts.model).not.toBeNull();
      expect(picker.flyouts.effort).toBeNull();
      expect(picker.flyouts.tier).toBeNull();
    });

    test('an unknown level is a no-op', () => {
      picker.flyouts.model = { remove: jest.fn() };
      picker.hideFlyoutsFrom('bogus');
      expect(picker.flyouts.model).not.toBeNull();
    });
  });

  describe('close timer / touch guard', () => {
    test('armCloseTimer does nothing on a touch device (no hover to leave)', () => {
      const realMatchMedia = global.window?.matchMedia;
      picker.isTouchDevice = () => true;
      picker.armCloseTimer();
      expect(picker.closeTimer).toBeNull();
      if (realMatchMedia) global.window.matchMedia = realMatchMedia;
    });

    test('armCloseTimer arms a timer on a non-touch device, cancelCloseTimer clears it', () => {
      picker.isTouchDevice = () => false;

      picker.armCloseTimer();
      expect(picker.closeTimer).not.toBeNull();

      picker.cancelCloseTimer();
      expect(picker.closeTimer).toBeNull();
    });
  });
});
