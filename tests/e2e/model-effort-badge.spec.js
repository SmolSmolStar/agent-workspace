const { test, expect } = require('@playwright/test');
const { ensureWorkspaceLoaded } = require('./_workspace');

test.describe('Model/effort badge', () => {
  test('shows the resolved model and effort on agent terminal headers', async ({ page }) => {
    test.setTimeout(60000);

    await page.route(/.*\/api\/sessions\/model-config$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          codex: {
            agent: 'codex',
            model: 'gpt-5.3-codex',
            effortLevel: 'xhigh',
            modelSource: null,
            effortSource: null
          },
          sessions: {
            'demo-work1-claude': {
              cwd: '/tmp/demo/work1',
              claude: {
                agent: 'claude',
                model: 'claude-fable-5[1m]',
                effortLevel: 'xhigh',
                modelSource: {
                  label: 'user settings (global)',
                  file: '/home/demo/.claude/settings.json'
                },
                effortSource: {
                  label: 'local settings',
                  file: '/tmp/demo/work1/.claude/settings.local.json'
                }
              }
            }
          }
        })
      });
    });

    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto('/');
    await ensureWorkspaceLoaded(page);

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

    const badge = page.locator('.terminal-wrapper[data-session-id="demo-work1-claude"] .terminal-model-badge');
    await expect(badge).toBeVisible({ timeout: 20000 });
    await expect(badge).toContainText('fable-5[1m]');
    await expect(badge).toContainText('xhigh');

    const tooltip = await badge.getAttribute('title');
    expect(tooltip).toContain('local settings');
    expect(tooltip).toContain('settings.local.json');
  });
});
