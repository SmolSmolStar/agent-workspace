const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

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
    expect(store.loadEntries()['acme-tycoon'].repo).toBe('owner/acme-tycoon');
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

  test('a uniquely matched legacy registry id follows the discovered repository', () => {
    const currentId = 'acme-tycoon-7b4f913a';
    store.saveDiscoveryCache([{
      id: currentId,
      name: 'acme-tycoon',
      localPath: repoDir,
      rootCommits: ['a'.repeat(40)],
      cloned: true
    }]);
    store.upsertRegistryEntry('acme-tycoon', {
      rootCommits: ['a'.repeat(40)],
      highlights: [{ topic: 'testing', quality: 5 }]
    });
    atlas.invalidate();

    expect(atlas.getEntries()).toEqual([
      expect.objectContaining({
        id: currentId,
        highlights: [expect.objectContaining({ topic: 'testing', quality: 5 })],
        sources: ['discovery', 'registry']
      })
    ]);
    expect(atlas.getEntry('acme-tycoon')?.id).toBe(currentId);
    expect(atlas.validate().identityWarnings).toEqual([]);

    atlas.addAvoid(currentId, { topic: 'ui', reason: 'legacy alias write' });
    expect(Object.keys(store.loadEntries())).toEqual(['acme-tycoon']);
    expect(store.loadEntries()['acme-tycoon'].rootCommits).toEqual(['a'.repeat(40)]);
    expect(atlas.getEntry(currentId)?.avoid).toEqual([{ topic: 'ui', reason: 'legacy alias write' }]);
  });

  test('the current registry file wins when a stale alias identifies the same repository', () => {
    const currentId = 'acme-tycoon-7b4f913a';
    const rootCommit = 'a'.repeat(40);
    store.saveDiscoveryCache([{
      id: currentId,
      name: 'acme-tycoon',
      localPath: repoDir,
      rootCommits: [rootCommit],
      cloned: true
    }]);
    store.upsertRegistryEntry('aa-old', {
      rootCommits: [rootCommit],
      highlights: [{ topic: 'old-note', quality: 4 }]
    });
    store.upsertRegistryEntry(currentId, {
      rootCommits: [rootCommit],
      highlights: [{ topic: 'current-note', quality: 5 }]
    });
    atlas.invalidate();

    expect(atlas.getEntry(currentId)?.highlights.map((item) => item.topic)).toEqual(['current-note']);
    expect(atlas.getEntry('aa-old')?.id).toBe(currentId);
    expect(atlas.validate().identityWarnings).toEqual([{
      type: 'duplicate-registry-identity',
      targetId: currentId,
      registryIds: ['aa-old', currentId]
    }]);

    atlas.addHighlight(currentId, { topic: 'written-later', quality: 3 });

    const registry = store.loadEntries();
    expect(registry['aa-old'].highlights.map((item) => item.topic)).toEqual(['old-note']);
    expect(registry[currentId].highlights.map((item) => item.topic))
      .toEqual(['current-note', 'written-later']);
    expect(atlas.getEntry(currentId)?.highlights.map((item) => item.topic))
      .toEqual(['current-note', 'written-later']);

    const doctorOutput = execFileSync(process.execPath, [
      path.resolve(__dirname, '../../scripts/atlas.js'),
      'doctor'
    ], {
      env: { ...process.env, AGENT_WORKSPACE_ATLAS_DIR: process.env.AGENT_WORKSPACE_ATLAS_DIR },
      encoding: 'utf8'
    });
    expect(doctorOutput).toContain(
      `${currentId}: registry files aa-old, ${currentId} identify the same repository`
    );
  });

  test('ambiguous legacy registry ids are reported instead of silently reassigned', () => {
    store.saveDiscoveryCache([
      { id: 'prototype-11111111', name: 'prototype', localPath: '/repos/alpha/prototype', cloned: true },
      { id: 'prototype-22222222', name: 'prototype', localPath: '/repos/beta/prototype', cloned: true }
    ]);
    store.upsertRegistryEntry('prototype', {
      highlights: [{ topic: 'testing', quality: 4 }]
    });
    atlas.invalidate();

    expect(atlas.validate().identityWarnings).toEqual([{
      type: 'ambiguous-registry-id',
      registryId: 'prototype',
      candidates: ['prototype-11111111', 'prototype-22222222']
    }]);
    expect(atlas.getStatus().identityWarningCount).toBe(1);
  });

  test('a name-only legacy registry match is reported as unverified', () => {
    store.saveDiscoveryCache([
      { id: 'prototype-11111111', name: 'prototype', localPath: '/repos/alpha/prototype', cloned: true }
    ]);
    store.upsertRegistryEntry('prototype', {
      highlights: [{ topic: 'testing', quality: 4 }]
    });
    atlas.invalidate();

    expect(atlas.validate().identityWarnings).toEqual([{
      type: 'unverified-registry-id',
      registryId: 'prototype',
      candidates: ['prototype-11111111']
    }]);
  });

  test('subscription entries cannot retain another machine local path aliases', () => {
    store.saveSubscription('teammate', {
      audience: 'team',
      entries: [{
        id: 'shared-tool',
        name: 'shared-tool',
        localPath: '/home/teammate/shared-tool',
        localPaths: ['/home/teammate/shared-tool', '/home/teammate/shared-tool/work1'],
        rootCommits: ['a'.repeat(40)]
      }]
    });
    atlas.invalidate();

    const shared = atlas.getEntry('shared-tool');
    expect(shared.localPath).toBeNull();
    expect(shared.localPaths).toEqual([]);
    expect(shared.rootCommits).toEqual([]);
  });
});

describe('Repo Atlas discovery identity', () => {
  test('duplicate clones collapse by remote slug and retain every local path', () => {
    const primaryPath = path.resolve('/repos/agent-workspace');
    const masterPath = path.join(primaryPath, 'master');
    const work1Path = path.join(primaryPath, 'work1');
    const featurePath = path.join(primaryPath, 'work-pr1029-jarvis');
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
      localPath: primaryPath,
      localPaths: [primaryPath, masterPath, work1Path],
      worktreeLayout: true,
      cloned: true
    };
    const feature = {
      id: 'agent-workspace',
      name: 'work-pr1029-jarvis',
      repo: 'Web3Dev1337/Agent-Workspace',
      localPath: featurePath,
      worktreeLayout: false,
      cloned: true
    };

    const forward = discovery.mergeDiscovery([feature, primary], github);
    const reverse = discovery.mergeDiscovery([primary, feature], github);

    expect(forward).toEqual(reverse);
    expect(forward).toHaveLength(1);
    expect(forward[0].name).toBe('agent-workspace');
    expect(forward[0].repo).toBe('web3dev1337/agent-workspace');
    expect(forward[0].localPath).toBe(primaryPath);
    expect(forward[0].localPaths).toEqual([primaryPath, masterPath, work1Path, featurePath]);
  });

  test('same-named repositories under different owners remain distinct', () => {
    const entries = discovery.mergeDiscovery([
      { id: 'shared', name: 'shared', repo: 'alice/shared', localPath: '/repos/alice/shared' },
      { id: 'shared', name: 'shared', repo: 'bob/shared', localPath: '/repos/bob/shared' }
    ], []);

    expect(entries.map((entry) => entry.id)).toEqual(['alice-shared', 'bob-shared']);
    expect(entries.map((entry) => entry.repo)).toEqual(['alice/shared', 'bob/shared']);
  });

  test('same-named local-only repositories receive stable distinct ids', () => {
    const first = {
      id: 'prototype',
      name: 'prototype',
      localPath: '/repos/alpha/prototype'
    };
    const second = {
      id: 'prototype',
      name: 'prototype',
      localPath: '/repos/beta/prototype'
    };

    const forward = discovery.mergeDiscovery([first, second], []);
    const reverse = discovery.mergeDiscovery([second, first], []);

    expect(forward).toEqual(reverse);
    expect(new Set(forward.map((entry) => entry.id))).toHaveProperty('size', 2);
    expect(forward.every((entry) => /^prototype-[a-f0-9]{8}$/.test(entry.id))).toBe(true);
  });

  test('local-only collision ids stay stable when checkout paths change machines', () => {
    const machineA = discovery.mergeDiscovery([
      { id: 'prototype', name: 'prototype', localPath: '/machine-a/alpha/prototype', rootCommits: ['a'.repeat(40)] },
      { id: 'prototype', name: 'prototype', localPath: '/machine-a/beta/prototype', rootCommits: ['b'.repeat(40)] }
    ], []);
    const machineB = discovery.mergeDiscovery([
      { id: 'prototype', name: 'prototype', localPath: '/machine-b/alpha/prototype', rootCommits: ['a'.repeat(40)] },
      { id: 'prototype', name: 'prototype', localPath: '/machine-b/beta/prototype', rootCommits: ['b'.repeat(40)] }
    ], []);

    expect(machineA.map((entry) => entry.id)).toEqual(machineB.map((entry) => entry.id));
  });

  test('remote-less repositories copied from one template remain separate', () => {
    const rootCommit = 'c'.repeat(40);
    const entries = discovery.mergeDiscovery([
      { id: 'game-a', name: 'game-a', localPath: '/repos/game-a', rootCommits: [rootCommit] },
      { id: 'game-b', name: 'game-b', localPath: '/repos/game-b', rootCommits: [rootCommit] }
    ], []);

    expect(entries.map((entry) => entry.id)).toEqual(['game-a', 'game-b']);
    expect(entries.map((entry) => entry.localPaths)).toEqual([
      [path.resolve('/repos/game-a')],
      [path.resolve('/repos/game-b')]
    ]);
    expect(discovery.identityWarnings(entries)).toEqual([{
      type: 'shared-root-commits',
      rootCommits: [rootCommit],
      candidates: ['game-a', 'game-b']
    }]);
  });

  test('local scanning derives portable collision ids from repository history', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-portable-identity-'));
    const machineA = path.join(tmpDir, 'machine-a');
    const machineB = path.join(tmpDir, 'machine-b');
    const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
    const seed = (parent, label) => {
      const repo = path.join(parent, label, 'prototype');
      fs.mkdirSync(repo, { recursive: true });
      git(repo, ['init', '--initial-branch=master']);
      fs.writeFileSync(path.join(repo, 'README.md'), `${label}\n`);
      git(repo, ['add', 'README.md']);
      git(repo, ['-c', 'user.name=Atlas Test', '-c', 'user.email=atlas-test@localhost', 'commit', '-m', label]);
      return repo;
    };

    try {
      const alpha = seed(machineA, 'alpha');
      const beta = seed(machineA, 'beta');
      fs.mkdirSync(path.join(machineB, 'alpha'), { recursive: true });
      fs.mkdirSync(path.join(machineB, 'beta'), { recursive: true });
      git(path.join(machineB, 'alpha'), ['clone', '--quiet', alpha, 'prototype']);
      git(path.join(machineB, 'beta'), ['clone', '--quiet', beta, 'prototype']);

      const first = await discovery.scanLocalRepos({ roots: [machineA], maxDepth: 3, languageCensus: false });
      const second = await discovery.scanLocalRepos({ roots: [machineB], maxDepth: 3, languageCensus: false });

      expect(first.map((entry) => entry.id)).toEqual(second.map((entry) => entry.id));
      expect(first.every((entry) => entry.rootCommits.length === 1)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('local scanning does not treat a shallow boundary as a repository root', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-shallow-identity-'));
    const sourceDir = path.join(tmpDir, 'source');
    const cloneRoot = path.join(tmpDir, 'clones');
    const cloneDir = path.join(cloneRoot, 'shallow-copy');
    const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe' });

    try {
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.mkdirSync(cloneRoot, { recursive: true });
      git(sourceDir, ['init', '--initial-branch=master']);
      fs.writeFileSync(path.join(sourceDir, 'README.md'), 'first\n');
      git(sourceDir, ['add', 'README.md']);
      git(sourceDir, ['-c', 'user.name=Atlas Test', '-c', 'user.email=atlas-test@localhost', 'commit', '-m', 'first']);
      fs.appendFileSync(path.join(sourceDir, 'README.md'), 'second\n');
      git(sourceDir, ['add', 'README.md']);
      git(sourceDir, ['-c', 'user.name=Atlas Test', '-c', 'user.email=atlas-test@localhost', 'commit', '-m', 'second']);
      git(cloneRoot, ['clone', '--quiet', '--depth', '1', `file://${sourceDir}`, cloneDir]);

      const entries = await discovery.scanLocalRepos({
        roots: [cloneRoot],
        maxDepth: 2,
        languageCensus: false
      });

      expect(entries).toHaveLength(1);
      expect(entries[0].rootCommits).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('disambiguated slugs do not replace an existing short id', () => {
    const entries = [
      { id: 'shared', name: 'shared', repo: 'alice/shared' },
      { id: 'shared', name: 'shared', repo: 'bob/shared' },
      { id: 'alice-shared', name: 'alice-shared', repo: 'charlie/alice-shared' }
    ];

    const forward = discovery.mergeDiscovery(entries, []);
    const reverse = discovery.mergeDiscovery(entries.slice().reverse(), []);

    expect(forward).toEqual(reverse);
    expect(new Set(forward.map((entry) => entry.id))).toHaveProperty('size', 3);
    expect(forward.find((entry) => entry.repo === 'charlie/alice-shared')?.id).toBe('alice-shared');
    expect(forward.find((entry) => entry.repo === 'alice/shared')?.id)
      .toMatch(/^alice-shared-[a-f0-9]{8}$/);
  });

  test('keeps independent repositories named master and main separate', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-independent-siblings-'));
    const projectRoot = path.join(tmpDir, 'sample');
    const masterDir = path.join(projectRoot, 'master');
    const mainDir = path.join(projectRoot, 'main');
    const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe' });

    const initialize = (repoPath, remote, sourceName) => {
      fs.mkdirSync(repoPath, { recursive: true });
      git(repoPath, ['init', '--initial-branch=main']);
      git(repoPath, ['remote', 'add', 'origin', remote]);
      fs.writeFileSync(path.join(repoPath, sourceName), 'return true;\n');
      git(repoPath, ['add', sourceName]);
      git(repoPath, [
        '-c', 'user.name=Atlas Test',
        '-c', 'user.email=atlas-test@localhost',
        'commit', '-m', 'initial'
      ]);
    };

    try {
      initialize(masterDir, 'https://github.com/alice/fixture.git', 'index.js');
      initialize(mainDir, 'https://github.com/bob/fixture.git', 'init.lua');

      const entries = await discovery.scanLocalRepos({
        roots: [tmpDir],
        maxDepth: 3,
        languageCensus: true
      });

      expect(entries).toHaveLength(2);
      expect(new Set(entries.map((entry) => entry.repo)))
        .toEqual(new Set(['alice/fixture', 'bob/fixture']));
      expect(entries.find((entry) => entry.repo === 'alice/fixture')?.localPaths)
        .toEqual([projectRoot, masterDir]);
      expect(entries.find((entry) => entry.repo === 'bob/fixture')?.localPaths)
        .toEqual([projectRoot, mainDir]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('keeps remote-less independent master and main repositories separate after merging', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-independent-local-siblings-'));
    const projectRoot = path.join(tmpDir, 'sample');
    const masterDir = path.join(projectRoot, 'master');
    const mainDir = path.join(projectRoot, 'main');
    const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe' });

    const initialize = (repoPath, sourceName) => {
      fs.mkdirSync(repoPath, { recursive: true });
      git(repoPath, ['init', '--initial-branch=main']);
      fs.writeFileSync(path.join(repoPath, sourceName), 'return true;\n');
      git(repoPath, ['add', sourceName]);
      git(repoPath, [
        '-c', 'user.name=Atlas Test',
        '-c', 'user.email=atlas-test@localhost',
        'commit', '-m', 'initial'
      ]);
    };

    try {
      initialize(masterDir, 'index.js');
      initialize(mainDir, 'init.lua');

      const scanned = await discovery.scanLocalRepos({
        roots: [tmpDir],
        maxDepth: 3,
        languageCensus: false
      });
      const entries = discovery.mergeDiscovery(scanned, []);

      expect(scanned).toHaveLength(2);
      expect(entries).toHaveLength(2);
      expect(new Set(entries.flatMap((entry) => entry.rootCommits))).toHaveProperty('size', 2);
      expect(new Set(entries.map((entry) => entry.id))).toHaveProperty('size', 2);
      expect(discovery.identityWarnings(entries)).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('still merges remote-less sibling clones with the same repository root', () => {
    const projectRoot = path.resolve('/repos/sample');
    const masterDir = path.join(projectRoot, 'master');
    const workDir = path.join(projectRoot, 'work1');
    const rootCommit = 'a'.repeat(40);
    const entries = discovery.mergeDiscovery([{
      id: 'sample',
      name: 'sample',
      localPath: projectRoot,
      localPaths: [projectRoot, masterDir],
      rootCommits: [rootCommit],
      worktreeLayout: true
    }, {
      id: 'sample',
      name: 'sample',
      localPath: projectRoot,
      localPaths: [projectRoot, workDir],
      rootCommits: [rootCommit],
      worktreeLayout: true
    }], []);

    expect(entries).toHaveLength(1);
    expect(entries[0].localPaths).toEqual([projectRoot, masterDir, workDir]);
    expect(entries[0].rootCommits).toEqual([rootCommit]);
  });

  test('keeps remote-less sibling repositories without usable history separate', () => {
    const projectRoot = path.resolve('/repos/sample');
    const masterDir = path.join(projectRoot, 'master');
    const mainDir = path.join(projectRoot, 'main');
    const entries = discovery.mergeDiscovery([{
      id: 'sample',
      name: 'sample',
      localPath: projectRoot,
      localPaths: [projectRoot, masterDir],
      rootCommits: []
    }, {
      id: 'sample',
      name: 'sample',
      localPath: projectRoot,
      localPaths: [projectRoot, mainDir],
      rootCommits: []
    }], []);

    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((entry) => entry.id))).toHaveProperty('size', 2);
  });

  test('local scanning retains sibling checkout paths under one project root', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-discovery-'));
    const projectRoot = path.join(tmpDir, 'sample');
    const masterDir = path.join(projectRoot, 'master');
    const workDir = path.join(projectRoot, 'work1');
    const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe' });

    try {
      fs.mkdirSync(masterDir, { recursive: true });
      git(masterDir, ['init', '--initial-branch=master']);
      fs.writeFileSync(path.join(masterDir, 'README.md'), 'sample\n');
      git(masterDir, ['add', 'README.md']);
      git(masterDir, [
        '-c', 'user.name=Atlas Test',
        '-c', 'user.email=atlas-test@localhost',
        'commit', '-m', 'initial'
      ]);
      git(masterDir, ['worktree', 'add', '-b', 'work1', workDir]);

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

  test('named linked worktrees share their common local-only repository root', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-linked-worktree-'));
    const projectRoot = path.join(tmpDir, 'sample');
    const masterDir = path.join(projectRoot, 'master');
    const featureDir = path.join(projectRoot, 'feature-preview');
    const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe' });

    try {
      fs.mkdirSync(masterDir, { recursive: true });
      git(masterDir, ['init', '--initial-branch=master']);
      fs.writeFileSync(path.join(masterDir, 'README.md'), 'sample\n');
      git(masterDir, ['add', 'README.md']);
      git(masterDir, [
        '-c', 'user.name=Atlas Test',
        '-c', 'user.email=atlas-test@localhost',
        'commit', '-m', 'initial'
      ]);
      git(masterDir, ['worktree', 'add', '-b', 'feature-preview', featureDir]);

      const entries = await discovery.scanLocalRepos({
        roots: [tmpDir],
        maxDepth: 3,
        languageCensus: false
      });

      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe('sample');
      expect(entries[0].localPath).toBe(projectRoot);
      expect(entries[0].localPaths).toEqual([projectRoot, featureDir, masterDir]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('uses an arbitrarily named primary checkout for repository facts', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-primary-checkout-'));
    const projectRoot = path.join(tmpDir, 'sample');
    const primaryDir = path.join(projectRoot, 'trunk');
    const featureDir = path.join(projectRoot, 'feature-preview');
    const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe' });

    try {
      fs.mkdirSync(primaryDir, { recursive: true });
      git(primaryDir, ['init', '--initial-branch=trunk']);
      fs.writeFileSync(path.join(primaryDir, 'index.js'), 'module.exports = true;\n');
      git(primaryDir, ['add', 'index.js']);
      git(primaryDir, [
        '-c', 'user.name=Atlas Test',
        '-c', 'user.email=atlas-test@localhost',
        'commit', '-m', 'initial'
      ]);
      git(primaryDir, ['worktree', 'add', '-b', 'feature-preview', featureDir]);
      fs.writeFileSync(path.join(featureDir, 'feature-only.lua'), 'return true\n');

      const entries = await discovery.scanLocalRepos({
        roots: [featureDir, tmpDir],
        maxDepth: 4,
        languageCensus: true
      });

      expect(entries).toHaveLength(1);
      expect(entries[0].languages).toEqual(['JavaScript']);
      expect(new Set(entries[0].localPaths)).toEqual(new Set([featureDir, primaryDir]));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
