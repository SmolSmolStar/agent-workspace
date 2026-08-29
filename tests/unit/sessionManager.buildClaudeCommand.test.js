const { SessionManager } = require('../../server/sessionManager');

describe('SessionManager.buildClaudeCommand model/effort flags', () => {
  let sessionManager;

  beforeEach(() => {
    const io = { emit: jest.fn() };
    const agentManager = { validateConfig: jest.fn(), validateAndAdjustFlags: jest.fn(), buildCommand: jest.fn() };
    sessionManager = new SessionManager(io, agentManager);
  });

  test('plain fresh launch has no model/effort flags by default', () => {
    const cmd = sessionManager.buildClaudeCommand({ shellKind: 'bash', mode: 'fresh' });
    expect(cmd).toBe('claude');
  });

  test('appends --model and --effort as launch-only flags', () => {
    const cmd = sessionManager.buildClaudeCommand({
      shellKind: 'bash',
      mode: 'fresh',
      model: 'opus',
      effort: 'xhigh'
    });
    expect(cmd).toBe("claude --model 'opus' --effort 'xhigh'");
  });

  test('combines with --continue, skip-permissions, model and effort', () => {
    const cmd = sessionManager.buildClaudeCommand({
      shellKind: 'bash',
      mode: 'continue',
      skipPermissions: true,
      model: 'sonnet',
      effort: 'high'
    });
    expect(cmd).toBe("claude --continue --dangerously-skip-permissions --model 'sonnet' --effort 'high'");
  });

  test('omits the flags entirely when model/effort are not selected', () => {
    const cmd = sessionManager.buildClaudeCommand({ shellKind: 'bash', mode: 'resume', resumeId: 'abc' });
    expect(cmd).not.toMatch(/--model|--effort/);
  });
});
