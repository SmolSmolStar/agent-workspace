const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  CodexUsageGuardService,
  DEFAULT_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS
} = require('../../server/codexUsageGuardService');

function codexLimits({ usedPercentage, resetsAt, sparkUsed = 0, sparkResetsAt = resetsAt }) {
  return {
    available: true,
    windows: [
      {
        bucket: 'codex_spark',
        name: 'primary',
        window: '5 hours',
        windowDurationMins: 300,
        usedPercentage: sparkUsed,
        resetsAt: sparkResetsAt
      },
      {
        bucket: 'codex_spark',
        name: 'secondary',
        window: '1 week',
        windowDurationMins: 10080,
        usedPercentage: sparkUsed,
        resetsAt: sparkResetsAt
      },
      {
        bucket: 'codex',
        name: 'primary',
        window: '1 week',
        windowDurationMins: 10080,
        usedPercentage,
        resetsAt
      }
    ]
  };
}

describe('CodexUsageGuardService', () => {
  let tempDir;
  let storePath;
  let nowMs;
  let usageLimitsService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-guard-'));
    storePath = path.join(tempDir, 'state.json');
    nowMs = Date.UTC(2026, 7, 23, 0, 0, 0);
    usageLimitsService = { getCodexLimits: jest.fn() };
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createService(options = {}) {
    return new CodexUsageGuardService({
      usageLimitsService,
      logger: { info: jest.fn(), warn: jest.fn() },
      storePath,
      enabled: true,
      now: () => nowMs,
      ...options
    });
  }

  test('enters drain mode only when the weekly reset advances and usage drops', async () => {
    usageLimitsService.getCodexLimits
      .mockResolvedValueOnce(codexLimits({ usedPercentage: 97, resetsAt: 1_800_000_000 }))
      .mockResolvedValueOnce(codexLimits({ usedPercentage: 2, resetsAt: 1_800_604_800 }));
    const service = createService();

    expect((await service.pollOnce()).mode).toBe('monitoring');
    nowMs += 2 * 60 * 1000;
    const status = await service.pollOnce();

    expect(status).toMatchObject({
      mode: 'draining',
      admittingCodex: false,
      drainReason: 'window-rollover',
      rollover: {
        previousResetsAt: 1_800_000_000,
        currentResetsAt: 1_800_604_800,
        previousUsedPercentage: 97,
        currentUsedPercentage: 2
      }
    });
    expect(usageLimitsService.getCodexLimits).toHaveBeenNthCalledWith(1, { refresh: true });
    expect(usageLimitsService.getCodexLimits).toHaveBeenNthCalledWith(2, { refresh: true });
  });

  test('blocks Codex admissions while the initial poll is pending', () => {
    const service = createService();

    expect(service.getStatus()).toMatchObject({
      mode: 'initializing',
      admittingCodex: false
    });
    expect(service.getAdmissionDecision({ agentId: 'codex' })).toMatchObject({
      allowed: false,
      code: 'codex-usage-monitor-pending'
    });
    expect(service.getAdmissionDecision({ agentId: 'claude' })).toEqual({ allowed: true });
  });

  test('stays fail-closed when every startup poll fails and cannot be resumed around the monitor', async () => {
    usageLimitsService.getCodexLimits.mockResolvedValue({ available: false, reason: 'app-server-failed' });
    const service = createService({ failureThreshold: 2 });

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect(await service.pollOnce()).toMatchObject({
        mode: 'initializing',
        admittingCodex: false,
        consecutiveFailures: attempt,
        monitorReady: false
      });
    }
    expect(service.resumeAdmissions({ acknowledgedBy: 'operator' })).toMatchObject({
      mode: 'initializing',
      admittingCodex: false,
      resumedBy: null
    });
    expect(service.getAdmissionDecision({ agentId: 'claude' })).toEqual({ allowed: true });
  });

  test('does not drain for a reset change without a drop or a drop without a reset change', async () => {
    usageLimitsService.getCodexLimits
      .mockResolvedValueOnce(codexLimits({ usedPercentage: 70, resetsAt: 1_800_000_000 }))
      .mockResolvedValueOnce(codexLimits({ usedPercentage: 70, resetsAt: 1_800_604_800 }))
      .mockResolvedValueOnce(codexLimits({ usedPercentage: 20, resetsAt: 1_800_604_800 }));
    const service = createService();

    await service.pollOnce();
    expect((await service.pollOnce()).mode).toBe('monitoring');
    expect((await service.pollOnce()).mode).toBe('monitoring');
  });

  test('a twelve-hour clock advance cannot trigger drain when limits are unchanged', async () => {
    const limits = codexLimits({ usedPercentage: 61, resetsAt: 1_800_000_000 });
    usageLimitsService.getCodexLimits.mockResolvedValue(limits);
    const service = createService();

    await service.pollOnce();
    nowMs += 12 * 60 * 60 * 1000;
    const status = await service.pollOnce();

    expect(status.mode).toBe('monitoring');
    expect(status.drainReason).toBeNull();
  });

  test('drains an exhausted weekly window without waiting for rollover', async () => {
    usageLimitsService.getCodexLimits.mockResolvedValue(
      codexLimits({ usedPercentage: 100, resetsAt: 1_800_000_000 })
    );
    const service = createService();

    const status = await service.pollOnce();

    expect(status.mode).toBe('draining');
    expect(status.drainReason).toBe('exhausted');
    expect(service.getAdmissionDecision({ agentId: 'codex' }).allowed).toBe(false);
    expect(service.getAdmissionDecision({ agentId: 'claude' }).allowed).toBe(true);
  });

  test('restores drain state after restart and requires explicit resume', async () => {
    usageLimitsService.getCodexLimits.mockResolvedValue(
      codexLimits({ usedPercentage: 100, resetsAt: 1_800_000_000 })
    );
    const first = createService();
    await first.pollOnce();

    const restarted = createService();
    expect(restarted.getStatus()).toMatchObject({
      mode: 'draining',
      admittingCodex: false,
      drainReason: 'exhausted'
    });

    expect(restarted.resumeAdmissions({ acknowledgedBy: 'too-early' }).mode).toBe('draining');
    await restarted.pollOnce();
    const resumed = restarted.resumeAdmissions({ acknowledgedBy: 'test' });
    expect(resumed).toMatchObject({
      mode: 'monitoring',
      admittingCodex: true,
      resumedBy: 'test'
    });
    expect(new CodexUsageGuardService({
      usageLimitsService,
      storePath,
      now: () => nowMs
    }).getStatus()).toMatchObject({
      mode: 'initializing',
      admittingCodex: false
    });
  });

  test('requires a live successful poll after restart before reopening persisted monitoring state', async () => {
    usageLimitsService.getCodexLimits
      .mockResolvedValueOnce(codexLimits({ usedPercentage: 40, resetsAt: 1_800_000_000 }))
      .mockResolvedValueOnce({ available: false, reason: 'app-server-failed' })
      .mockResolvedValueOnce(codexLimits({ usedPercentage: 41, resetsAt: 1_800_000_000 }));
    await createService().pollOnce();

    const restarted = createService();
    expect(restarted.getStatus()).toMatchObject({
      mode: 'initializing',
      admittingCodex: false,
      monitorReady: false
    });
    expect(await restarted.pollOnce()).toMatchObject({
      mode: 'initializing',
      admittingCodex: false
    });
    expect(await restarted.pollOnce()).toMatchObject({
      mode: 'monitoring',
      admittingCodex: true,
      monitorReady: true
    });
  });

  test('restores the last weekly observation and detects rollover after restart', async () => {
    usageLimitsService.getCodexLimits
      .mockResolvedValueOnce(codexLimits({ usedPercentage: 88, resetsAt: 1_800_000_000 }))
      .mockResolvedValueOnce(codexLimits({ usedPercentage: 1, resetsAt: 1_800_604_800 }));
    await createService().pollOnce();

    nowMs += 2 * 60 * 1000;
    const restarted = createService();
    const status = await restarted.pollOnce();

    expect(status.mode).toBe('draining');
    expect(status.drainReason).toBe('window-rollover');
  });

  test('ignores Spark rollover when the main Codex weekly window is unchanged', async () => {
    usageLimitsService.getCodexLimits
      .mockResolvedValueOnce(codexLimits({
        usedPercentage: 80,
        resetsAt: 1_800_000_000,
        sparkUsed: 95,
        sparkResetsAt: 1_800_000_000
      }))
      .mockResolvedValueOnce(codexLimits({
        usedPercentage: 80,
        resetsAt: 1_800_000_000,
        sparkUsed: 1,
        sparkResetsAt: 1_800_604_800
      }));
    const service = createService();

    await service.pollOnce();
    const status = await service.pollOnce();

    expect(status.mode).toBe('monitoring');
    expect(status.observedWindow.bucket).toBe('codex');
  });

  test('poll failures preserve the last observation and never manufacture a rollover', async () => {
    usageLimitsService.getCodexLimits
      .mockResolvedValueOnce(codexLimits({ usedPercentage: 40, resetsAt: 1_800_000_000 }))
      .mockResolvedValueOnce({ available: false, reason: 'helper-failed' });
    const service = createService();

    await service.pollOnce();
    const status = await service.pollOnce();

    expect(status.mode).toBe('monitoring');
    expect(status.lastError).toBe('helper-failed');
    expect(status.observedWindow.usedPercentage).toBe(40);
  });

  test('fails closed after repeated poll failures and recovers on a valid poll', async () => {
    usageLimitsService.getCodexLimits
      .mockResolvedValueOnce(codexLimits({ usedPercentage: 40, resetsAt: 1_800_000_000 }))
      .mockResolvedValueOnce({ available: false, reason: 'app-server-failed' })
      .mockResolvedValueOnce({ available: false, reason: 'app-server-failed' })
      .mockResolvedValueOnce(codexLimits({ usedPercentage: 42, resetsAt: 1_800_000_000 }));
    const service = createService({ failureThreshold: 2 });

    await service.pollOnce();
    expect((await service.pollOnce()).mode).toBe('monitoring');
    expect(await service.pollOnce()).toMatchObject({
      mode: 'monitor-unavailable',
      admittingCodex: false,
      consecutiveFailures: 2
    });
    expect(service.getAdmissionDecision({ agentId: 'codex' }).code).toBe('codex-usage-monitor-unavailable');
    expect(service.resumeAdmissions({ acknowledgedBy: 'test' })).toMatchObject({
      mode: 'monitor-unavailable',
      admittingCodex: false,
      resumedBy: null
    });

    expect(await service.pollOnce()).toMatchObject({
      mode: 'monitoring',
      admittingCodex: true,
      consecutiveFailures: 0,
      lastError: null
    });
  });

  test('fails closed until a successful observation can be persisted', async () => {
    usageLimitsService.getCodexLimits.mockResolvedValue(
      codexLimits({ usedPercentage: 64, resetsAt: 1_800_000_000 })
    );
    const rename = jest.spyOn(fs, 'renameSync')
      .mockImplementationOnce(() => { throw new Error('disk unavailable'); });
    const service = createService();

    expect(await service.pollOnce()).toMatchObject({
      mode: 'monitor-unavailable',
      admittingCodex: false,
      drainReason: 'monitor-unavailable',
      lastError: 'usage-guard-state-persist-failed: disk unavailable'
    });
    expect(service.getAdmissionDecision({ agentId: 'codex' })).toMatchObject({
      allowed: false,
      code: 'codex-usage-monitor-unavailable'
    });

    rename.mockRestore();
    expect(await service.pollOnce()).toMatchObject({
      mode: 'monitoring',
      admittingCodex: true,
      lastError: null
    });
    expect(JSON.parse(fs.readFileSync(storePath, 'utf8'))).toMatchObject({
      mode: 'monitoring',
      observedWindow: { usedPercentage: 64 }
    });
  });

  test('keeps a persisted drain closed when resume cannot be persisted', async () => {
    usageLimitsService.getCodexLimits.mockResolvedValue(
      codexLimits({ usedPercentage: 100, resetsAt: 1_800_000_000 })
    );
    const service = createService();
    await service.pollOnce();
    jest.spyOn(fs, 'renameSync')
      .mockImplementationOnce(() => { throw new Error('disk unavailable'); });

    expect(service.resumeAdmissions({ acknowledgedBy: 'test' })).toMatchObject({
      mode: 'draining',
      admittingCodex: false,
      drainReason: 'exhausted',
      resumedBy: null,
      lastError: 'usage-guard-state-persist-failed: disk unavailable'
    });
    expect(JSON.parse(fs.readFileSync(storePath, 'utf8'))).toMatchObject({
      mode: 'draining',
      drainReason: 'exhausted'
    });
  });

  test('stop cancels and awaits the active app-server read', async () => {
    let resolvePoll;
    const pendingPoll = new Promise((resolve) => { resolvePoll = resolve; });
    usageLimitsService.getCodexLimits.mockReturnValue(pendingPoll);
    usageLimitsService.cancelCodexFetch = jest.fn(async () => {
      resolvePoll({ available: false, reason: 'cancelled' });
    });
    const service = createService();
    const poll = service.pollOnce();

    await service.stop();
    await poll;

    expect(usageLimitsService.cancelCodexFetch).toHaveBeenCalledTimes(1);
    expect(service.pollInFlight).toBeNull();
  });

  test('keeps guard polling between two and five minutes', () => {
    expect(createService({ pollIntervalMs: undefined }).pollIntervalMs).toBe(DEFAULT_POLL_INTERVAL_MS);
    expect(createService({ pollIntervalMs: 1 }).pollIntervalMs).toBe(MIN_POLL_INTERVAL_MS);
    expect(createService({ pollIntervalMs: 60 * 60 * 1000 }).pollIntervalMs).toBe(MAX_POLL_INTERVAL_MS);
  });
});
