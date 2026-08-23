const { test, expect } = require('@playwright/test');
const { ensureWorkspaceLoaded } = require('./_workspace');

test.describe('Inline tier selector', () => {
  test('can set tier from agent tile dropdown', async ({ page }) => {
    test.setTimeout(60000);

    await page.route(/.*\/api\/process\/task-records$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0, records: [] })
      });
    });

    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto('/');
    await ensureWorkspaceLoaded(page);

    const putReqPromise = page.waitForRequest((req) => {
      return req.method() === 'PUT'
        && /\/api\/process\/task-records\//.test(req.url())
        && req.url().includes(encodeURIComponent('session:demo-work1-claude'));
    });

    await page.route(/.*\/api\/process\/task-records\/.*/, async (route) => {
      const req = route.request();
      if (req.method() !== 'PUT') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ record: {} })
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ record: { tier: 3 } })
      });
    });

    await page.waitForFunction(() => !!window.orchestrator, { timeout: 30000 });

    await page.evaluate(() => {
      const id = 'demo-work1-claude';
      window.orchestrator.showActiveOnly = false;
      window.orchestrator.workflowMode = 'review';
      window.orchestrator.viewMode = 'all';
      window.orchestrator.tierFilter = 'all';
      window.orchestrator.sessions = new Map([
        [id, { sessionId: id, type: 'claude', status: 'busy', branch: 'main', worktreeId: 'work1' }]
      ]);
      window.orchestrator.visibleTerminals = new Set([id]);
      window.orchestrator.taskRecords = new Map();
      window.orchestrator.updateTerminalGrid();
    });

    const tierSelect = page.locator('select.tier-dropdown[data-session-id="demo-work1-claude"]');
    await expect(tierSelect).toHaveCount(1, { timeout: 10000 });

    await tierSelect.selectOption('3', { force: true });

    const putReq = await putReqPromise;
    const payload = JSON.parse(putReq.postData() || '{}');
    expect(payload.tier).toBe(3);
  });
});
