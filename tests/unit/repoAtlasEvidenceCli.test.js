const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const CLI_PATH = path.join(__dirname, '..', '..', 'scripts', 'atlas.js');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
}

describe('atlas evidence CLI', () => {
  let root;
  let checkout;
  let atlasDir;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-evidence-cli-'));
    checkout = path.join(root, 'private-checkout-name');
    atlasDir = path.join(root, 'atlas');
    fs.mkdirSync(checkout, { recursive: true });
    fs.mkdirSync(path.join(atlasDir, 'registry', 'entries'), { recursive: true });

    git(checkout, ['init', '-b', 'main']);
    git(checkout, ['remote', 'add', 'origin', 'https://github.com/owner/fixture.git']);
    fs.writeFileSync(path.join(checkout, 'index.js'), 'module.exports = true;\n');
    git(checkout, ['add', 'index.js']);
    git(checkout, ['-c', 'user.name=Fixture Author', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'feat: fixture']);

    fs.writeFileSync(
      path.join(atlasDir, 'registry', 'entries', 'fixture.json'),
      `${JSON.stringify({ id: 'fixture', repo: 'owner/fixture', localPath: checkout }, null, 2)}\n`
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function run(args) {
    return spawnSync(process.execPath, [CLI_PATH, ...args], {
      cwd: root,
      env: { ...process.env, AGENT_WORKSPACE_ATLAS_DIR: atlasDir },
      encoding: 'utf8'
    });
  }

  test('prints measured text without exposing the absolute checkout path', () => {
    const result = run(['evidence', 'fixture', '--max', '2']);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('fixture\n');
    expect(result.stdout).toContain('1 commits | 1 author identities');
    expect(result.stdout).toContain('index.js | frequently-changed-source');
    expect(result.stdout).not.toContain(root);
  });

  test('prints privacy-safe JSON', () => {
    const result = run(['evidence', 'fixture', '--json']);
    const report = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(report.available).toBe(true);
    expect(report.checkout).toEqual({ resolution: 'exact' });
    expect(JSON.stringify(report)).not.toContain(root);
  });
});
