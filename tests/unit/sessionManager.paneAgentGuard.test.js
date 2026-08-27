jest.mock('node-pty', () => ({
  spawn: jest.fn()
}));

const { TmuxSessionBackend } = require('../../server/utils/tmuxSessionBackend');
const { SessionManager } = require('../../server/sessionManager');

const makeBackend = (execImpl) => new TmuxSessionBackend({
  socketName: 'test-sock',
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
  execImpl,
  platform: 'linux',
  baseEnv: { PATH: '/usr/bin', HOME: '/home/u' }
});

describe('TmuxSessionBackend.paneCurrentCommand', () => {
  test('returns the pane foreground command', () => {
    const backend = makeBackend(jest.fn(() => 'claude\n'));
    expect(backend.paneCurrentCommand('s1')).toBe('claude');
  });

  test('returns null when tmux fails or reports nothing', () => {
    expect(makeBackend(jest.fn(() => { throw new Error('no server'); })).paneCurrentCommand('s1')).toBeNull();
    expect(makeBackend(jest.fn(() => '   \n')).paneCurrentCommand('s1')).toBeNull();
  });
});

describe('SessionManager.paneStillRunsAgent', () => {
  const callGuard = ({ command, backend = 'tmux', enabled = true }) => {
    const fakeThis = {
      sessionPersistenceEnabled: enabled,
      sessionPersistence: { paneCurrentCommand: jest.fn(() => command) }
    };
    const session = { persistence: { backend } };
    return SessionManager.prototype.paneStillRunsAgent.call(fakeThis, 'sid', session);
  };

  test('a pane running an agent blocks the shell-prompt marker clear', () => {
    expect(callGuard({ command: 'claude' })).toBe(true);
    expect(callGuard({ command: 'codex' })).toBe(true);
    expect(callGuard({ command: 'node' })).toBe(true);
  });

  test('a pane back at a plain shell allows the clear', () => {
    expect(callGuard({ command: 'bash' })).toBe(false);
    expect(callGuard({ command: 'zsh' })).toBe(false);
    expect(callGuard({ command: 'fish' })).toBe(false);
  });

  test('no ground truth available falls back to the heuristic verdict', () => {
    expect(callGuard({ command: null })).toBe(false);
    expect(callGuard({ command: 'claude', backend: 'pty' })).toBe(false);
    expect(callGuard({ command: 'claude', enabled: false })).toBe(false);
  });
});
