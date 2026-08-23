const { createHash } = require('crypto');
const path = require('path');

const { kebab } = require('./atlasSchema');

function parseOwnerRepo(remoteUrl) {
  const match = String(remoteUrl || '').trim().match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2], nameWithOwner: `${match[1]}/${match[2]}` };
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

  const used = new Set();
  for (const [id, bucket] of byId) {
    if (bucket.length !== 1) continue;
    bucket[0].id = id;
    used.add(id);
  }

  const collisions = [...byId.entries()]
    .filter(([, bucket]) => bucket.length > 1)
    .sort(([leftId], [rightId]) => leftId.localeCompare(rightId));

  for (const [baseId, bucket] of collisions) {
    const ordered = bucket.slice().sort((left, right) => (
      discoveryIdentity(left).localeCompare(discoveryIdentity(right))
    ));
    for (const entry of ordered) {
      const slug = repositorySlug(entry);
      const identityKey = discoveryIdentity(entry);
      const suffix = createHash('sha256').update(identityKey).digest('hex').slice(0, 8);
      const preferred = (slug && kebab(slug)) || (baseId ? `${baseId}-${suffix}` : `repo-${suffix}`);
      let candidate = preferred;
      if (used.has(candidate)) candidate = `${preferred}-${suffix}`;
      let counter = 2;
      while (used.has(candidate)) {
        candidate = `${preferred}-${suffix}-${counter}`;
        counter += 1;
      }
      entry.id = candidate;
      used.add(candidate);
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
