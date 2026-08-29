const fs = require('fs');
const os = require('os');
const path = require('path');

const { seedE2EHome, withSafeWorkerDefault } = require('../../scripts/e2eHome');

describe('seedE2EHome', () => {
  let home;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-home-test-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('seeds a workspace and test-only legal acceptance', () => {
    const now = '2030-01-02T03:04:05.000Z';
    const { dataDir } = seedE2EHome(home, { now });
    const workspace = JSON.parse(fs.readFileSync(
      path.join(dataDir, 'workspaces', 'test-workspace.json'),
      'utf8'
    ));
    const onboarding = JSON.parse(fs.readFileSync(
      path.join(dataDir, 'onboarding-state.json'),
      'utf8'
    ));

    expect(workspace).toMatchObject({ id: 'test-workspace', empty: true, lastAccess: now });
    expect(onboarding).toEqual({
      version: 1,
      updatedAt: now,
      dependencySetup: {
        legalAccepted: true,
        completed: false,
        dismissed: false,
        currentStep: 0,
        skippedActionIds: []
      }
    });
  });

  test('uses one worker unless the caller explicitly chooses a worker count', () => {
    expect(withSafeWorkerDefault(['tests/e2e/orchestrator.spec.js']))
      .toEqual(['--workers=1', 'tests/e2e/orchestrator.spec.js']);
    expect(withSafeWorkerDefault(['--workers=3', 'tests/e2e/orchestrator.spec.js']))
      .toEqual(['--workers=3', 'tests/e2e/orchestrator.spec.js']);
    expect(withSafeWorkerDefault(['--workers', '3']))
      .toEqual(['--workers', '3']);
  });
});
