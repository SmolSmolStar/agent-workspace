const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { seedE2EHome, withSafeWorkerDefault } = require('./e2eHome');

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
const { dataDir } = seedE2EHome(e2eHome);

const playwrightArgs = withSafeWorkerDefault(process.argv.slice(2));
let exitCode = 1;

try {
  const result = spawnSync('npx', ['playwright', 'test', ...playwrightArgs], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ORCHESTRATOR_TEST_PORT: port,
      ORCHESTRATOR_CODEX_USAGE_GUARD_ENABLED: 'true',
      CODEX_BIN: path.join(e2eHome, 'missing-codex'),
      HOME: e2eHome,
      USERPROFILE: e2eHome,
      AGENT_WORKSPACE_DIR: dataDir,
      // Keep Playwright browsers cache pointing at the user's real install location
      // so we don't need to re-download browsers into the temp HOME.
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(originalHome, '.cache', 'ms-playwright')
    }
  });

  if (result.error) {
    console.error(`Failed to start Playwright: ${result.error.message}`);
  } else if (Number.isInteger(result.status)) {
    exitCode = result.status;
  } else if (result.signal) {
    console.error(`Playwright exited after signal ${result.signal}`);
  }
} finally {
  fs.rmSync(e2eHome, { recursive: true, force: true });
}

process.exit(exitCode);
