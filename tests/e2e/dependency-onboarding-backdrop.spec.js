const { test, expect } = require('@playwright/test');
const { mockUserSettings } = require('./_mockUserSettings');

async function mockDependencySetup(page, { legalAccepted }) {
  await mockUserSettings(page);

  const setup = {
    state: {
      legalAccepted,
      dismissed: false,
      completed: false,
      currentStep: 0,
      skippedActionIds: []
    }
  };

  await page.route('**/bootstrap/setup-state.js', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `window.__ORCHESTRATOR_SETUP_STATE__ = ${JSON.stringify(setup.state)};`
    });
  });

  await page.route('**/api/setup-actions/state', async (route) => {
    if (route.request().method() === 'PUT') {
      setup.state = {
        ...setup.state,
        ...(route.request().postDataJSON() || {})
      };
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, state: setup.state })
    });
  });

  await page.route('**/api/diagnostics', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        platform: 'win32',
        tools: [
          { id: 'git', ok: true, version: '2.47.0' },
          { id: 'claude', ok: true, version: '1.0.0' },
          { id: 'codex', ok: false },
          { id: 'gitIdentity', ok: false }
        ]
      })
    });
  });

  await page.route('**/api/setup-actions', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        platform: 'win32',
        actions: [
          {
            id: 'install-git',
            title: 'Install Git',
            description: 'Install Git for repository operations.',
            command: 'winget install Git.Git',
            optional: false
          },
          {
            id: 'install-claude',
            title: 'Install Claude Code',
            description: 'Install Claude Code for agent workflows.',
            command: 'npm install -g @anthropic-ai/claude-code',
            optional: false
          },
          {
            id: 'configure-git-identity',
            title: 'Configure Git identity',
            description: 'Set your name and email for commits.',
            command: '',
            optional: true,
            runSupported: false
          },
          {
            id: 'install-codex',
            title: 'Install Codex',
            description: 'Install Codex for additional agent workflows.',
            command: 'npm install -g @openai/codex',
            optional: true
          }
        ]
      })
    });
  });

  return setup;
}

test.describe('Dependency onboarding backdrop dismissal', () => {
  test('backdrop clicks do not dismiss onboarding', async ({ page }) => {
    test.setTimeout(60000);

    const setup = await mockDependencySetup(page, { legalAccepted: true });

    await page.goto('/');

    await page.getByRole('button', { name: 'Start setup' }).click();

    const modal = page.locator('#dependency-setup-modal');
    const container = page.locator('.onboarding-container');
    await expect(modal).toBeVisible();
    await expect(page.locator('.onboarding-step-title')).toHaveText('Install Git');

    const modalBox = await modal.boundingBox();
    const containerBox = await container.boundingBox();

    if (!modalBox || !containerBox) {
      throw new Error('Expected onboarding modal geometry to be available.');
    }

    const backdropX = modalBox.x + ((containerBox.x - modalBox.x) / 2);
    const backdropY = containerBox.y + 40;

    await page.mouse.click(backdropX, backdropY);

    await expect(modal).toBeVisible();
    await expect(page.locator('.onboarding-step-title')).toHaveText('Install Git');
    expect(setup.state.dismissed).toBe(false);
    await page.getByRole('button', { name: 'Next step' }).click();
    await expect(page.locator('.onboarding-step-title')).toHaveText('Install Claude Code');
  });

  test('blocks dependency setup until the legal acknowledgement is accepted', async ({ page }) => {
    const setup = await mockDependencySetup(page, { legalAccepted: false });

    await page.goto('/');

    const agreement = page.getByRole('button', { name: 'I Agree' });
    await expect(page.locator('.onboarding-legal-card')).toBeVisible();
    await expect(agreement).toBeVisible();
    expect(setup.state.legalAccepted).toBe(false);

    await agreement.click();

    await expect.poll(() => setup.state.legalAccepted).toBe(true);
    await page.getByRole('button', { name: 'Start setup' }).click();
    await expect(page.locator('.onboarding-step-title')).toHaveText('Install Git');
  });
});
