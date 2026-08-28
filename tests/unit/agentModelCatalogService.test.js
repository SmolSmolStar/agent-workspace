const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentModelCatalogService } = require('../../server/agentModelCatalogService');

describe('AgentModelCatalogService', () => {
  let dir;
  let catalogPath;

  const writeCatalog = (data) => fs.writeFileSync(catalogPath, JSON.stringify(data));

  const createService = (options = {}) =>
    new AgentModelCatalogService({
      catalogPath,
      logger: { error: () => {} },
      setIntervalFn: () => ({ unref: () => {} }),
      ...options
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-model-catalog-'));
    catalogPath = path.join(dir, 'catalog.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('loads models + efforts per provider, falling back to provider-level efforts', () => {
    writeCatalog({
      claude: {
        label: 'Claude',
        efforts: ['low', 'high'],
        models: [
          { id: 'opus', label: 'Opus 5' },
          { id: 'sonnet', label: 'Sonnet 5', efforts: ['medium'] }
        ]
      }
    });

    const { providers } = createService().getCatalog();

    expect(providers.claude.label).toBe('Claude');
    expect(providers.claude.models).toEqual([
      { id: 'opus', label: 'Opus 5', efforts: ['low', 'high'] },
      { id: 'sonnet', label: 'Sonnet 5', efforts: ['medium'] }
    ]);
  });

  test('skips keys starting with underscore (comments) and malformed provider entries', () => {
    writeCatalog({
      _comment: 'this is not a provider',
      codex: { label: 'Codex', efforts: ['low'], models: [{ id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' }] },
      broken: 'not an object'
    });

    const { providers } = createService().getCatalog();

    expect(Object.keys(providers)).toEqual(['codex']);
  });

  test('drops model entries with no id instead of throwing', () => {
    writeCatalog({
      grok: { label: 'Grok', efforts: ['low'], models: [{ label: 'no id here' }, { id: 'grok-4.6', label: 'Grok 4.6' }] }
    });

    const { providers } = createService().getCatalog();

    expect(providers.grok.models).toEqual([{ id: 'grok-4.6', label: 'Grok 4.6', efforts: ['low'] }]);
  });

  test('keeps serving the last good catalog when the file goes missing or malformed', () => {
    writeCatalog({ claude: { label: 'Claude', efforts: ['low'], models: [{ id: 'opus', label: 'Opus 5' }] } });
    const service = createService();
    service.getCatalog();

    fs.writeFileSync(catalogPath, '{ not valid json');
    const { providers, lastError } = service.refresh();

    expect(lastError).toBeTruthy();
    expect(providers.claude.models[0].id).toBe('opus');
  });

  test('returns an empty catalog (not a crash) when the file has never loaded successfully', () => {
    // catalogPath was never written
    const { providers, lastError } = createService().getCatalog();

    expect(providers).toEqual({});
    expect(lastError).toBeTruthy();
  });

  test('refresh() re-reads the file and updates lastLoadedAt', () => {
    writeCatalog({ claude: { label: 'Claude', efforts: ['low'], models: [{ id: 'opus', label: 'Opus 5' }] } });
    let tick = 1000;
    const service = createService({ now: () => tick });
    const first = service.getCatalog();

    writeCatalog({ claude: { label: 'Claude', efforts: ['low'], models: [{ id: 'sonnet', label: 'Sonnet 5' }] } });
    tick = 2000;
    const second = service.refresh();

    expect(first.lastLoadedAt).toBe(1000);
    expect(second.lastLoadedAt).toBe(2000);
    expect(second.providers.claude.models[0].id).toBe('sonnet');
  });

  test('startBackgroundRefresh() loads immediately and only arms one timer', () => {
    writeCatalog({ claude: { label: 'Claude', efforts: ['low'], models: [{ id: 'opus', label: 'Opus 5' }] } });
    let calls = 0;
    const setIntervalFn = () => {
      calls += 1;
      return { unref: () => {} };
    };
    const service = createService({ setIntervalFn });

    service.startBackgroundRefresh();
    service.startBackgroundRefresh();

    expect(calls).toBe(1);
    expect(service.getCatalog().providers.claude).toBeTruthy();
  });

  test('getInstance() returns the same singleton', () => {
    expect(AgentModelCatalogService.getInstance()).toBe(AgentModelCatalogService.getInstance());
  });
});
