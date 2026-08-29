const { SystemStatsService, dedupeByPid } = require('../../server/systemStatsService');

describe('dedupeByPid', () => {
  test('sums usedGB for rows sharing a pid instead of listing them separately', () => {
    // Windows' GPU dedicated-usage counter emits one row per (pid, engine)
    // pair — a single process using two engines must collapse to one row.
    const rows = [
      { pid: 34272, name: 'vmwp', usedGB: 23.6 },
      { pid: 20624, name: 'discord_clips', usedGB: 96.6 },
      { pid: 34272, name: 'vmwp', usedGB: 2.4 }
    ];
    const result = dedupeByPid(rows);
    expect(result).toHaveLength(2);
    const vmwp = result.find(p => p.pid === 34272);
    expect(vmwp.usedGB).toBeCloseTo(26.0, 5);
  });

  test('sorts the deduped result by usedGB descending', () => {
    const rows = [
      { pid: 1, name: 'a', usedGB: 1 },
      { pid: 2, name: 'b', usedGB: 5 },
      { pid: 3, name: 'c', usedGB: 3 }
    ];
    expect(dedupeByPid(rows).map(p => p.pid)).toEqual([2, 3, 1]);
  });

  test('leaves distinct pids untouched (other than descending re-sort)', () => {
    const rows = [{ pid: 1, name: 'a', usedGB: 1 }, { pid: 2, name: 'b', usedGB: 2 }];
    expect(dedupeByPid(rows)).toEqual([rows[1], rows[0]]);
  });
});

describe('SystemStatsService._enrichWslBucket', () => {
  test('merges every raw WSL2 VM bucket row into the one identified entry', async () => {
    const svc = new SystemStatsService();
    svc._fetchLocalWslGpuProcesses = jest.fn().mockResolvedValue([
      { pid: 616572, argv: [], kind: 'llama.cpp', label: 'Nemotron-30B', modelPath: null, port: '18869' }
    ]);
    // Simulates the pre-dedupe-fix bug: two counter-instance rows for the
    // same underlying vmwp process, both already renamed to the bucket name.
    const processes = [
      { pid: 34272, name: 'WSL2 VM (Linux-side GPU usage)', usedGB: 23.6 },
      { pid: 34272, name: 'WSL2 VM (Linux-side GPU usage)', usedGB: 2.4 }
    ];
    const result = await svc._enrichWslBucket(processes);
    const wslRows = result.filter(p => p.name.includes('WSL') || p.name.includes('Nemotron'));
    expect(wslRows).toHaveLength(1);
    expect(wslRows[0].usedGB).toBeCloseTo(26.0, 5);
    expect(wslRows[0].name).toBe('Nemotron-30B (llama.cpp)');
    expect(wslRows[0].identified).toEqual([
      { pid: 616572, kind: 'llama.cpp', label: 'Nemotron-30B', port: '18869' }
    ]);
  });

  test('returns processes unchanged when there is no WSL2 VM bucket', async () => {
    const svc = new SystemStatsService();
    svc._fetchLocalWslGpuProcesses = jest.fn();
    const processes = [{ pid: 1, name: 'chrome.exe', usedGB: 1.2 }];
    const result = await svc._enrichWslBucket(processes);
    expect(result).toEqual(processes);
    expect(svc._fetchLocalWslGpuProcesses).not.toHaveBeenCalled();
  });
});

describe('SystemStatsService.getStats suspect flagging', () => {
  test('flags a process reporting more VRAM than the card physically has', async () => {
    const svc = new SystemStatsService();
    svc.getGpu = jest.fn().mockResolvedValue({ available: true, totalGB: 31.8, usedGB: 29.1, name: 'RTX 5090' });
    svc.getGpuProcesses = jest.fn().mockResolvedValue({
      available: true,
      source: 'windows-gpu-counters',
      processes: [
        { pid: 20624, name: 'discord_clips', usedGB: 96.6 },
        { pid: 34272, name: 'Nemotron-30B (llama.cpp)', usedGB: 23.6 }
      ]
    });
    svc.getLoadedModels = jest.fn().mockResolvedValue({ ollama: { models: [] }, llamaCppServers: [] });

    const stats = await svc.getStats({ includeProcesses: true });
    const discord = stats.gpuProcesses.processes.find(p => p.pid === 20624);
    const llama = stats.gpuProcesses.processes.find(p => p.pid === 34272);
    expect(discord.suspect).toBe(true);
    expect(llama.suspect).toBe(false);
    expect(stats.gpuProcesses.hasSuspect).toBe(true);
  });
});
