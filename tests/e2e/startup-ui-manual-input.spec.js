const { test, expect } = require('@playwright/test');
const { ensureWorkspaceLoaded } = require('./_workspace');

test.describe('Startup UI manual suppression', () => {
  test('manual typing prevents startup overlay from showing', async ({ page }) => {
    test.setTimeout(60000);

    await page.route(/.*\/api\/process\/task-records$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0, records: [] })
      });
    });

    await page.goto('/');
    await ensureWorkspaceLoaded(page);

    await page.waitForFunction(() => !!window.orchestrator, { timeout: 10000 });

    await page.evaluate(() => {
      const id = 'demo-work1-claude';
      window.orchestrator.showActiveOnly = false;
      window.orchestrator.workflowMode = 'review';
      window.orchestrator.viewMode = 'all';
      window.orchestrator.tierFilter = 'all';
      window.orchestrator.sessions = new Map([
        [id, { sessionId: id, type: 'claude', status: 'idle', branch: 'main', worktreeId: 'work1' }]
      ]);
      window.orchestrator.visibleTerminals = new Set([id]);
      window.orchestrator.dismissedStartupUI = new Map();
      window.orchestrator.updateTerminalGrid();

      // Schedule startup UI show (idle -> waiting), but immediately simulate user typing.
      window.orchestrator.showStartupUIIfNeeded(id, 'waiting', 'idle');
      window.orchestrator.onManualTerminalInput(id);
    });

    await page.waitForTimeout(600);

    const display = await page.evaluate(() => {
      const el = document.getElementById('startup-ui-demo-work1-claude');
      return el ? el.style.display : null;
    });

    expect(display).not.toBe('block');
  });
});

