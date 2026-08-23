const { test, expect } = require('@playwright/test');
const { ensureWorkspaceLoaded } = require('./_workspace');
const { mockUserSettings } = require('./_mockUserSettings');

const mockTasksApi = async (page) => {
  await page.route('**/api/tasks/providers**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        providers: [{ id: 'trello', label: 'Trello', configured: true, capabilities: { read: true, write: true } }]
      })
    });
  });

  await page.route('**/api/tasks/me**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ provider: 'trello', member: { id: 'm1', fullName: 'Me', username: 'me' } })
    });
  });

  await page.route('**/api/tasks/boards**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        provider: 'trello',
        boards: [{ id: 'b1', name: 'Mock Board' }]
      })
    });
  });

  await page.route('**/api/tasks/boards/b1/snapshot**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        provider: 'trello',
        boardId: 'b1',
        lists: [
          { id: 'l1', name: 'To Do', pos: 1 },
          { id: 'l2', name: 'Doing', pos: 2 }
        ],
        cardsByList: {
          l1: [{ id: 'c1', idList: 'l1', idMembers: ['m1'], name: 'Card 1', pos: 1, dateLastActivity: '2026-01-01T00:00:00Z' }],
          l2: [{ id: 'c2', idList: 'l2', idMembers: ['m1'], name: 'Card 2', pos: 1, dateLastActivity: '2026-01-01T00:00:00Z' }]
        }
      })
    });
  });

  await page.route('**/api/tasks/boards/b1/members**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ provider: 'trello', boardId: 'b1', members: [] })
    });
  });

  await page.route('**/api/tasks/boards/b1/custom-fields**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ provider: 'trello', boardId: 'b1', customFields: [] })
    });
  });

  await page.route('**/api/tasks/boards/b1/labels**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ provider: 'trello', boardId: 'b1', labels: [] })
    });
  });
};

test.describe('Tasks Kanban persistence', () => {
  test('remembers collapsed columns per board', async ({ page }) => {
    await mockUserSettings(page);
    await mockTasksApi(page);

    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto('/');
    await ensureWorkspaceLoaded(page);
    const overlay = page.locator('#focus-overlay.active');
    if (await overlay.isVisible().catch(() => false)) {
      await page.locator('#focus-overlay .focus-close-btn').click();
      await expect(overlay).toBeHidden();
    }

    // Open Tasks
    await page.evaluate(() => document.getElementById('tasks-btn')?.click());
    await expect(page.locator('#tasks-panel')).toBeVisible({ timeout: 10000 });

    // Select the mock board and switch to Board view.
    await page.locator('#tasks-board').selectOption('b1');
    await page.locator('#tasks-view-board').click();

    // Wait for columns to render.
    await expect(page.locator('.tasks-column[data-list-id="l1"]')).toBeVisible();
    await expect(page.locator('.tasks-column[data-list-id="l2"]')).toBeVisible();

    // Collapse one column (desktop behavior).
    await page.evaluate(() => document.querySelector('[data-col-toggle="l1"]')?.click());
    await expect(page.locator('.tasks-column[data-list-id="l1"]')).toHaveClass(/is-collapsed/);

    // Close and reopen Tasks.
    await page.locator('.tasks-close-btn').click();
    await expect(page.locator('#tasks-panel')).toHaveCount(0);
    await page.evaluate(() => document.getElementById('tasks-btn')?.click());
    await expect(page.locator('#tasks-panel')).toBeVisible({ timeout: 10000 });

    // Restore selection and board view (localStorage keeps board + view).
    // Ensure the collapsed state is restored.
    await expect(page.locator('#tasks-board')).toHaveValue('b1');
    await page.locator('#tasks-view-board').click();
    await expect(page.locator('.tasks-column[data-list-id="l1"]')).toHaveClass(/is-collapsed/);
  });
});
