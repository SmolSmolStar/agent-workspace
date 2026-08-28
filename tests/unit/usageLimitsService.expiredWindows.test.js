const { UsageLimitsService } = require('../../server/usageLimitsService');

const secondsFromNow = (secs) => Math.round(Date.now() / 1000) + secs;

describe('UsageLimitsService window expiry', () => {
  const service = new UsageLimitsService();

  test('a window is over only once its reset time has passed', () => {
    expect(service.isWindowOver({ resetsAt: secondsFromNow(600) })).toBe(false);
    expect(service.isWindowOver({ resetsAt: secondsFromNow(-3600) })).toBe(true);
    // No reset time (per-model weekly buckets arrive that way) is never expired.
    expect(service.isWindowOver({ usedPercentage: 40, resetsAt: null })).toBe(false);
    expect(service.isWindowOver(null)).toBe(false);
  });

  test('dropExpiredClaudeBuckets keeps running windows and clears finished ones', () => {
    const live = { usedPercentage: 12, resetsAt: secondsFromNow(1800) };
    const finished = { usedPercentage: 99, resetsAt: secondsFromNow(-1800) };
    const result = service.dropExpiredClaudeBuckets({
      available: true,
      fiveHour: finished,
      sevenDay: live,
      extraBuckets: [
        { key: 'seven_day_fable', usedPercentage: 37, resetsAt: null },
        { key: 'seven_day_opus', usedPercentage: 88, resetsAt: secondsFromNow(-60 * 60 * 24) }
      ]
    });

    expect(result.fiveHour).toBeNull();
    expect(result.sevenDay).toBe(live);
    expect(result.extraBuckets.map((b) => b.key)).toEqual(['seven_day_fable']);
  });

  test('unavailable readings pass through untouched', () => {
    const unavailable = { available: false, reason: 'no-oauth-token' };
    expect(service.dropExpiredClaudeBuckets(unavailable)).toBe(unavailable);
  });

  test('dropExpiredWindows filters provider windows and keeps the object when nothing expired', () => {
    const fresh = { available: true, windows: [{ usedPercentage: 9, resetsAt: secondsFromNow(3600) }] };
    expect(service.dropExpiredWindows(fresh)).toBe(fresh);

    const mixed = {
      available: true,
      windows: [
        { usedPercentage: 9, resetsAt: secondsFromNow(3600) },
        { usedPercentage: 100, resetsAt: secondsFromNow(-600) }
      ]
    };
    expect(service.dropExpiredWindows(mixed).windows).toHaveLength(1);
    expect(mixed.windows).toHaveLength(2);
  });
});

describe('UsageLimitsService.getClaudeLimits', () => {
  const buildService = ({ tap, oauth }) => {
    const service = new UsageLimitsService();
    service.readClaudeLimits = () => service.dropExpiredClaudeBuckets(tap);
    service.fetchClaudeOauthLimits = jest.fn().mockResolvedValue(oauth);
    return service;
  };

  test('never reports a percentage from a window that already reset', async () => {
    // What the user hit: every session sat blocked on a full 5-hour window, so
    // nothing rewrote the status-line tap, and the OAuth payload came back
    // without a session limit. The widget kept showing "5h 99%" after reset.
    const service = buildService({
      tap: {
        available: true,
        stale: false,
        model: 'Opus 5',
        fiveHour: { usedPercentage: 99, resetsAt: secondsFromNow(-2400) },
        sevenDay: { usedPercentage: 20, resetsAt: secondsFromNow(60 * 60 * 24) },
        extraBuckets: []
      },
      oauth: { available: true, fiveHour: null, sevenDay: null, extraBuckets: [] }
    });

    const result = await service.getClaudeLimits();
    expect(result.fiveHour).toBeNull();
    expect(result.sevenDay.usedPercentage).toBe(20);
  });

  test('still uses the tap for a running window the OAuth payload omits', async () => {
    const service = buildService({
      tap: {
        available: true,
        stale: false,
        model: 'Opus 5',
        fiveHour: { usedPercentage: 44, resetsAt: secondsFromNow(2400) },
        sevenDay: null,
        extraBuckets: []
      },
      oauth: { available: true, fiveHour: null, sevenDay: { usedPercentage: 20, resetsAt: secondsFromNow(60 * 60 * 24) }, extraBuckets: [] }
    });

    const result = await service.getClaudeLimits();
    expect(result.fiveHour.usedPercentage).toBe(44);
  });

  test('falls back to the tap when OAuth is unavailable, minus finished windows', async () => {
    const service = buildService({
      tap: {
        available: true,
        stale: true,
        model: 'Opus 5',
        fiveHour: { usedPercentage: 99, resetsAt: secondsFromNow(-30 * 60) },
        sevenDay: { usedPercentage: 20, resetsAt: secondsFromNow(60 * 60 * 24) },
        extraBuckets: []
      },
      oauth: { available: false, reason: 'http-401' }
    });

    const result = await service.getClaudeLimits();
    expect(result.stale).toBe(true);
    expect(result.fiveHour).toBeNull();
    expect(result.sevenDay.usedPercentage).toBe(20);
  });

  test('a cached OAuth response is refetched once one of its windows resets', async () => {
    const service = buildService({
      tap: { available: false },
      oauth: { available: true, fiveHour: { usedPercentage: 0, resetsAt: secondsFromNow(5 * 3600) }, sevenDay: null, extraBuckets: [] }
    });
    service.claudeOauthCache = {
      at: Date.now(),
      data: { available: true, fiveHour: { usedPercentage: 99, resetsAt: secondsFromNow(-300) }, sevenDay: null, extraBuckets: [] }
    };

    const result = await service.getClaudeLimits();
    expect(service.fetchClaudeOauthLimits).toHaveBeenCalledTimes(1);
    expect(result.fiveHour.usedPercentage).toBe(0);
  });

  test('a cached OAuth response is reused while its windows are still running', async () => {
    const service = buildService({
      tap: { available: false },
      oauth: { available: true, fiveHour: { usedPercentage: 1, resetsAt: secondsFromNow(3600) }, sevenDay: null, extraBuckets: [] }
    });
    service.claudeOauthCache = {
      at: Date.now(),
      data: { available: true, fiveHour: { usedPercentage: 55, resetsAt: secondsFromNow(3600) }, sevenDay: null, extraBuckets: [] }
    };

    const result = await service.getClaudeLimits();
    expect(service.fetchClaudeOauthLimits).not.toHaveBeenCalled();
    expect(result.fiveHour.usedPercentage).toBe(55);
  });
});
