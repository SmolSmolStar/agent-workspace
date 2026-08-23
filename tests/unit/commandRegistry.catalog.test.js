const commandRegistry = require('../../server/commandRegistry');

describe('CommandRegistry catalog metadata', () => {
  beforeAll(() => {
    commandRegistry.init({
      io: { emit: jest.fn() },
      sessionManager: {
        sessions: new Map(),
        getSessionById: () => null,
        writeToSession: () => false
      },
      workspaceManager: {
        listWorkspaces: async () => []
      }
    });
  });

  test('getCatalog returns flat commands with metadata', () => {
    const catalog = commandRegistry.getCatalog();
    expect(Array.isArray(catalog)).toBe(true);
    expect(catalog.length).toBeGreaterThan(0);

    const listSessions = catalog.find((cmd) => cmd.name === 'list-sessions');
    expect(listSessions).toBeTruthy();
    expect(listSessions.category).toBe('sessions');
    expect(listSessions.safetyLevel).toBe('safe');
    expect(typeof listSessions.safetyNotes).toBe('string');
    expect(listSessions.safetyNotes.length).toBeGreaterThan(0);
    expect(Array.isArray(listSessions.surfaces)).toBe(true);
    expect(listSessions.surfaces).toContain('voice');
    expect(listSessions.surfaces).toContain('commander');
  });

  test('getCapabilities keeps grouped shape and includes metadata', () => {
    const capabilities = commandRegistry.getCapabilities();
    expect(capabilities).toBeTruthy();
    expect(Array.isArray(capabilities.sessions)).toBe(true);
    expect(capabilities.sessions.length).toBeGreaterThan(0);

    const first = capabilities.sessions[0];
    expect(first).toHaveProperty('name');
    expect(first).toHaveProperty('description');
    expect(first).toHaveProperty('safetyLevel');
    expect(first).toHaveProperty('safetyNotes');
    expect(first).toHaveProperty('surfaces');
  });

  test('advertised aliases resolve to the canonical command for lookup and execution', async () => {
    const handler = jest.fn(() => ({ message: 'Alias target ran' }));
    commandRegistry.register('test-alias-target', {
      category: 'test',
      description: 'Alias execution target',
      aliases: ['test-shortcut'],
      params: [],
      handler
    });

    expect(commandRegistry.getCommand(' TEST-SHORTCUT ')?.name).toBe('test-alias-target');
    await expect(commandRegistry.execute(' TEST-SHORTCUT ')).resolves.toEqual({
      success: true,
      message: 'Alias target ran'
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('rejects aliases that would make command resolution ambiguous', () => {
    commandRegistry.register('test-first-alias-target', {
      category: 'test',
      description: 'First alias target',
      aliases: ['shared-test-shortcut'],
      params: [],
      handler: () => ({})
    });

    expect(() => commandRegistry.register('test-second-alias-target', {
      category: 'test',
      description: 'Second alias target',
      aliases: ['shared-test-shortcut'],
      params: [],
      handler: () => ({})
    })).toThrow('Alias already registered: shared-test-shortcut');
  });
});
