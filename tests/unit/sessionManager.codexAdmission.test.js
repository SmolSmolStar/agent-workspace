const { SessionManager } = require('../../server/sessionManager');

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
});
