const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadNodePty } = require('../../server/utils/nodePtyCompat');
const {
  NodePtyRuntimeRepair,
  isPackagedBackendRoot,
  parseNodePtyAbiMismatch,
  resolveNpmCli
} = require('../../server/utils/nodePtyRuntimeRepair');

const ABI_ERROR = new Error(
  "The module '/repo/node_modules/node-pty/build/Release/pty.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 115. This version of Node.js requires NODE_MODULE_VERSION 141. Please try re-compiling or re-installing the module."
);
const SOURCE_ROOT = path.resolve('node-pty-runtime-repair-test-root');
const RUNTIME_ROOT = path.resolve('node-pty-runtime-repair-test-runtime');
const NPM_CLI = path.join(RUNTIME_ROOT, 'npm-cli.js');
const NODE_EXECUTABLE = path.join(RUNTIME_ROOT, 'node');

function createSourceFs(npmCli = NPM_CLI) {
  return {
    existsSync: jest.fn((candidate) => candidate === npmCli || [
      path.join(SOURCE_ROOT, '.git'),
      path.join(SOURCE_ROOT, 'package.json'),
      path.join(SOURCE_ROOT, 'node_modules', 'node-pty', 'package.json')
    ].includes(candidate))
  };
}

describe('NodePtyRuntimeRepair', () => {
  test('parses the native ABI mismatch reported by Node.js', () => {
    expect(parseNodePtyAbiMismatch(ABI_ERROR)).toEqual({
      builtAbi: 115,
      runtimeAbi: 141
    });
    expect(parseNodePtyAbiMismatch(new Error('Cannot find module node-pty'))).toBeNull();
  });

  test('uses the active Node executable with npm CLI instead of a PATH-selected Node', () => {
    const fsImpl = createSourceFs();
    const spawnSyncImpl = jest.fn(() => ({ status: 0, stdout: 'rebuilt' }));
    const env = { npm_execpath: NPM_CLI };
    const repair = new NodePtyRuntimeRepair({
      spawnSyncImpl,
      fsImpl,
      env,
      execPath: NODE_EXECUTABLE,
      platform: 'linux',
      timeoutMs: 1234
    });

    expect(repair.tryRepair(ABI_ERROR, { rootDir: SOURCE_ROOT })).toMatchObject({
      attempted: true,
      repaired: true,
      reason: 'rebuilt',
      builtAbi: 115,
      runtimeAbi: 141
    });
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      NODE_EXECUTABLE,
      [NPM_CLI, 'rebuild', 'node-pty'],
      expect.objectContaining({
        cwd: SOURCE_ROOT,
        env,
        timeout: 1234,
        windowsHide: false
      })
    );
  });

  test('does not rebuild for unrelated load failures', () => {
    const spawnSyncImpl = jest.fn();
    const repair = new NodePtyRuntimeRepair({ spawnSyncImpl });

    expect(repair.tryRepair(new Error('permission denied'), { rootDir: '/repo' })).toEqual({
      attempted: false,
      repaired: false,
      reason: 'not-abi-mismatch'
    });
    expect(spawnSyncImpl).not.toHaveBeenCalled();
  });

  test('does not modify a packaged backend or run when disabled', () => {
    expect(isPackagedBackendRoot('/opt/Agent Workspace/resources/backend')).toBe(true);

    const packagedSpawn = jest.fn();
    const packagedRepair = new NodePtyRuntimeRepair({ spawnSyncImpl: packagedSpawn });
    expect(packagedRepair.tryRepair(ABI_ERROR, {
      rootDir: '/opt/Agent Workspace/resources/backend'
    })).toMatchObject({
      attempted: false,
      reason: 'packaged-backend'
    });
    expect(packagedSpawn).not.toHaveBeenCalled();

    const disabledSpawn = jest.fn();
    const disabledRepair = new NodePtyRuntimeRepair({
      spawnSyncImpl: disabledSpawn,
      env: { ORCHESTRATOR_NODE_PTY_AUTO_REBUILD: 'false' }
    });
    expect(disabledRepair.tryRepair(ABI_ERROR, { rootDir: '/repo' })).toMatchObject({
      attempted: false,
      reason: 'disabled'
    });
    expect(disabledSpawn).not.toHaveBeenCalled();
  });

  test('attempts at most one rebuild per process after a command failure', () => {
    const fsImpl = createSourceFs();
    const spawnSyncImpl = jest.fn(() => ({ status: 1, stderr: 'native build failed' }));
    const repair = new NodePtyRuntimeRepair({
      spawnSyncImpl,
      fsImpl,
      env: { npm_execpath: NPM_CLI },
      execPath: NODE_EXECUTABLE
    });

    expect(repair.tryRepair(ABI_ERROR, { rootDir: SOURCE_ROOT })).toMatchObject({
      attempted: true,
      repaired: false,
      reason: 'rebuild-failed',
      error: expect.objectContaining({ message: 'native build failed' })
    });
    expect(repair.tryRepair(ABI_ERROR, { rootDir: SOURCE_ROOT })).toMatchObject({
      attempted: false,
      repaired: false,
      reason: 'already-attempted'
    });
    expect(spawnSyncImpl).toHaveBeenCalledTimes(1);
  });

  test.each([
    'npm.cmd',
    'yarn.js'
  ])('rejects an unsupported package manager entrypoint named %s', (entrypoint) => {
    const candidate = path.join(RUNTIME_ROOT, entrypoint);
    const fsImpl = { existsSync: jest.fn((value) => value === candidate) };

    expect(resolveNpmCli({
      env: { npm_execpath: candidate },
      execPath: NODE_EXECUTABLE,
      fsImpl
    })).toBeNull();
  });

  test('repairs an isolated ABI-mismatched package through the real npm subprocess', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-pty-abi-repair-'));
    const packageDir = path.join(rootDir, 'node_modules', 'node-pty');
    const mismatchMarker = path.join(packageDir, 'ABI_MISMATCH');
    fs.mkdirSync(path.join(rootDir, '.git'), { recursive: true });
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({
      name: 'node-pty-repair-fixture',
      version: '1.0.0',
      private: true
    }));
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
      name: 'node-pty',
      version: '1.0.0',
      scripts: { install: 'node repair.js' }
    }));
    fs.writeFileSync(path.join(packageDir, 'repair.js'), [
      "const fs = require('fs');",
      "const path = require('path');",
      "fs.rmSync(path.join(__dirname, 'ABI_MISMATCH'));"
    ].join('\n'));
    fs.writeFileSync(path.join(packageDir, 'index.js'), [
      "const fs = require('fs');",
      "const path = require('path');",
      "if (fs.existsSync(path.join(__dirname, 'ABI_MISMATCH'))) {",
      "  throw new Error('The module was compiled against a different Node.js version using NODE_MODULE_VERSION 115. This version of Node.js requires NODE_MODULE_VERSION 141.');",
      '}',
      'module.exports = { spawn() {} };'
    ].join('\n'));
    fs.writeFileSync(mismatchMarker, '1');

    const runtimeRepair = new NodePtyRuntimeRepair();
    const requireModule = (specifier) => {
      if (specifier !== 'node-pty') throw new Error(`unexpected module: ${specifier}`);
      return require(packageDir);
    };

    try {
      expect(loadNodePty({
        platform: 'linux',
        requireModule,
        runtimeRepair,
        rootDir
      })).toEqual({ spawn: expect.any(Function) });
      expect(fs.existsSync(mismatchMarker)).toBe(false);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
