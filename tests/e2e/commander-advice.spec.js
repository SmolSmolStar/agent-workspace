const { test, expect } = require('@playwright/test');
const { ensureWorkspaceLoaded, dismissFocusOverlay } = require('./_workspace');

test.describe('Commander advice', () => {
  test('shows advice panel with mocked recommendations', async ({ page }) => {
    await page.route('**/api/process/advice**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: '2026-01-26T00:00:00Z',
          mode: 'mine',
          lookbackHours: 24,
          advice: [
            {
              level: 'warn',
              code: 'wip_over_cap',
              title: 'Too many projects in flight',
              message: 'WIP is 5 (cap 3).',
              actions: [{ type: 'ui', action: 'open-queue', label: 'Open Queue' }]
            }
          ]
        })
      });
    });

    await page.goto('/');
    await ensureWorkspaceLoaded(page);
    await dismissFocusOverlay(page);

    // Open Commander panel.
    await page.waitForFunction(() => !!window.orchestrator?.commanderPanel, { timeout: 20000 });
    await page.evaluate(() => window.orchestrator?.commanderPanel?.show?.());
    await expect(page.locator('#commander-panel')).toBeVisible();

    // Open advice.
    await page.evaluate(async () => {
      await window.orchestrator?.commanderPanel?.showAdvice?.();
    });
    await expect(page.locator('#commander-advice-panel')).toBeVisible();
    await expect(page.locator('#commander-advice-body')).toContainText('Too many projects in flight');
    await expect(page.locator('#commander-advice-body')).toContainText('WIP is 5 (cap 3).');
  });
});
