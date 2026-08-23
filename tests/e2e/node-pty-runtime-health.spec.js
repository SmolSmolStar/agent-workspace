const { test, expect } = require('@playwright/test');

test('safe-port server loads the native terminal runtime', async ({ request }) => {
  const response = await request.get('/api/diagnostics');
  expect(response.ok()).toBe(true);

  const diagnostics = await response.json();
  expect(diagnostics).toMatchObject({
    ok: true,
    nodePty: { ok: true }
  });
});
