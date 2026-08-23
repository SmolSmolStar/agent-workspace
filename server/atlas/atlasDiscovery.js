const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const { kebab } = require('./atlasSchema');
const {
  parseOwnerRepo,
  repositorySlug,
  localPathsFor,
  discoveryIdentity,
  comparePreferredLocal,
  uniqueStrings,
  latestActivity,
  disambiguateIds
} = require('./atlasIdentity');

const SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'target', 'coverage',
  'vendor', '.next', '.nuxt', '.cache', '__pycache__', '.venv', 'venv', 'bin', 'obj'
]);

// Path segments that classify a repo without having to look inside it.
const CATEGORY_KINDS = {
  games: 'game',
  game: 'game',
  websites: 'website',
  website: 'website',
  web: 'website',
  tools: 'tool',
  tooling: 'tool',
  automation: 'tool',
  libraries: 'library',
  libs: 'library',
  writing: 'writing',
  docs: 'reference',
  experiments: 'experiment',
  labs: 'experiment'
};

const PLATFORM_SEGMENTS = [
  'roblox', 'hytopia', 'monogame', 'unity', 'godot', 'threejs', 'unreal',
  'phaser', 'pixi', 'love2d', 'bevy', 'react', 'nextjs', 'rails', 'django'
];

const REFERENCE_SEGMENTS = new Set(['_ref', '_refs', 'reference', '.reference', 'references', 'examples', 'third-party']);

const EXTENSION_LANGUAGES = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript',
  '.lua': 'Lua', '.luau': 'Luau', '.cs': 'C#', '.cpp': 'C++', '.cc': 'C++', '.c': 'C',
  '.rs': 'Rust', '.py': 'Python', '.rb': 'Ruby', '.go': 'Go', '.java': 'Java',
  '.kt': 'Kotlin', '.swift': 'Swift', '.sh': 'Shell', '.html': 'HTML', '.css': 'CSS',
  '.md': 'Markdown', '.glsl': 'GLSL', '.wgsl': 'WGSL'
};

const execFileAsync = (command, args, options = {}) => new Promise((resolve) => {
  execFile(command, args, { timeout: 15_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...options }, (error, stdout) => {
    resolve(error ? null : String(stdout || '').trim());
  });
});

function isGitRepoRoot(dirPath) {
  const gitPath = path.join(dirPath, '.git');
  try {
    // A worktree checkout has `.git` as a file pointing at the real gitdir.
    return fs.existsSync(gitPath);
  } catch {
    return false;
  }
}

/**
 * `~/GitHub/games/roblox/sabot-fps/master` describes a repo whose real
 * identity is `sabot-fps` — the worktree folder is an implementation detail.
 */
function resolveProjectRoot(repoDir) {
  const base = path.basename(repoDir);
  if (/^work\d+$/i.test(base) || base.toLowerCase() === 'master' || base.toLowerCase() === 'main') {
    return { projectRoot: path.dirname(repoDir), worktreeLayout: true };
  }
  return { projectRoot: repoDir, worktreeLayout: false };
}

async function resolveScannedProject(repoDir) {
  const fallback = { ...resolveProjectRoot(repoDir), primaryCheckout: null };
  try {
    if (!fs.lstatSync(path.join(repoDir, '.git')).isFile()) return fallback;
  } catch {
    return fallback;
  }
  const commonDir = await execFileAsync('git', ['-C', repoDir, 'rev-parse', '--git-common-dir']);
  if (!commonDir) return fallback;

  const checkout = path.resolve(repoDir);
  const resolvedCommonDir = path.resolve(repoDir, commonDir);
  if (path.basename(resolvedCommonDir).toLowerCase() !== '.git') return fallback;

  const primaryCheckout = path.dirname(resolvedCommonDir);
  const isPrimaryCheckout = checkout === primaryCheckout;
  const isSiblingCheckout = path.dirname(checkout) === path.dirname(primaryCheckout);
  if (!isPrimaryCheckout && !isSiblingCheckout) return fallback;

  const resolved = resolveProjectRoot(primaryCheckout);
  return {
    ...resolved,
    worktreeLayout: resolved.worktreeLayout || !isPrimaryCheckout,
    primaryCheckout
  };
}

function inferFromPath(projectRoot, roots) {
  const root = roots.find((r) => projectRoot.startsWith(r));
  const relative = root ? path.relative(root, projectRoot) : path.basename(projectRoot);
  const segments = relative.split(path.sep).filter(Boolean).map((s) => s.toLowerCase());
  const contextSegments = segments.slice(0, -1);

  let kind = null;
  const platforms = [];
  let isReference = false;

  for (const segment of contextSegments) {
    if (!kind && CATEGORY_KINDS[segment]) kind = CATEGORY_KINDS[segment];
    if (PLATFORM_SEGMENTS.includes(segment) && !platforms.includes(segment)) platforms.push(segment);
    if (REFERENCE_SEGMENTS.has(segment)) isReference = true;
  }

  return { kind: isReference ? 'reference' : kind, platforms, categoryPath: segments.slice(0, -1).join('/') };
}

function censusLanguages(repoDir, { maxFiles = 400 } = {}) {
  const counts = new Map();
  let seen = 0;
  const queue = [{ dir: repoDir, depth: 0 }];

  while (queue.length && seen < maxFiles) {
    const { dir, depth } = queue.shift();
    if (depth > 3) continue;
    let dirents = [];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (seen >= maxFiles) break;
      if (dirent.isDirectory()) {
        if (SKIP_DIRECTORIES.has(dirent.name) || dirent.name.startsWith('.')) continue;
        queue.push({ dir: path.join(dir, dirent.name), depth: depth + 1 });
        continue;
      }
      const language = EXTENSION_LANGUAGES[path.extname(dirent.name).toLowerCase()];
      if (!language || language === 'Markdown') continue;
      counts.set(language, (counts.get(language) || 0) + 1);
      seen += 1;
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([language]) => language);
}

async function readGitFacts(repoDir) {
  const [remoteUrl, lastCommit] = await Promise.all([
    execFileAsync('git', ['-C', repoDir, 'remote', 'get-url', 'origin']),
    execFileAsync('git', ['-C', repoDir, 'log', '-1', '--format=%cI'])
  ]);
  return { remoteUrl: remoteUrl || '', lastActivity: lastCommit || null };
}

function walkForRepos(root, maxDepth) {
  const found = [];
  if (!fs.existsSync(root)) return found;

  const queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (isGitRepoRoot(dir)) {
      found.push(dir);
      // Do not descend into a repo — nested worktrees are siblings, not children.
      continue;
    }
    if (depth >= maxDepth) continue;

    let dirents = [];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      if (SKIP_DIRECTORIES.has(dirent.name)) continue;
      queue.push({ dir: path.join(dir, dirent.name), depth: depth + 1 });
    }
  }
  return found;
}

/**
 * Discover repos on disk. Worktree siblings collapse into a single entry keyed
 * by the project root, so `master/` and `work1..work8` never appear as nine repos.
 */
async function scanLocalRepos({ roots, maxDepth = 6, languageCensus = true } = {}) {
  const searchRoots = (Array.isArray(roots) && roots.length ? roots : [path.join(os.homedir(), 'GitHub')])
    .map((r) => path.resolve(r));

  const byProject = new Map();

  for (const root of searchRoots) {
    for (const repoDir of walkForRepos(root, maxDepth)) {
      const { projectRoot, worktreeLayout, primaryCheckout } = await resolveScannedProject(repoDir);
      const existing = byProject.get(projectRoot);
      if (existing) {
        existing.checkoutPaths.add(repoDir);
        existing.worktreeLayout = existing.worktreeLayout || worktreeLayout;
        // Prefer the common checkout when it appears in the scan.
        const base = path.basename(repoDir).toLowerCase();
        if (repoDir === primaryCheckout || base === 'master' || base === 'main') existing.repoDir = repoDir;
        continue;
      }
      byProject.set(projectRoot, {
        projectRoot,
        repoDir,
        worktreeLayout,
        searchRoot: root,
        checkoutPaths: new Set([repoDir])
      });
    }
  }

  const entries = [];
  for (const { projectRoot, repoDir, worktreeLayout, checkoutPaths } of byProject.values()) {
    const { remoteUrl, lastActivity } = await readGitFacts(repoDir);
    const parsed = parseOwnerRepo(remoteUrl);
    const inferred = inferFromPath(projectRoot, searchRoots);
    const checkoutAliases = [...checkoutPaths].map((candidate) => path.resolve(candidate)).sort();
    const localPaths = [...new Set([projectRoot, ...checkoutAliases])];

    entries.push({
      __source: 'discovery',
      id: kebab(parsed?.repo || path.basename(projectRoot)),
      name: parsed?.repo || path.basename(projectRoot),
      repo: parsed?.nameWithOwner || '',
      owner: parsed?.owner || '',
      kind: inferred.kind || undefined,
      platforms: inferred.platforms,
      languages: languageCensus ? censusLanguages(repoDir) : [],
      tags: inferred.categoryPath ? [kebab(inferred.categoryPath)] : [],
      localPath: projectRoot,
      localPaths,
      cloned: true,
      worktreeLayout,
      remoteUrl,
      lastActivity,
      lastScannedAt: new Date().toISOString()
    });
  }

  return entries.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Repos that exist on GitHub but are not on this disk still belong on the map —
 * that is the whole point of an atlas rather than a directory listing.
 */
async function listGitHubRepos({ limit = 300, owner = '' } = {}) {
  const args = ['repo', 'list'];
  if (owner) args.push(owner);
  args.push('--limit', String(limit), '--json', 'nameWithOwner,name,description,visibility,primaryLanguage,updatedAt,isFork,isArchived,url');

  const stdout = await execFileAsync('gh', args);
  if (!stdout) return { available: false, entries: [] };

  let rows = [];
  try {
    rows = JSON.parse(stdout);
  } catch {
    return { available: false, entries: [] };
  }

  const entries = rows.map((row) => ({
    __source: 'discovery',
    id: kebab(row?.name),
    name: String(row?.name || ''),
    repo: String(row?.nameWithOwner || ''),
    owner: String(row?.nameWithOwner || '').split('/')[0] || '',
    summary: String(row?.description || ''),
    visibility: String(row?.visibility || '').toLowerCase() === 'public' ? 'public' : 'private',
    languages: row?.primaryLanguage?.name ? [row.primaryLanguage.name] : [],
    isFork: row?.isFork === true,
    archived: row?.isArchived === true,
    status: row?.isArchived === true ? 'archived' : undefined,
    kind: row?.isFork === true ? 'reference' : undefined,
    remoteUrl: String(row?.url || ''),
    lastActivity: row?.updatedAt || null,
    cloned: false,
    lastScannedAt: new Date().toISOString()
  })).filter((entry) => entry.id);

  return { available: true, entries };
}

/**
 * Merge the two discovery sources by repo identity. Local wins on paths and
 * language detail; GitHub wins on visibility, fork/archive state, and description.
 */
function mergeDiscovery(localEntries = [], githubEntries = []) {
  const groups = new Map();
  for (const entry of githubEntries) {
    const key = discoveryIdentity(entry);
    const group = groups.get(key) || { github: null, locals: [] };
    group.github = { ...entry, repo: repositorySlug(entry) || entry.repo };
    groups.set(key, group);
  }
  for (const entry of localEntries) {
    const normalized = { ...entry, repo: repositorySlug(entry) || entry.repo };
    const key = discoveryIdentity(normalized);
    const group = groups.get(key) || { github: null, locals: [] };
    group.locals.push(normalized);
    groups.set(key, group);
  }

  const merged = [];
  for (const { github, locals } of groups.values()) {
    if (!locals.length) {
      merged.push({ ...github });
      continue;
    }

    const rankedLocals = locals.slice().sort(comparePreferredLocal);
    const preferred = rankedLocals[0];
    const slug = repositorySlug(github) || repositorySlug(preferred);
    const repoName = slug.split('/').filter(Boolean).slice(-1)[0] || '';
    const localPaths = uniqueStrings(rankedLocals.map(localPathsFor));
    const [preferredPath] = localPathsFor(preferred);
    const entry = {
      ...(github || {}),
      ...preferred,
      id: kebab(github?.id || repoName || preferred.id || preferred.name),
      name: github?.name || repoName || preferred.name,
      repo: slug,
      owner: github?.owner || preferred.owner || slug.split('/')[0] || '',
      summary: preferred.summary || github?.summary || '',
      visibility: github?.visibility || preferred.visibility,
      isFork: github?.isFork ?? preferred.isFork,
      archived: github?.archived ?? preferred.archived,
      status: github?.status || preferred.status,
      languages: uniqueStrings([
        ...rankedLocals.map((candidate) => candidate.languages || []),
        github?.languages || []
      ]),
      localPath: preferredPath || localPaths[0] || null,
      localPaths,
      remoteUrl: preferred.remoteUrl || github?.remoteUrl || '',
      lastActivity: latestActivity([github, ...rankedLocals]),
      cloned: true
    };
    merged.push(entry);
  }

  disambiguateIds(merged);
  return merged.sort((a, b) => a.id.localeCompare(b.id) || String(a.repo || '').localeCompare(String(b.repo || '')));
}

module.exports = {
  scanLocalRepos,
  listGitHubRepos,
  mergeDiscovery,
  repositorySlug,
  localPathsFor,
  discoveryIdentity,
  parseOwnerRepo,
  resolveProjectRoot,
  inferFromPath,
  censusLanguages
};
