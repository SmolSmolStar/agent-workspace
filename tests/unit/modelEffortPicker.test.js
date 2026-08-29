const fs = require('fs');
const path = require('path');
const vm = require('vm');

// client/model-effort-picker.js is a browser script (assigns
// window.ModelEffortPicker at the top level), so evaluate it in a sandbox
// instead of require()-ing it, same pattern as commanderPanel.mouseFilter.test.js.
const loadModelEffortPickerClass = () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'model-effort-picker.js'), 'utf8');
  const sandbox = { window: { location: { origin: 'http://localhost' } } };
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
});
