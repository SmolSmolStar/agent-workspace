const { test, expect } = require('@playwright/test');
const { ensureWorkspaceLoaded } = require('./_workspace');

test.describe('Commander workflow actions', () => {
  test.beforeEach(async ({ page }) => {
    await page.route(/.*\/api\/process\/task-records$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0, records: [] })
      });
    });

    await page.route(/.*\/api\/process\/tasks.*/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ tasks: [] })
      });
    });

    await page.route(/.*\/api\/process\/task-records\/.*/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ record: {} })
      });
    });

    await page.goto('/');
    await ensureWorkspaceLoaded(page);
    await page.waitForFunction(() => !!window.orchestrator, { timeout: 10000 });
    // Avoid flakiness: wait for init() to finish (user settings + task records loaded).
    await page.waitForFunction(() => {
      return !!window.orchestrator?.userSettings && window.orchestrator?.taskRecords instanceof Map;
    }, { timeout: 10000 });
  });

  test('set-workflow-mode updates header buttons', async ({ page }) => {
    await page.evaluate(() => {
      window.orchestrator.handleCommanderAction('set-workflow-mode', { mode: 'focus' });
    });

    await expect(page.locator('#workflow-focus')).toHaveAttribute('aria-pressed', 'true');

    await page.evaluate(() => {
      window.orchestrator.handleCommanderAction('set-workflow-mode', { mode: 'background' });
    });
    await expect(page.locator('#workflow-background')).toHaveAttribute('aria-pressed', 'true');
  });

  test('open-queue shows queue panel', async ({ page }) => {
    await page.evaluate(() => {
      window.orchestrator.handleCommanderAction('open-queue', {});
    });

    const panel = page.locator('#queue-panel');
    await expect(panel).toBeVisible({ timeout: 5000 });
    await expect(panel.locator('h2')).toContainText('Queue');
  });
});
