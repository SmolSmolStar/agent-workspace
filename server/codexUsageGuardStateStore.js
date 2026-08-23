const fs = require('fs');
const path = require('path');

const LOCK_TIMEOUT_MS = 1_000;
const LOCK_RETRY_MS = 10;
const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

class CodexUsageGuardStateStore {
  constructor({ filePath, normalizeState, logger = console } = {}) {
    this.filePath = filePath;
    this.normalizeState = normalizeState;
    this.logger = logger;
  }

  read({ throwOnError = false } = {}) {
    try {
      if (!fs.existsSync(this.filePath)) return null;
      return this.normalizeState(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
    } catch (error) {
      this.logger.warn?.('Failed to load Codex usage guard state', {
        error: error.message,
        path: this.filePath
      });
      if (throwOnError) throw error;
      return null;
    }
  }

  update(buildNextState) {
    let lockPath = null;
    try {
      lockPath = this.acquireLock();
      const persisted = this.read({ throwOnError: true });
      const nextState = this.normalizeState(buildNextState(persisted));
      this.write(nextState);
      return nextState;
    } finally {
      this.releaseLock(lockPath);
    }
  }

  acquireLock() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const lockPath = `${this.filePath}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    while (true) {
      try {
        const descriptor = fs.openSync(lockPath, 'wx', 0o600);
        fs.closeSync(descriptor);
        return lockPath;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw new Error('usage-guard-state-lock-timeout');
        Atomics.wait(LOCK_WAIT, 0, 0, LOCK_RETRY_MS);
      }
    }
  }

  releaseLock(lockPath) {
    if (!lockPath) return;
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger.warn?.('Failed to release Codex usage guard state lock', {
          error: error.message,
          path: lockPath
        });
      }
    }
  }

  write(nextState) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }
}

module.exports = { CodexUsageGuardStateStore };
