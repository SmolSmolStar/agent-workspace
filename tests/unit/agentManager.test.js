const AgentManager = require('../../server/agentManager');

describe('AgentManager', () => {
  let manager;

  beforeEach(() => {
    manager = new AgentManager();
  });

  test('getAllAgents includes claude, codex, and grok', () => {
    const ids = manager.getAllAgents().map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(['claude', 'codex', 'grok']));
  });

  test('getUIConfig exposes a logo path for every agent', () => {
    for (const agent of manager.getAllAgents()) {
      const ui = manager.getUIConfig(agent.id);
      expect(typeof ui.logo).toBe('string');
      expect(ui.logo.length).toBeGreaterThan(0);
    }
  });

  test('buildCommand appends --model/--effort as plain launch flags for claude', () => {
    const command = manager.buildCommand('claude', 'fresh', { model: 'opus', effort: 'xhigh', flags: [] });
    expect(command).toBe('claude --model opus --effort xhigh');
  });

  test('buildCommand appends --model/--effort as plain launch flags for grok', () => {
    const command = manager.buildCommand('grok', 'fresh', { model: 'grok-4.6', effort: 'high', flags: [] });
    expect(command).toBe('grok --model grok-4.6 --effort high');
  });

  test('buildCommand still uses -m / -c model_reasoning_effort for codex (unchanged)', () => {
    const command = manager.buildCommand('codex', 'fresh', {
      model: 'gpt-5.3-codex',
      reasoning: 'xhigh',
      flags: []
    });
    expect(command).toBe('codex -m gpt-5.3-codex -c model_reasoning_effort="xhigh"');
  });

  test('buildCommand omits --model/--effort for claude/grok when not provided', () => {
    expect(manager.buildCommand('claude', 'fresh', { flags: [] })).toBe('claude');
    expect(manager.buildCommand('grok', 'fresh', { flags: [] })).toBe('grok');
  });

  test('grok defaultFlags/defaultMode resolve to a valid config', () => {
    const config = manager.getDefaultConfig('grok');
    expect(config).toEqual({ agentId: 'grok', mode: 'fresh', flags: ['alwaysApprove'] });
    expect(manager.validateConfig(config)).toEqual({ valid: true });
  });
});
