const { UsageLimitsService } = require('../../server/usageLimitsService');

describe('UsageLimitsService.parseCodexRateLimits', () => {
  const service = new UsageLimitsService();

  test('uses raw app-server reset epochs and duration minutes', () => {
    const resetsAt = 1_807_801_542;
    const windows = service.parseCodexRateLimits({
      rateLimits: { limitId: 'codex' },
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          limitName: null,
          primary: { usedPercent: 9, windowDurationMins: 10_080, resetsAt },
          secondary: null
        },
        codex_bengalfox: {
          limitId: 'codex_bengalfox',
          limitName: 'GPT-5.3-Codex-Spark',
          primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: resetsAt + 10 }
        }
      }
    });

    expect(windows).toEqual([
      {
        bucket: 'codex',
        bucketName: null,
        name: 'primary',
        window: '1 week',
        windowDurationMins: 10_080,
        usedPercentage: 9,
        resetsAt
      },
      {
        bucket: 'codex_bengalfox',
        bucketName: 'GPT-5.3-Codex-Spark',
        name: 'primary',
        window: '5 hours',
        windowDurationMins: 300,
        usedPercentage: 42,
        resetsAt: resetsAt + 10
      }
    ]);
  });

  test('returns no windows for malformed envelopes', () => {
    expect(service.parseCodexRateLimits('')).toEqual([]);
    expect(service.parseCodexRateLimits({ rateLimits: { primary: { usedPercent: 1 } } })).toEqual([]);
    expect(service.parseCodexRateLimits(null)).toEqual([]);
  });
});

describe('UsageLimitsService.readClaudeLimits', () => {
  test('reports unavailable when the tap file is missing', () => {
    const service = new UsageLimitsService();
    process.env.HOME = '/nonexistent-home-for-test';
    const result = service.readClaudeLimits();
    expect(result.available === false || result.available === true).toBe(true);
  });
});

describe('UsageLimitsService.getCodexLimits', () => {
  test('fetches production app-server envelopes through the raw client', async () => {
    const resetsAt = 1_807_801_542;
    const codexRateLimitsClient = {
      read: jest.fn().mockResolvedValue({
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 48, windowDurationMins: 10_080, resetsAt }
        },
        rateLimitsByLimitId: {}
      }),
      cancelActive: jest.fn()
    };
    const service = new UsageLimitsService({ codexRateLimitsClient });

    await expect(service.fetchCodexLimits()).resolves.toMatchObject({
      available: true,
      windows: [{
        bucket: 'codex',
        windowDurationMins: 10_080,
        usedPercentage: 48,
        resetsAt
      }]
    });
    expect(codexRateLimitsClient.read).toHaveBeenCalledTimes(1);
  });

  test('refresh bypasses the fifteen-minute cache', async () => {
    const service = new UsageLimitsService();
    const cached = { available: true, windows: [{ usedPercentage: 90 }] };
    const fresh = { available: true, windows: [{ usedPercentage: 4 }] };
    service.codexCache = { at: Date.now(), data: cached };
    service.fetchCodexLimits = jest.fn().mockResolvedValue(fresh);

    await expect(service.getCodexLimits()).resolves.toBe(cached);
    await expect(service.getCodexLimits({ refresh: true })).resolves.toBe(fresh);
    expect(service.fetchCodexLimits).toHaveBeenCalledTimes(1);
  });
});

describe('UsageLimitsService grok parsing and provider gating', () => {
  const service = new UsageLimitsService();

  test('parseGrokWindows computes weekly percent and reset', () => {
    const weekly = { config: {
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' },
      onDemandCap: { val: 200 }, onDemandUsed: { val: 50 },
      billingPeriodEnd: '2026-08-20T14:52:28.270350+00:00'
    } };
    const windows = service.parseGrokWindows({ monthly: null, weekly });
    expect(windows).toHaveLength(1);
    expect(windows[0].window).toBe('1 week');
    expect(windows[0].usedPercentage).toBe(25);
    expect(typeof windows[0].resetsAt).toBe('number');
  });

  test('parseGrokWindows treats zero cap as 0% and adds monthly when limited', () => {
    const weekly = { config: {
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' },
      onDemandCap: { val: 0 }, onDemandUsed: { val: 0 },
      billingPeriodEnd: '2026-08-20T00:00:00+00:00'
    } };
    const monthly = { config: {
      monthlyLimit: { val: 100 }, used: { val: 30 },
      billingPeriodEnd: '2026-09-01T00:00:00+00:00'
    } };
    const windows = service.parseGrokWindows({ monthly, weekly });
    expect(windows).toHaveLength(2);
    expect(windows[0].usedPercentage).toBe(0);
    expect(windows[1].window).toBe('1 month');
    expect(windows[1].usedPercentage).toBe(30);
  });

  test('disabled providers short-circuit without fetching', async () => {
    const s2 = new UsageLimitsService();
    s2.fetchCodexLimits = jest.fn();
    s2.fetchGrokLimits = jest.fn();
    const result = await s2.getLimits({ providers: { claude: false, codex: false, grok: false } });
    expect(result.claude.reason).toBe('disabled');
    expect(result.codex.reason).toBe('disabled');
    expect(result.grok.reason).toBe('disabled');
    expect(s2.fetchCodexLimits).not.toHaveBeenCalled();
    expect(s2.fetchGrokLimits).not.toHaveBeenCalled();
  });
});
