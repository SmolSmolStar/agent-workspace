const { spawn } = require('child_process');
const os = require('os');

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_MESSAGE_CHARS = 2_000_000;
const MAX_TOTAL_RESPONSE_CHARS = 8_000_000;
const MAX_MESSAGES = 500;
const FORCE_KILL_DELAY_MS = 1_000;
const CLEANUP_TIMEOUT_MS = 2_000;
const MAX_STDERR_CHARS = 4_000;

class CodexRateLimitsClient {
  constructor({
    spawnImpl = spawn,
    executable = process.env.CODEX_BIN || 'codex',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cleanupTimeoutMs = CLEANUP_TIMEOUT_MS,
    forceKillDelayMs = FORCE_KILL_DELAY_MS,
    logger = console
  } = {}) {
    this.spawnImpl = spawnImpl;
    this.executable = executable;
    this.timeoutMs = timeoutMs;
    this.cleanupTimeoutMs = cleanupTimeoutMs;
    this.forceKillDelayMs = forceKillDelayMs;
    this.logger = logger;
    this.activeOperation = null;
  }

  read() {
    if (this.activeOperation) return this.activeOperation.promise;

    let child;
    try {
      child = this.spawnImpl(this.executable, ['app-server', '--stdio'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        cwd: os.tmpdir()
      });
    } catch (error) {
      return Promise.reject(error);
    }

    let buffer = '';
    let totalChars = 0;
    let messageCount = 0;
    let settled = false;
    let stderrBuffer = '';
    let resolvePromise;
    let rejectPromise;
    let timeout;
    let forceKillTimer;

    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    const writeMessage = (message) => {
      if (!child.stdin?.writable) throw new Error('codex-app-server-stdin-closed');
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const awaitExit = () => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode) {
        resolve();
        return;
      }
      let cleanupTimer;
      const done = () => {
        clearTimeout(cleanupTimer);
        child.removeListener('exit', done);
        child.removeListener('close', done);
        resolve();
      };
      child.once('exit', done);
      child.once('close', done);
      cleanupTimer = setTimeout(done, this.cleanupTimeoutMs);
      cleanupTimer.unref?.();
      try {
        child.stdin?.end();
      } catch {
        // The process may have already closed its input.
      }
      try {
        child.kill('SIGTERM');
      } catch {
        done();
        return;
      }
      forceKillTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // The process exited between the check and the signal.
        }
      }, this.forceKillDelayMs);
      forceKillTimer.unref?.();
    });

    const withStderr = (error) => {
      if (!error || error.message === 'codex-app-server-cancelled') return error;
      const diagnostic = stderrBuffer.trim().replace(/\s+/g, ' ').slice(-MAX_STDERR_CHARS);
      if (!diagnostic) return error;
      return new Error(`${error.message}: ${diagnostic}`);
    };

    const finish = async (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      await awaitExit();
      clearTimeout(forceKillTimer);
      if (this.activeOperation?.promise === promise) this.activeOperation = null;
      if (error) rejectPromise(withStderr(error));
      else resolvePromise(result);
    };

    const handleEnvelope = (message) => {
      if (!message || typeof message !== 'object' || message.id == null) return;
      if (message.error) {
        const detail = typeof message.error === 'object' ? message.error.message : message.error;
        finish(new Error(`codex-app-server-rejected: ${String(detail || 'unknown error')}`));
        return;
      }
      if (message.id === 1) {
        try {
          writeMessage({ jsonrpc: '2.0', method: 'initialized', params: {} });
          writeMessage({ jsonrpc: '2.0', method: 'account/rateLimits/read', id: 2 });
        } catch (error) {
          finish(error);
        }
        return;
      }
      if (message.id === 2) {
        if (!message.result || typeof message.result !== 'object') {
          finish(new Error('codex-app-server-invalid-rate-limits'));
          return;
        }
        finish(null, message.result);
      }
    };

    child.stdout?.on('data', (chunk) => {
      if (settled) return;
      const text = String(chunk);
      totalChars += text.length;
      if (totalChars > MAX_TOTAL_RESPONSE_CHARS) {
        finish(new Error('codex-app-server-response-too-large'));
        return;
      }
      buffer += text;
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0 && !settled) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > MAX_MESSAGE_CHARS) {
          finish(new Error('codex-app-server-message-too-large'));
          return;
        }
        messageCount += 1;
        if (messageCount > MAX_MESSAGES) {
          finish(new Error('codex-app-server-too-many-messages'));
          return;
        }
        try {
          handleEnvelope(JSON.parse(line));
        } catch {
          // App-server may write non-JSON diagnostics to stdout. Ignore them.
        }
        newlineIndex = buffer.indexOf('\n');
      }
      if (buffer.length > MAX_MESSAGE_CHARS) {
        finish(new Error('codex-app-server-message-too-large'));
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderrBuffer = `${stderrBuffer}${String(chunk)}`.slice(-MAX_STDERR_CHARS);
    });

    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      if (!settled) {
        finish(new Error(`codex-app-server-exited: ${signal || code || 'unknown'}`));
      }
    });

    timeout = setTimeout(() => finish(new Error('codex-app-server-timeout')), this.timeoutMs);
    timeout.unref?.();

    this.activeOperation = {
      child,
      promise,
      cancel: () => finish(new Error('codex-app-server-cancelled'))
    };

    try {
      writeMessage({
        jsonrpc: '2.0',
        method: 'initialize',
        id: 1,
        params: {
          clientInfo: {
            name: 'agent-workspace',
            title: 'Agent Workspace',
            version: '1.0.0'
          }
        }
      });
    } catch (error) {
      finish(error);
    }

    return promise;
  }

  async cancelActive() {
    const operation = this.activeOperation;
    if (!operation) return;
    operation.cancel();
    await operation.promise.catch(() => {});
  }
}

module.exports = {
  CodexRateLimitsClient,
  DEFAULT_TIMEOUT_MS
};
