const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  analyzeRepositoryEvidence,
  createRepositoryEvidenceAnalyzer,
  formatRepositoryEvidence,
  GitInspectionError,
  isTestPath,
  normalizeRepoPath,
  runGit
} = require('../../server/atlas/atlasEvidence');
const { resolveCheckout } = require('../../server/atlas/atlasCheckout');

const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

function writeFile(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function commit(checkout, message, authorName, authorEmail) {
  git(checkout, ['add', '.']);
  git(checkout, [
    '-c', `user.name=${authorName}`,
    '-c', `user.email=${authorEmail}`,
    'commit', '-m', message
  ]);
}

describe('atlasEvidence', () => {
  let root;
  let checkout;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-evidence-'));
    checkout = path.join(root, 'master');
    fs.mkdirSync(checkout, { recursive: true });
    git(checkout, ['init', '-b', 'main']);
    git(checkout, ['remote', 'add', 'origin', 'https://github.com/owner/fixture.git']);

    writeFile(checkout, 'src/index.js', 'module.exports = () => "one";\n');
    writeFile(checkout, 'src/unused.js', 'module.exports = 1;\n');
    writeFile(checkout, 'tests/index.test.js', 'test("index", () => expect(true).toBe(true));\n');
    writeFile(checkout, '.github/workflows/test.yml', 'name: test\n');
    writeFile(checkout, 'CODEBASE_DOCUMENTATION.md', '# Fixture\n');
    writeFile(checkout, 'AGENTS.md', '# Rules\n');
    writeFile(checkout, 'package-lock.json', '{"lockfileVersion":3}\n');
    commit(checkout, 'feat: initial fixture', 'First Author', 'first@example.test');

    writeFile(checkout, 'src/index.js', 'module.exports = () => "two";\n');
    commit(checkout, 'fix: update entry point', 'Second Author', 'second@example.test');
    git(checkout, ['tag', 'v1.0.0']);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('resolves the primary checkout from a worktree-layout project root', async () => {
    const workCheckout = path.join(root, 'work1');
    fs.mkdirSync(workCheckout, { recursive: true });
    git(workCheckout, ['init', '-b', 'work']);
    const primary = await resolveCheckout(
      {
        repo: 'owner/fixture',
        localPath: workCheckout,
        localPaths: [root, checkout],
        worktreeLayout: true
      },
      { runGit }
    );
    const direct = await resolveCheckout({ localPath: checkout }, { runGit });

    expect(primary).toMatchObject({
      path: fs.realpathSync(checkout),
      resolution: 'exact'
    });
    expect(direct).toMatchObject({
      path: fs.realpathSync(checkout),
      resolution: 'exact'
    });
  });

  test('does not mistake a nested repository for a flat checkout', async () => {
    const nested = path.join(checkout, 'fixtures', 'master');
    fs.mkdirSync(nested, { recursive: true });
    git(nested, ['init', '-b', 'main']);

    await expect(resolveCheckout({ localPath: checkout }, { runGit })).resolves.toMatchObject({
      path: fs.realpathSync(checkout),
      resolution: 'exact'
    });
  });

  test('does not infer arbitrary child repositories from a broad parent path', async () => {
    const broadRoot = path.join(root, 'broad-root');
    for (const name of ['alpha', 'beta']) {
      const child = path.join(broadRoot, name);
      fs.mkdirSync(child, { recursive: true });
      git(child, ['init', '-b', 'main']);
    }

    await expect(resolveCheckout({ localPath: broadRoot }, { runGit })).resolves.toBeNull();
  });

  test('only infers standard child checkouts for an explicit worktree layout', async () => {
    await expect(resolveCheckout({ localPath: root }, { runGit })).resolves.toBeNull();
    await expect(resolveCheckout({ localPath: root, worktreeLayout: true }, { runGit }))
      .resolves.toMatchObject({ path: fs.realpathSync(checkout), resolution: 'inferred' });
  });

  test('skips a broken checkout candidate when a later candidate is healthy', async () => {
    const layoutRoot = path.join(root, 'fallback-layout');
    const broken = path.join(layoutRoot, 'master');
    const healthy = path.join(layoutRoot, 'work1');
    fs.mkdirSync(path.join(broken, '.git'), { recursive: true });
    git(checkout, ['worktree', 'add', '-b', 'fallback-evidence', healthy]);

    await expect(resolveCheckout({
      repo: 'owner/fixture',
      localPaths: [broken, healthy],
      worktreeLayout: true
    }, { runGit })).resolves.toMatchObject({
      path: fs.realpathSync(healthy),
      resolution: 'exact'
    });
  });

  test('rejects a checkout whose origin does not match the atlas repository', async () => {
    const entry = {
      id: 'fixture',
      repo: 'another-owner/fixture',
      localPath: checkout
    };

    await expect(resolveCheckout(entry, { runGit })).resolves.toBeNull();
    await expect(analyzeRepositoryEvidence(entry)).resolves.toEqual({
      repoId: 'fixture',
      available: false,
      reason: 'No local checkout matched this repository identity.'
    });
  });

  test('does not accept a lookalike GitHub hostname as the expected origin', async () => {
    git(checkout, ['remote', 'set-url', 'origin', 'https://evilgithub.com/owner/fixture.git']);

    await expect(resolveCheckout({
      id: 'fixture',
      repo: 'owner/fixture',
      localPath: checkout
    }, { runGit })).resolves.toBeNull();
  });

  test('checks the raw origin instead of a locally rewritten fetch URL', async () => {
    git(checkout, ['remote', 'set-url', 'origin', 'local-alias']);
    git(checkout, [
      'config',
      'url.https://github.com/owner/fixture.git.insteadOf',
      'local-alias'
    ]);

    expect(git(checkout, ['remote', 'get-url', 'origin']))
      .toBe('https://github.com/owner/fixture.git');
    await expect(resolveCheckout({
      id: 'fixture',
      repo: 'owner/fixture',
      localPath: checkout
    }, { runGit })).resolves.toBeNull();
  });

  test('accepts a linked worktree whose git marker is a file', async () => {
    const linkedCheckout = path.join(root, 'linked-checkout');
    git(checkout, ['worktree', 'add', '-b', 'linked-evidence', linkedCheckout]);

    expect(fs.lstatSync(path.join(linkedCheckout, '.git')).isFile()).toBe(true);
    const report = await analyzeRepositoryEvidence({
      id: 'fixture',
      repo: 'owner/fixture',
      localPath: linkedCheckout
    });

    expect(report.available).toBe(true);
    expect(report.checkout).toEqual({ resolution: 'exact' });
  });

  test('returns measurable repository history, code signals, and examples', async () => {
    const report = await analyzeRepositoryEvidence({
      id: 'fixture',
      localPath: root,
      worktreeLayout: true,
      highlights: [{ topic: 'entry-point', quality: 5, paths: ['src/index.js'] }]
    });

    expect(report.available).toBe(true);
    expect(report.checkout).toEqual({ resolution: 'inferred' });
    expect(report.history).toMatchObject({
      commitCount: 2,
      authorIdentityCount: 2,
      tagCount: 1,
      latestTagByCreatorDate: 'v1.0.0',
      sampledCommitCount: 2
    });
    expect(report.history.firstCommitAt).toBeTruthy();
    expect(report.history.lastCommitAt).toBeTruthy();
    expect(report.code).toMatchObject({
      trackedFiles: 7,
      sourceFiles: 2,
      testFiles: 1,
      testToSourceRatio: 0.5
    });
    expect(report.code.languages).toEqual([{ language: 'JavaScript', files: 3 }]);
    expect(report.practices).toEqual({
      ciConfigCount: 1,
      hasCodebaseDocumentation: true,
      hasAgentInstructions: true,
      hasDependencyLockfile: true,
      hasTests: true
    });
    expect(report.examples[0]).toMatchObject({
      path: 'src/index.js',
      kind: 'curated',
      recentCommitTouches: 2,
      curated: { topic: 'entry-point', quality: 5 }
    });
    expect(report.examples.some((example) => example.kind === 'test')).toBe(true);
    expect(JSON.stringify(report)).not.toContain(fs.realpathSync(root));
  });

  test('does not treat traversal or absolute highlight paths as repository evidence', async () => {
    const report = await analyzeRepositoryEvidence({
      id: 'fixture',
      localPath: checkout,
      highlights: [{ topic: 'unsafe', quality: 5, paths: ['../secret.js', '/etc/passwd'] }]
    });

    expect(report.examples.every((example) => example.kind !== 'curated')).toBe(true);
    expect(report.examples.every((example) => !example.path.includes('..'))).toBe(true);
  });

  test('returns an explicit unavailable report for remote-only entries', async () => {
    await expect(analyzeRepositoryEvidence({ id: 'remote-only', cloned: false })).resolves.toEqual({
      repoId: 'remote-only',
      available: false,
      reason: 'No local Git checkout is available for this repository.'
    });
  });

  test('returns an explicit unavailable report for an empty checkout', async () => {
    const emptyCheckout = path.join(root, 'empty-checkout');
    fs.mkdirSync(emptyCheckout);
    git(emptyCheckout, ['init', '-b', 'main']);

    await expect(analyzeRepositoryEvidence({ id: 'empty', localPath: emptyCheckout })).resolves.toEqual({
      repoId: 'empty',
      available: false,
      reason: 'The local Git checkout has no commits.'
    });
  });

  test('reports an empty tracked tree without inventing a source ratio', async () => {
    git(checkout, ['rm', '-r', '.']);
    commit(checkout, 'chore: remove tracked fixture files', 'Second Author', 'second@example.test');

    const report = await analyzeRepositoryEvidence({ id: 'fixture', localPath: checkout });

    expect(report.code).toEqual({
      trackedFiles: 0,
      sourceFiles: 0,
      testFiles: 0,
      testToSourceRatio: null,
      languages: []
    });
    expect(report.examples).toEqual([]);
  });

  test('counts author names rather than treating email aliases as new people', async () => {
    writeFile(checkout, 'src/index.js', 'module.exports = () => "three";\n');
    commit(checkout, 'fix: update through an alias', 'Second Author', 'alias@example.test');

    const report = await analyzeRepositoryEvidence({ id: 'fixture', localPath: checkout });

    expect(report.history.commitCount).toBe(3);
    expect(report.history.authorIdentityCount).toBe(2);
  });

  test('counts source under bin directories', async () => {
    writeFile(checkout, 'src/bin/cli.js', 'module.exports = () => 1;\n');
    commit(checkout, 'feat: add cli', 'Second Author', 'second@example.test');

    const report = await analyzeRepositoryEvidence({ id: 'fixture', localPath: checkout });

    expect(report.code.sourceFiles).toBe(3);
    expect(report.code.languages).toEqual([{ language: 'JavaScript', files: 4 }]);
  });

  const symlinkTest = process.platform === 'win32' ? test.skip : test;
  symlinkTest('does not follow a tracked source symlink outside the checkout', async () => {
    const outside = path.join(root, 'outside.js');
    fs.writeFileSync(outside, 'secret\nsecond line\n');
    fs.symlinkSync(outside, path.join(checkout, 'src', 'outside.js'));
    commit(checkout, 'test: add tracked source symlink', 'Second Author', 'second@example.test');

    const report = await analyzeRepositoryEvidence({
      id: 'fixture',
      localPath: checkout,
      highlights: [{ topic: 'unsafe', quality: 1, paths: ['src/outside.js'] }]
    });
    const example = report.examples.find((row) => row.path === 'src/outside.js');

    expect(example).toMatchObject({ kind: 'curated', nonBlankLines: null });
  });

  test('does not read beyond the file size validated on the opened descriptor', async () => {
    writeFile(checkout, 'src/growing.js', 'first\nsecond\nthird\n');
    commit(checkout, 'test: add growing source fixture', 'Second Author', 'second@example.test');
    const originalFstat = fs.fstatSync.bind(fs);
    const fstat = jest.spyOn(fs, 'fstatSync').mockImplementation((fd) => {
      const stat = originalFstat(fd);
      Object.defineProperty(stat, 'size', { value: 6 });
      return stat;
    });

    try {
      const report = await analyzeRepositoryEvidence({
        id: 'fixture',
        localPath: checkout,
        highlights: [{ topic: 'bounded-read', quality: 5, paths: ['src/growing.js'] }]
      }, { maxExamples: 1 });

      expect(report.examples[0]).toMatchObject({
        path: 'src/growing.js',
        nonBlankLines: 1
      });
    } finally {
      fstat.mockRestore();
    }
  });

  test('keeps internal Git failure details out of the public error message', async () => {
    const analyzer = createRepositoryEvidenceAnalyzer({
      runGitFn: async (cwd, args) => {
        if (args[0] === 'ls-files') {
          throw new GitInspectionError(`fatal: failed inside ${cwd}`, args);
        }
        return runGit(cwd, args);
      }
    });

    let failure = null;
    try {
      await analyzer({ id: 'fixture', localPath: checkout });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(GitInspectionError);
    expect(failure.message).toBe('Repository evidence inspection failed.');
    expect(failure.message).not.toContain(fs.realpathSync(root));
    expect(failure.detail).toContain(fs.realpathSync(checkout));
  });

  test('does not coalesce requests with different curated evidence', async () => {
    const analyzer = createRepositoryEvidenceAnalyzer();
    const baseEntry = { id: 'fixture', localPath: checkout };
    const [first, second] = await Promise.all([
      analyzer({
        ...baseEntry,
        highlights: [{ topic: 'first-topic', quality: 5, paths: ['src/index.js'] }]
      }),
      analyzer({
        ...baseEntry,
        highlights: [{ topic: 'second-topic', quality: 5, paths: ['src/index.js'] }]
      })
    ]);

    expect(first.examples[0].curated.topic).toBe('first-topic');
    expect(second.examples[0].curated.topic).toBe('second-topic');
  });

  test('keeps option-specific requests separate while enforcing example limits', async () => {
    for (let index = 0; index < 15; index += 1) {
      writeFile(checkout, `src/generated-${index}.js`, `module.exports = ${index};\n`);
    }
    commit(checkout, 'feat: add evidence fixtures', 'Second Author', 'second@example.test');
    const analyzer = createRepositoryEvidenceAnalyzer();
    const entry = { id: 'fixture', localPath: checkout };

    const [oneExample, twoExamples, clamped, fallback] = await Promise.all([
      analyzer(entry, { maxExamples: 1 }),
      analyzer(entry, { maxExamples: 2 }),
      analyzer(entry, { maxExamples: 100 }),
      analyzer(entry, { maxExamples: 'garbage' })
    ]);

    expect(oneExample.examples).toHaveLength(1);
    expect(twoExamples.examples).toHaveLength(2);
    expect(clamped.examples).toHaveLength(12);
    expect(fallback.examples).toHaveLength(6);
  });

  test('formats a compact report without claiming frequently changed files are good', async () => {
    const report = await analyzeRepositoryEvidence({ id: 'fixture', localPath: checkout });
    const formatted = formatRepositoryEvidence(report);

    expect(formatted).toContain('2 commits | 2 author identities | 1 tags');
    expect(formatted).toContain('checkout       exact');
    expect(formatted).not.toContain(fs.realpathSync(root));
    expect(formatted).toContain('src/index.js | frequently-changed-source | 2 touches');
    expect(formatted).not.toMatch(/best|quality code|recommended/);
  });

  test('normalizes safe paths and recognizes common test layouts', () => {
    expect(normalizeRepoPath('.\\tests\\thing.spec.ts')).toBe('tests/thing.spec.ts');
    expect(normalizeRepoPath('src\\ambiguous.js', { allowBackslash: false })).toBeNull();
    expect(normalizeRepoPath('../outside.js')).toBeNull();
    expect(normalizeRepoPath('src/escape\u001b.js')).toBeNull();
    expect(normalizeRepoPath(' src/ambiguous.js')).toBeNull();
    expect(isTestPath('tests/thing.js')).toBe(true);
    expect(isTestPath('src/thing.test.ts')).toBe(true);
    expect(isTestPath('src/contest.js')).toBe(false);
  });
});
