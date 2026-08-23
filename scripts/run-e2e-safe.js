const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const node = process.execPath;
const pick = path.join(__dirname, 'pick-free-port.js');

const picked = spawnSync(node, [pick], {
  env: { ...process.env, PORT_START: process.env.ORCHESTRATOR_TEST_PORT || '4001' },
  encoding: 'utf8'
});

if (picked.status !== 0) {
  process.exit(picked.status || 1);
}

const port = String(picked.stdout || '').trim();
if (!port) {
  console.error('Failed to pick a safe E2E port');
  process.exit(1);
}

// Run e2e against an isolated HOME so we don't read/write the user's real ~/.orchestrator.
const e2eHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-e2e-home-'));
const originalHome = process.env.HOME || os.homedir();
const orchestratorDir = path.join(e2eHome, '.orchestrator');
const workspacesDir = path.join(orchestratorDir, 'workspaces');
fs.mkdirSync(workspacesDir, { recursive: true });

fs.writeFileSync(path.join(orchestratorDir, 'onboarding-state.json'), JSON.stringify({
  version: 1,
  updatedAt: new Date().toISOString(),
  dependencySetup: {
    legalAccepted: true,
    completed: true,
    dismissed: true,
    currentStep: 0,
    skippedActionIds: []
  }
}, null, 2));

fs.writeFileSync(path.join(orchestratorDir, 'config.json'), JSON.stringify({
  version: '2.0.0',
  activeWorkspace: null,
  workspaceDirectory: workspacesDir,
  discovery: {
    scanPaths: [],
    exclude: ['node_modules', '.git', 'dist', 'build', 'target']
  },
  globalShortcuts: [],
  server: {
    port: Number.parseInt(port, 10),
    host: '127.0.0.1'
  },
  ui: {
    theme: 'dark',
    startupDashboard: true,
    rememberLastWorkspace: false
  },
  orchestratorStartup: {
    autoUpdate: false,
    openBrowserOnStart: false,
    checkForNewRepos: false
  },
  user: {
    username: null,
    teammates: []
  }
}, null, 2));

// Seed a minimal "empty" workspace so the dashboard always has an "Open Workspace" button.
const seededWorkspace = {
  id: 'test-workspace',
  name: 'Test Workspace',
  type: 'custom',
  icon: '🧪',
  empty: true,
  repository: { path: '', masterBranch: 'master', remote: '' },
  terminals: [],
  worktrees: { enabled: false, count: 0, namingPattern: 'work{n}', autoCreate: false },
  shortcuts: [],
  quickLinks: [],
  notifications: { enabled: false, background: false, types: {}, priority: 'normal' },
  lastAccess: new Date().toISOString()
};
fs.writeFileSync(path.join(workspacesDir, `${seededWorkspace.id}.json`), JSON.stringify(seededWorkspace, null, 2));

const passthroughArgs = process.argv.slice(2);
const result = spawnSync('npx', ['playwright', 'test', ...passthroughArgs], {
  stdio: 'inherit',
  env: {
    ...process.env,
    ORCHESTRATOR_TEST_PORT: port,
    ORCHESTRATOR_CODEX_USAGE_GUARD_ENABLED: 'true',
    CODEX_BIN: path.join(e2eHome, 'missing-codex'),
    HOME: e2eHome,
    USERPROFILE: e2eHome,
    // Keep Playwright browsers cache pointing at the user's real install location
    // so we don't need to re-download browsers into the temp HOME.
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(originalHome, '.cache', 'ms-playwright')
  }
});

process.exit(result.status || 0);
