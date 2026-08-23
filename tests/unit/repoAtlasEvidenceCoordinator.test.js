const { createEvidenceCoordinator } = require('../../server/atlas/atlasEvidenceCoordinator');

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('atlasEvidenceCoordinator', () => {
  test('coalesces matching work onto the same promise', async () => {
    const coordinator = createEvidenceCoordinator({ maxConcurrent: 2 });
    const gate = deferred();
    const task = jest.fn(async () => {
      await gate.promise;
      return 'report';
    });

    const first = coordinator.run('same-repo', task);
    const second = coordinator.run('same-repo', task);

    await Promise.resolve();
    expect(second).toBe(first);
    expect(task).toHaveBeenCalledTimes(1);
    gate.resolve();
    await expect(first).resolves.toBe('report');
    expect(coordinator.state()).toEqual({ active: 0, queued: 0, inFlight: 0 });
  });

  test('caps concurrent repository inspections and drains queued work', async () => {
    const coordinator = createEvidenceCoordinator({ maxConcurrent: 2 });
    const gates = [deferred(), deferred(), deferred()];
    let active = 0;
    let peak = 0;
    const tasks = gates.map((gate, index) => coordinator.run(`repo-${index}`, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
      return index;
    }));

    await Promise.resolve();
    expect(coordinator.state()).toEqual({ active: 2, queued: 1, inFlight: 3 });
    expect(peak).toBe(2);

    gates[0].resolve();
    await tasks[0];
    await Promise.resolve();
    expect(coordinator.state().active).toBe(2);

    gates[1].resolve();
    gates[2].resolve();
    await expect(Promise.all(tasks)).resolves.toEqual([0, 1, 2]);
    expect(peak).toBe(2);
  });

  test('rejects excess unique work instead of growing the queue without a bound', async () => {
    const coordinator = createEvidenceCoordinator({ maxConcurrent: 1, maxQueued: 1 });
    const activeGate = deferred();
    const queuedGate = deferred();
    const active = coordinator.run('active', () => activeGate.promise);
    const queued = coordinator.run('queued', () => queuedGate.promise);

    await expect(coordinator.run('overflow', async () => 'never'))
      .rejects.toThrow('Repository evidence queue is full.');
    expect(coordinator.state()).toEqual({ active: 1, queued: 1, inFlight: 2 });

    activeGate.resolve('active');
    queuedGate.resolve('queued');
    await expect(Promise.all([active, queued])).resolves.toEqual(['active', 'queued']);
  });
});
