/**
 * Unit tests for CommanderService multi-provider launch support
 * (startAgent / startNonClaudeAgent / buildNonClaudeCommand).
 */

const { CommanderService } = require('../../server/commanderService');

describe('CommanderService multi-provider launch', () => {
  let service;

  beforeEach(() => {
    jest.useFakeTimers();
    CommanderService.instance = null;
    service = CommanderService.getInstance({ io: null, sessionManager: null });
  });

  afterEach(() => {
    if (service.session) service.stop();
    CommanderService.instance = null;
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  describe('buildNonClaudeCommand', () => {
    it('builds a plain codex launch with yolo', () => {
      const cmd = service.buildNonClaudeCommand({ provider: 'codex', mode: 'fresh', yolo: true });
      expect(cmd).toBe('codex --dangerously-bypass-approvals-and-sandbox');
    });

    it('builds codex with model + effort', () => {
      const cmd = service.buildNonClaudeCommand({
        provider: 'codex',
        mode: 'fresh',
        yolo: false,
        model: 'gpt-5.3-codex',
        effort: 'xhigh'
      });
      expect(cmd).toBe('codex -m gpt-5.3-codex -c model_reasoning_effort="xhigh"');
    });

    it('maps codex continue/resume to the resume subcommand', () => {
      expect(service.buildNonClaudeCommand({ provider: 'codex', mode: 'continue', yolo: false })).toBe(
        'codex resume --last'
      );
      expect(service.buildNonClaudeCommand({ provider: 'codex', mode: 'resume', yolo: false })).toBe('codex resume');
    });

    it('builds a plain grok launch with always-approve', () => {
      const cmd = service.buildNonClaudeCommand({ provider: 'grok', mode: 'fresh', yolo: true });
      expect(cmd).toBe('grok --always-approve');
    });

    it('builds grok with model + effort + continue', () => {
      const cmd = service.buildNonClaudeCommand({
        provider: 'grok',
        mode: 'continue',
        yolo: true,
        model: 'grok-4.6',
        effort: 'high'
      });
      expect(cmd).toBe('grok --continue --model grok-4.6 --effort high --always-approve');
    });

    it('adds -c service_tier for a non-default codex tier', () => {
      const cmd = service.buildNonClaudeCommand({
        provider: 'codex',
        mode: 'fresh',
        yolo: false,
        model: 'gpt-5.6-luna',
        effort: 'medium',
        tier: 'priority'
      });
      expect(cmd).toBe('codex -m gpt-5.6-luna -c model_reasoning_effort="medium" -c service_tier="priority"');
    });

    it('omits -c service_tier for the default codex tier', () => {
      const cmd = service.buildNonClaudeCommand({
        provider: 'codex',
        mode: 'fresh',
        yolo: false,
        model: 'gpt-5.6-luna',
        tier: 'default'
      });
      expect(cmd).not.toContain('service_tier');
    });

    it('ignores tier for grok (codex-only concept)', () => {
      const cmd = service.buildNonClaudeCommand({ provider: 'grok', mode: 'fresh', yolo: false, tier: 'priority' });
      expect(cmd).not.toContain('service_tier');
    });
  });

  describe('startAgent', () => {
    it('routes provider "claude" through startClaude', async () => {
      const spy = jest.spyOn(service, 'startClaude').mockResolvedValue({ success: true });
      await service.startAgent({ provider: 'claude', mode: 'fresh', model: 'opus', effort: 'high' });
      expect(spy).toHaveBeenCalledWith('fresh', true, { model: 'opus', effort: 'high' });
    });

    it('routes non-claude providers through startNonClaudeAgent', async () => {
      const spy = jest.spyOn(service, 'startNonClaudeAgent').mockReturnValue({ success: true });
      await service.startAgent({ provider: 'codex', mode: 'fresh' });
      expect(spy).toHaveBeenCalledWith({
        provider: 'codex',
        mode: 'fresh',
        yolo: true,
        model: null,
        effort: null,
        tier: null
      });
    });

    it('passes an explicit tier through to startNonClaudeAgent', async () => {
      const spy = jest.spyOn(service, 'startNonClaudeAgent').mockReturnValue({ success: true });
      await service.startAgent({ provider: 'codex', mode: 'fresh', model: 'gpt-5.6-luna', effort: 'medium', tier: 'priority' });
      expect(spy).toHaveBeenCalledWith({
        provider: 'codex',
        mode: 'fresh',
        yolo: true,
        model: 'gpt-5.6-luna',
        effort: 'medium',
        tier: 'priority'
      });
    });

    it('rejects an unknown provider', () => {
      const result = service.startNonClaudeAgent({ provider: 'bogus', mode: 'fresh', yolo: true });
      expect(result).toEqual({ success: false, error: 'Unknown provider: bogus' });
    });

    it('refuses a duplicate start while one is already marked started', () => {
      service.claudeStarted = true;
      const result = service.startNonClaudeAgent({ provider: 'codex', mode: 'fresh', yolo: true });
      expect(result).toEqual({ success: false, error: 'Already started' });
    });

    it('sets activeProvider once a non-claude agent is launched (even without a live PTY)', () => {
      service.startNonClaudeAgent({ provider: 'grok', mode: 'fresh', yolo: true });
      expect(service.activeProvider).toBe('grok');
      expect(service.claudeStarted).toBe(true);
    });
  });

  describe('getStatus / listInstances expose the active provider', () => {
    it('getStatus().provider is null before any agent starts', () => {
      expect(service.getStatus().provider).toBeNull();
    });

    it('getStatus().provider reflects the launched provider', () => {
      service.activeProvider = 'grok';
      expect(service.getStatus().provider).toBe('grok');
    });

    it('listInstances() includes provider per instance', () => {
      service.activeProvider = 'codex';
      const list = CommanderService.listInstances();
      const main = list.find((i) => i.id === 'main');
      expect(main.provider).toBe('codex');
    });
  });
});
