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
    expect(html).not.toContain('/home/');
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
