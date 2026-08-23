const fs = require('fs');
const path = require('path');

function loadAtlasPortfolioUI() {
  const rendererSource = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'atlas-portfolio-renderer.js'), 'utf8');
  const uiSource = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'atlas-portfolio.js'), 'utf8');
  const windowStub = {};
  new Function('window', rendererSource)(windowStub);
  new Function('window', uiSource)(windowStub);
  return windowStub;
}

function installDocumentStub() {
  const previousDocument = global.document;
  const modal = {
    classList: { add: jest.fn(), remove: jest.fn() },
    querySelector: jest.fn(() => ({ focus: jest.fn() }))
  };
  global.document = {
    getElementById: jest.fn(() => modal),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn()
  };
  return () => {
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
  };
}

function abortableFetch() {
  return (url, options = {}) => new Promise((resolve, reject) => {
    options.signal?.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
}

function contrastRatio(foreground, background) {
  const luminance = (hex) => hex.match(/[a-f\d]{2}/gi)
    .map((part) => Number.parseInt(part, 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
    .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
  const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe('AtlasPortfolioUI', () => {
  let AtlasPortfolioUI;
  let AtlasPortfolioRenderer;

  beforeAll(() => {
    const loaded = loadAtlasPortfolioUI();
    AtlasPortfolioUI = loaded.AtlasPortfolioUI;
    AtlasPortfolioRenderer = loaded.AtlasPortfolioRenderer;
  });

  test('builds a bounded portfolio request from the visible filters', () => {
    const ui = new AtlasPortfolioUI(null);
    ui.query = 'merge planes';
    ui.kind = 'game';
    ui.platform = 'roblox';
    ui.limit = 25;
    ui.includeRemote = true;
    ui.includeForks = false;
    ui.includeArchived = true;

    const request = new URL(ui.buildRequestPath(), 'http://localhost');

    expect(request.pathname).toBe('/api/atlas/portfolio');
    expect(Object.fromEntries(request.searchParams)).toEqual({
      limit: '25',
      maxExamples: '4',
      includeRemote: 'true',
      includeForks: 'false',
      includeArchived: 'true',
      q: 'merge planes',
      kind: 'game',
      platform: 'roblox'
    });
  });

  test('falls back to ten repositories when state contains an unsupported limit', () => {
    const ui = new AtlasPortfolioUI(null);
    ui.limit = 500;

    const request = new URL(ui.buildRequestPath(), 'http://localhost');

    expect(request.searchParams.get('limit')).toBe('10');
  });

  test('opens without waiting for the initial report request', async () => {
    const restoreDocument = installDocumentStub();
    const previousFetch = global.fetch;
    global.fetch = jest.fn(abortableFetch());
    const ui = new AtlasPortfolioUI(null);
    ui.render = jest.fn();

    try {
      await expect(ui.show()).resolves.toBe(true);

      expect(ui.visible).toBe(true);
      expect(ui.loading).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);

      ui.hide();
      await new Promise((resolve) => setImmediate(resolve));
      expect(ui.loading).toBe(false);
      expect(ui.needsRefresh).toBe(true);
    } finally {
      if (previousFetch === undefined) delete global.fetch;
      else global.fetch = previousFetch;
      restoreDocument();
    }
  });

  test('retries an interrupted cached refresh instead of reopening forever loading', async () => {
    const restoreDocument = installDocumentStub();
    const previousFetch = global.fetch;
    const freshReport = { repositoryCount: 2, eligibleCount: 2, repositories: [] };
    global.fetch = jest.fn()
      .mockImplementationOnce(abortableFetch())
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, report: freshReport })
      });
    const ui = new AtlasPortfolioUI(null);
    ui.report = { repositoryCount: 1, eligibleCount: 1, repositories: [] };
    ui.render = jest.fn();

    try {
      const interrupted = ui.refresh();
      ui.hide();
      await interrupted;

      expect(ui.loading).toBe(false);
      expect(ui.needsRefresh).toBe(true);

      await expect(ui.show()).resolves.toBe(true);
      await new Promise((resolve) => setImmediate(resolve));

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(ui.loading).toBe(false);
      expect(ui.needsRefresh).toBe(false);
      expect(ui.report).toBe(freshReport);
      ui.hide();
    } finally {
      if (previousFetch === undefined) delete global.fetch;
      else global.fetch = previousFetch;
      restoreDocument();
    }
  });

  test('keeps the portfolio visible when Projects Board cannot open', async () => {
    const showToast = jest.fn();
    const ui = new AtlasPortfolioUI({ showToast });
    ui.hide = jest.fn();

    await expect(ui.showProjectsBoard()).resolves.toBe(false);

    expect(ui.hide).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('Projects Board is unavailable.', 'error');
  });

  test('returns to a visible Projects Board without waiting for its refresh', async () => {
    let finishRefresh;
    const projectsBoardUI = {
      visible: false,
      show: () => {
        projectsBoardUI.visible = true;
        return new Promise((resolve) => {
          finishRefresh = resolve;
        });
      }
    };
    const ui = new AtlasPortfolioUI({ projectsBoardUI });
    ui.hide = jest.fn();

    const transition = ui.showProjectsBoard();
    await new Promise((resolve) => setImmediate(resolve));

    await expect(transition).resolves.toBe(true);
    expect(ui.hide).toHaveBeenCalledTimes(1);
    finishRefresh();
  });

  test('renders evidence metrics and representative paths without local checkout paths', () => {
    const renderer = new AtlasPortfolioRenderer();
    const html = renderer.renderReportHtml({
      includeRemote: false,
      eligibleCount: 3,
      repositoryCount: 1,
      omittedCount: 2,
      repositories: [{
        repository: {
          id: 'merge-planes',
          name: 'Merge Planes',
          repo: 'studio/merge-planes',
          summary: 'Merge and defend.',
          kind: 'game',
          platforms: ['roblox'],
          languages: ['Luau'],
          quality: 5
        },
        evidence: {
          available: true,
          history: { commitCount: 42, authorIdentityCount: 3, tagCount: 2 },
          code: {
            sourceFiles: 100,
            testFiles: 20,
            testToSourceRatio: 0.2,
            languages: [{ language: 'Luau', files: 120 }]
          },
          practices: {
            hasTests: true,
            ciConfigCount: 1,
            hasCodebaseDocumentation: true,
            hasAgentInstructions: true,
            hasDependencyLockfile: false
          },
          examples: [{
            path: 'src/server/MergeService.luau',
            kind: 'curated',
            recentCommitTouches: 9,
            nonBlankLines: 180,
            curated: { topic: 'merge-system', quality: 5 }
          }]
        }
      }]
    });

    expect(html).toContain('42');
    expect(html).toContain('Source files');
    expect(html).toContain('src/server/MergeService.luau');
    expect(html).toContain('curated merge-system 5/5');
    expect(html).toContain('Tests: Present');
    expect(html).toContain('Lockfile: Absent');
    expect(html).not.toContain('/home/');
  });

  test('keeps small bold action text above WCAG AA contrast on hover', () => {
    const stylesheet = fs.readFileSync(
      path.join(__dirname, '..', '..', 'client', 'styles', 'atlas-portfolio.css'),
      'utf8'
    );
    const hoverRule = stylesheet.match(/\.atlas-portfolio-secondary-button:hover,[\s\S]*?\.projects-board-portfolio-button:hover\s*\{([^}]*)\}/);
    const background = hoverRule?.[1].match(/background:\s*(#[a-f\d]{6})/i)?.[1];

    expect(background).toBeTruthy();
    expect(contrastRatio('#ffffff', background)).toBeGreaterThanOrEqual(4.5);
  });

  test('keeps portfolio card headers off the app shell header surface', () => {
    const stylesheet = fs.readFileSync(
      path.join(__dirname, '..', '..', 'client', 'styles', 'atlas-portfolio.css'),
      'utf8'
    );
    const cardHeaderRule = stylesheet.match(/\.atlas-portfolio-card > header\s*\{([^}]*)\}/)?.[1] || '';

    expect(cardHeaderRule).toMatch(/height:\s*auto/);
    expect(cardHeaderRule).toMatch(/padding:\s*0/);
    expect(cardHeaderRule).toMatch(/border-bottom:\s*0/);
    expect(cardHeaderRule).toMatch(/background:\s*transparent/);
  });

  test('escapes repository metadata and example paths', () => {
    const renderer = new AtlasPortfolioRenderer();
    const html = renderer.renderReportHtml({
      repositoryCount: 1,
      eligibleCount: 1,
      omittedCount: 0,
      repositories: [{
        repository: {
          name: '<img src=x onerror=alert(1)>',
          summary: '<script>alert(2)</script>'
        },
        evidence: {
          available: true,
          history: {},
          code: { languages: [] },
          practices: {},
          examples: [{ path: '<svg/onload=alert(3)>', recentCommitTouches: 1 }]
        }
      }]
    });

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<svg');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img');
    expect(html).toContain('&lt;svg');
  });

  test('shows the API reason for evidence that is unavailable', () => {
    const renderer = new AtlasPortfolioRenderer();
    const html = renderer.renderReportHtml({
      includeRemote: true,
      repositoryCount: 1,
      eligibleCount: 1,
      omittedCount: 0,
      repositories: [{
        repository: { id: 'remote-only', name: 'Remote only' },
        evidence: { available: false, reason: 'No local Git checkout is available.' }
      }]
    });

    expect(html).toContain('Remote only');
    expect(html).toContain('No local Git checkout is available.');
  });
});
