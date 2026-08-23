const fs = require('fs');
const os = require('os');
const path = require('path');

const RepoAtlasService = require('../../server/repoAtlasService');
const store = require('../../server/atlas/atlasStore');
const discovery = require('../../server/atlas/atlasDiscovery');

describe('RepoAtlasService', () => {
  let tmpDir;
  let repoDir;
  let atlas;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-test-'));
    repoDir = path.join(tmpDir, 'repos', 'acme-tycoon');
    fs.mkdirSync(repoDir, { recursive: true });
    process.env.AGENT_WORKSPACE_ATLAS_DIR = path.join(tmpDir, 'atlas');

    atlas = new RepoAtlasService();
    store.saveDiscoveryCache([{
      __source: 'discovery',
      id: 'acme-tycoon',
      name: 'acme-tycoon',
      repo: 'owner/acme-tycoon',
      kind: 'game',
      languages: ['TypeScript'],
      localPath: repoDir,
      cloned: true,
      lastActivity: new Date().toISOString()
    }]);
  });

  afterEach(() => {
    delete process.env.AGENT_WORKSPACE_ATLAS_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('discovery alone produces a usable entry', () => {
    const entry = atlas.getEntry('acme-tycoon');
    expect(entry.kind).toBe('game');
    expect(entry.visibility).toBe('private');
    expect(entry.sources).toEqual(['discovery']);
  });

  test('an in-repo manifest layers over discovery', () => {
    fs.writeFileSync(path.join(repoDir, '.repo-atlas.json'), JSON.stringify({
      id: 'acme-tycoon',
      summary: 'Multiplayer zoo tycoon',
      highlights: [{ topic: 'data-compression', quality: 5, notes: 'bitpacked saves' }]
    }));
    atlas.invalidate();

    const entry = atlas.getEntry('acme-tycoon');
    expect(entry.summary).toBe('Multiplayer zoo tycoon');
    expect(entry.kind).toBe('game');
    expect(entry.highlights[0].topic).toBe('data-compression');
    expect(entry.sources).toEqual(['discovery', 'manifest']);
  });

  test('a manifest in any checkout alias layers over canonical discovery', () => {
    const aliasDir = path.join(tmpDir, 'repos', 'acme-tycoon-work-feature');
    fs.mkdirSync(aliasDir, { recursive: true });
    fs.writeFileSync(path.join(aliasDir, '.repo-atlas.json'), JSON.stringify({
      id: 'acme-tycoon',
      summary: 'Manifest from another checkout'
    }));
    store.saveDiscoveryCache([{
      __source: 'discovery',
      id: 'acme-tycoon',
      name: 'acme-tycoon',
      repo: 'owner/acme-tycoon',
      localPath: repoDir,
      localPaths: [repoDir, aliasDir],
      cloned: true
    }]);
    atlas.invalidate();

    const entry = atlas.getEntry('owner/acme-tycoon');
    expect(entry.summary).toBe('Manifest from another checkout');
    expect(entry.sources).toEqual(['discovery', 'manifest']);
  });

  test('remote slugs resolve to the existing entry for curation', () => {
    expect(atlas.getEntry('owner/acme-tycoon').id).toBe('acme-tycoon');

    atlas.addHighlight('owner/acme-tycoon', { topic: 'testing', quality: 5 });

    expect(Object.keys(store.loadEntries())).toEqual(['acme-tycoon']);
    expect(atlas.getEntry('acme-tycoon').highlights[0].topic).toBe('testing');
  });

  test('the registry overrides the manifest — your opinion wins', () => {
    fs.writeFileSync(path.join(repoDir, '.repo-atlas.json'), JSON.stringify({
      id: 'acme-tycoon',
      summary: 'From the repo',
      maturity: 'production'
    }));
    atlas.setEntry('acme-tycoon', { summary: 'From you', maturity: 'prototype' });

    const entry = atlas.getEntry('acme-tycoon');
    expect(entry.summary).toBe('From you');
    expect(entry.maturity).toBe('prototype');
    expect(entry.sources).toEqual(['discovery', 'manifest', 'registry']);
  });

  test('addHighlight persists and replaces the same topic', () => {
    atlas.addHighlight('acme-tycoon', { topic: 'multiplayer', quality: 3, notes: 'chatty' });
    atlas.addHighlight('acme-tycoon', { topic: 'networking', quality: 5, paths: ['src/net'], notes: 'rewritten' });

    const entry = new RepoAtlasService().getEntry('acme-tycoon');
    expect(entry.highlights).toEqual([
      { topic: 'networking', quality: 5, paths: ['src/net'], notes: 'rewritten' }
    ]);
  });

  test('addAvoid records a do-not-copy note without removing the repo', () => {
    atlas.addAvoid('acme-tycoon', { topic: 'ui', reason: 'hand-rolled' });
    const entry = atlas.getEntry('acme-tycoon');
    expect(entry.avoid).toEqual([{ topic: 'ui', reason: 'hand-rolled' }]);
    expect(atlas.find('ui')).toEqual([]);
  });

  test('entries can be recorded for repos that were never cloned', () => {
    atlas.setEntry('never-cloned', {
      name: 'never-cloned',
      summary: 'lives only on GitHub',
      remoteUrl: 'https://github.com/owner/never-cloned'
    });
    atlas.addHighlight('never-cloned', { topic: 'auth', quality: 4 });

    const hits = atlas.find('auth');
    expect(hits).toHaveLength(1);
    expect(hits[0].cloned).toBe(false);
    expect(hits[0].remoteUrl).toBe('https://github.com/owner/never-cloned');
  });

  test('compile writes an audience bundle and withholds private entries', () => {
    atlas.setAudience({ id: 'core-team', label: 'Core team' });
    atlas.setEntry('acme-tycoon', { visibility: 'team', groups: ['core-team'] });
    atlas.setEntry('secret-thing', { name: 'secret', visibility: 'private' });

    const result = atlas.compile('core-team');
    expect(result.counts.included).toBe(1);
    expect(result.bundle.entries[0].id).toBe('acme-tycoon');

    const written = JSON.parse(fs.readFileSync(result.written[0], 'utf8'));
    expect(written.entries.map((e) => e.id)).toEqual(['acme-tycoon']);
    expect(JSON.stringify(written)).not.toContain(repoDir);
  });

  test('compile --dry-run writes nothing', () => {
    atlas.setEntry('acme-tycoon', { visibility: 'public' });
    const result = atlas.compile('core-team', { write: false });
    expect(result.written).toEqual([]);
    expect(fs.existsSync(store.bundlesDir())).toBe(false);
  });

  test('initManifest seeds a manifest from what is already known', () => {
    const { path: manifestPath, entry } = atlas.initManifest(repoDir);
    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(entry.id).toBe('acme-tycoon');
    expect(entry.kind).toBe('game');
    expect(entry.visibility).toBe('private');
  });

  test('refresh with both scanners disabled clears the map instead of hanging', async () => {
    const result = await atlas.refresh({ scanLocal: false, scanGitHub: false });
    expect(result.totalCount).toBe(0);
    expect(atlas.getEntries()).toEqual([]);
  });

  test('getStatus reports where data lives and how much is curated', () => {
    atlas.addHighlight('acme-tycoon', { topic: 'testing', quality: 4 });
    const status = atlas.getStatus();
    expect(status.entryCount).toBe(1);
    expect(status.clonedCount).toBe(1);
    expect(status.highlightCount).toBe(1);
    expect(status.registryDir).toContain('registry');
    expect(status.curatedCount).toBe(1);
  });
});

describe('Repo Atlas discovery identity', () => {
  test('duplicate clones collapse by remote slug and retain every local path', () => {
    const github = [{
      id: 'agent-workspace',
      name: 'agent-workspace',
      repo: 'web3dev1337/agent-workspace',
      summary: 'Agent orchestrator',
      cloned: false
    }];
    const primary = {
      id: 'agent-workspace',
      name: 'claude-orchestrator',
      repo: 'web3dev1337/agent-workspace',
      localPath: '/repos/agent-workspace',
      localPaths: ['/repos/agent-workspace', '/repos/agent-workspace/master', '/repos/agent-workspace/work1'],
      worktreeLayout: true,
      cloned: true
    };
    const feature = {
      id: 'agent-workspace',
      name: 'work-pr1029-jarvis',
      repo: 'Web3Dev1337/Agent-Workspace',
      localPath: '/repos/agent-workspace/work-pr1029-jarvis',
      worktreeLayout: false,
      cloned: true
    };

    const forward = discovery.mergeDiscovery([feature, primary], github);
    const reverse = discovery.mergeDiscovery([primary, feature], github);

    expect(forward).toEqual(reverse);
    expect(forward).toHaveLength(1);
    expect(forward[0].name).toBe('agent-workspace');
    expect(forward[0].repo).toBe('web3dev1337/agent-workspace');
    expect(forward[0].localPath).toBe('/repos/agent-workspace');
    expect(forward[0].localPaths).toEqual([
      '/repos/agent-workspace',
      '/repos/agent-workspace/master',
      '/repos/agent-workspace/work1',
      '/repos/agent-workspace/work-pr1029-jarvis'
    ]);
  });

  test('same-named repositories under different owners remain distinct', () => {
    const entries = discovery.mergeDiscovery([
      { id: 'shared', name: 'shared', repo: 'alice/shared', localPath: '/repos/alice/shared' },
      { id: 'shared', name: 'shared', repo: 'bob/shared', localPath: '/repos/bob/shared' }
    ], []);

    expect(entries.map((entry) => entry.id)).toEqual(['alice-shared', 'bob-shared']);
    expect(entries.map((entry) => entry.repo)).toEqual(['alice/shared', 'bob/shared']);
  });

  test('local scanning retains sibling checkout paths under one project root', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-discovery-'));
    const projectRoot = path.join(tmpDir, 'sample');
    const masterDir = path.join(projectRoot, 'master');
    const workDir = path.join(projectRoot, 'work1');
    fs.mkdirSync(path.join(masterDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(workDir, '.git'), { recursive: true });

    try {
      const entries = await discovery.scanLocalRepos({
        roots: [tmpDir],
        maxDepth: 3,
        languageCensus: false
      });

      expect(entries).toHaveLength(1);
      expect(entries[0].localPath).toBe(projectRoot);
      expect(entries[0].localPaths).toEqual([projectRoot, masterDir, workDir]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
