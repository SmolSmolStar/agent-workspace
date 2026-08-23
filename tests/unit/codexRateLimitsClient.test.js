const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const { CodexRateLimitsClient } = require('../../server/codexRateLimitsClient');

function createFakeChild(onRequest = () => {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = jest.fn((signal) => {
    child.signalCode = signal;
    queueMicrotask(() => child.emit('exit', null, signal));
    return true;
  });
  child.stdin = new Writable({
    write(chunk, encoding, callback) {
      for (const line of String(chunk).trim().split('\n')) {
        if (line) onRequest(JSON.parse(line), child);
      }
      callback();
    }
  });
  return child;
}

describe('CodexRateLimitsClient', () => {
  test('reads the production JSON-RPC envelope and ignores notifications', async () => {
    const requests = [];
    const child = createFakeChild((request, activeChild) => {
      requests.push(request);
      if (request.id === 1) {
        activeChild.stdout.write(`${JSON.stringify({ method: 'account/updated', params: {} })}\n`);
        activeChild.stdout.write(`${JSON.stringify({ id: 1, result: { userAgent: 'codex' } })}\n`);
      }
      if (request.id === 2) {
        activeChild.stdout.write(`${JSON.stringify({
          id: 2,
          result: {
            rateLimits: {
              limitId: 'codex',
              primary: { usedPercent: 47, windowDurationMins: 10_080, resetsAt: 1_807_801_542 }
            },
            rateLimitsByLimitId: {}
          }
        })}\n`);
      }
    });
    const client = new CodexRateLimitsClient({
      spawnImpl: jest.fn(() => child),
      timeoutMs: 1_000
    });

    await expect(client.read()).resolves.toMatchObject({
      rateLimits: {
        primary: { usedPercent: 47, windowDurationMins: 10_080, resetsAt: 1_807_801_542 }
      }
    });
    expect(requests.map(({ method }) => method)).toEqual([
      'initialize',
      'initialized',
      'account/rateLimits/read'
    ]);
    expect(requests.every(({ jsonrpc }) => jsonrpc === '2.0')).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  test('cancels and awaits an active child', async () => {
    const child = createFakeChild();
    const client = new CodexRateLimitsClient({
      spawnImpl: jest.fn(() => child),
      timeoutMs: 10_000
    });
    const read = client.read();
    const rejection = expect(read).rejects.toThrow('codex-app-server-cancelled');

    await client.cancelActive();
    await rejection;

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(client.activeOperation).toBeNull();
  });

  test('bounds cleanup when a child never reports exit and retains stderr diagnostics', async () => {
    const child = createFakeChild();
    child.kill = jest.fn(() => true);
    const client = new CodexRateLimitsClient({
      spawnImpl: jest.fn(() => child),
      timeoutMs: 5,
      forceKillDelayMs: 5,
      cleanupTimeoutMs: 15
    });
    child.stderr.write('authentication required\n');

    await expect(client.read()).rejects.toThrow('codex-app-server-timeout: authentication required');

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(client.activeOperation).toBeNull();
  });

  test('finishes cleanup when signalling the child fails', async () => {
    const child = createFakeChild();
    child.kill = jest.fn(() => {
      throw new Error('process already unavailable');
    });
    const client = new CodexRateLimitsClient({
      spawnImpl: jest.fn(() => child),
      timeoutMs: 10_000,
      cleanupTimeoutMs: 10_000
    });
    const read = client.read();

    await client.cancelActive();
    await expect(read).rejects.toThrow('codex-app-server-cancelled');

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(client.activeOperation).toBeNull();
  });
});
