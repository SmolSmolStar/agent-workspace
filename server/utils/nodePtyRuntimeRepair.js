const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const REBUILD_TIMEOUT_MS = 180_000;
const REBUILD_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const DISABLED_VALUES = new Set(['0', 'false', 'no', 'off']);

function parseNodePtyAbiMismatch(error) {
  const message = String(error?.message || '');
  const match = message.match(
    /compiled against a different Node\.js version[\s\S]*?NODE_MODULE_VERSION\s+(\d+)[\s\S]*?requires NODE_MODULE_VERSION\s+(\d+)/i
  );
  if (!match) return null;

  const builtAbi = Number.parseInt(match[1], 10);
  const runtimeAbi = Number.parseInt(match[2], 10);
  if (!Number.isInteger(builtAbi) || !Number.isInteger(runtimeAbi)) return null;

  return { builtAbi, runtimeAbi };
}

function isAutoRepairEnabled(env = process.env) {
  const configured = String(env.ORCHESTRATOR_NODE_PTY_AUTO_REBUILD || '').trim().toLowerCase();
  return !DISABLED_VALUES.has(configured);
}

function isPackagedBackendRoot(rootDir) {
  const normalized = path.resolve(rootDir).replace(/\\/g, '/').toLowerCase();
  return normalized.includes('/resources/backend');
}

function isSourceCheckout(rootDir, fsImpl = fs) {
  return fsImpl.existsSync(path.join(rootDir, '.git'))
    && fsImpl.existsSync(path.join(rootDir, 'package.json'))
    && fsImpl.existsSync(path.join(rootDir, 'node_modules', 'node-pty', 'package.json'));
}

function resolveNpmCli({
  env = process.env,
  execPath = process.execPath,
  fsImpl = fs
} = {}) {
  const candidates = [
    String(env.npm_execpath || '').trim(),
    path.resolve(path.dirname(execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ];

  for (const candidate of candidates) {
    if (!candidate || path.extname(candidate).toLowerCase() !== '.js') continue;
    if (fsImpl.existsSync(candidate)) return candidate;
  }

  return null;
}

function formatSpawnFailure(result) {
  if (result?.error) return String(result.error.message || result.error);
  const stderr = String(result?.stderr || '').trim().replace(/\s+/g, ' ');
  if (stderr) return stderr.slice(-2000);
  if (result?.signal) return `npm rebuild stopped by ${result.signal}`;
  return `npm rebuild exited with status ${String(result?.status ?? 'unknown')}`;
}

class NodePtyRuntimeRepair {
  constructor({
    spawnSyncImpl = childProcess.spawnSync,
    fsImpl = fs,
    env = process.env,
    execPath = process.execPath,
    platform = process.platform,
    timeoutMs = REBUILD_TIMEOUT_MS
  } = {}) {
    this.spawnSyncImpl = spawnSyncImpl;
    this.fsImpl = fsImpl;
    this.env = env;
    this.execPath = execPath;
    this.platform = platform;
    this.timeoutMs = timeoutMs;
    this.attempted = false;
  }

  tryRepair(error, { rootDir } = {}) {
    const mismatch = parseNodePtyAbiMismatch(error);
    if (!mismatch) return { attempted: false, repaired: false, reason: 'not-abi-mismatch' };
    if (!isAutoRepairEnabled(this.env)) {
      return { attempted: false, repaired: false, reason: 'disabled', ...mismatch };
    }

    const resolvedRoot = path.resolve(rootDir || path.resolve(__dirname, '..', '..'));
    if (isPackagedBackendRoot(resolvedRoot)) {
      return { attempted: false, repaired: false, reason: 'packaged-backend', ...mismatch };
    }
    if (!isSourceCheckout(resolvedRoot, this.fsImpl)) {
      return { attempted: false, repaired: false, reason: 'not-source-checkout', ...mismatch };
    }
    if (this.attempted) {
      return { attempted: false, repaired: false, reason: 'already-attempted', ...mismatch };
    }

    const npmCli = resolveNpmCli({
      env: this.env,
      execPath: this.execPath,
      fsImpl: this.fsImpl
    });
    if (!npmCli) {
      return { attempted: false, repaired: false, reason: 'npm-cli-unavailable', ...mismatch };
    }

    this.attempted = true;
    let result;
    try {
      result = this.spawnSyncImpl(
        this.execPath,
        [npmCli, 'rebuild', 'node-pty'],
        {
          cwd: resolvedRoot,
          env: this.env,
          encoding: 'utf8',
          maxBuffer: REBUILD_MAX_BUFFER_BYTES,
          timeout: this.timeoutMs,
          windowsHide: this.platform === 'win32'
        }
      );
    } catch (error) {
      result = { error };
    }

    if (result?.status === 0 && !result.error) {
      return {
        attempted: true,
        repaired: true,
        reason: 'rebuilt',
        npmCli,
        ...mismatch
      };
    }

    return {
      attempted: true,
      repaired: false,
      reason: 'rebuild-failed',
      error: new Error(formatSpawnFailure(result)),
      npmCli,
      ...mismatch
    };
  }
}

const defaultNodePtyRuntimeRepair = new NodePtyRuntimeRepair();

module.exports = {
  NodePtyRuntimeRepair,
  REBUILD_TIMEOUT_MS,
  defaultNodePtyRuntimeRepair,
  isAutoRepairEnabled,
  isPackagedBackendRoot,
  isSourceCheckout,
  parseNodePtyAbiMismatch,
  resolveNpmCli
};
