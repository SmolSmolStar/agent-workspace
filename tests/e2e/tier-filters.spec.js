const { test, expect } = require('@playwright/test');
const { ensureWorkspaceLoaded, dismissFocusOverlay } = require('./_workspace');

test.describe('Tier Filters', () => {
  test('shows tier badges and filters sidebar', async ({ page }) => {
    test.setTimeout(60000);
    await page.route(/.*\/api\/process\/task-records$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: 2,
          records: [
            { id: 'session:demo-work1-claude', tier: 1 },
            { id: 'session:demo-work2-claude', tier: 2 }
          ]
        })
      });
    });

    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto('/');
    await page.waitForResponse(/\/api\/process\/task-records$/, { timeout: 10000 }).catch(() => {});
    await page.waitForFunction(() => !!window.orchestrator, { timeout: 30000 });
    await dismissFocusOverlay(page);

    const ids = await page.evaluate(() => {
      try {
        window.orchestrator?.socket?.disconnect?.();
      } catch {}

      window.orchestrator.updateTerminalGrid = () => {};
      window.orchestrator.buildSidebar = () => {};
      // Make this test independent of userSettings workflow mode.
      window.orchestrator.workflowMode = 'review';
      window.orchestrator.viewMode = 'all';
      window.orchestrator.currentWorkspace = null;
      window.orchestrator.sessions = new Map();
      window.orchestrator.visibleTerminals = new Set();
      window.orchestrator.taskRecords = new Map([
        ['session:demo-work1-claude', { tier: 1 }],
        ['session:demo-work2-claude', { tier: 2 }]
      ]);
      window.orchestrator.loadTaskRecords = async () => {};

      const aId = 'demo-work1-claude';
      const bId = 'demo-work2-claude';
      window.orchestrator.sessions.set(aId, { sessionId: aId, type: 'claude', status: 'idle', branch: 'main', worktreeId: 'work1' });
      window.orchestrator.sessions.set(bId, { sessionId: bId, type: 'claude', status: 'idle', branch: 'main', worktreeId: 'work2' });
      window.orchestrator.visibleTerminals.add(aId);
      window.orchestrator.visibleTerminals.add(bId);

      return { aId, bId };
    });

    expect(ids.aId).toBeTruthy();
    expect(ids.bId).toBeTruthy();

    await page.evaluate(() => window.orchestrator.setTierFilter('1'));
    const focusVisible = await page.evaluate(({ aId, bId }) => ({
      a: window.orchestrator.isSessionVisibleInCurrentView(aId),
      b: window.orchestrator.isSessionVisibleInCurrentView(bId)
    }), ids);
    expect(focusVisible).toEqual({ a: true, b: false });

    await page.evaluate(() => window.orchestrator.setTierFilter('all'));
    const allVisible = await page.evaluate(({ aId, bId }) => ({
      a: window.orchestrator.isSessionVisibleInCurrentView(aId),
      b: window.orchestrator.isSessionVisibleInCurrentView(bId)
    }), ids);
    expect(allVisible).toEqual({ a: true, b: true });
  });
});
