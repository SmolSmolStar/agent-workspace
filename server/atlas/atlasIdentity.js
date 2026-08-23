const path = require('path');

const { kebab } = require('./atlasSchema');

const GITHUB_REMOTE_PROTOCOLS = new Set(['git:', 'git+ssh:', 'http:', 'https:', 'ssh:']);

function parseOwnerRepo(remoteUrl) {
  const value = String(remoteUrl || '').trim();
  const buildIdentity = (owner, rawRepo) => {
    const repo = String(rawRepo || '').replace(/\.git$/i, '');
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
    return { owner, repo, nameWithOwner: `${owner}/${repo}` };
  };

  const scpMatch = value.match(/^(?:[^@\s/:]+@)?github\.com:([^/\s]+)\/([^/\s]+?)\/?$/i);
  if (scpMatch) return buildIdentity(scpMatch[1], scpMatch[2]);

  const urlValue = /^github\.com\//i.test(value) ? `https://${value}` : value;
  try {
    const parsed = new URL(urlValue);
    if (!GITHUB_REMOTE_PROTOCOLS.has(parsed.protocol.toLowerCase())) return null;
    if (parsed.hostname.toLowerCase() !== 'github.com') return null;
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length !== 2) return null;
    return buildIdentity(segments[0], segments[1]);
  } catch {
    return null;
  }
}

function repositorySlug(entry) {
  const explicit = String(entry?.repo || '').trim().replace(/\.git$/i, '');
  const slugMatch = explicit.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (slugMatch) return `${slugMatch[1]}/${slugMatch[2]}`;
  return parseOwnerRepo(entry?.remoteUrl)?.nameWithOwner || '';
}

function localPathsFor(entry) {
  const supplied = [
    entry?.localPath,
    ...(Array.isArray(entry?.localPaths) ? entry.localPaths : [])
  ];
  const paths = [];
  const seen = new Set();

  for (const candidate of supplied) {
    const value = String(candidate || '').trim();
    if (!value) continue;
    const resolved = path.resolve(value);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(resolved);
  }

  return paths;
}

function discoveryIdentity(entry) {
  const slug = repositorySlug(entry);
  if (slug) return `github:${slug.toLowerCase()}`;
  const [localPath] = localPathsFor(entry);
  if (localPath) {
    const key = process.platform === 'win32' ? localPath.toLowerCase() : localPath;
    return `local:${key}`;
  }
  return `id:${kebab(entry?.id || entry?.name)}`;
}

function comparePreferredLocal(left, right) {
  const leftUsesPrimaryLayout = left?.worktreeLayout === true;
  const rightUsesPrimaryLayout = right?.worktreeLayout === true;
  if (leftUsesPrimaryLayout !== rightUsesPrimaryLayout) return leftUsesPrimaryLayout ? -1 : 1;

  const leftPath = String(left?.localPath || '');
  const rightPath = String(right?.localPath || '');
  const leftLooksLikeWorktree = /^work(?:\d+|[-_])/i.test(path.basename(leftPath));
  const rightLooksLikeWorktree = /^work(?:\d+|[-_])/i.test(path.basename(rightPath));
  if (leftLooksLikeWorktree !== rightLooksLikeWorktree) return leftLooksLikeWorktree ? 1 : -1;
  if (leftPath.length !== rightPath.length) return leftPath.length - rightPath.length;
  return leftPath.localeCompare(rightPath);
}

function uniqueStrings(values) {
  const out = [];
  for (const value of values.flat()) {
    const text = String(value || '').trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function latestActivity(entries) {
  let latest = null;
  let latestMs = -Infinity;
  for (const entry of entries) {
    const value = entry?.lastActivity;
    const ms = Date.parse(String(value || ''));
    if (Number.isFinite(ms) && ms > latestMs) {
      latest = value;
      latestMs = ms;
    }
  }
  return latest;
}

function disambiguateIds(entries) {
  const byId = new Map();
  for (const entry of entries) {
    const id = kebab(entry?.id || entry?.name || entry?.repo);
    const bucket = byId.get(id) || [];
    bucket.push(entry);
    byId.set(id, bucket);
  }

  for (const bucket of byId.values()) {
    if (bucket.length < 2) continue;
    for (const entry of bucket) {
      const slug = repositorySlug(entry);
      if (slug) entry.id = kebab(slug);
    }
  }

  return entries;
}

module.exports = {
  parseOwnerRepo,
  repositorySlug,
  localPathsFor,
  discoveryIdentity,
  comparePreferredLocal,
  uniqueStrings,
  latestActivity,
  disambiguateIds
};
