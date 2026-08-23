const path = require('path');

const { kebab } = require('./atlasSchema');
const { localPathsFor, repositorySlug, rootCommitsFor } = require('./atlasIdentity');

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function candidateIds(entries) {
  return [...new Set(entries.map((entry) => String(entry?.id || '')).filter(Boolean))].sort();
}

function resolveCandidates(registryId, entries) {
  const candidates = candidateIds(entries);
  if (candidates.length === 1) return { targetId: candidates[0], warning: null };
  if (candidates.length > 1) {
    return {
      targetId: registryId,
      warning: { type: 'ambiguous-registry-id', registryId, candidates }
    };
  }
  return null;
}

function resolveRegistryTarget(registryId, registryEntry, discoveredEntries) {
  const key = kebab(registryId);
  const exact = discoveredEntries.find((entry) => entry?.id === key);
  if (exact) return { targetId: key, warning: null };

  const registryRoots = rootCommitsFor(registryEntry).join(',');
  if (registryRoots) {
    const rootMatch = resolveCandidates(key, discoveredEntries.filter((entry) => (
      rootCommitsFor(entry).join(',') === registryRoots
    )));
    if (rootMatch) return rootMatch;
  }

  const registryPaths = new Set(localPathsFor(registryEntry).map(comparablePath));
  if (registryPaths.size) {
    const pathMatch = resolveCandidates(key, discoveredEntries.filter((entry) => (
      localPathsFor(entry).some((candidate) => registryPaths.has(comparablePath(candidate)))
    )));
    if (pathMatch) return pathMatch;
  }

  const slug = repositorySlug(registryEntry).toLowerCase();
  if (slug) {
    const slugMatch = resolveCandidates(key, discoveredEntries.filter((entry) => (
      repositorySlug(entry).toLowerCase() === slug
    )));
    if (slugMatch) return slugMatch;
  }

  const legacyEntries = discoveredEntries.filter((entry) => {
    const repoName = repositorySlug(entry).split('/').filter(Boolean).at(-1);
    return [entry?.name, repoName].some((value) => kebab(value) === key);
  });
  const legacyCandidates = candidateIds(legacyEntries);
  if (legacyCandidates.length) {
    return {
      targetId: key,
      warning: {
        type: legacyCandidates.length > 1 ? 'ambiguous-registry-id' : 'unverified-registry-id',
        registryId: key,
        candidates: legacyCandidates
      }
    };
  }
  return { targetId: key, warning: null };
}

function portableRegistryIdentity(entry) {
  const seed = {};
  const name = String(entry?.name || '').trim();
  const repo = repositorySlug(entry);
  const rootCommits = rootCommitsFor(entry);
  if (name) seed.name = name;
  if (repo) seed.repo = repo;
  if (rootCommits.length) seed.rootCommits = rootCommits;
  return seed;
}

function reconcileRegistryLayers(byId, discoveredEntries, registryEntries) {
  const identityWarnings = [];
  const registryTargets = new Map();
  const registryAliases = new Map();
  const byTarget = new Map();

  for (const [registryId, entry] of Object.entries(registryEntries || {})) {
    const resolution = resolveRegistryTarget(registryId, entry, discoveredEntries);
    const targetId = resolution.targetId;
    const bucket = byTarget.get(targetId) || [];
    bucket.push({ registryId, entry });
    byTarget.set(targetId, bucket);
    registryTargets.set(registryId, targetId);
    if (resolution.warning) identityWarnings.push(resolution.warning);
  }

  for (const [targetId, records] of byTarget) {
    const ordered = records.slice().sort((left, right) => {
      const leftExact = left.registryId === targetId;
      const rightExact = right.registryId === targetId;
      if (leftExact !== rightExact) return leftExact ? -1 : 1;
      return left.registryId.localeCompare(right.registryId);
    });
    const primary = ordered[0];
    const slot = byId.get(targetId) || {};
    slot.registry = { ...primary.entry, __source: 'registry' };
    byId.set(targetId, slot);
    registryAliases.set(targetId, primary.registryId);

    if (ordered.length > 1) {
      identityWarnings.push({
        type: 'duplicate-registry-identity',
        targetId,
        registryIds: ordered.map((record) => record.registryId).sort()
      });
    }
  }

  identityWarnings.sort((left, right) => {
    const leftKey = left.registryId || left.targetId || '';
    const rightKey = right.registryId || right.targetId || '';
    return leftKey.localeCompare(rightKey) || left.type.localeCompare(right.type);
  });
  return { identityWarnings, registryTargets, registryAliases };
}

module.exports = {
  resolveRegistryTarget,
  reconcileRegistryLayers,
  portableRegistryIdentity
};
