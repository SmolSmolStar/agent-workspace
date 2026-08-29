const fs = require('fs');
const path = require('path');

function seedE2EHome(e2eHome, { now = new Date().toISOString() } = {}) {
  const dataDir = path.join(e2eHome, '.orchestrator');
  const workspacesDir = path.join(dataDir, 'workspaces');
  fs.mkdirSync(workspacesDir, { recursive: true });

  const workspace = {
    id: 'test-workspace',
    name: 'Test Workspace',
    type: 'website',
    icon: '🧪',
    empty: true,
    terminals: { pairs: 2, defaultVisible: [1, 2], layout: 'dynamic' },
    worktrees: { enabled: false, count: 0, namingPattern: 'work{n}', autoCreate: false },
    shortcuts: [],
    quickLinks: [],
    notifications: { enabled: false, background: false, types: {}, priority: 'normal' },
    lastAccess: now
  };
  fs.writeFileSync(
    path.join(workspacesDir, `${workspace.id}.json`),
    JSON.stringify(workspace, null, 2)
  );

  const onboardingState = {
    version: 1,
    updatedAt: now,
    dependencySetup: {
      legalAccepted: true,
      completed: false,
      dismissed: false,
      currentStep: 0,
      skippedActionIds: []
    }
  };
  fs.writeFileSync(
    path.join(dataDir, 'onboarding-state.json'),
    JSON.stringify(onboardingState, null, 2)
  );

  return { dataDir, workspacesDir };
}

function withSafeWorkerDefault(args = []) {
  const supplied = Array.isArray(args) ? [...args] : [];
  const hasWorkerOverride = supplied.some((arg) => arg === '--workers' || String(arg).startsWith('--workers='));
  return hasWorkerOverride ? supplied : ['--workers=1', ...supplied];
}

module.exports = { seedE2EHome, withSafeWorkerDefault };
