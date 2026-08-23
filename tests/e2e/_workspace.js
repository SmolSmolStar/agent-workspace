async function ensureWorkspaceLoaded(page, { timeout = 20_000 } = {}) {
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await page.waitForFunction(() => window.orchestrator?.socket?.connected === true, { timeout });
      await page.waitForFunction(() => window.orchestrator?.userSettings != null, { timeout });

      const sidebar = page.locator('.sidebar:not(.hidden)');
      const openWorkspaceButton = page.getByRole('button', { name: 'Open Workspace' }).first();
      await Promise.any([
        sidebar.waitFor({ state: 'visible', timeout }),
        openWorkspaceButton.waitFor({ state: 'visible', timeout })
      ]);

      if (await sidebar.isVisible().catch(() => false)) return;

      await openWorkspaceButton.click();
      await page.waitForSelector('#recovery-dialog, .sidebar:not(.hidden)', { timeout });

      const recoveryDialog = page.locator('#recovery-dialog');
      const recoverySkipButton = page.locator('#recovery-skip');
      if (await recoveryDialog.isVisible().catch(() => false)) {
        try {
          await recoverySkipButton.waitFor({ state: 'visible', timeout: Math.min(timeout, 5_000) });
        } catch {
          throw new Error('Recovery dialog opened without a visible Skip recovery button.');
        }
        await recoverySkipButton.click();
      }

      await sidebar.waitFor({ state: 'visible', timeout });
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await page.reload();
    }
  }

  throw new Error(`Failed to load workspace for tests: ${lastError?.message || 'unknown error'}`);
}

async function dismissFocusOverlay(page) {
  const overlay = page.locator('#focus-overlay.active');
  if (!await overlay.isVisible().catch(() => false)) return;
  await page.locator('#focus-overlay .focus-close-btn').click();
  await overlay.waitFor({ state: 'hidden' });
}

module.exports = { ensureWorkspaceLoaded, dismissFocusOverlay };
