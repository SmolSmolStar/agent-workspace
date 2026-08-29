const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentModelCatalogService } = require('../../server/agentModelCatalogService');

describe('AgentModelCatalogService', () => {
  let dir;
  let catalogPath;
  let fakeHomeDir;

  const writeCatalog = (data) => fs.writeFileSync(catalogPath, JSON.stringify(data));
  const writeCodexCache = (data) => {
    const codexDir = path.join(fakeHomeDir, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'models_cache.json'), JSON.stringify(data));
  };

  // homeDir defaults to a fresh, empty temp dir (no .codex/models_cache.json)
  // so these tests never read the real developer machine's actual Codex
  // cache — only writeCodexCache() above puts one there deliberately.
  const createService = (options = {}) =>
    new AgentModelCatalogService({
      catalogPath,
      homeDir: fakeHomeDir,
      logger: { error: () => {} },
      setIntervalFn: () => ({ unref: () => {} }),
      ...options
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-model-catalog-'));
    catalogPath = path.join(dir, 'catalog.json');
    fakeHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-model-catalog-home-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(fakeHomeDir, { recursive: true, force: true });
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
      { id: 'opus', label: 'Opus 5', efforts: ['low', 'high'], tiers: [] },
      { id: 'sonnet', label: 'Sonnet 5', efforts: ['medium'], tiers: [] }
    ]);
  });

  test('an explicit empty efforts array overrides the provider default (e.g. Haiku has none)', () => {
    writeCatalog({
      claude: {
        label: 'Claude',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        models: [
          { id: 'opus', label: 'Opus 5' },
          { id: 'haiku', label: 'Haiku 4.5', efforts: [] }
        ]
      }
    });

    const { providers } = createService().getCatalog();

    expect(providers.claude.models).toEqual([
      { id: 'opus', label: 'Opus 5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], tiers: [] },
      { id: 'haiku', label: 'Haiku 4.5', efforts: [], tiers: [] }
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

    expect(providers.grok.models).toEqual([{ id: 'grok-4.6', label: 'Grok 4.6', efforts: ['low'], tiers: [] }]);
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

  describe('enrichCodexFromLiveCache', () => {
    beforeEach(() => {
      writeCatalog({
        codex: {
          label: 'Codex',
          efforts: ['low', 'medium'],
          models: [{ id: 'curated-fallback', label: 'Curated Fallback' }]
        }
      });
    });

    test('replaces the curated codex models with the live ~/.codex/models_cache.json list', () => {
      // Cache lists Luna before Sol, but the curated display order puts
      // Sol first regardless of cache order.
      writeCodexCache({
        models: [
          {
            slug: 'gpt-5.6-luna',
            display_name: 'GPT-5.6-Luna',
            supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }]
          },
          {
            slug: 'gpt-5.6-sol',
            display_name: 'GPT-5.6-Sol',
            supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }]
          }
        ]
      });

      const { providers } = createService().getCatalog();

      expect(providers.codex.models).toEqual([
        { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', efforts: ['low', 'ultra'], tiers: [] },
        { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', efforts: ['low', 'medium', 'high'], tiers: [] }
      ]);
      expect(providers.codex.liveSource).toContain('models_cache.json');
    });

    test('sorts by the curated display order: flagships, then Spark, then utility models, then the rest', () => {
      const model = (slug) => ({ slug, display_name: slug, supported_reasoning_levels: [{ effort: 'medium' }] });
      // Deliberately scrambled input order.
      writeCodexCache({
        models: [
          model('gpt-5.4-mini'),
          model('codex-auto-review'),
          model('gpt-5.6-luna'),
          model('gpt-reserve'),
          model('gpt-5.3-codex-spark'),
          model('gpt-5.6-sol'),
          model('gpt-5.5'),
          model('gpt-5.6-terra')
        ]
      });

      const { providers } = createService().getCatalog();

      expect(providers.codex.models.map((m) => m.id)).toEqual([
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
        'gpt-5.3-codex-spark',
        'codex-auto-review',
        'gpt-reserve',
        // Unranked models keep their original (cache) relative order.
        'gpt-5.4-mini',
        'gpt-5.5'
      ]);
    });

    test('drops models with no supported reasoning levels instead of shipping an empty effort list', () => {
      writeCodexCache({
        models: [
          { slug: 'no-efforts', display_name: 'No Efforts', supported_reasoning_levels: [] },
          { slug: 'has-efforts', display_name: 'Has Efforts', supported_reasoning_levels: [{ effort: 'medium' }] }
        ]
      });

      const { providers } = createService().getCatalog();

      expect(providers.codex.models).toEqual([{ id: 'has-efforts', label: 'Has Efforts', efforts: ['medium'], tiers: [] }]);
    });

    test('exposes a Normal + Priority tier picker only for models that offer one', () => {
      writeCodexCache({
        models: [
          {
            slug: 'gpt-5.6-luna',
            display_name: 'GPT-5.6-Luna',
            supported_reasoning_levels: [{ effort: 'medium' }],
            service_tiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }]
          },
          {
            slug: 'gpt-5.4-mini',
            display_name: 'GPT-5.4-Mini',
            supported_reasoning_levels: [{ effort: 'medium' }],
            service_tiers: []
          }
        ]
      });

      const { providers } = createService().getCatalog();

      const luna = providers.codex.models.find((m) => m.id === 'gpt-5.6-luna');
      const mini = providers.codex.models.find((m) => m.id === 'gpt-5.4-mini');
      expect(luna.tiers).toEqual([
        { id: 'default', label: 'Normal' },
        { id: 'priority', label: 'Fast' }
      ]);
      // No tiers beyond "Normal" - drop the picker entirely rather than
      // show a single-option selector.
      expect(mini.tiers).toEqual([]);
    });

    test('skips hidden models', () => {
      writeCodexCache({
        models: [
          { slug: 'hidden-one', display_name: 'Hidden', visibility: 'hidden', supported_reasoning_levels: [{ effort: 'low' }] },
          { slug: 'visible-one', display_name: 'Visible', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }] }
        ]
      });

      const { providers } = createService().getCatalog();

      expect(providers.codex.models.map((m) => m.id)).toEqual(['visible-one']);
    });

    test('falls back to the curated list when no cache file exists', () => {
      const { providers } = createService().getCatalog();
      expect(providers.codex.models).toEqual([{ id: 'curated-fallback', label: 'Curated Fallback', efforts: ['low', 'medium'], tiers: [] }]);
      expect(providers.codex.liveSource).toBeUndefined();
    });

    test('falls back to the curated list when the cache file is malformed, without throwing', () => {
      fs.mkdirSync(path.join(fakeHomeDir, '.codex'), { recursive: true });
      fs.writeFileSync(path.join(fakeHomeDir, '.codex', 'models_cache.json'), '{ not valid json');

      const { providers } = createService().getCatalog();

      expect(providers.codex.models).toEqual([{ id: 'curated-fallback', label: 'Curated Fallback', efforts: ['low', 'medium'], tiers: [] }]);
    });

    test('does nothing when the catalog has no codex provider at all', () => {
      writeCatalog({ claude: { label: 'Claude', efforts: ['low'], models: [{ id: 'opus', label: 'Opus 5' }] } });
      writeCodexCache({ models: [{ slug: 'x', display_name: 'X', supported_reasoning_levels: [{ effort: 'low' }] }] });

      const { providers } = createService().getCatalog();

      expect(providers.codex).toBeUndefined();
      expect(providers.claude.models).toEqual([{ id: 'opus', label: 'Opus 5', efforts: ['low'], tiers: [] }]);
    });
  });
});
