const fs = require('fs');
const path = require('path');

const { repositorySlug } = require('./atlasIdentity');

const INFERRED_CHECKOUT_NAME = /^(?:main|master|work\d+)$/i;

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isGitCheckout(candidate) {
  if (!isDirectory(candidate)) return false;
  try {
    const gitMarker = fs.lstatSync(path.join(candidate, '.git'));
    return gitMarker.isDirectory() || gitMarker.isFile();
  } catch {
    return false;
  }
}

function checkoutPriority(candidate) {
  const name = path.basename(candidate.path).toLowerCase();
  if (name === 'master') return 0;
  if (name === 'main') return 1;
  if (/^work\d+$/.test(name)) return 3;
  return 2;
}

function canonicalPath(candidate) {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function checkoutCandidates(entry) {
  const supplied = [
    entry?.localPath,
    ...(Array.isArray(entry?.localPaths) ? entry.localPaths : [])
  ];
  const candidates = new Map();

  const add = (candidate, resolution) => {
    const value = String(candidate || '').trim();
    if (!value || !isGitCheckout(value)) return;
    const resolved = canonicalPath(value);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    const existing = candidates.get(key);
    if (!existing || (existing.resolution === 'inferred' && resolution === 'exact')) {
      candidates.set(key, { path: resolved, resolution });
    }
  };

  for (const suppliedPath of supplied) {
    const value = String(suppliedPath || '').trim();
    if (!value) continue;
    const resolved = path.resolve(value);
    add(resolved, 'exact');
    if (entry?.worktreeLayout !== true || isGitCheckout(resolved) || !isDirectory(resolved)) continue;

    let children = [];
    try {
      children = fs.readdirSync(resolved, { withFileTypes: true })
        .filter((child) => child.isDirectory() && INFERRED_CHECKOUT_NAME.test(child.name))
        .map((child) => path.join(resolved, child.name));
    } catch {
      children = [];
    }
    for (const child of children) add(child, 'inferred');
  }

  return [...candidates.values()].sort((left, right) => (
    checkoutPriority(left) - checkoutPriority(right)
      || (left.resolution === right.resolution ? 0 : left.resolution === 'exact' ? -1 : 1)
      || left.path.localeCompare(right.path)
  ));
}

async function resolveCheckout(entry, { runGit }) {
  if (typeof runGit !== 'function') throw new Error('runGit is required.');
  const expectedSlug = repositorySlug(entry).toLowerCase();
  let firstFailure = null;

  for (const candidate of checkoutCandidates(entry)) {
    if (expectedSlug) {
      let remoteUrl = '';
      try {
        remoteUrl = (await runGit(candidate.path, [
          'config', '--local', '--get', 'remote.origin.url'
        ])).trim();
      } catch (error) {
        if (error?.exitCode === 1) continue;
        firstFailure ||= error;
        continue;
      }
      if (repositorySlug({ remoteUrl }).toLowerCase() !== expectedSlug) continue;
    }

    return candidate;
  }

  if (firstFailure) throw firstFailure;
  return null;
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function openedPath(fd, fallback, descriptorStat) {
  const candidates = [];
  if (process.platform !== 'win32') {
    candidates.push(`/proc/self/fd/${fd}`, `/dev/fd/${fd}`);
  }
  candidates.push(fallback);

  for (const candidate of candidates) {
    try {
      const resolved = fs.realpathSync(candidate);
      const pathStat = fs.statSync(resolved);
      if (pathStat.dev === descriptorStat.dev && pathStat.ino === descriptorStat.ino) return resolved;
    } catch {
      // Try the next descriptor path.
    }
  }
  return null;
}

function readUtf8Bytes(fd, byteLength) {
  const buffer = Buffer.alloc(byteLength);
  let offset = 0;
  while (offset < byteLength) {
    const bytesRead = fs.readSync(fd, buffer, offset, byteLength - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.toString('utf8', 0, offset);
}

function countNonBlankLines(checkout, repoPath, { maxBytes = 512 * 1024 } = {}) {
  let fd = null;
  try {
    const root = fs.realpathSync(checkout);
    const relativePath = String(repoPath || '');
    if (!relativePath || relativePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(relativePath)) return null;
    const segments = relativePath.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
    const absolutePath = path.resolve(root, ...segments);
    if (!isContained(root, absolutePath)) return null;
    if (fs.lstatSync(absolutePath).isSymbolicLink()) return null;

    const noFollow = Number(fs.constants.O_NOFOLLOW) || 0;
    fd = fs.openSync(absolutePath, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;

    const resolvedOpenedPath = openedPath(fd, absolutePath, stat);
    if (!resolvedOpenedPath || !isContained(root, resolvedOpenedPath)) return null;

    return readUtf8Bytes(fd, stat.size)
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .length;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // The descriptor is already unusable.
      }
    }
  }
}

module.exports = {
  checkoutCandidates,
  countNonBlankLines,
  isGitCheckout,
  resolveCheckout
};
