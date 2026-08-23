const { test, expect } = require('@playwright/test');
const { mockUserSettings } = require('./_mockUserSettings');

const mockCompletedSetup = async (page) => {
  const state = {
    legalAccepted: true,
    dismissed: true,
    completed: true,
    currentStep: 0,
    skippedActionIds: []
  };

  await page.route('**/bootstrap/setup-state.js', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `window.__ORCHESTRATOR_SETUP_STATE__ = ${JSON.stringify(state)};`
    });
  });
  await page.route('**/api/setup-actions/state', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, state })
    });
  });
};

const ensureWorkspaceLoaded = async (page) => {
  const projectsButton = page.locator('#projects-board-btn');
  if (await projectsButton.isVisible().catch(() => false)) return;

  await page.waitForFunction(() => window.orchestrator?.socket?.connected === true, {
    timeout: 20000
  });

  const openWorkspace = page.getByRole('button', { name: 'Open Workspace' }).first();
  await projectsButton.or(openWorkspace).waitFor({ state: 'visible', timeout: 20000 });
  if (await projectsButton.isVisible().catch(() => false)) return;

  await openWorkspace.click();
  await page.waitForSelector('#recovery-dialog, #projects-board-btn', { state: 'visible', timeout: 20000 });

  const skipRecovery = page.locator('#recovery-skip');
  if (await skipRecovery.isVisible().catch(() => false)) await skipRecovery.click();
  await projectsButton.waitFor({ state: 'visible', timeout: 20000 });
};

test('keeps the board entry and portfolio actions reachable at 390x667', async ({ page }) => {
  await mockUserSettings(page);
  await mockCompletedSetup(page);
  await page.route('**/api/projects/board', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        columns: [],
        board: { projectToColumn: {}, orderByColumn: {}, collapsedColumnIds: [], tagsByProjectKey: {} }
      })
    });
  });
  await page.route(/\/api\/atlas\/portfolio(\?|$)/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        report: {
          includeRemote: false,
          repositoryCount: 0,
          eligibleCount: 0,
          omittedCount: 0,
          repositories: []
        }
      })
    });
  });

  await page.setViewportSize({ width: 390, height: 667 });
  await page.goto('/');
  await ensureWorkspaceLoaded(page);
  await page.evaluate(() => {
    window.orchestrator.getScannedRepos = async () => [];
    window.orchestrator.getGitHubRepos = async () => [];
    document.getElementById('projects-board-btn')?.click();
  });

  const board = page.locator('#projects-board-modal');
  const entry = page.locator('#projects-board-portfolio');
  await expect(board).toBeVisible({ timeout: 10000 });
  await expect(entry).toBeInViewport();
  const entryBox = await entry.boundingBox();
  expect(entryBox.x).toBeGreaterThanOrEqual(0);
  expect(entryBox.x + entryBox.width).toBeLessThanOrEqual(390);

  await entry.click();
  const portfolio = page.locator('#atlas-portfolio-modal');
  const generate = page.locator('.atlas-portfolio-run-button');
  await expect(portfolio).toBeVisible();
  await expect(board).toBeHidden();
  await expect(generate).toBeInViewport();
  const generateBox = await generate.boundingBox();
  expect(generateBox.x).toBeGreaterThanOrEqual(0);
  expect(generateBox.x + generateBox.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await page.getByRole('button', { name: 'Back to projects' }).click();
  await expect(board).toBeVisible();
  await expect(portfolio).toBeHidden();
  await expect(entry).toBeInViewport();

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(entry).toBeInViewport();
  await expect(page.locator('.projects-board-toolbar')).toHaveCSS('flex-wrap', 'nowrap');
});
