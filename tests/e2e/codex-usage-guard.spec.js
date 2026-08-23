const { test, expect } = require('@playwright/test');

test.describe('Codex usage guard API', () => {
  test('fails closed while the isolated app-server monitor is unavailable', async ({ request }) => {
    const statusResponse = await request.get('/api/usage/codex-guard');
    expect(statusResponse.ok()).toBe(true);
    const status = await statusResponse.json();
    expect(status).toMatchObject({
      enabled: true,
      mode: 'initializing',
      admittingCodex: false
    });
    expect(status.pollIntervalMs).toBeGreaterThanOrEqual(120_000);
    expect(status.pollIntervalMs).toBeLessThanOrEqual(300_000);

    const resumeResponse = await request.post('/api/usage/codex-guard/resume', {
      data: { acknowledgedBy: 'e2e' }
    });
    expect(resumeResponse.ok()).toBe(true);
    await expect(resumeResponse.json()).resolves.toMatchObject({
      mode: 'initializing',
      admittingCodex: false,
      resumedBy: null
    });
  });
});
