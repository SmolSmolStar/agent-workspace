const path = require('path');

const { countNonBlankLines } = require('./atlasCheckout');

const MAX_SOURCE_BYTES = 512 * 1024;

const SOURCE_LANGUAGES = new Map([
  ['.bash', 'Shell'], ['.c', 'C'], ['.cc', 'C++'], ['.cpp', 'C++'], ['.cs', 'C#'],
  ['.css', 'CSS'], ['.go', 'Go'], ['.graphql', 'GraphQL'], ['.gql', 'GraphQL'],
  ['.h', 'C'], ['.hpp', 'C++'], ['.html', 'HTML'], ['.java', 'Java'],
  ['.js', 'JavaScript'], ['.jsx', 'JavaScript'], ['.kt', 'Kotlin'], ['.kts', 'Kotlin'],
  ['.lua', 'Lua'], ['.luau', 'Luau'], ['.mjs', 'JavaScript'], ['.php', 'PHP'],
  ['.ps1', 'PowerShell'], ['.psm1', 'PowerShell'], ['.py', 'Python'], ['.rb', 'Ruby'],
  ['.rs', 'Rust'], ['.scss', 'SCSS'], ['.sh', 'Shell'], ['.sql', 'SQL'],
  ['.svelte', 'Svelte'], ['.swift', 'Swift'], ['.ts', 'TypeScript'], ['.tsx', 'TypeScript'],
  ['.vue', 'Vue'], ['.wgsl', 'WGSL'], ['.zsh', 'Shell']
]);

const EXCLUDED_SEGMENTS = new Set([
  '.cache', '.next', '.nuxt', 'build', 'coverage', 'dist',
  'node_modules', 'obj', 'target', 'vendor'
]);

const LOCKFILE_NAMES = new Set([
  'bun.lock', 'bun.lockb', 'cargo.lock', 'composer.lock', 'gemfile.lock', 'go.sum',
  'gradle.lockfile', 'package-lock.json', 'packages.lock.json', 'pnpm-lock.yaml',
  'poetry.lock', 'uv.lock', 'yarn.lock'
]);

function normalizeRepoPath(value, { allowBackslash = true } = {}) {
  const raw = String(value || '');
  if (raw !== raw.trim()) return null;
  if (!allowBackslash && raw.includes('\\')) return null;
  const normalized = (allowBackslash ? raw.replace(/\\/g, '/') : raw).replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return null;
  if (/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(normalized)) return null;
  if (normalized.split('/').includes('..')) return null;
  return normalized.replace(/\/$/, '');
}

function sourceLanguage(repoPath) {
  const excluded = repoPath.split('/')
    .some((segment) => EXCLUDED_SEGMENTS.has(segment.toLowerCase()));
  if (excluded) return null;
  return SOURCE_LANGUAGES.get(path.posix.extname(repoPath).toLowerCase()) || null;
}

function isTestPath(repoPath) {
  const lower = repoPath.toLowerCase();
  const base = path.posix.basename(lower);
  return /(^|\/)(__tests__|spec|specs|test|tests)(\/|$)/.test(lower)
    || /(^|[._-])(spec|test)(?=\.[^.]+$)/.test(base)
    || /^(spec|test)[_-]/.test(base)
    || /_(spec|test)\.[^.]+$/.test(base);
}

function splitNulls(value) {
  return String(value || '')
    .split('\0')
    .map((item) => item.replace(/^[\r\n]+|[\r\n]+$/g, ''))
    .filter(Boolean);
}

function collectTouches(logOutput, knownFiles) {
  const touches = new Map();
  for (const rawPath of splitNulls(logOutput)) {
    const repoPath = normalizeRepoPath(rawPath, { allowBackslash: false });
    if (!repoPath || !knownFiles.has(repoPath)) continue;
    touches.set(repoPath, (touches.get(repoPath) || 0) + 1);
  }
  return touches;
}

function sortByTouches(files, touches) {
  return [...files].sort((left, right) => {
    const countDifference = (touches.get(right) || 0) - (touches.get(left) || 0);
    return countDifference || left.localeCompare(right);
  });
}

function matchingTrackedFiles(curatedPath, trackedFiles) {
  const normalized = normalizeRepoPath(curatedPath);
  if (!normalized) return [];
  if (trackedFiles.has(normalized)) return [normalized];
  const prefix = `${normalized}/`;
  return [...trackedFiles].filter((candidate) => candidate.startsWith(prefix));
}

function buildExamples({ entry, checkout, sourceFiles, testFiles, touches, limit }) {
  const examples = [];
  const included = new Set();
  const eligible = new Set([...sourceFiles, ...testFiles]);

  const add = (repoPath, kind, curated = null) => {
    if (!repoPath || included.has(repoPath) || examples.length >= limit) return;
    included.add(repoPath);
    const example = {
      path: repoPath,
      kind,
      recentCommitTouches: touches.get(repoPath) || 0,
      nonBlankLines: countNonBlankLines(checkout, repoPath, { maxBytes: MAX_SOURCE_BYTES })
    };
    if (curated) example.curated = curated;
    examples.push(example);
  };

  const highlights = [...(entry?.highlights || [])]
    .sort((left, right) => Number(right?.quality || 0) - Number(left?.quality || 0));
  for (const highlight of highlights) {
    for (const curatedPath of highlight?.paths || []) {
      const matches = sortByTouches(matchingTrackedFiles(curatedPath, eligible), touches);
      if (!matches.length) continue;
      add(matches[0], 'curated', {
        topic: String(highlight.topic || ''),
        quality: Number.isFinite(Number(highlight.quality)) ? Number(highlight.quality) : null
      });
      if (examples.length >= limit) return examples;
    }
  }

  const sourceTarget = Math.max(1, limit - (testFiles.length ? 1 : 0));
  for (const repoPath of sortByTouches(sourceFiles, touches)) {
    if (examples.length >= sourceTarget) break;
    add(repoPath, 'frequently-changed-source');
  }

  for (const repoPath of sortByTouches(testFiles, touches)) {
    if (examples.length >= limit) break;
    add(repoPath, 'test');
  }

  return examples;
}

function practiceSignals(trackedFiles, testFiles) {
  const lowerFiles = trackedFiles.map((repoPath) => repoPath.toLowerCase());
  const isCiConfig = (repoPath) => (repoPath.startsWith('.github/workflows/') && /\.ya?ml$/.test(repoPath))
    || repoPath === '.circleci/config.yml'
    || repoPath === '.gitlab-ci.yml'
    || repoPath === '.travis.yml'
    || repoPath === 'azure-pipelines.yml'
    || repoPath === 'bitbucket-pipelines.yml'
    || repoPath === 'jenkinsfile';
  return {
    ciConfigCount: lowerFiles.filter(isCiConfig).length,
    hasCodebaseDocumentation: lowerFiles.includes('codebase_documentation.md'),
    hasAgentInstructions: lowerFiles.includes('agents.md') || lowerFiles.includes('claude.md'),
    hasDependencyLockfile: lowerFiles.some((repoPath) => LOCKFILE_NAMES.has(path.posix.basename(repoPath))),
    hasTests: testFiles.length > 0
  };
}

function languageCounts(sourceFiles, testFiles) {
  const counts = new Map();
  for (const repoPath of [...sourceFiles, ...testFiles]) {
    const language = sourceLanguage(repoPath);
    if (language) counts.set(language, (counts.get(language) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([language, files]) => ({ language, files }))
    .sort((left, right) => right.files - left.files || left.language.localeCompare(right.language));
}

module.exports = {
  buildExamples,
  collectTouches,
  isTestPath,
  languageCounts,
  normalizeRepoPath,
  practiceSignals,
  sourceLanguage,
  splitNulls
};
