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
        usedPercentage: sparkUsed,
        resetsAt: sparkResetsAt
      },
      {
        bucket: 'codex_spark',
        name: 'secondary',
        window: '1 week',
        usedPercentage: sparkUsed,
        resetsAt: sparkResetsAt
      },
      {
        bucket: 'codex',
        name: 'primary',
        window: '1 week',
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
    }).getStatus().mode).toBe('monitoring');
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

  test('keeps guard polling between two and five minutes', () => {
    expect(createService({ pollIntervalMs: undefined }).pollIntervalMs).toBe(DEFAULT_POLL_INTERVAL_MS);
    expect(createService({ pollIntervalMs: 1 }).pollIntervalMs).toBe(MIN_POLL_INTERVAL_MS);
    expect(createService({ pollIntervalMs: 60 * 60 * 1000 }).pollIntervalMs).toBe(MAX_POLL_INTERVAL_MS);
  });
});
