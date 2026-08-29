const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentModelSwitchService } = require('../../server/agentModelSwitchService');

describe('AgentModelSwitchService', () => {
  let homeDir;
  let settingsPath;

  const writeSettings = (settings) => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
  };
  const readSettings = () => JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

  // Fake session manager: writeToSession mutates the settings file the way
  // the real Claude CLI would once it processes the slash command, so the
  // service's poll loop sees the change on its very first read — no real
  // waiting needed. sleepFn resolves instantly for the same reason.
  const createFakeSessionManager = ({ session, onWrite } = {}) => ({
    getSessionById: (id) => (id === 'work1-claude' ? session : null),
    writeToSession: jest.fn((sessionId, data) => {
      onWrite?.(sessionId, data);
      return true;
    })
  });

  const createService = (sessionManager, options = {}) =>
    new AgentModelSwitchService({
      homeDir,
      sessionManager,
      sleepFn: () => Promise.resolve(),
      pollTimeoutMs: 50,
      logger: { error: () => {} },
      ...options
    });

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-model-switch-home-'));
    settingsPath = path.join(homeDir, '.claude', 'settings.json');
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  test('switches model + effort, then restores the persisted default', async () => {
    writeSettings({ model: 'sonnet', effortLevel: 'medium', theme: 'dark' });
    const session = { type: 'claude', status: 'waiting' };
    const sm = createFakeSessionManager({
      session,
      onWrite: (sessionId, data) => {
        const current = readSettings();
        if (data.startsWith('/model ')) current.model = data.replace('/model ', '').replace('\r', '');
        if (data.startsWith('/effort ')) current.effortLevel = data.replace('/effort ', '').replace('\r', '');
        fs.writeFileSync(settingsPath, JSON.stringify(current));
      }
    });

    const result = await createService(sm).switchClaudeSession({
      sessionId: 'work1-claude',
      model: 'opus',
      effort: 'high'
    });

    expect(result).toMatchObject({
      ok: true,
      model: 'opus',
      effort: 'high',
      defaultChangeDetected: true,
      defaultRestored: true
    });
    // The persisted default reverted to what it was before the switch...
    expect(readSettings()).toMatchObject({ model: 'sonnet', effortLevel: 'medium', theme: 'dark' });
    // ...but the live session was actually sent the new model/effort.
    expect(sm.writeToSession).toHaveBeenCalledWith('work1-claude', '/model opus\r');
    expect(sm.writeToSession).toHaveBeenCalledWith('work1-claude', '/effort high\r');
  });

  test('deletes the field on restore when it was absent before the switch', async () => {
    writeSettings({ theme: 'dark' }); // no model/effortLevel set yet
    const session = { type: 'claude', status: 'waiting' };
    const sm = createFakeSessionManager({
      session,
      onWrite: (sessionId, data) => {
        const current = readSettings();
        current.model = 'opus';
        fs.writeFileSync(settingsPath, JSON.stringify(current));
      }
    });

    const result = await createService(sm).switchClaudeSession({ sessionId: 'work1-claude', model: 'opus' });

    expect(result.defaultRestored).toBe(true);
    expect(readSettings()).toEqual({ theme: 'dark' });
  });

  test('rejects a session that is not found', async () => {
    const sm = createFakeSessionManager({ session: null });
    const result = await createService(sm).switchClaudeSession({ sessionId: 'nope', model: 'opus' });
    expect(result).toEqual({ ok: false, error: 'SESSION_NOT_FOUND' });
  });

  test('rejects a non-Claude session', async () => {
    const sm = createFakeSessionManager({ session: { type: 'codex', status: 'waiting' } });
    const result = await createService(sm).switchClaudeSession({ sessionId: 'work1-claude', model: 'opus' });
    expect(result).toEqual({ ok: false, error: 'UNSUPPORTED_SESSION_TYPE' });
  });

  test('refuses to interrupt a busy session', async () => {
    const sm = createFakeSessionManager({ session: { type: 'claude', status: 'busy' } });
    const result = await createService(sm).switchClaudeSession({ sessionId: 'work1-claude', model: 'opus' });
    expect(result).toEqual({ ok: false, error: 'SESSION_BUSY' });
    expect(sm.writeToSession).not.toHaveBeenCalled();
  });

  test('reports defaultChangeDetected: false on timeout without throwing, and still restores', async () => {
    writeSettings({ model: 'sonnet' });
    // onWrite intentionally does nothing — simulates a hung/unresponsive CLI.
    const sm = createFakeSessionManager({ session: { type: 'claude', status: 'waiting' } });

    const result = await createService(sm).switchClaudeSession({ sessionId: 'work1-claude', model: 'opus' });

    expect(result.ok).toBe(true);
    expect(result.defaultChangeDetected).toBe(false);
    expect(readSettings()).toEqual({ model: 'sonnet' });
  });

  test('throws when called with neither model nor effort', async () => {
    const sm = createFakeSessionManager({ session: { type: 'claude', status: 'waiting' } });
    await expect(createService(sm).switchClaudeSession({ sessionId: 'work1-claude' })).rejects.toThrow(
      'model or effort is required'
    );
  });

  test('getInstance() returns the same singleton', () => {
    expect(AgentModelSwitchService.getInstance()).toBe(AgentModelSwitchService.getInstance());
  });

  describe('switchCommanderSession', () => {
    const createFakeCommanderService = ({ session, activeProvider = 'claude', isReady = true, onWrite } = {}) => ({
      session,
      activeProvider,
      isReady,
      sendInput: jest.fn((data) => {
        onWrite?.(data);
        return true;
      })
    });

    test('switches model + effort, then restores the persisted default', async () => {
      writeSettings({ model: 'sonnet', effortLevel: 'medium' });
      const commanderService = createFakeCommanderService({
        session: { id: 'commander' },
        onWrite: (data) => {
          const current = readSettings();
          if (data.startsWith('/model ')) current.model = data.replace('/model ', '').replace('\r', '');
          if (data.startsWith('/effort ')) current.effortLevel = data.replace('/effort ', '').replace('\r', '');
          fs.writeFileSync(settingsPath, JSON.stringify(current));
        }
      });

      const result = await createService(null).switchCommanderSession({
        commanderService,
        model: 'opus',
        effort: 'high'
      });

      expect(result).toMatchObject({ ok: true, defaultChangeDetected: true, defaultRestored: true });
      expect(readSettings()).toEqual({ model: 'sonnet', effortLevel: 'medium' });
      expect(commanderService.sendInput).toHaveBeenCalledWith('/model opus\r', { bypassLaunchQueue: true });
      expect(commanderService.sendInput).toHaveBeenCalledWith('/effort high\r', { bypassLaunchQueue: true });
    });

    test('rejects when Commander has no running session', async () => {
      const commanderService = createFakeCommanderService({ session: null });
      const result = await createService(null).switchCommanderSession({ commanderService, model: 'opus' });
      expect(result).toEqual({ ok: false, error: 'SESSION_NOT_FOUND' });
    });

    test('rejects a non-Claude Commander instance', async () => {
      const commanderService = createFakeCommanderService({ session: {}, activeProvider: 'codex' });
      const result = await createService(null).switchCommanderSession({ commanderService, model: 'opus' });
      expect(result).toEqual({ ok: false, error: 'UNSUPPORTED_SESSION_TYPE', type: 'codex' });
    });

    test('refuses to interrupt a not-yet-ready Commander', async () => {
      const commanderService = createFakeCommanderService({ session: {}, isReady: false });
      const result = await createService(null).switchCommanderSession({ commanderService, model: 'opus' });
      expect(result).toEqual({ ok: false, error: 'SESSION_BUSY' });
      expect(commanderService.sendInput).not.toHaveBeenCalled();
    });
  });
});
