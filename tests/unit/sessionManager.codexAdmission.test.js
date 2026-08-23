const { SessionManager } = require('../../server/sessionManager');
const sessionRecoveryService = require('../../server/sessionRecoveryService');

describe('SessionManager Codex admission control', () => {
  test('blocks a new Codex command without touching an existing terminal', () => {
    const io = { emit: jest.fn() };
    const agentManager = {
      validateConfig: jest.fn().mockReturnValue({ valid: true }),
      validateAndAdjustFlags: jest.fn().mockReturnValue([]),
      buildCommand: jest.fn().mockReturnValue('codex')
    };
    const sessionManager = new SessionManager(io, agentManager);
    const pty = { write: jest.fn() };
    sessionManager.sessions.set('repo-work1-claude', {
      id: 'repo-work1-claude',
      type: 'claude',
      status: 'waiting',
      pty,
      config: {}
    });
    sessionManager.setAgentAdmissionController({
      getAdmissionDecision: ({ agentId }) => agentId === 'codex'
        ? {
            allowed: false,
            code: 'codex-usage-draining',
            reason: 'window-rollover',
            triggeredAt: 'trigger-time'
          }
        : { allowed: true }
    });

    const started = sessionManager.startAgentWithConfig('repo-work1-claude', {
      agentId: 'codex',
      mode: 'fresh',
      flags: []
    });

    expect(started).toBe(false);
    expect(pty.write).not.toHaveBeenCalled();
    expect(agentManager.buildCommand).not.toHaveBeenCalled();
    expect(io.emit).toHaveBeenCalledWith('agent-start-blocked', {
      sessionId: 'repo-work1-claude',
      agentId: 'codex',
      code: 'codex-usage-draining',
      reason: 'window-rollover',
      triggeredAt: 'trigger-time'
    });
    expect(sessionManager.getAgentAdmissionDecision({ agentId: 'claude' })).toEqual({ allowed: true });
  });

  test('blocks automated turns to an existing Codex session without interrupting its PTY', () => {
    const io = { emit: jest.fn() };
    const sessionManager = new SessionManager(io, null);
    const pty = { write: jest.fn(), kill: jest.fn() };
    sessionManager.sessions.set('repo-work1-claude', {
      id: 'repo-work1-claude',
      type: 'claude',
      status: 'busy',
      activeAgentId: 'codex',
      pty,
      config: {}
    });
    sessionManager.setAgentAdmissionController({
      getAdmissionDecision: ({ agentId }) => agentId === 'codex'
        ? { allowed: false, code: 'codex-usage-draining', reason: 'window-rollover' }
        : { allowed: true }
    });

    expect(sessionManager.writeNewTurnToSession('repo-work1-claude', 'next\r', { source: 'pager' })).toBe(false);

    expect(pty.write).not.toHaveBeenCalled();
    expect(pty.kill).not.toHaveBeenCalled();
    expect(io.emit).toHaveBeenCalledWith('agent-turn-blocked', expect.objectContaining({
      sessionId: 'repo-work1-claude',
      source: 'pager',
      code: 'codex-usage-draining'
    }));
  });

  test('fails closed for Codex when the admission controller throws but allows non-Codex work', () => {
    const sessionManager = new SessionManager({ emit: jest.fn() }, null);
    sessionManager.setAgentAdmissionController({
      getAdmissionDecision: () => { throw new Error('controller unavailable'); }
    });

    expect(sessionManager.getAgentAdmissionDecision({ agentId: 'codex' })).toMatchObject({
      allowed: false,
      code: 'codex-usage-monitor-error'
    });
    expect(sessionManager.getAgentAdmissionDecision({ agentId: 'claude' })).toEqual({ allowed: true });
  });

  test.each([
    'codex',
    'FOO=1 codex',
    'npx @openai/codex'
  ])('tracks a recognized typed Codex command before gating later automated turns: %s', (command) => {
    const updateAgent = jest.spyOn(sessionRecoveryService, 'updateAgent').mockImplementation(() => {});
    const agentManager = {
      getAllAgents: () => [
        { id: 'claude', baseCommand: 'claude' },
        { id: 'codex', baseCommand: 'codex' }
      ]
    };
    const sessionManager = new SessionManager({ emit: jest.fn() }, agentManager);
    sessionManager.workspace = { id: 'test-workspace' };
    sessionManager.sessions.set('repo-work1-claude', {
      id: 'repo-work1-claude',
      type: 'claude',
      status: 'busy',
      pty: { write: jest.fn() },
      config: {}
    });

    sessionManager.handleCommandExecution('repo-work1-claude', command);

    expect(sessionManager.getSessionAgentId('repo-work1-claude')).toBe('codex');
    expect(updateAgent).toHaveBeenCalledWith('test-workspace', 'repo-work1-claude', 'codex', 'fresh');
    updateAgent.mockRestore();
  });
});
